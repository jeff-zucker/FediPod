// admin.mjs — loopback HTTP front: admin API + Mastodon client-API facade +
// the bundled Phanpy UI served same-origin (no CORS, no mixed content — the
// role data-kitchen's router plays for the in-app pane). Loopback-bound; the
// gate (vendor/gate.cjs) engages only when a token is configured, exactly
// its standalone behavior.

import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { followHandle, followActor, unfollowActor, ejectFollower, retractAnnouncement,
  admitRequest, refuseRequest } from './social.mjs';
import { MastoApi } from './mastoapi.mjs';
import { Streaming } from './streaming.mjs';
import { nodeinfoPointer, nodeinfoDoc } from './wire.mjs';
import { allowedAuthorities, checkRequest } from './guard.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { makeGate } = require(path.join(projectRoot, 'vendor/gate.cjs'));

const PHANPY_DIR = path.join(projectRoot, 'phanpy/dist');
const UI_DIR = path.join(projectRoot, 'ui');       // extra client dists: ui/<name>/ → /<name>/
const AGENT_VERSION = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.woff2': 'font/woff2',
};

// Sent on every response: nosniff and no-referrer everywhere, and for HTML
// a CSP that keeps scripts to our own origin (so a client XSS has nowhere to
// exfiltrate to) while still allowing the remote avatars and media a
// fediverse client must display.
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

export function wsOrigins(port) {
  const out = new Set();
  for (const a of allowedAuthorities(port)) {
    // Bare IPv6 cannot carry a port without brackets; the bracketed form is
    // already in the set, so `::1` and `::1:8041` are both noise here.
    if (a.startsWith('::')) continue;
    out.add(`ws://${/:\d+$/.test(a) ? a : `${a}:${port}`}`);
  }
  return [...out];
}

