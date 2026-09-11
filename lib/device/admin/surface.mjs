// surface.mjs — the whole admin surface as one request handler, with
// nothing that belongs to a process of its own: the preamble every request
// passes (CORS for the client API, the Host/Origin firewall, the operator's
// door when embedded), the protocol routes that answer strangers (C2S, the
// OAuth metadata, nodeinfo, the Mastodon facade), the pages and client
// served off disk, and the dispatch to the routes modules beside it. Each of
// those exports get() and post() over the same ctx.

import { MastoApi } from '../../client/masto/index.mjs';
import { C2S } from '../../client/c2s.mjs';
import { makeC2sAuth } from '../../client/oidc-auth.mjs';
import { Streaming } from '../../client/streaming.mjs';
import { nodeinfoPointer, nodeinfoDoc } from '../../core/wire.mjs';
import { checkRequest } from '../../shared/guard.mjs';
import { hasCredential } from '../setup.mjs';
import { localVersion } from '../update.mjs';
import { projectRoot, AGENT_VERSION, SETUP_PAGE, securityHeaders, sendJson, serveStatic, serveWeb, webDirRedirect, webMount } from './static.mjs';
import * as owner from './routes/owner.mjs';
import * as setup from './routes/setup.mjs';
import * as lifecycle from './routes/lifecycle.mjs';
import * as gateway from './routes/gateway.mjs';
import * as social from './routes/social.mjs';
import * as connections from './routes/connections.mjs';

// POSTs an unconfigured agent still answers: /block is worth having before
// federation starts, and /setup is how it stops being unconfigured.
// /shutdown is here because stopping an agent that was never set up is exactly
// the case it exists for; it is in LOCAL_ONLY_POSTS below, so it still answers
// only to this machine.
const OPEN_POSTS = new Set(['/block', '/unblock', '/setup', '/setup/check', '/setup/reset', '/shutdown']);
// Routes that manage a local agent process — spawning siblings, killing this
// one, moving files on the machine, running setup in a browser. Inside a pod
// server there is no such process and no such machine: identities come from
// the server's own configuration, so these are not there to be found.
const EMBEDDED_CUT = new Set(['/profiles', '/shutdown', '/new-actor', '/start-actor',
  '/state-move', '/setup', '/setup/check', '/setup/reset']);
// AP_ALLOWED_HOSTS may name a tailnet host or a reverse-proxy domain. The
// fediverse is welcome there; creating accounts and editing the record is for
// whoever is sitting at the machine.
const LOCAL_ONLY_POSTS = new Set(['/setup', '/setup/check', '/setup/reset', '/config', '/new-actor', '/start-actor', '/shutdown', '/state-move', '/atproto/connect', '/fediacct/connect', '/fediacct/disconnect', '/fediacct', '/gateway', '/alias', '/import', '/update']);

// A cross-origin form POST needs no CORS preflight, and JSON.parse does not
// care what Content-Type claimed — so parsing whatever arrived let a visited
// page reach every write route with a body of its choosing. Our own callers
// (web/admin/*.js, the CLI) all send application/json; `stop` sends no body at
// all, which is why an absent type is allowed only for an empty one.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const isJson = ct === 'application/json';
    const wrongType = () => reject(new Error('expected content-type: application/json'));
    if (ct && !isJson) { req.resume(); wrongType(); return; }
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (data && !isJson) return wrongType();
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// The routes, in the order the one if-chain and the one switch used to be
// read: the first module that answers a path wins.
const ROUTES = [owner, setup, lifecycle, gateway, social, connections];

