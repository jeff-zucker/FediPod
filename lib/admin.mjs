// admin.mjs — loopback HTTP front: admin API + Mastodon client-API facade +
// the bundled Phanpy UI served same-origin (no CORS, no mixed content — the
// role data-kitchen's router plays for the in-app pane). Loopback-bound; the
// gate (vendor/gate.cjs) engages only when a token is configured, exactly
// its standalone behavior.

import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { followHandle, unfollowActor } from './social.mjs';
import { MastoApi } from './mastoapi.mjs';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { makeGate } = require(path.join(projectRoot, 'vendor/gate.cjs'));

const PHANPY_DIR = path.join(projectRoot, 'phanpy/dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.woff2': 'font/woff2',
};

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj) + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// The Phanpy dist, path-jailed. Hash-routed app: '/' (and directories) get
// their index.html; anything unknown 404s.
function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PHANPY_DIR, rel));
  if (!file.startsWith(PHANPY_DIR + path.sep) && file !== path.join(PHANPY_DIR, 'index.html')) {
    res.writeHead(403); res.end(); return true;
  }
  let target = file;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    const body = fs.readFileSync(target);
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  }
  return true;
}

export function startAdmin({ port, gateToken, agent, log = console.log }) {
  const gate = makeGate(gateToken);
  const masto = new MastoApi({ agent, log });

  const server = http.createServer(async (req, res) => {
    if (gate(req, res)) return;
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/') || p.startsWith('/oauth/')) {
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
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p);
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const body = await readBody(req);
      if (p !== '/block' && !agent.configured()) {
        return json(res, 409, { error: 'agent not configured — run the setup CLI first' });
      }
      switch (p) {
        case '/drain': await agent.intake.drain(); return json(res, 200, agent.status());
        case '/publish-profile': await agent.publisher.publishProfile(); return json(res, 200, { ok: true });
        case '/post': {
          if (!body.content) return json(res, 400, { error: 'content required' });
          const note = await agent.publisher.publishNote(body.content, { inReplyTo: body.inReplyTo });
          return json(res, 200, { ok: true, id: note.id });
        }
        case '/tagfeed': return json(res, 200, agent.tagfeed.setConfig(body));
        case '/follow': return json(res, 200, await followHandle(agent, body.handle));
        case '/unfollow': return json(res, 200, await unfollowActor(agent, body.actor));
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
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${port} is already in use by another server — set AP_PORT to a free port and retry`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, '127.0.0.1', () => log(`activitypod-js on http://127.0.0.1:${port}/ (UI + API)`));
  return server;
}
