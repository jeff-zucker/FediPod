// The bundle entry for the browser-agent integration test: sign-up, the agent,
// and a small adapter that drives the Mastodon facade the way a Node HTTP
// server would (the facade speaks req/res; the service worker will wrap it the
// same way).
import { signUp, moveIn, readAccount } from '../../../web/app/signup.mjs';
import { BrowserAgent } from '../../../web/app/agent.mjs';
import { makeDpopSession, mintCredential, createAccountWithPod } from '../../../web/app/pod-auth.mjs';
import { givePublicTypeIndex } from './pod-fixture.mjs';

export { signUp, moveIn, readAccount, BrowserAgent, makeDpopSession, mintCredential, createAccountWithPod };

/**
 * A pod session for a harness: the pod made through the account API (as the
 * provider's own page would), a credential minted and turned into a DPoP
 * session — the same WebID the pod's Solid-OIDC login would present, without
 * a person at a login form. Shaped like oidc-session.mjs's handle.
 */
export async function podSession({ issuer, email, password, podName, name = 'fedipod-test' }) {
  const made = await createAccountWithPod({ issuer, email, password, podName });
  const cred = await mintCredential({ issuer, email, password, webId: made.webId, podUrl: made.pod, accountToken: made.accountToken, name });
  const dpop = await makeDpopSession(cred);
  // A real pod names a public type index from its profile; the scratch one is given its own.
  await givePublicTypeIndex((u, i) => dpop.fetch(u, i), { pod: made.pod, webId: cred.webId });
  return { webId: cred.webId, issuer: issuer.replace(/\/+$/, ''), pod: made.pod, fetch: (u, i) => dpop.fetch(u, i), refresh: dpop.refresh };
}

export async function facadeFetch(agent, method, path, { headers = {}, body = '' } = {}) {
  const url = new URL('https://front.local' + path);
  const reqHeaders = {}; for (const [k, v] of Object.entries(headers)) reqHeaders[k.toLowerCase()] = v;
  const listeners = {};
  // The body's events fire on the next microtask, and a route that reads the
  // body registers for them only after an await or two (the facade dispatches
  // through its area modules first) — so, as the service worker does
  // (sw-src.mjs), a listener that arrives after the events have fired is
  // given them at once. Without this a POST that read its body late hung the
  // harness forever: the events had gone to nobody.
  let fired = false;
  const req = { method, url: path, headers: { ...reqHeaders, host: 'front.local' }, socket: { encrypted: true },
    // What the service worker stamps once a request has passed its origin gate
    // (sw-src.mjs). MastoApi asks the authorities object whether a caller is the
    // owner, and in a browser that question means exactly this — so a shim that
    // leaves it off is a different caller from the one the worker builds.
    sameOrigin: true,
    on(ev, cb) {
      (listeners[ev] ||= []).push(cb);
      if (fired) { if (ev === 'data' && body) cb(body); else if (ev === 'end') cb(); }
      return req;
    }, destroy() {} };
  queueMicrotask(() => { fired = true; if (body) (listeners.data || []).forEach((cb) => cb(body)); (listeners.end || []).forEach((cb) => cb()); });
  let status = 200; const outHeaders = {}; const chunks = [];
  const res = {
    writeHead(s, h) { status = s; if (h) Object.assign(outHeaders, h); return res; },
    setHeader(k, v) { outHeaders[k] = v; }, getHeader(k) { return outHeaders[k]; },
    write(c) { chunks.push(c); }, end(c) { if (c) chunks.push(c); },
  };
  const handled = await agent.masto.handle(req, res, url.pathname, url);
  return { handled, status, headers: outHeaders, body: chunks.join('') };
}
// The owner's manage endpoints are a second surface on the same agent — the
// worker routes to one or the other by path. Same req/res shim, different
// handler, and this one takes the body as a string rather than as a stream.
export async function adminFetch(agent, method, path, body = '') {
  const url = new URL('https://front.local' + path);
  const req = { method, url: path, headers: { 'content-type': 'application/json' }, socket: { encrypted: true },
    sameOrigin: true, on() { return req; }, destroy() {} };
  let status = 200; const outHeaders = {}; const chunks = [];
  const res = {
    writeHead(s, h) { status = s; if (h) Object.assign(outHeaders, h); return res; },
    setHeader(k, v) { outHeaders[k] = v; }, getHeader(k) { return outHeaders[k]; },
    write(c) { chunks.push(c); }, end(c) { if (c) chunks.push(c); },
  };
  const handled = await agent.admin.handle(req, res, url.pathname, url, body);
  return { handled, status, headers: outHeaders, body: chunks.join('') };
}

globalThis.__test = { signUp, moveIn, readAccount, BrowserAgent, facadeFetch, adminFetch, makeDpopSession, mintCredential, createAccountWithPod, podSession };