function securityHeaders(port, isHtml) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
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
      `connect-src 'self' https: ${wsOrigins(port).join(' ')}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
  }
  return h;
}

function sendJson(res, status, obj, port) {
  res.writeHead(status, { 'content-type': 'application/json', ...securityHeaders(port, false) });
  res.end(JSON.stringify(obj) + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Static UI serving, path-jailed. Phanpy owns the root; any other client
// dist dropped into ui/<name>/ is served at /<name>/. Hash-routed apps:
// '/' (and directories) get their index.html; anything unknown 404s.
function serveStatic(res, pathname, port) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let baseDir = PHANPY_DIR;
  const uiName = rel.split('/')[0];
  if (uiName && fs.existsSync(path.join(UI_DIR, uiName)) && fs.statSync(path.join(UI_DIR, uiName)).isDirectory()) {
    baseDir = path.join(UI_DIR, uiName);
    rel = rel.slice(uiName.length).replace(/^\/+/, '');
  }
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
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      ...securityHeaders(port, ext === '.html'),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain', ...securityHeaders(port, false) });
    res.end('not found\n');
  }
  return true;
}

export function startAdmin({ port, gateToken, agent, log = console.log }) {
  const gate = makeGate(gateToken);
  const allowed = allowedAuthorities(port);
  const json = (res, status, obj) => sendJson(res, status, obj, port);
  const masto = new MastoApi({ agent, log, allowed });
  const streaming = new Streaming({ masto, log, allowed, gate });
  // Asked per request, not once here: startAdmin runs before connect, so the
  // kind is not known yet at mount time.
  const isGroup = () => agent.store.getConfig()?.kind === 'group';
  // New statuses/notifications flow to connected streaming clients live.
  agent.store.onEvent = (type, obj) => {
    try {
      if (type === 'status') streaming.broadcast('update', masto.status(obj));
      else if (type === 'notification') streaming.broadcast('notification', masto.notification(obj));
    } catch (e) { log(`streaming broadcast: ${e.message}`); }
  };

  const handler = async (req, res) => {
    // Host/Origin firewall first: loopback binding alone does not keep a
    // visited web page (or a rebound DNS name) out.
    const bad = checkRequest(req, allowed);
    if (bad) {
      log(`refused: ${bad} (${req.method} ${req.url})`);
      res.writeHead(403, { 'content-type': 'text/plain', ...securityHeaders(port, false) });
      res.end('forbidden\n');
      return;
    }
    if (gate(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
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
          localPosts: agent.store.getStatuses().filter(s => s.kind === 'post').length,
        }));
      }
      // A group has no human reading a timeline, so it serves no client — and
      // dropping the facade drops the whole token/oauth surface with it.
      if (!isGroup() && (p.startsWith('/api/') || p.startsWith('/oauth/'))) {
        if (await masto.handle(req, res, p, url)) return;
      }
      if (req.method === 'GET' && p === '/status') return json(res, 200, agent.status());
      if (req.method === 'GET' && p === '/log') return json(res, 200, { lines: agent.logLines(200) });
      if (req.method === 'GET' && p === '/deadletter') return json(res, 200, { items: agent.store.getDeadLetters() });
      if (req.method === 'GET' && p === '/tagfeed') {
        return json(res, 200, agent.tagfeed
          ? { ...agent.tagfeed.config(), lastSweep: agent.tagfeed.lastSweep, lastAdded: agent.tagfeed.lastAdded }
          : { error: 'agent not configured' });
      }
      // Group-only: who is here, and what the group has carried. A group cannot
      // force an unfollow, so muting — declining to carry — is its whole lever.
      if (req.method === 'GET' && p === '/members') {
        if (!isGroup()) return json(res, 404, { error: 'not a group' });
        const muted = agent.store.getMuted().actors;
        return json(res, 200, {
          members: agent.store.getContacts().followers
            .map(f => ({ actor: f.actor, inbox: f.sharedInbox || f.inbox, muted: muted.includes(f.actor) })),
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
        if (!isGroup()) return json(res, 404, { error: 'not a group' });
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
        if (isGroup()) return json(res, 404, { error: 'this agent is a group — it serves no client' });
        return serveStatic(res, p, port);
      }
      // Shut down on request: the only way to stop an agent whose pidfile is
      // gone and which no terminal owns (backgrounded, orphaned by a closed
      // shell). Loopback-only like everything here, and it takes the normal
      // graceful path.
      if (req.method === 'POST' && p === '/shutdown') {
        json(res, 200, { ok: true, stopping: process.pid });
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
        return;
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const body = await readBody(req);
      if (p !== '/block' && !agent.configured()) {
        return json(res, 409, { error: 'agent not configured — run the setup CLI first' });
      }
      switch (p) {
        case '/drain': await agent.intake.drain(); return json(res, 200, agent.status());
        case '/publish-profile': {
          const r = await agent.publisher.publishProfile();
          return json(res, 200, { ok: true, ...(r?.unreachable?.length ? { unreachable: r.unreachable } : {}) });
        }
        case '/post': {
          if (!body.content) return json(res, 400, { error: 'content required' });
          const note = await agent.publisher.publishNote(body.content, { inReplyTo: body.inReplyTo });
          return json(res, 200, { ok: true, id: note.id });
        }
        case '/tagfeed': return json(res, 200, agent.tagfeed.setConfig(body));
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
          if (!isGroup()) return json(res, 404, { error: 'not a group' });
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
        case '/block': {
          if (!body.domain) return json(res, 400, { error: 'domain required' });
          const b = agent.store.getBlocklist();
          if (!b.domains.includes(body.domain)) { b.domains.push(body.domain); agent.store.setBlocklist(b); }
          return json(res, 200, { ok: true, domains: b.domains });
        }
        default: return json(res, 404, { error: 'unknown endpoint' });
      }
    } catch (e) {
      log(`admin ${p}: ${e.message}`);
      return json(res, 500, { error: e.message });
    }
  };

  // Loopback both ways: the canonical URL is http://localhost:<port>/, and
  // "localhost" resolves to ::1 on many systems before falling back to IPv4 —
  // answer on both so the same origin always works (one origin = one
  // browser storage = one login).
  const server = http.createServer(handler);
  streaming.attach(server);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${port} is already in use by another server — set AP_PORT to a free port and retry`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, '127.0.0.1', () => {
    // Pidfile for `activitypod stop` — written only AFTER the listen
    // succeeds, so a port-race loser can never clobber the live agent's pid.
    try {
      if (agent.home) fs.writeFileSync(path.join(agent.home, 'agent.pid'), String(process.pid) + '\n');
    } catch { /* stop will report no pidfile */ }
    log(`activitypod-js on http://localhost:${port}/ (UI + API)`);
  });
  const server6 = http.createServer(handler);
  streaming.attach(server6);
  server6.on('error', () => { /* no IPv6 loopback on this system — IPv4 covers it */ });
  server6.listen(port, '::1');
  return server;
}