// The whole admin/facade surface as one request handler, with nothing that
// belongs to a process of its own. startAdmin wraps it in listeners; the CSS
// component hands it CSS's, so the same routes answer on the pod's origin.
//
// `embedded` cuts the routes that manage local agent processes — they have no
// meaning inside a server that is not one — and moves the gate: a pod that is
// a fediverse instance must let strangers reach /api and /oauth, so the gate
// guards the operator's door (basePath) instead of the whole surface.
export function buildAdminSurface({ agent, gate, allowed, log = console.log,
  port = null, handle = null, embedded = false, basePath = '/',
  publicOrigin = null, scheme = null,
  versionOnDisk = () => localVersion(projectRoot) }) {
  const json = (res, status, obj) => sendJson(res, status, obj, allowed);
  const masto = new MastoApi({ agent, log, allowed, scheme, embedded });
  // The spec's own write API (§6), beside the facade. Its bearer fallback is
  // the facade's token, so the two surfaces share one notion of the operator.
  const c2s = new C2S({ agent, log, auth: makeC2sAuth({ agent, masto, log, scheme }) });
  const streaming = new Streaming({ masto, log, allowed, gate, gateOptional: embedded });
  // Asked per request, not once here: startAdmin runs before connect, so the
  // kind is not known yet at mount time.
  const isGroup = () => agent.store.getConfig()?.kind === 'group';
  // One setup at a time, and the record outlives the run: a reloaded page
  // must still find out how the run it started ended. `setup.run` is written
  // by the setup routes and read by the setup page's state route.
  const setup_ = { run: null };
  // New statuses/notifications flow to connected streaming clients live.
  agent.store.onEvent = (type, obj) => {
    try {
      if (type === 'status') streaming.broadcast('update', masto.status(obj));
      else if (type === 'notification') {
        streaming.broadcast('notification', masto.notification(obj));
        // and out to any closed client, via its push subscription
        masto.pushNotify(obj).catch(e => log(`webpush: ${e.message}`));
      }
    } catch (e) { log(`streaming broadcast: ${e.message}`); }
  };

  // A path as the browser must ask for it: behind the door, prefixed with it.
  const atPath = (p_) => (basePath === '/' ? p_ : basePath.slice(0, -1) + p_);

  // What every route may reach: the agent and the deployment's facts.
  const ctx = { agent, log, allowed, embedded, port, handle, publicOrigin, versionOnDisk, isGroup, json, setup: setup_ };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Mastodon-style: the bearer-gated client API and the OAuth + nodeinfo
    // routes answer any origin — a browser client is served the way any
    // instance serves it. CORS headers and the preflight make that work; the
    // bearer stays the only credential, and the Host check below (which is
    // what stops DNS rebinding) still runs.
    const apiPath = url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/')
      || url.pathname === '/.well-known/nodeinfo' || url.pathname === '/nodeinfo/2.0';
    if (apiPath) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-expose-headers', 'Link');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
          'access-control-max-age': '86400',
        });
        res.end();
        return;
      }
    }
    // Host/Origin firewall: loopback binding alone does not keep a visited web
    // page (or a rebound DNS name) out. The API paths keep the Host check but
    // answer a foreign Origin, per above.
    const bad = checkRequest(req, allowed, { ignoreOrigin: apiPath });
    if (bad) {
      log(`refused: ${bad} (${req.method} ${req.url})`);
      res.writeHead(403, { 'content-type': 'text/plain', ...securityHeaders(allowed, false) });
      res.end('forbidden\n');
      return;
    }
    let p = url.pathname;
    // Embedded, the operator's door is one path on the pod's origin. Behind it
    // is everything that was the admin server; in front of it are the protocol
    // routes, which have to answer strangers because that is what makes the pod
    // an instance other software can talk to.
    let atDoor = !embedded;
    if (embedded && basePath !== '/'
      && (p === basePath.slice(0, -1) || p.startsWith(basePath))) {
      atDoor = true;
      p = p.slice(basePath.length - 1) || '/';
    }
    if (embedded && atDoor && EMBEDDED_CUT.has(p)) {
      return json(res, 404, { error: 'not available on a server-hosted identity' });
    }
    try {
      // C2S (ActivityPub §6) carries its own authentication — a Solid-OIDC
      // DPoP proof or the facade's bearer — so the dk-token gate does not
      // stand in front of it. The Host/Origin firewall above still does.
      if (p === '/ap/outbox' || p === '/ap/actor' || p === '/ap/inbox') {
        if (await c2s.handle(req, res, p, url)) return;
      }
      // Where a client looks first to find out how to sign in (RFC 8414), and
      // in front of the door for the same reason C2S is: a client that has to
      // be handed a secret before it can ask how to sign in cannot set itself
      // up at all. It names endpoints and nothing else, the endpoints it names
      // refuse without a password anyway, and the host and origin firewall
      // above still decides who gets this far.
      if (p === '/.well-known/oauth-authorization-server') {
        const scheme = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
        return json(res, 200, masto.authorizationServerMetadata(`${scheme}://${req.headers.host}`));
      }
      if (atDoor && gate(req, res)) return;
      if (p === '/api/v1/streaming/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK'); return;
      }
      // NodeInfo on the agent origin — clients probe it at login.
      if (p === '/.well-known/nodeinfo') {
        return json(res, 200, nodeinfoPointer(
          `${req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}/nodeinfo/2.0`));
      }
      if (p === '/nodeinfo/2.0') {
        return json(res, 200, nodeinfoDoc({
          version: AGENT_VERSION,
          localPosts: agent.store.countStatuses('post'),
        }));
      }
      // A group serves the client too, as of 2026-08-01. It was withheld on the
      // reasoning that a group has no timeline a human reads — which was wrong
      // twice over: a group has statuses (what it carried) and notifications
      // (who joined), and its operator has a bio to edit and a profile they
      // want to see the way everyone else does. The surface this opens is a
      // login and client tokens, and `passwd` has never had a group carve-out,
      // so a group can be gated exactly like a person before it is exposed.
      if (p.startsWith('/api/') || p.startsWith('/oauth/')) {
        if (await masto.handle(req, res, p, url)) return;
      }
      if (embedded && !atDoor) return json(res, 404, { error: 'unknown endpoint' });
      if (req.method === 'GET') {
        for (const r of ROUTES) if (await r.get?.(p, ctx, req, res, url)) return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // Our own pages come before the group check: a group is set up in the
        // browser like anything else, and it has a record to edit. It still
        // serves no fediverse client — see the 404 two lines down.
        const mount = webMount(p);
        if (mount) {
          // Without the slash a page's own relative <script src> resolves one
          // level up and 404s — and that is true at any depth, so ask the
          // filesystem rather than only special-casing the mount itself.
          const asDir = webDirRedirect(p);
          if (asDir) {
            res.writeHead(302, { location: atPath(asDir), ...securityHeaders(allowed, false) });
            res.end();
            return;
          }
          return serveWeb(res, p, mount, allowed);
        }
        // The bare URL means "show me what this agent wants from me now".
        // Keyed on the credential FILE, never on configured(): a healthy
        // install whose pod is briefly unreachable reports itself
        // unconfigured for up to an hour, and must not be sent to setup.
        if (p === '/' || p === '/index.html') {
          if (!(agent.home && hasCredential(agent.home))) {
            res.writeHead(302, { location: atPath(SETUP_PAGE), ...securityHeaders(allowed, false) });
            res.end();
            return;
          }
          // Opening the bare origin gets this actor's own client — the framed
          // view with the bar — not the unbound app. The client page frames
          // `/` itself and that load says so (Sec-Fetch-Dest: iframe), so only
          // a top-level navigation is sent onward. The one top-level landing
          // that must NOT be sent onward is the OAuth return, `/?code=…`: the
          // client registered `/` as its redirect URI and only the app at `/`
          // can exchange the code — the framed page would drop it and leave
          // the client logged out.
          const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
          const oauthLanding = /[?&](code|error)=/.test(q);
          if (!oauthLanding && req.headers['sec-fetch-dest'] === 'document') {
            res.writeHead(302, { location: atPath('/admin/client/') + q, ...securityHeaders(allowed, false) });
            res.end();
            return;
          }
        }
        return serveStatic(res, p, allowed);
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      // A body we refuse to read is the caller's mistake, not ours — 400 says
      // so, where the catch-all below would have called it a server fault.
      let body;
      try { body = await readBody(req); }
      catch (e) { return json(res, 400, { error: e.message }); }
      if (!OPEN_POSTS.has(p) && !agent.configured()) {
        return json(res, 409, { error: 'agent not configured — set it up at /admin/setup/' });
      }
      if (!embedded && LOCAL_ONLY_POSTS.has(p) && !allowed.isLocalRequest(req)) {
        return json(res, 403, { error: 'setup and configuration are available on this machine only' });
      }
      for (const r of ROUTES) if (await r.post?.(p, body, ctx, req, res)) return;
      return json(res, 404, { error: 'unknown endpoint' });
    } catch (e) {
      // The caller gets the real message: this server binds loopback only, sets
      // no CORS headers, and its one reader is the operator. Hiding the reason
      // from them buys nothing and costs a trip to the log. Stack stays here.
      log(`admin ${p}: ${e.stack || e.message}`);
      return json(res, 500, { error: e.message || String(e) });
    }
  };

  return { handler, masto, c2s, streaming };
}
