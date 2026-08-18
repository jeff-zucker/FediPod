// admin.mjs — loopback HTTP front: admin API + Mastodon client-API facade +
// the bundled Phanpy UI served same-origin (no CORS, no mixed content — the
// role data-kitchen's router plays for the in-app pane). Loopback-bound; the
// gate (vendor/gate.cjs) engages only when a token is configured, exactly
// its standalone behavior.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { followHandle, followActor, unfollowActor, ejectFollower, retractAnnouncement,
  admitRequest, refuseRequest, resolveHandle, applyModeration, announceModeration } from './social.mjs';
import { addRemoveActivity, webfingerHost } from './wire.mjs';
import { MastoApi, hashPassword } from './mastoapi.mjs';
import { C2S } from './c2s.mjs';
import { makeC2sAuth } from './oidc-auth.mjs';
import { Streaming } from './streaming.mjs';
import { nodeinfoPointer, nodeinfoDoc } from './wire.mjs';
import { allowedAuthorities, checkRequest, isCrossSiteNavigation, Authorities, hostLabel } from './guard.mjs';
import { identityHomes, rootOf, tildify, defaultProfile, writeJsonAtomic } from './home.mjs';
import { copyPrivateHalf, isCurrent, CURRENT_LAYOUT } from './migrate.mjs';
import { normalizeImport, IMPORT_KINDS } from './import.mjs';
import { insecureUrlReason } from './safefetch.mjs';
import { newRun, preflight, runSetup, setupInputError, hasCredential } from './setup.mjs';
import { portFree, freePortFrom } from './ports.mjs';
import { claimDirectory, yieldDirectory } from './directory.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { makeGate } = require(path.join(projectRoot, 'vendor/gate.cjs'));

const PHANPY_DIR = path.join(projectRoot, 'phanpy/dist');
const UI_DIR = path.join(projectRoot, 'ui');       // extra client dists: ui/<name>/ → /<name>/
// Our own pages, kept out of ui/ for two reasons: a client dist dropped in
// there under the same name would shadow them, and a group serves these and
// nothing else — so the prefix has to be one nobody is invited to write into.
// One surface, /admin/, with setup as its first section: /admin/setup/ is the
// first run, /admin/ is the record, and there is room for the rest.
const WEB_DIR = path.join(projectRoot, 'web');
const WEB_MOUNTS = ['admin'];
const webMount = (pathname) => {
  const seg = decodeURIComponent(pathname).replace(/^\/+/, '').split('/')[0];
  return WEB_MOUNTS.includes(seg) ? seg : null;
};
const SETUP_PAGE = '/admin/setup/';
const AGENT_VERSION = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
// POSTs an unconfigured agent still answers: /block is worth having before
// federation starts, and /setup is how it stops being unconfigured.
// /shutdown is here because stopping an agent that was never set up is exactly
// the case it exists for; it is in LOCAL_ONLY_POSTS below, so it still answers
// only to this machine.
const OPEN_POSTS = new Set(['/block', '/unblock', '/setup', '/setup/check', '/shutdown']);
// Routes that manage a local agent process — spawning siblings, killing this
// one, moving files on the machine, running setup in a browser. Inside a pod
// server there is no such process and no such machine: identities come from
// the server's own configuration, so these are not there to be found.
const EMBEDDED_CUT = new Set(['/profiles', '/shutdown', '/new-actor', '/start-actor',
  '/state-move', '/setup', '/setup/check']);
// AP_ALLOWED_HOSTS may name a tailnet host or a reverse-proxy domain. The
// fediverse is welcome there; creating accounts and editing the record is for
// whoever is sitting at the machine.
const LOCAL_ONLY_POSTS = new Set(['/setup', '/setup/check', '/config', '/new-actor', '/start-actor', '/shutdown', '/state-move', '/atproto/connect', '/gateway', '/alias', '/import']);
// The identity itself. Changing any of these means a different actor at a
// different address, which is a new setup, not an edit.
const PERMANENT_CONFIG = ['handle', 'remotePod', 'issuer', 'root', 'kind'];
// Config the actor document carries, so a change is not real until it is
// republished.
const WIRE_CONFIG = ['name', 'summary', 'icon', 'image', 'fields', 'approveJoins', 'moderators'];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.woff2': 'font/woff2',
};

// Sent on every response: nosniff and no-referrer everywhere, and for HTML a
// CSP that keeps SCRIPTS to our own origin while still allowing the remote
// avatars, media and instance calls a fediverse client must make. It is not an
// exfiltration boundary — connect-src has to allow https: for the client to
// work at all — it is a code-execution one.
// Phanpy's index.html carries an inline bootstrap script. Rather than
// opening the policy with 'unsafe-inline', hash the inline scripts we
// actually ship and allow exactly those.
let inlineHashes = null;
function inlineScriptHashes() {
  if (inlineHashes) return inlineHashes;
  inlineHashes = [];
  try {
    const html = fs.readFileSync(path.join(PHANPY_DIR, 'index.html'), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const digest = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      inlineHashes.push(`'sha256-${digest}'`);
    }
  } catch { /* no inline scripts to allow */ }
  return inlineHashes;
}

// The origin a browser should be sent to for an identity. A browser keys
// storage per ORIGIN, so linking every identity at localhost:<port> files them
// all in one bucket — which is how a client ends up holding one actor's login
// and showing it on another's page. Named whenever the handle is a legal host
// label; bare loopback when it is not, because a mangled name would be an
// origin the other agent's own guard refuses.
export function namedOrigin(handle, port) {
  const label = hostLabel(handle);
  return `http://${label ? label + '.' : ''}localhost:${port}`;
}

export function wsOrigins(port, labels = [], httpsPort = null) {
  const out = new Set();
  for (const a of allowedAuthorities(port, labels)) {
    // No IPv6 at all. Bare `::1` cannot carry a port, and Chrome rejects the
    // bracketed form inside a CSP source expression — one invalid source makes
    // it drop the whole directive, which is worse than not listing the socket.
    if (a.startsWith('::') || a.startsWith('[')) continue;
    out.add(`ws://${/:\d+$/.test(a) ? a : `${a}:${port}`}`);
  }
  if (httpsPort) {
    for (const a of allowedAuthorities(httpsPort, labels)) {
      if (a.startsWith('::') || a.startsWith('[')) continue;
      out.add(`wss://${/:\d+$/.test(a) ? a : `${a}:${httpsPort}`}`);
    }
  }
  return [...out];
}

