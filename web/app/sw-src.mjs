// sw-src.mjs — the service worker that hosts the in-browser agent.
//
// Phanpy (served static on this origin) calls the Mastodon API on its own
// origin. This worker answers those calls from the agent running inside it, so
// there is no server behind the client. The page boots the agent by posting it
// the sign-up material (credential, config, plaintext keys); the worker holds
// the agent for the life of the worker and intercepts the facade paths. Static
// files fall through to the network.
import { BrowserAgent } from './agent.mjs';
import { getSession } from './oidc-session.mjs';
import { ADMIN_PATHS } from './admin-facade.mjs';

let agent = null;
let booting = null;

const FACADE = /^\/(api\/v[12]\/|oauth\/|nodeinfo\/)/;   // Mastodon paths only — never the front's own /api/handle, /api/attach, /api/relay
const FACADE_EXACT = new Set(['/.well-known/nodeinfo', '/.well-known/oauth-authorization-server', '/nodeinfo/2.0']);
const isFacade = (p) => FACADE.test(p) || FACADE_EXACT.has(p);
// The owner's record/manage data endpoints (see admin-facade.mjs). The web/admin
// PAGES are static files Netlify serves; only these data calls are ours.
const isAdmin = (p) => ADMIN_PATHS.has(p);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Boot the agent from the stored Solid-OIDC session. The sign-in page posts a
// 'boot' to prime it, but the worker ALSO boots itself on demand (see serve):
// browsers kill an idle service worker and restart it fresh, and the client at
// /app/ never posts 'boot' — so without on-demand boot every request after a
// restart 503s. On a boot failure `booting` is cleared so the next request retries.
async function bootFromSession(frontOrigin) {
  const oidc = await getSession();
  if (!oidc) throw new Error('no session — sign in first');
  const a = new BrowserAgent({ log: (m) => console.log('[sw-agent]', m) });
  await a.boot({ oidc, frontOrigin: frontOrigin || self.location.origin });
  agent = a;
  return a;
}
function ensureBooting(frontOrigin) {
  if (agent) return Promise.resolve(agent);
  if (!booting) booting = bootFromSession(frontOrigin).catch((err) => { booting = null; throw err; });
  return booting;
}

self.addEventListener('message', (e) => {
  if (e.data?.type !== 'boot') return;
  ensureBooting(e.data.frontOrigin)
    .then(() => e.source?.postMessage({ type: 'booted' }))
    .catch((err) => e.source?.postMessage({ type: 'boot-error', error: err.message, stack: String(err.stack || '') }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !(isFacade(url.pathname) || isAdmin(url.pathname))) return;   // static → network
  e.respondWith(serve(e.request, url));
});

async function serve(request, url) {
  // Boot on demand from the stored session, so the client works even when the
  // worker was restarted (idle-killed) and nobody posted 'boot' this time.
  if (!agent) { try { await ensureBooting(); } catch { /* no session → 503 below */ } }
  if (!agent) return json(503, { error: 'the agent is not booted yet — open the app from the sign-in page' });
  const bodyText = (request.method === 'GET' || request.method === 'HEAD') ? '' : await request.text();
  const reqHeaders = {}; for (const [k, v] of request.headers) reqHeaders[k.toLowerCase()] = v;
  const listeners = {};
  const req = { method: request.method, url: url.pathname + url.search, headers: reqHeaders,
    socket: { encrypted: url.protocol === 'https:' }, on(ev, cb) { (listeners[ev] ||= []).push(cb); return req; }, destroy() {} };
  queueMicrotask(() => { if (bodyText) (listeners.data || []).forEach((cb) => cb(bodyText)); (listeners.end || []).forEach((cb) => cb()); });
  let status = 200; const outHeaders = {}; const chunks = [];
  const res = {
    writeHead(s, h) { status = s; if (h) Object.assign(outHeaders, h); return res; },
    setHeader(k, v) { outHeaders[k] = v; }, getHeader(k) { return outHeaders[k]; },
    write(c) { chunks.push(c); }, end(c) { if (c) chunks.push(c); },
  };
  try {
    const handled = isAdmin(url.pathname)
      ? await agent.admin.handle(req, res, url.pathname, url, bodyText)
      : await agent.masto.handle(req, res, url.pathname, url);
    if (!handled) return fetch(request);
    return new Response(chunks.join(''), { status, headers: { 'content-type': 'application/json', ...outHeaders } });
  } catch (err) {
    return json(500, { error: err.message });
  }
}
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
