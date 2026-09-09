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

// ---- who may drive these routes ----
//
// Same-origin is the WHOLE trust boundary for this build. The worker answers
// the owner's admin routes with no password and no token — the only interlock
// on the destructive ones is `confirm === handle`, and the handle is public —
// so without this gate any page the owner merely visited could move every
// follower to an attacker's account, retire the identity, rotate the key,
// point the inbox at an attacker's gateway, or set a UI password the owner
// does not know. The Node agent is covered by lib/guard.mjs; nothing from
// that file is in this bundle, and it could not do the job here anyway —
// `Sec-Fetch-*` headers are NOT visible inside a service worker's fetch
// event, and neither is `Origin`. So the gate is built from what a worker
// CAN see: the request's mode, its referrer, and its headers.
//
// The header is what does the work, and it does not need to be a secret to do
// it. A cross-site FORM cannot set a header at all. A cross-origin fetch()
// that sets one is a preflighted request, and nothing here ever answers a
// preflight with CORS headers, so the browser never sends the real one. That
// leaves a top-level navigation, which also carries no custom headers.
//
// (The review suggested making it a per-session secret handed to the page by
// postMessage. Deliberately not carried: the header already refuses every
// cross-ORIGIN caller, and a secret would only add something against an
// attacker already running script on this origin — who could read it straight
// out of the page. The defence at that layer is the CSP, in the site's
// _headers.)
const PAGE_HEADER = 'x-fedipod-page';

// The one route that MUST survive a cross-site navigation: the other server's
// OAuth redirect lands the browser here, from their origin, by design. Its
// `state` parameter is what stands in for the header.
const NAV_ALLOWED = new Set(['/fediacct/callback']);

const sameOriginReferrer = (request) => {
  const r = request.referrer;
  // 'about:client' is the browser saying "the context that asked", which for a
  // request this worker intercepts is a page on this origin.
  if (!r || r === 'about:client') return r === 'about:client';
  try { return new URL(r).origin === self.location.origin; } catch { return false; }
};

// Returns null when the request may proceed, else the reason to refuse with.
function notAllowed(request, url) {
  const p = url.pathname;

  // The Mastodon client API is deliberately open, exactly as it is on the Node
  // agent and on any real instance: a bearer is its credential, and a client
  // has to be able to call it. It mints nothing without one.
  if (!isAdmin(p) && !p.startsWith('/oauth/')) return null;

  if (request.mode === 'navigate') {
    if (NAV_ALLOWED.has(p)) return null;
    // The bundled client signs in by navigating its frame to /oauth/authorize
    // from a page on this origin. A navigation from anywhere else — or from
    // nowhere, which is what a page that suppressed its referrer looks like —
    // is not that, and /oauth/authorize is where a 90-day bearer is minted.
    if (p.startsWith('/oauth/') && sameOriginReferrer(request)) return null;
    return 'a navigation may not drive this route';
  }

  // /oauth/* is not open the way /api/* is: the only client here is the one
  // served from this origin, so a call from another origin is never legitimate.
  if (p.startsWith('/oauth/')) {
    return sameOriginReferrer(request) ? null : 'this route answers this origin only';
  }

  if (request.headers.get(PAGE_HEADER) !== '1') return `missing ${PAGE_HEADER}`;
  // Belt and braces on top of the header: the facade parses a body as JSON
  // whatever its content type, and `text/plain` is the one a cross-site form
  // can send. Nothing that got past the header sends anything else anyway.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct && ct !== 'application/json') return `unexpected content type "${ct}"`;
  }
  return null;
}

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
  // Drop the identity this worker is holding. A worker outlives a page, so
  // signing in as somebody else left the FIRST account's agent live and serving
  // — the new session sat in IndexedDB while every request was still answered
  // by the old actor, with the old key. The page posts this before it boots the
  // new one; the next request boots from whatever session is stored now.
  if (e.data?.type === 'reset') {
    const had = !!agent;
    agent = null; booting = null;
    e.source?.postMessage({ type: 'reset-done', had });
    return;
  }
  if (e.data?.type !== 'boot') return;
  ensureBooting(e.data.frontOrigin)
    .then(() => e.source?.postMessage({ type: 'booted' }))
    // `code` matters: a boot that failed only because this browser has never
    // opened the signing key is not a failure the page should show as one — it
    // is a question the page can answer (boot.mjs). Everything else is shown.
    .catch((err) => e.source?.postMessage({ type: 'boot-error', error: err.message,
      code: err.code || null, stack: String(err.stack || '') }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !(isFacade(url.pathname) || isAdmin(url.pathname))) return;   // static → network
  e.respondWith(serve(e.request, url));
});

async function serve(request, url) {
  // Before anything is booted or read: is this caller allowed to be here at all?
  const refuse = notAllowed(request, url);
  if (refuse) {
    console.warn(`[sw-agent] refused ${request.method} ${url.pathname}: ${refuse}`);
    return json(403, { error: `refused: ${refuse}` });
  }
  // Boot on demand from the stored session, so the client works even when the
  // worker was restarted (idle-killed) and nobody posted 'boot' this time.
  if (!agent) { try { await ensureBooting(); } catch { /* no session → 503 below */ } }
  if (!agent) return json(503, { error: 'the agent is not booted yet — open the app from the sign-in page' });
  // Bytes, not text. A multipart upload is binary — read as text it comes back
  // through a UTF-8 round trip that replaces every byte that is not valid UTF-8,
  // which is most of a JPEG, so the boundary search found nothing and every
  // media and avatar upload answered "422 file required". readBody() does
  // `data += chunk`, which decodes a Buffer the same way it always did, so the
  // JSON and form paths are unchanged.
  const bodyBytes = (request.method === 'GET' || request.method === 'HEAD')
    ? null : Buffer.from(new Uint8Array(await request.arrayBuffer()));
  // The admin facade is JSON-only (the gate above enforces the content type),
  // and takes its body already decoded.
  const bodyText = bodyBytes ? new TextDecoder().decode(bodyBytes) : '';
  const reqHeaders = {}; for (const [k, v] of request.headers) reqHeaders[k.toLowerCase()] = v;
  const listeners = {};
  const req = { method: request.method, url: url.pathname + url.search, headers: reqHeaders,
    // notAllowed() above let this through, so it came from this origin. Said
    // out loud rather than left implicit: MastoApi asks (through the
    // authorities object in agent.mjs) whether a request is the owner's own,
    // and in a browser that question means exactly this.
    sameOrigin: true,
    socket: { encrypted: url.protocol === 'https:' }, on(ev, cb) { (listeners[ev] ||= []).push(cb); return req; }, destroy() {} };
  queueMicrotask(() => { if (bodyBytes?.length) (listeners.data || []).forEach((cb) => cb(bodyBytes)); (listeners.end || []).forEach((cb) => cb()); });
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