function securityHeaders(auth, isHtml) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // SAMEORIGIN, not DENY: /admin/client/ frames the bundled client so a bar
    // of ours can sit above it. Only pages on this agent's own origins may —
    // the same set the Host/Origin firewall already trusts.
    'x-frame-options': 'SAMEORIGIN',
  };
  if (isHtml) {
    h['content-security-policy'] = [
      "default-src 'self'",
      `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes().join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      "media-src 'self' https: data: blob:",
      "font-src 'self' data:",
      // Every authority the Host/Origin firewall accepts, so browsing an agent
      // at its own name (solo.localhost:8041, a tailnet host) keeps streaming.
      // Pinning this to localhost blocked the socket with no visible error.
      //
      // `https:` is still here and the comment above no longer claims otherwise:
      // a fediverse client fetches remote instances by design — link previews,
      // an actor's own server, media — so there is no narrower set that leaves
      // it working. The XSS story is `script-src 'self'` plus hashes; treat
      // connect-src as availability, not containment.
      `connect-src 'self' https: ${(typeof auth.wsAuthorities === 'function'
        ? auth.wsAuthorities()
        : wsOrigins(auth.port, auth.labels(), auth.extraPorts?.[0])).join(' ')}`,
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
  }
  return h;
}

function sendJson(res, status, obj, auth) {
  res.writeHead(status, { 'content-type': 'application/json', ...securityHeaders(auth, false) });
  res.end(JSON.stringify(obj) + '\n');
}

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

// Static UI serving, path-jailed. Phanpy owns the root; any other client
// dist dropped into ui/<name>/ is served at /<name>/. Hash-routed apps:
// '/' (and directories) get their index.html; anything unknown 404s.
function serveStatic(res, pathname, auth) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let baseDir = PHANPY_DIR;
  const uiName = rel.split('/')[0];
  // The mount name is joined to UI_DIR, so it must be CONTAINED by it — the
  // same resolve-then-check sendFile does below, for the same reason.
  //
  // Decoding happens before the split, so a `%2f` in the first segment becomes
  // a real separator afterwards and `..` arrives here as a mount name. It
  // exists, and it is a directory, so baseDir was silently re-based to the
  // project root — and sendFile's jail then enforced containment against THAT,
  // dutifully approving `/..%2fpackage.json`, `/..%2f.git/config` and every
  // source file under it for anyone who could reach the port.
  // Resolved through symlinks, not just lexically: sendFile's own jail has
  // always used realpath, and a lexical check here would still admit a mount
  // that is a link pointing out of ui/.
  let mount = '';
  try {
    if (uiName) {
      const cand = path.resolve(UI_DIR, uiName);
      if (cand.startsWith(UI_DIR + path.sep) && fs.statSync(cand).isDirectory()) {
        const real = fs.realpathSync(cand);
        if (real.startsWith(fs.realpathSync(UI_DIR) + path.sep)) mount = cand;
      }
    }
  } catch { /* no such mount; fall through to the default base */ }
  if (mount) {
    baseDir = mount;
    rel = rel.slice(uiName.length).replace(/^\/+/, '');
  }
  return sendFile(res, baseDir, rel, auth);
}

// '/admin/setup' names a directory, so it needs the slash the browser will
// resolve relative URLs against. Returns the corrected path, or null.
function webDirRedirect(pathname) {
  if (pathname.endsWith('/')) return null;
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR + path.sep)) return null;      // not ours to stat
  try {
    if (fs.statSync(full).isDirectory()) return pathname + '/';
  } catch { /* not a directory here */ }
  return null;
}

// web/<mount>/ → /<mount>/. Same jail, different mount rule.
function serveWeb(res, pathname, mount, auth) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '').slice(mount.length).replace(/^\/+/, '');
  return sendFile(res, path.join(WEB_DIR, mount), rel, auth);
}

function sendFile(res, baseDir, rel, auth) {
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep) && file !== path.join(baseDir, 'index.html')) {
    res.writeHead(403); res.end(); return true;
  }
  let target = file;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    // Resolve symlinks before reading: a link inside a UI dir must not be a
    // way out of the jail.
    const real = fs.realpathSync(target);
    const realBase = fs.realpathSync(baseDir);
    if (!real.startsWith(realBase + path.sep) && real !== path.join(realBase, 'index.html')) {
      res.writeHead(403); res.end(); return true;
    }
    const ext = path.extname(real);
    const body = fs.readFileSync(real);
    // Our own pages are read straight off disk and change whenever the project
    // does. With no cache headers a browser is free to reuse them without
    // asking, so an edited page keeps rendering the old one and looks like the
    // edit never landed. The vendored client dists have hashed filenames and
    // are left alone.
    const ours = real.startsWith(fs.realpathSync(WEB_DIR) + path.sep);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      ...(ours ? { 'cache-control': 'no-store' } : {}),
      ...securityHeaders(auth, ext === '.html'),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain', ...securityHeaders(auth, false) });
    res.end('not found\n');
  }
  return true;
}

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
  publicOrigin = null, scheme = null }) {
  const json = (res, status, obj) => sendJson(res, status, obj, allowed);
  const masto = new MastoApi({ agent, log, allowed, scheme });
  // The spec's own write API (§6), beside the facade. Its bearer fallback is
  // the facade's token, so the two surfaces share one notion of the operator.
  const c2s = new C2S({ agent, log, auth: makeC2sAuth({ agent, masto, log, scheme }) });
  const streaming = new Streaming({ masto, log, allowed, gate, gateOptional: embedded });
  // Asked per request, not once here: startAdmin runs before connect, so the
  // kind is not known yet at mount time.
  const isGroup = () => agent.store.getConfig()?.kind === 'group';
  // One setup at a time, and the record outlives the run: a reloaded page
  // must still find out how the run it started ended.
  let setupRun = null;
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

  const handler = async (req, res) => {
    // Host/Origin firewall first: loopback binding alone does not keep a
    // visited web page (or a rebound DNS name) out.
    const bad = checkRequest(req, allowed);
    if (bad) {
      log(`refused: ${bad} (${req.method} ${req.url})`);
      res.writeHead(403, { 'content-type': 'text/plain', ...securityHeaders(allowed, false) });
      res.end('forbidden\n');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
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
      if (p === '/ap/outbox' || p === '/ap/actor') {
        if (await c2s.handle(req, res, p, url)) return;
      }
      if (atDoor && gate(req, res)) return;
      if (p === '/api/v1/streaming/health') {
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK'); return;
      }
      // NodeInfo on the agent origin — clients probe it at login.
      if (p === '/.well-known/nodeinfo') {
        return json(res, 200, nodeinfoPointer(`http://${req.headers.host}/nodeinfo/2.0`));
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
      if (req.method === 'GET' && p === '/status') return json(res, 200, agent.status());
      // The moderation queue: what listed moderators asked for over federation,
      // waiting for the operator to vouch (or not). See POST /modqueue.
      if (req.method === 'GET' && p === '/modqueue') {
        return json(res, 200, agent.store.getConfig()?.kind === 'group'
          ? agent.store.read('modqueue.json', []) : []);
      }
      // The inbox gateway (optional, opt-in). Its state, and the shadow-mode
      // measurement that says whether it is worth trusting. The HMAC secret is
      // never returned — only whether one is set.
      if (req.method === 'GET' && p === '/gateway') {
        const g = agent.store.getConfig()?.gateway || null;
        return json(res, 200, {
          configured: !!(g && g.url),
          url: g?.url || null, webId: g?.webId || null,
          frontActor: g?.frontActor || null,
          mode: g?.mode || 'off', hasSecret: !!g?.hmacSecret,
          stats: agent.store.read('gateway-stats.json', { verified: 0, unverified: 0, lastAt: null }),
        });
      }
      // The other identities on this machine, so the page can link to each one.
      // Their `agent.json` is the only file read — a port and a handle. A
      // sibling's credential and keys are never opened; anything else shown
      // here comes from that agent answering /status for itself.
      if (req.method === 'GET' && p === '/profiles') {
        const here = path.resolve(agent.home || '');
        // Which identity a plain command means: the last one started. A
        // different question from `current`, which is the page you are on.
        const wasLast = defaultProfile(rootOf(here));
        const rows = await Promise.all(identityHomes(rootOf(here)).map(async ({ name, dir }) => {
          // agent.json holds a port AND a handle — setup records both, exactly
          // so the named origin can be built before that agent has said a word.
          let rec = {};
          try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) || {}; } catch {}
          const port = rec.port || null;
          // A directory under profiles/ is not an identity until it holds a
          // credential or has run somewhere. A half-finished setup leaves one
          // behind, and listing it offers a page that cannot exist yet.
          if (!port && !fs.existsSync(path.join(dir, 'credential.json'))) return null;
          const current = path.resolve(dir) === here;
          const live = current ? agent.status() : port
            ? await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(1200) })
              .then(r => r.json()).catch(() => null)
            : null;
          // The handle is right here — spending it on the origin is the whole
          // point of having asked that agent who it is. A stopped one never
          // answers, so its recorded handle stands in: the link has to be named
          // before you get there, or starting it lands you on the shared origin.
          const handle = live?.handle || rec.handle || null;
          const origin = port ? namedOrigin(handle, port) : null;
          // The fediverse address, assembled from the two things /status has:
          // the handle, and the pod host its actor URL sits on.
          let address = null;
          if (live?.handle && live?.actor) {
            try { address = `${live.handle}@${new URL(live.actor).host}`; } catch { /* not a URL yet */ }
          }
          return {
            name, port, current,
            admin: origin ? `${origin}/admin/` : null,
            app: origin ? `${origin}/` : null,
            handle,
            address,
            lastUsed: name === wasLast,
            kind: live?.kind || null,
            mode: live ? live.mode : null,
          };
        }));
        return json(res, 200, { identities: rows.filter(Boolean) });
      }
      if (req.method === 'GET' && p === '/blocks') return json(res, 200, agent.store.getBlocklist());
      if (req.method === 'GET' && p === '/log') return json(res, 200, { lines: agent.logLines(200) });
      if (req.method === 'GET' && p === '/deadletter') return json(res, 200, { items: agent.store.getDeadLetters() });
      if (req.method === 'GET' && p === '/tagfeed') {
        return json(res, 200, agent.tagfeed
          ? { ...agent.tagfeed.config(), lastSweep: agent.tagfeed.lastSweep, lastAdded: agent.tagfeed.lastAdded }
          : { error: 'agent not configured' });
      }
      // ---- setup and configuration, for the pages under /admin/ ----
      // These answer for a group too: a group is set up in the browser like
      // anything else, and it has a display name to change.
      if (req.method === 'GET' && p === '/setup/state') {
        const home = agent.home || null;
        const held = home && hasCredential(home) ? agent.readCredential?.() : null;
        return json(res, 200, {
          hasCredential: !!(home && hasCredential(home)),
          configured: agent.configured(),
          // Not the same question: a crashed setup leaves a credential with no
          // actor behind it, and that is finishable without minting a second.
          resumable: !!(home && hasCredential(home)) && !agent.configured(),
          running: setupRun?.phase === 'running',
          phase: setupRun?.phase || 'idle',
          home,
          port,
          handle: agent.store.getConfig()?.handle || allowed.label || null,
          kind: agent.store.getConfig()?.kind || null,
          origins: {
            loopback: publicOrigin || `http://localhost:${port}/`,
            named: publicOrigin
              ? null
              : allowed.label ? `http://${allowed.label}.localhost:${port}/` : null,
          },
          // Set in the environment, the password never needs to reach the page.
          passwordSupplied: !!process.env.AP_PASSWORD,
          identity: held ? { pod: held.remotePod, issuer: held.issuerOrigin, root: held.root || null } : null,
          defaults: { issuer: 'https://solidcommunity.net', port: 8030 },
        });
      }
      if (req.method === 'GET' && p === '/setup/progress') {
        return json(res, 200, setupRun || { phase: 'idle', steps: [], error: null, result: null });
      }
      if (req.method === 'GET' && p === '/config') {
        const cfg = agent.store.getConfig();
        if (!cfg) return json(res, 409, { error: 'agent not configured — set it up at /admin/setup/' });
        const urls = agent.urls || agent.publisher?.urls || null;
        const wfHost = urls ? new URL(urls.base).host : null;
        return json(res, 200, {
          // permanent
          handle: cfg.handle, remotePod: cfg.remotePod, issuer: cfg.issuer,
          root: cfg.root || null, kind: cfg.kind || 'person',
          actor: urls?.actor || null, webId: agent.readCredential?.()?.webId || null,
          // The opaque id the client addresses this actor by, so the record can
          // link straight at its profile there. Derived from the actor URL the
          // same way every other id is — computed here rather than in the page,
          // which has no business knowing how they are made.
          accountId: urls?.actor ? agent.store.idFor(urls.actor) : null,
          address: wfHost ? `@${cfg.handle}@${wfHost}` : null,
          // editable
          name: cfg.name || null, summary: cfg.summary || null, icon: cfg.icon || null,
          image: cfg.image || null, fields: cfg.fields || [],
          approveJoins: !!cfg.approveJoins, review: !!cfg.review,
          aliases: cfg.aliases || [],
          autoAcceptFollows: !!cfg.autoAcceptFollows,
          // never the record itself
          hasUiPassword: !!cfg.uiPassword,
          quiescedAt: cfg.quiescedAt || null, movedTo: cfg.movedTo || null,
          // Per-machine, so it comes from the credential file, not pod config —
          // and it is a fact here, not a setting: moving it means moving data,
          // which is `fedipod state --to <url>`.
          privateRoot: agent.readCredential?.()?.privateRoot || null,
          mode: agent.status?.().mode || null, port, home: tildify(agent.home) || null,
          // The connected Bluesky account, non-secret half. `connected` is the
          // credential's word, so a config entry orphaned by a deleted
          // atproto.json shows as disconnected rather than pretending.
          atproto: cfg.atproto
            ? { ...cfg.atproto, connected: !!agent.atproto?.connected() }
            : null,
          origins: {
            loopback: publicOrigin || `http://localhost:${port}/`,
            named: publicOrigin
              ? null
              : allowed.label ? `http://${allowed.label}.localhost:${port}/` : null,
          },
        });
      }
      // How far the CSV import has gotten — polled by the CLI while it runs.
      if (req.method === 'GET' && p === '/import') {
        if (!agent.importer) return json(res, 409, { error: 'agent not connected yet' });
        return json(res, 200, agent.importer.progress());
      }
      // Group-only: who is here, and what the group has carried. A group cannot
      // force an unfollow, so muting — declining to carry — is its whole lever.
      if (req.method === 'GET' && p === '/members') {
        if (!isGroup()) return json(res, 404, { error: 'not a group' });
        const muted = agent.store.getMuted().actors;
        return json(res, 200, {
          members: agent.store.getContacts().followers
            .map(f => ({
              actor: f.actor,
              handle: agent.store.handleOf(f.actor),
              inbox: f.sharedInbox || f.inbox,
              muted: muted.includes(f.actor),
            })),
        });
      }
      if (req.method === 'GET' && p === '/announced') {
        if (!isGroup()) return json(res, 404, { error: 'not a group' });
        return json(res, 200, {
          announced: agent.store.getStatuses().filter(s => s.announcedAt)
            .map(s => ({ noteId: s.noteId, actor: s.actor, announcedAt: s.announcedAt })),
        });
      }
      if (req.method === 'GET' && p === '/requests') {
        // Not group-only any more: a person queues unverifiable follows here
        // too, and a queue with no way to read it is worse than no queue.
        return json(res, 200, {
          approveJoins: !!agent.store.getConfig()?.approveJoins,
          requests: agent.store.getRequests().map(r => ({ actor: r.actor, at: r.at })),
        });
      }
      if (req.method === 'GET' && p === '/pending') {
        if (!isGroup()) return json(res, 404, { error: 'not a group' });
        return json(res, 200, {
          review: !!agent.store.getConfig()?.review,
          pending: agent.store.getPending(),
        });
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
      switch (p) {
        // Stop an agent whose pidfile is gone and which no terminal owns
        // (backgrounded, orphaned by a closed shell). It used to sit ABOVE both
        // the configured() gate and the isLocal one, so it was the only
        // state-changing route that needed neither — reachable from any host
        // AP_ALLOWED_HOSTS named, on an agent that had never been set up.
        case '/shutdown': {
          json(res, 200, { ok: true, stopping: process.pid });
          setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
          return;
        }
        // ---- setup, driven by the page at /admin/setup/ ----
        case '/setup/check': return json(res, 200, preflight(body));
        case '/setup': {
          // A visited page must not be able to navigate this into existence.
          if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
          if (agent.configured()) {
            return json(res, 409, {
              error: 'this home already holds an identity',
              pod: agent.store.getConfig()?.remotePod || null,
            });
          }
          if (setupRun?.phase === 'running') {
            return json(res, 409, { error: 'setup is already running', phase: 'running' });
          }
          const home = agent.home;
          if (!home) return json(res, 500, { error: 'this agent has no AP_HOME to set up' });
          // A crashed setup left a credential with no actor behind it. That is
          // finishable, and must NOT mint a second credential — the first is
          // unrecoverable and would be orphaned.
          const resuming = hasCredential(home);
          const answers = { ...body, password: body.password || process.env.AP_PASSWORD || '' };
          const bad = setupInputError(answers, resuming);
          if (bad) return json(res, 400, { error: bad });
          if (!resuming) {
            const pre = preflight(answers);
            if (!pre.ok) return json(res, 400, { ...pre, error: pre.error || pre.refusal });
          }
          // Widen the allowlist now, not at the end: the page offers to move to
          // the named origin, which has to answer before it is offered.
          allowed.setHandle(answers.handle);
          setupRun = newRun();
          // Deliberately not awaited. The credential a CSS server mints is
          // shown once, so what a run depends on is the file it writes, never
          // a connection a closed tab can take with it.
          runSetup({ home, agent, answers, run: setupRun, log })
            .catch(e => { setupRun.phase = 'error'; setupRun.error = e.message; });
          return json(res, 202, { ok: true, running: true, resuming });
        }
        // ---- the record, edited from the page at /admin/ ----
        case '/config': {
          const fixed = PERMANENT_CONFIG.filter(k => k in body);
          if (fixed.length) {
            return json(res, 400, {
              error: `${fixed.join(', ')} cannot be changed — that is the identity itself, not a setting`,
            });
          }
          for (const k of ['approveJoins', 'review']) {
            if (k in body && !isGroup()) return json(res, 404, { error: 'not a group' });
          }
          // A user acting here outranks an idle active agent on another device:
          // claim the lease rather than write state that one will clobber.
          await agent.requestTakeover?.();
          // Merge, never replace: the UI password and anything else set later
          // must survive an edit that never mentions it.
          const cfg = { ...agent.store.getConfig() };
          if ('name' in body) {
            if (!body.name) return json(res, 400, { error: 'a display name is required' });
            cfg.name = String(body.name);
          }
          if ('summary' in body) cfg.summary = body.summary || undefined;
          if ('icon' in body) cfg.icon = body.icon || undefined;
          // The banner and the labelled rows, so a client and this page edit one
          // record rather than each other's leftovers.
          if ('image' in body) cfg.image = body.image || undefined;
          if ('fields' in body) {
            cfg.fields = (Array.isArray(body.fields) ? body.fields : [])
              .filter(f => f?.name?.trim())
              .map(f => ({ name: String(f.name).trim(), value: String(f.value ?? '').trim() }));
          }
          if ('approveJoins' in body) cfg.approveJoins = !!body.approveJoins;
          if ('review' in body) cfg.review = !!body.review;
          // A person's queue gate: on, and an inbound Follow is accepted on
          // arrival instead of waiting in the requests queue. Local behavior,
          // not on the wire — but intake reads the LIVE config, so it is
          // patched below whether or not anything republishes.
          if ('autoAcceptFollows' in body) cfg.autoAcceptFollows = !!body.autoAcceptFollows;
          // The moderator roster (FEP-1b12): actor IRIs whose federated
          // moderation asks are queued, published as attributedTo.
          let rosterDiff = null;
          if ('moderators' in body) {
            if (!isGroup()) return json(res, 404, { error: 'not a group' });
            const next = [...new Set((Array.isArray(body.moderators) ? body.moderators : [])
              .map(String).filter(m => /^https?:\/\/\S+$/.test(m)))];
            const prev = cfg.moderators || [];
            rosterDiff = {
              added: next.filter(m => !prev.includes(m)),
              removed: prev.filter(m => !next.includes(m)),
            };
            cfg.moderators = next;
          }
          if ('password' in body) {
            // '' clears it. The UI password is what turns the instant OAuth
            // redirect into a login form; switching that off is a real choice.
            if (body.password) cfg.uiPassword = hashPassword(body.password);
            else delete cfg.uiPassword;
          }
          const republish = WIRE_CONFIG.some(k => k in body);
          agent.store.setConfig(cfg);
          if ('autoAcceptFollows' in body && agent.publisher) {
            agent.publisher.config.autoAcceptFollows = cfg.autoAcceptFollows;
          }
          if (republish && agent.publisher) {
            Object.assign(agent.publisher.config, {
              name: cfg.name, summary: cfg.summary, icon: cfg.icon,
              image: cfg.image, fields: cfg.fields,
              approveJoins: !!cfg.approveJoins,
              moderators: cfg.moderators,
              aliases: cfg.aliases,
            });
          }
          await agent.store.flush();
          // Publishing is only half of it: publishProfile re-fetches the public
          // documents unauthenticated and reports the ones a stranger's server
          // could not read. Carrying that back is what lets this be the only
          // republish control there is.
          const pub = republish ? await agent.publisher.publishProfile() : null;
          // Roster changes are announced to the membership (FEP-1b12), so
          // their servers can mirror who moderates here.
          if (rosterDiff && agent.publisher) {
            const urls = agent.publisher.urls;
            for (const [type, list] of [['Add', rosterDiff.added], ['Remove', rosterDiff.removed]]) {
              for (const m of list) {
                await announceModeration(agent, addRemoveActivity({
                  urls, type, object: m, target: urls.moderators, serial: Date.now(),
                })).catch(e => log(`moderation announce failed: ${e.message}`));
              }
            }
          }
          return json(res, 200, {
            ok: true, published: republish,
            ...(pub?.unreachable?.length ? { unreachable: pub.unreachable } : {}),
            config: {
              name: cfg.name || null, summary: cfg.summary || null, icon: cfg.icon || null,
          image: cfg.image || null, fields: cfg.fields || [],
              approveJoins: !!cfg.approveJoins, review: !!cfg.review,
              autoAcceptFollows: !!cfg.autoAcceptFollows,
              ...(isGroup() ? { moderators: cfg.moderators || [] } : {}),
              hasUiPassword: !!cfg.uiPassword,
            },
          });
        }
        // Both of these DELETE from the pod's inbox, which is the one thing the
        // lease exists to keep to a single agent. A viewer must claim it first
        // and give up if it cannot — the facade has refused viewer writes since
        // multi-device landed, and these two were simply missed.
        case '/drain': {
          if (!await agent.requestTakeover?.()) {
            return json(res, 503, { error: 'another agent is active for this pod — it is doing the draining' });
          }
          await agent.intake.drain();
          return json(res, 200, agent.status());
        }
        // The owner's answer to "your inbox is very full". Never automatic:
        // discarding someone's mail is their call, not the agent's.
        case '/inbox/prune': {
          if (!body.before) return json(res, 400, { error: 'before (a date) required' });
          if (!await agent.requestTakeover?.()) {
            return json(res, 503, { error: 'another agent is active for this pod — discard from that one' });
          }
          return json(res, 200, await agent.intake.prune({
            before: body.before,
            ...(body.sizeThreshold ? { sizeThreshold: Number(body.sizeThreshold) } : {}),
            ...(body.keepConcerning ? { keepConcerning: true } : {}),
          }));
        }
        // Put back the posts a lost or restored machine no longer knows about,
        // from what the pod still serves. It writes the statuses store, which is
        // the lease's business, so it refuses the same way the drain does.
        case '/rebuild': {
          if (!await agent.requestTakeover?.()) {
            return json(res, 503, { error: 'another agent is active for this pod — rebuild from that one' });
          }
          return json(res, 200, await agent.publisher.rebuildStatuses({ fromNotes: !!body.fromNotes }));
        }
        // One identity per home, so a new actor means a new home, a free port
        // and a process there — then its own setup, run with the answers this
        // page collected. The reply is the address of the new actor's page,
        // which is where the progress of that setup is reported.
        case '/new-actor': {
          if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
          const handle = String(body.handle || '').trim().toLowerCase();
          // The name first, and before anything is created: it is what becomes
          // a directory, and "mode must be new or existing" is a poor answer to
          // a handle that could climb out of profiles/.
          // Named after the handle rather than generated, so `profiles` and
          // `--profile <name>` stay legible a year from now.
          if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(handle)) {
            return json(res, 400, { error: 'a handle is letters, digits, hyphens and underscores' });
          }
          const dir = path.join(rootOf(path.resolve(agent.home || '')), 'profiles', handle);
          if (fs.existsSync(path.join(dir, 'credential.json'))) {
            return json(res, 409, { error: `${handle} already exists — it is in the list above` });
          }
          // Then everything else setup needs, so a missing password is refused
          // here rather than after a process has been started for it.
          const bad = setupInputError({ ...body, handle });
          if (bad) return json(res, 400, { error: bad });
          const newPort = await freePortFrom(port + 1);
          if (!newPort) return json(res, 503, { error: 'no free port in the next 50' });
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const child = spawn(process.execPath, [path.join(projectRoot, 'run-agent.mjs')], {
            detached: true, stdio: 'ignore',
            env: { ...process.env, AP_HOME: dir, AP_PORT: String(newPort), AP_PROFILE: '' },
          });
          child.unref();
          // Answer only once it is listening: handing back a URL that is not
          // up yet shows a connection error instead of the setup form.
          let listening = false;
          for (let i = 0; i < 60 && !listening; i++) {
            await new Promise(r => setTimeout(r, 250));
            listening = await fetch(`http://localhost:${newPort}/status`, { signal: AbortSignal.timeout(1000) })
              .then(r => r.ok).catch(() => false);
          }
          if (!listening) return json(res, 504, { error: `started it on ${newPort} but it never answered` });

          // Its own /setup owns the work — minting the credential, provisioning
          // the pod, publishing. It answers 202 and runs in the background, so
          // the page that opens next is the one reporting progress.
          const started = await fetch(`http://localhost:${newPort}/setup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, handle }),
          }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))
            .catch(e => ({ status: 0, json: { error: e.message } }));
          if (started.status !== 202) {
            return json(res, started.status || 502, {
              error: started.json?.error || `the new agent refused setup (HTTP ${started.status})`,
              port: newPort, url: `${namedOrigin(handle, newPort)}${SETUP_PAGE}`,
            });
          }
          return json(res, 200,
            { ok: true, handle, port: newPort, url: `${namedOrigin(handle, newPort)}${SETUP_PAGE}` });
        }
        // Start an actor that is not running, so its page can be visited. The
        // same spawn as /new-actor, minus the making: this one has a home
        // already. Its recorded port is preferred so its address stays what it
        // was, but a port something else has taken is walked past, not fought.
        case '/start-actor': {
          if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
          const name = String(body.name || '');
          const found = identityHomes(rootOf(path.resolve(agent.home || ''))).find(h => h.name === name);
          if (!found) return json(res, 404, { error: `no identity called ${name}` });

          let want = null;
          try { want = JSON.parse(fs.readFileSync(path.join(found.dir, 'agent.json'), 'utf8')).port || null; } catch {}
          if (want) {
            // Its own handle, not the profile directory's name: usually the
            // same, but a renamed profile makes them differ and the origin has
            // to be one that agent's own guard will accept.
            const live = await fetch(`http://localhost:${want}/status`, { signal: AbortSignal.timeout(1000) })
              .then(r => (r.ok ? r.json() : null)).catch(() => null);
            if (live) {
              return json(res, 200, {
                ok: true, name, port: want, already: true,
                url: `${namedOrigin(live.handle || name, want)}/`,
              });
            }
          }
          // The port is not the only evidence it is running. An agent from
          // before agent.json was written at startup has a live pidfile and no
          // recorded port, and spawning past that gives one home two agents —
          // which is exactly how this machine ended up with two on profiles/jeff.
          let held = null;
          try { held = Number(fs.readFileSync(path.join(found.dir, 'agent.pid'), 'utf8').trim()) || null; } catch {}
          if (held) {
            let alive = false;
            try { process.kill(held, 0); alive = true; } catch { /* gone */ }
            if (alive) {
              return json(res, 409, {
                error: `${name} is already running as pid ${held}, on a port it never recorded. `
                  + `Stop it first:  kill ${held}`,
              });
            }
          }
          // A recorded port held by the directory door is still this
          // identity's port — the door steps aside for its owner.
          if (want && !await portFree(want)) await yieldDirectory(want, { portFree });
          const on = (want && await portFree(want)) ? want : await freePortFrom(port + 1);
          if (!on) return json(res, 503, { error: 'no free port in the next 50' });

          const started = spawn(process.execPath, [path.join(projectRoot, 'run-agent.mjs')], {
            detached: true, stdio: 'ignore',
            env: { ...process.env, AP_HOME: found.dir, AP_PORT: String(on), AP_PROFILE: '' },
          });
          started.unref();
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 250));
            const up = await fetch(`http://localhost:${on}/status`, { signal: AbortSignal.timeout(1000) })
              .then(r => (r.ok ? r.json() : null)).catch(() => null);
            if (up) return json(res, 200, { ok: true, name, port: on, url: `${namedOrigin(up.handle || name, on)}/` });
          }
          return json(res, 504, { error: `started ${name} on ${on} but it never answered` });
        }
        case '/publish-profile': {
          // The explicit "republish now" control. Asking for it IS the reason.
          const r = await agent.publisher.publishProfile({ force: true });
          return json(res, 200, { ok: true, ...(r?.unreachable?.length ? { unreachable: r.unreachable } : {}) });
        }
        // ---- lifecycle: what the CLI calls park | revive | rotate-key | retire ----
        // Each claims the lease first, for the same reason /config does: someone
        // acting on this page outranks an idle active agent on another device.
        // Asking first is the page's job — see the warnings in its markup.
        case '/park': {
          await agent.requestTakeover?.();
          return json(res, 200, { ok: true, ...await agent.park() });
        }
        case '/revive': {
          await agent.requestTakeover?.();
          return json(res, 200, { ok: true, ...await agent.revive() });
        }
        case '/rotate-key': {
          await agent.requestTakeover?.();
          const r = await agent.rotateKey();
          return json(res, 200, { ok: true, changed: !!r?.changed });
        }
        // Hand the identity on. Federated and effectively one-way: the Move
        // tells every follower's server to migrate them, and the actor is left
        // advertising movedTo so the old handle redirects. Same typed-handle
        // interlock as retire — a stray click cannot produce it.
        case '/move': {
          if (!body.target) return json(res, 400, { error: 'target required' });
          if (!body.confirm || body.confirm !== agent.store.getConfig()?.handle) {
            return json(res, 400, { error: 'type the handle to confirm' });
          }
          await agent.requestTakeover?.();
          // A handle is not an actor URI, and the Move's target has to be one or
          // the far side has nothing to migrate anyone to. The CLI resolves it
          // the same way; doing it here rather than in the page keeps the one
          // WebFinger lookup on the side that already knows how.
          let target = String(body.target).trim();
          if (!/^https?:\/\//.test(target)) {
            const doc = await resolveHandle(agent, target);
            if (!doc?.id) return json(res, 400, { error: `could not resolve ${target}` });
            target = doc.id;
          }
          return json(res, 200, { ok: true, ...await agent.moveTo(target) });
        }
        // The inbound half of a migration: list an old account elsewhere in
        // this actor's alsoKnownAs, which is what the old server checks for
        // before it will send a Move here. Whatever is entered is resolved to
        // the account's canonical id — the check on the far side is an exact
        // string match, so a pasted profile URL stored as typed would fail it.
        case '/alias': {
          const urls = agent.publisher?.urls;
          if (!urls) return json(res, 409, { error: 'agent not connected yet' });
          if (!body.add && !body.remove) return json(res, 400, { error: 'add or remove required' });
          await agent.requestTakeover?.();
          const cfg = { ...agent.store.getConfig() };
          const aliases = [...(cfg.aliases || [])];
          if (body.add) {
            // A Move target nobody can resolve is a landing pad nobody lands on.
            if (!webfingerHost(urls.base) && !cfg.gateway?.frontActor) {
              return json(res, 400, {
                error: 'this pod is a path on a shared host, so WebFinger cannot answer for it '
                  + '— other servers could never resolve this account as a Move target',
              });
            }
            const input = String(body.add).trim().replace(/^@/, '');
            let doc = /^https?:\/\//.test(input)
              ? await agent.intake.fetchAP(input).catch(() => null)
              : await resolveHandle(agent, input).catch(() => null);
            // A URL may answer with any id it likes; before that id is stored
            // it must vouch for itself — the intake's verify-by-deref.
            if (doc?.id && /^https?:\/\//.test(input) && doc.id !== input) {
              const own = await agent.intake.fetchAP(doc.id).catch(() => null);
              doc = own?.id === doc.id ? own : null;
            }
            if (!doc?.id) {
              return json(res, 400, { error: `could not fetch the old account (${input}) — it must exist and answer` });
            }
            if (doc.id === urls.actor) return json(res, 400, { error: 'that is this account' });
            if (!aliases.includes(doc.id)) aliases.push(doc.id);
          } else {
            const target = String(body.remove).trim();
            if (!aliases.includes(target)) return json(res, 404, { error: 'no such alias' });
            // Follower servers process a Move on their own retry schedules,
            // over days — an alias removed early strands the late ones.
            if (!body.confirm) {
              return json(res, 409, {
                error: 'servers still retrying the Move check this alias and would strand '
                  + 'their followers — send confirm: true to remove it anyway',
              });
            }
            aliases.splice(aliases.indexOf(target), 1);
          }
          cfg.aliases = aliases;
          agent.store.setConfig(cfg);
          agent.publisher.config.aliases = aliases;
          await agent.store.flush();
          const pub = await agent.publisher.publishProfile();
          return json(res, 200, {
            ok: true, aliases,
            ...(pub?.unreachable?.length ? { unreachable: pub.unreachable } : {}),
          });
        }
        // Stage a CSV export from the old account. Rows are applied by the
        // agent's paced worker, not in this request — big lists take a while,
        // and GET /import is the window onto how far it has gotten.
        case '/import': {
          if (!agent.importer) return json(res, 409, { error: 'agent not connected yet' });
          // Unlike the one-shot routes, staging arms a worker that keeps
          // writing for minutes — a device that could not take the lease must
          // not run one alongside the device that holds it.
          const took = await agent.requestTakeover?.();
          if (took === false) {
            return json(res, 503, { error: 'another device is active for this pod — import from there' });
          }
          if (body.clear === true) {
            agent.importer.clear();
            return json(res, 200, { ok: true, cleared: true });
          }
          if (!IMPORT_KINDS.includes(body.kind)) {
            return json(res, 400, { error: `kind must be one of: ${IMPORT_KINDS.join(', ')}` });
          }
          if (typeof body.text !== 'string' || !body.text.trim()) {
            return json(res, 400, { error: 'text required — the CSV file contents' });
          }
          const { values, invalid } = normalizeImport(body.kind, body.text);
          const r = agent.importer.stage(body.kind, values);
          await agent.store.flush();
          return json(res, 200, {
            ok: true, kind: body.kind, ...r,
            invalid: invalid.length,
            ...(invalid.length ? { invalidSample: invalid.slice(0, 5) } : {}),
          });
        }
        // Move the private half — every state document and the RDF tree — while
        // the agent runs: quiesce this process's writers, flush, copy, verify,
        // repoint the credential, then reconnect on the new location. The old
        // copy is left where it was, exactly as the CLI move leaves it.
        case '/state-move': {
          const cred = agent.readCredential?.();
          if (!cred) return json(res, 409, { error: 'no credential — run setup first' });
          const to = String(body.to || '').trim();
          if (!to) return json(res, 400, { error: 'say where it should go' });
          let target = null;
          if (to !== 'pod') {
            // A path or a URL — two chars before the colon, so a Windows drive
            // letter reads as a path rather than a scheme.
            const asPath = !/^[a-z][a-z0-9+.-]+:/i.test(to);
            const raw = asPath
              ? pathToFileURL(path.resolve(to.replace(/^~(?=[/\\]|$)/, os.homedir()))).href
              : to;
            target = raw.endsWith('/') ? raw : raw + '/';
            try { new URL(target); } catch { return json(res, 400, { error: `"${to}" is not a container URL or a path` }); }
            if (/^https?:/i.test(target)) {
              const bad = insecureUrlReason(target, 'private-data address');
              if (bad) return json(res, 400, { error: bad });
            }
          }
          const whereState = (c) => (c.privateRoot ? tildify(c.privateRoot) : 'on the pod');
          if ((cred.privateRoot || null) === target) {
            return json(res, 200, { ok: true, docs: 0, notes: 0, unchanged: true, now: whereState(cred) });
          }
          await agent.requestTakeover?.();
          agent.intake?.stop(); agent.deliverer?.stop(); agent.tagfeed?.stop(); agent.importer?.stop();
          try {
            await agent.store.flush();
            const destCred = { ...cred, privateRoot: target };
            const copied = await copyPrivateHalf({
              from: { state: agent.privateStorage(cred, 'state'), fediverse: agent.privateStorage(cred, 'fediverse') },
              to: { state: agent.privateStorage(destCred, 'state'), fediverse: agent.privateStorage(destCred, 'fediverse') },
              log,
            });
            if (target) cred.privateRoot = target; else delete cred.privateRoot;
            if (isCurrent(cred)) cred.layout = CURRENT_LAYOUT; else delete cred.layout;
            writeJsonAtomic(path.join(agent.home, 'credential.json'), cred);
            // connect() rebuilds everything that pointed at the old location —
            // store, RDF tree, publisher, intake — and restarts them.
            agent.store.attach(agent.privateStorage(cred, 'state'));
            agent.stateLoaded = false;
            await agent.connect();
            return json(res, 200, { ok: true, ...copied, now: whereState(cred) });
          } catch (e) {
            // The credential is only repointed after a verified copy, so on any
            // failure reconnect puts the agent back to work where it was.
            agent.stateLoaded = false;
            await agent.connect().catch(() => {});
            return json(res, 502, { error: e.message });
          }
        }
        case '/retire': {
          // Irreversible and federated: a Delete leaves for every follower and
          // the actor becomes a Tombstone. The typed handle is the interlock —
          // a stray click cannot produce it, and nor can anything that never
          // read the record.
          if (!body.confirm || body.confirm !== agent.store.getConfig()?.handle) {
            return json(res, 400, { error: 'type the handle to confirm' });
          }
          await agent.requestTakeover?.();
          return json(res, 200, { ok: true, ...await agent.publisher.retireActor() });
        }
        case '/post': {
          if (!body.content) return json(res, 400, { error: 'content required' });
          const note = await agent.publisher.publishNote(body.content, { inReplyTo: body.inReplyTo });
          return json(res, 200, { ok: true, id: note.id });
        }
        case '/tagfeed': return json(res, 200, agent.tagfeed.setConfig(body));
        case '/atproto/connect': {
          // The one endpoint that ever sees the app password; loopback-only.
          if (!body.identifier || !body.appPassword) {
            return json(res, 400, { error: 'identifier and appPassword required' });
          }
          const conn = await agent.atproto.connect({
            service: body.service, identifier: body.identifier, appPassword: body.appPassword,
          });
          const cfg = agent.store.getConfig();
          agent.store.setConfig({
            ...cfg,
            atproto: { ...conn, crossPost: cfg.atproto?.crossPost ?? true },
          });
          await agent.store.flush();
          agent.startBsky?.();
          return json(res, 200, { ok: true, ...agent.atproto.status() });
        }
        case '/atproto/disconnect': {
          agent.stopBsky?.();
          await agent.atproto.disconnect();
          const { atproto, ...rest } = agent.store.getConfig();
          agent.store.setConfig(rest);
          await agent.store.flush();
          return json(res, 200, { ok: true });
        }
        case '/atproto': {
          // Non-secret settings only — today that is the cross-post toggle.
          const cfg = agent.store.getConfig();
          if (!cfg.atproto) return json(res, 400, { error: 'no bluesky account connected' });
          agent.store.setConfig({
            ...cfg, atproto: { ...cfg.atproto, crossPost: !!body.crossPost },
          });
          await agent.store.flush();
          return json(res, 200, { ok: true, atproto: { ...cfg.atproto, crossPost: !!body.crossPost } });
        }
        case '/archive': {
          // Whether drained mail's original bytes are kept in the private
          // half's inbox-archive/. Absent means on.
          const cfg = agent.store.getConfig();
          agent.store.setConfig({ ...cfg, archiveInbox: !!body.on });
          await agent.store.flush();
          return json(res, 200, { ok: true, archiveInbox: !!body.on });
        }
        case '/follow': {
          // By handle normally; by actor URL when there is no handle to resolve —
          // a pod on a path, or anything WebFinger cannot answer for. Pasting an
          // actor URL is a normal way to follow in Mastodon too.
          if (body.actor) { await followActor(agent, body.actor); return json(res, 200, { ok: true, actor: body.actor }); }
          if (!body.handle) return json(res, 400, { error: 'handle or actor required' });
          return json(res, 200, await followHandle(agent, body.handle));
        }
        case '/unfollow': return json(res, 200, await unfollowActor(agent, body.actor));
        case '/mute':
        case '/unmute': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          if (!body.actor) return json(res, 400, { error: 'actor required' });
          const m = agent.store.getMuted();
          m.actors = p === '/mute'
            ? [...new Set([...m.actors, body.actor])]
            : m.actors.filter(a => a !== body.actor);
          agent.store.setMuted(m);
          await agent.store.flush();
          return json(res, 200, { ok: true, actors: m.actors });
        }
        case '/eject': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          if (!body.actor) return json(res, 400, { error: 'actor required' });
          const r = await ejectFollower(agent, body.actor);
          await agent.store.flush();
          return json(res, 200, r);
        }
        case '/retract': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          if (!body.noteId) return json(res, 400, { error: 'noteId required' });
          const r = await retractAnnouncement(agent, body.noteId);
          await agent.store.flush();
          return json(res, 200, r);
        }
        case '/review': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          agent.store.setConfig({ ...agent.store.getConfig(), review: !!body.on });
          await agent.store.flush();
          return json(res, 200, { ok: true, review: !!body.on });
        }
        case '/describe': {
          const cfg = { ...agent.store.getConfig() };
          if ('summary' in body) cfg.summary = body.summary || undefined;
          if ('icon' in body) cfg.icon = body.icon || undefined;
          agent.store.setConfig(cfg);
          Object.assign(agent.publisher.config, { summary: cfg.summary, icon: cfg.icon });
          await agent.store.flush();
          await agent.publisher.publishProfile();      // the bio and avatar are on the wire
          return json(res, 200, { ok: true, summary: cfg.summary || null, icon: cfg.icon || null });
        }
        case '/joins': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          const cfg = { ...agent.store.getConfig(), approveJoins: !!body.approve };
          agent.store.setConfig(cfg);
          agent.publisher.config.approveJoins = !!body.approve;
          await agent.store.flush();
          // Unlike review, this one is visible to the fediverse: the actor
          // document carries manuallyApprovesFollowers, so nothing changes for
          // anyone until it is republished.
          await agent.publisher.publishProfile();
          return json(res, 200, { ok: true, approveJoins: !!body.approve });
        }
        case '/admit':
        case '/refuse': {
          // Kind-agnostic, like the queue they act on: admitting adds a
          // follower and Accepts, refusing Rejects. A person needs both.
          // `all` answers the whole queue — the shape a migration wave arrives
          // in — with one collections republish for the lot.
          if (p === '/admit' && body.all === true) {
            const waiting = agent.store.getRequests().map(r => r.actor);
            let admitted = 0;
            for (const actor of waiting) {
              try { await admitRequest(agent, actor, { publish: false }); admitted++; }
              catch (e) { log(`admit ${actor} failed: ${e.message}`); }
            }
            if (admitted) await agent.publisher.publishCollections({ followers: true, pending: true });
            await agent.store.flush();
            return json(res, 200, { ok: true, admitted, requests: agent.store.getRequests().length });
          }
          if (!body.actor) return json(res, 400, { error: 'actor required' });
          const r = p === '/admit' ? await admitRequest(agent, body.actor)
            : await refuseRequest(agent, body.actor);
          await agent.store.flush();
          return json(res, 200, { ...r, requests: agent.store.getRequests().length });
        }
        case '/approve':
        case '/decline': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          if (!body.noteId) return json(res, 400, { error: 'noteId required' });
          const held = agent.store.getPending().some(x => x.noteId === body.noteId);
          if (!held) return json(res, 404, { error: 'not held for review' });
          if (p === '/approve') await agent.intake.amplify(body.noteId, { approved: true });
          else agent.store.setPending(agent.store.getPending().filter(x => x.noteId !== body.noteId));
          await agent.store.flush();
          return json(res, 200, { ok: true, noteId: body.noteId, pending: agent.store.getPending().length });
        }
        // Answer one queued moderation ask: apply it (the operator vouching
        // for a delivery nothing else can vouch for) or dismiss it.
        case '/modqueue': {
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
          const q = agent.store.read('modqueue.json', []);
          const entry = q.find(e => e.id === body.id);
          if (!entry) return json(res, 404, { error: 'no such queued action' });
          if (body.action !== 'apply' && body.action !== 'dismiss') {
            return json(res, 400, { error: 'action must be apply or dismiss' });
          }
          let applied = null;
          if (body.action === 'apply') applied = await applyModeration(agent, entry);
          agent.store.write('modqueue.json', q.filter(e => e.id !== entry.id));
          await agent.store.flush();
          return json(res, 200, {
            ok: true, action: body.action, type: entry.type, moderator: entry.moderator,
            ...(applied && typeof applied === 'object' ? { result: applied } : {}),
            remaining: agent.store.read('modqueue.json', []).length,
          });
        }
        // The inbox gateway lifecycle (opt-in). `configure` points at a
        // deployed gateway (and reveals the HMAC secret once, to paste into
        // its env); `mode` walks off→shadow→trust→locked and back, each step
        // reversible; `forget` clears it and restores the pod inbox.
        case '/gateway': {
          const cfg = { ...agent.store.getConfig() };
          const g = { ...(cfg.gateway || {}) };
          const inboxUrl = agent.publisher?.urls?.inbox;
          await agent.requestTakeover?.();
          const persist = async () => {
            cfg.gateway = g; agent.store.setConfig(cfg);
            if (agent.publisher) agent.publisher.config.gateway = g;
            await agent.store.flush();
          };
          if (body.action === 'configure') {
            if (!/^https:\/\/\S+$/.test(String(body.url || ''))) return json(res, 400, { error: 'gateway url must be https' });
            if (!/^https?:\/\/\S+$/.test(String(body.webId || ''))) return json(res, 400, { error: 'gateway webId must be a URL' });
            g.url = String(body.url); g.webId = String(body.webId);
            g.hmacSecret = g.hmacSecret || crypto.randomBytes(32).toString('base64');
            g.mode = g.mode || 'off';
            // The fronted actor URL, for a multi-user front that gives this
            // identity a @name@front handle: the agent then publishes and signs
            // under it. Optional; setting it on a published identity renames
            // every id (a Move), so it belongs at setup or a fresh identity.
            if ('frontActor' in body) {
              const fa = String(body.frontActor || '');
              if (fa && !/^https:\/\/\S+\/ap\/actor$/.test(fa)) {
                return json(res, 400, { error: 'frontActor must be an https …/ap/actor URL' });
              }
              g.frontActor = fa || undefined;
            }
            await persist();
            // The one time the secret is returned: the operator pastes it into
            // the gateway's deploy env. /gateway GET never reveals it again.
            return json(res, 200, { ok: true, mode: g.mode, url: g.url, webId: g.webId, hmacSecret: g.hmacSecret });
          }
          if (body.action === 'mode') {
            const target = body.mode;
            if (!['off', 'shadow', 'trust', 'locked'].includes(target)) {
              return json(res, 400, { error: 'mode must be off, shadow, trust or locked' });
            }
            if (target !== 'off' && !g.url) return json(res, 400, { error: 'point at a gateway first (action: configure)' });
            const prev = g.mode || 'off';
            g.mode = target;
            await persist();
            // Advertisement flips only when crossing the off boundary (the actor
            // doc's inbox changes → publishProfile republishes, digest-gated).
            if ((prev === 'off') !== (target === 'off')) await agent.publisher?.publishProfile();
            else if (target !== 'off') await agent.publisher?.publishGatewayPolicy().catch(() => {});
            // The ACL: lock on entering `locked`, restore public-Append on leaving it.
            if (target === 'locked') await agent.publisher?.lockInboxToGateway(g.webId);
            else if (prev === 'locked' && inboxUrl) await agent.remote.setAcl(inboxUrl, ['Append']);
            return json(res, 200, { ok: true, mode: g.mode });
          }
          if (body.action === 'forget') {
            const wasLocked = g.mode === 'locked';
            delete cfg.gateway; agent.store.setConfig(cfg);
            if (agent.publisher) agent.publisher.config.gateway = undefined;
            await agent.store.flush();
            if (wasLocked && inboxUrl) await agent.remote.setAcl(inboxUrl, ['Append']).catch(() => {});
            await agent.publisher?.publishProfile();   // re-advertise the pod inbox
            return json(res, 200, { ok: true, mode: 'off', forgotten: true });
          }
          return json(res, 400, { error: 'action must be configure, mode or forget' });
        }
        // Symmetrical with /block, and open for the same reason: a block made
        // by mistake is worth undoing before federation is even configured.
        case '/unblock': {
          const b = agent.store.getBlocklist();
          const before = b.domains.length + b.actors.length;
          if (body.actor) b.actors = b.actors.filter(a => a !== body.actor);
          else if (body.domain) b.domains = b.domains.filter(d => d !== body.domain);
          else return json(res, 400, { error: 'domain or actor required' });
          agent.store.setBlocklist(b);
          // The published blocked collection (FEP-c648) follows, best-effort.
          Promise.resolve(agent.publisher?.publishCollections?.({ blocked: true })).catch(() => {});
          return json(res, 200, {
            ok: true, removed: before - (b.domains.length + b.actors.length),
            domains: b.domains, actors: b.actors,
          });
        }
        case '/block': {
          const b = agent.store.getBlocklist();
          if (body.actor) {
            if (!/^https?:\/\/\S+$/.test(body.actor)) return json(res, 400, { error: 'actor must be a URL' });
            if (!b.actors.includes(body.actor)) b.actors.push(body.actor);
          } else if (body.domain) {
            if (!b.domains.includes(body.domain)) b.domains.push(body.domain);
          } else {
            return json(res, 400, { error: 'domain or actor required' });
          }
          agent.store.setBlocklist(b);
          // The published blocked collection (FEP-c648) follows, best-effort.
          Promise.resolve(agent.publisher?.publishCollections?.({ blocked: true })).catch(() => {});
          return json(res, 200, { ok: true, domains: b.domains, actors: b.actors });
        }
        default: return json(res, 404, { error: 'unknown endpoint' });
      }
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

