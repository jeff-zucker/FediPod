// oidc-session.mjs — Solid-OIDC login for the browser agent, with a secure,
// durable, worker-visible session.
//
// The redirect handshake (authorization-code + PKCE) runs in the page. The
// session it yields — a DPoP keypair whose private half is NON-EXTRACTABLE, plus
// the refresh token, the token endpoint and the WebID — is kept in IndexedDB.
// IndexedDB survives a browser restart and is readable by the service worker
// where the agent runs, and a non-extractable key can sign but never be read
// out, even by injected script. That is the security this buys over uvdsl's
// sessionStorage (which must hold an extractable key as a string, per-tab).
//
// Page:   const { authorizationUrl } = await beginLogin({ issuer, redirectUri });
//         location.href = authorizationUrl;                 // ... redirect ...
//         await completeLogin({ currentUrl: location.href });  // on return
// Anywhere (page or worker):
//         const session = await getSession();  // { webId, fetch, signOut } | null

const DB = 'fedipod-oidc';
const STORE = 'session';
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
const rand = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE).objectStore(STORE).get(key); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite').objectStore(STORE).put(val, key); t.onsuccess = () => res(); t.onerror = () => rej(t.error); });
}
async function idbDel(key) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); t.onsuccess = () => res(); t.onerror = () => rej(t.error); });
}

async function dpopKey() { return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); }
async function publicJwk(pair) { const j = await crypto.subtle.exportKey('jwk', pair.publicKey); return { kty: j.kty, crv: j.crv, x: j.x, y: j.y }; }
async function dpopProof(pair, jwk, htm, htu, ath) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk };
  const payload = { htm, htu: htu.split('#')[0], jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), ...(ath ? { ath } : {}) };
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(data));
  return `${data}.${b64u(sig)}`;
}
const jwtPayload = (jwt) => { try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { return {}; } };

async function discover(issuer) {
  const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OIDC discovery failed at ${issuer} (HTTP ${res.status})`);
  return res.json();
}
async function registerClient(cfg, redirectUri, clientName) {
  const res = await fetch(cfg.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web', scope: 'openid webid offline_access' }),
  });
  if (!res.ok) throw new Error(`client registration failed (HTTP ${res.status})`);
  return (await res.json()).client_id;
}

/** Begin login: prepare PKCE + a non-extractable DPoP key, stash the pending
 *  state, and return the authorization URL for the caller to navigate to. */
export async function beginLogin({ issuer, redirectUri, clientName = 'FediPod' }) {
  const cfg = await discover(issuer);
  const client_id = await registerClient(cfg, redirectUri, clientName);
  const pair = await dpopKey();
  const verifier = rand(48);
  const challenge = b64u(await sha256(verifier));
  const state = rand(16);
  await idbPut('pending', { issuer, client_id, redirectUri, verifier, state, pair,
    tokenEndpoint: cfg.token_endpoint, authorizationEndpoint: cfg.authorization_endpoint });
  const url = new URL(cfg.authorization_endpoint);
  for (const [k, v] of Object.entries({ client_id, redirect_uri: redirectUri, response_type: 'code',
    scope: 'openid webid offline_access', code_challenge: challenge, code_challenge_method: 'S256', state, prompt: 'consent' })) url.searchParams.set(k, v);
  return { authorizationUrl: url.href };
}

/** Complete login from the redirect back. Exchanges the code (DPoP + PKCE),
 *  stores the durable session, and returns it. Returns null if there is no code. */
export async function completeLogin({ currentUrl }) {
  const u = new URL(currentUrl);
  const code = u.searchParams.get('code');
  const state = u.searchParams.get('state');
  if (!code) return null;
  const p = await idbGet('pending');
  if (!p || p.state !== state) throw new Error('login state mismatch');
  const jwk = await publicJwk(p.pair);
  const res = await fetch(p.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: await dpopProof(p.pair, jwk, 'POST', p.tokenEndpoint) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: p.client_id, code_verifier: p.verifier }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new Error(`token exchange failed (HTTP ${res.status}): ${tok.error || ''}`);
  const webId = jwtPayload(tok.access_token).webid || jwtPayload(tok.id_token || '').webid || null;
  const session = { issuer: p.issuer, client_id: p.client_id, tokenEndpoint: p.tokenEndpoint, pair: p.pair,
    refreshToken: tok.refresh_token || null, accessToken: tok.access_token,
    expiresAt: Date.now() + Math.max(30, (tok.expires_in || 300)) * 1000, webId };
  await idbPut('session', session);
  await idbDel('pending');
  return sessionHandle(session);
}

/** Restore the session from IndexedDB — works in the page and the worker. */
export async function getSession() {
  const s = await idbGet('session');
  return s ? sessionHandle(s) : null;
}

export async function signOut() { await idbDel('session'); await idbDel('pending'); }

function sessionHandle(s) {
  let { accessToken, expiresAt, refreshToken } = s;
  const jwkP = publicJwk(s.pair);
  const refresh = async () => {
    if (!refreshToken) throw new Error('session expired and there is no refresh token — sign in again');
    const jwk = await jwkP;
    const res = await fetch(s.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: await dpopProof(s.pair, jwk, 'POST', s.tokenEndpoint) },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: s.client_id, scope: 'openid webid offline_access' }),
    });
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok.access_token) { await idbDel('session'); throw new Error('refresh failed — sign in again'); }
    accessToken = tok.access_token;
    expiresAt = Date.now() + Math.max(30, (tok.expires_in || 300)) * 1000;
    if (tok.refresh_token) refreshToken = tok.refresh_token;
    await idbPut('session', { ...s, accessToken, expiresAt, refreshToken });
  };
  const authFetch = async (url, init = {}) => {
    if (Date.now() > expiresAt - 30_000) await refresh();
    const jwk = await jwkP;
    const ath = b64u(await sha256(accessToken));
    const headers = { ...(init.headers || {}), authorization: `DPoP ${accessToken}`, dpop: await dpopProof(s.pair, jwk, (init.method || 'GET'), url, ath) };
    return fetch(url, { ...init, headers });
  };
  return { webId: s.webId, fetch: authFetch, refresh, signOut };
}