export function startAdmin({ port, gateToken, agent, log = console.log, handle = null,
  httpsPort = null, tls = null }) {
  const gate = makeGate(gateToken);
  // Live, so the named origin appears the moment connect() reads the handle
  // out of pod state — including for the OAuth redirect check in MastoApi.
  // The https listener's port joins the authority set: same names, second port.
  const allowed = new Authorities(port, handle, tls && httpsPort ? [httpsPort] : []);
  agent.authorities = allowed;
  const { handler, streaming } = buildAdminSurface({ agent, gate, allowed, log, port, handle });

  // Loopback both ways: the canonical URL is http://localhost:<port>/, and
  // "localhost" resolves to ::1 on many systems before falling back to IPv4 —
  // answer on both so the same origin always works (one origin = one
  // browser storage = one login).
  const server = http.createServer(handler);
  streaming.attach(server);
  const server6 = http.createServer(handler);
  streaming.attach(server6);
  server6.on('error', () => { /* no IPv6 loopback on this system — IPv4 covers it */ });
  const onListen = () => {
    // Pidfile for `fedipod stop` — written only AFTER the listen
    // succeeds, so a port-race loser can never clobber the live agent's pid.
    try {
      if (agent.home) fs.writeFileSync(path.join(agent.home, 'agent.pid'), String(process.pid) + '\n');
    } catch { /* stop will report no pidfile */ }
    // The named origin when there is one: on a detached start this line is the
    // only record of where to browse, and sending you to the shared origin is
    // how two identities end up in one browser storage bucket.
    log(`FediPod on ${namedOrigin(allowed.label, port)}/ (UI + API)`);
    // Hold the well-known door: whoever answers on 8030 sends the browser to
    // its own record page, which lists every identity on this machine.
    const door = claimDirectory({ port, origin: () => namedOrigin(allowed.label, port), log });
    server.on('close', () => door.stop());
  };
  let retriedDoor = false;
  server.on('error', async (e) => {
    if (e.code === 'EADDRINUSE') {
      // The directory door yields to a real owner of its port; anything else
      // holding it is a genuine conflict.
      if (!retriedDoor && await yieldDirectory(port, { portFree })) {
        retriedDoor = true;
        server.listen(port, '127.0.0.1', onListen);
        if (!server6.listening) server6.listen(port, '::1');
        return;
      }
      log(`port ${port} is already in use by another server — set AP_PORT to a free port and retry`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, '127.0.0.1', onListen);
  server6.listen(port, '::1');

  // The https listeners: the same handler and streaming behind a per-machine
  // certificate, for the clients that refuse cleartext. http stays the
  // canonical origin; a failure here degrades to http-only, never exits.
  if (tls && httpsPort) {
    const tlsOpts = { key: tls.key, cert: tls.cert };
    const httpsServer = https.createServer(tlsOpts, handler);
    streaming.attach(httpsServer);
    const httpsServer6 = https.createServer(tlsOpts, handler);
    streaming.attach(httpsServer6);
    httpsServer6.on('error', () => { /* no IPv6 loopback — IPv4 covers it */ });
    httpsServer.on('error', (e) => {
      log(`https listener on :${httpsPort} failed (${e.code || e.message}) — continuing on http only`);
    });
    httpsServer.on('listening', () => {
      log(`FediPod https on ${namedOrigin(allowed.label, httpsPort).replace('http://', 'https://')}/`
        + (tls.trust ? '' : ' (self-signed — your client may ask once to trust it)'));
    });
    httpsServer.listen(httpsPort, '127.0.0.1');
    httpsServer6.listen(httpsPort, '::1');
    server.on('close', () => { httpsServer.close(); httpsServer6.close(); });
  }
  return server;
}
