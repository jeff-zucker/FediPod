// idp-grant.cjs — mint a CSS client-credential and run the headless DPoP
// `client_credentials` grant that turns it into authenticated fetches.
//
// This is the durable, no-popup, no-Authorize path of "remember this IdP":
//   - mintCredential(): drives the CSS account API (login → controls →
//     create-client-credential) to obtain a long-lived, revocable {id, secret}.
//     The account password is used transiently here and never persisted (the
//     vault stores only the resulting credential — see idp-vault.cjs).
//   - createGrantSession(): given a stored credential, manages a DPoP key pair +
//     access-token lifecycle and exposes .fetch(url, init) — a Solid-OIDC
//     DPoP-bound fetch identical in effect to an interactive session's fetch,
//     but obtained with zero user interaction.
//
// All of this runs in the Electron MAIN process. The access token and DPoP
// private key never leave it; the renderer only ever gets a proxied fetch.
//
// The DPoP plumbing (proof JWTs, the use_dpop_nonce retry dance) is hand-built
// because @inrupt/solid-client-authn-node is not installed — jose (already in
// the tree) provides the signing primitives.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');
const { jfetch } = require('./jfetch.cjs');

// The HTTP URI for a DPoP proof's `htu` is the request URL without query/fragment.
function htuOf(url) { const u = new URL(url); return u.origin + u.pathname; }

// Build a DPoP proof JWT bound to (htm, htu), optionally carrying a server nonce
// and the access-token hash (`ath`, required on resource requests).
async function dpopProof({ keyPair, htm, htu, nonce, accessToken }) {
  const jwk = await exportJWK(keyPair.publicKey);
  const payload = { htu, htm, jti: crypto.randomUUID() };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = crypto.createHash('sha256').update(accessToken).digest('base64url');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
    .setIssuedAt()
    .sign(keyPair.privateKey);
}

/**
 * Mint a durable client-credential for an issuer via its CSS account API.
 * The password is used only here and discarded by the caller.
 * @param {object} o
 * @param {string} o.origin     issuer origin, e.g. "https://solidcommunity.net"
 * @param {string} o.email      account email
 * @param {string} o.password   account password (transient — never stored)
 * @param {string} [o.webId]    WebID to bind; discovered from the account if absent
 * @param {string} [o.podUrl]   the pod this credential is for — picks the right
 *                              WebID when the account owns more than one
 * @param {string} [o.gateToken] x-dk-token, ONLY for the local gated origin
 * @param {string} [o.name]     human label for the credential
 * @returns {{clientId, secret, webId, tokenEndpoint, issuerOrigin}}
 */
async function mintCredential({ origin, email, password, webId, podUrl, gateToken, name = 'data-kitchen' }) {
  const accountRoot = `${origin}/.account/`;

  const pre = (await jfetch(accountRoot, { gateToken })).json;
  const loginUrl = pre?.controls?.password?.login || `${accountRoot}login/password/`;
  const login = await jfetch(loginUrl, { method: 'POST', gateToken, body: { email, password } });
  if (login.status >= 400 || !login.json?.authorization) {
    throw new Error(`account login failed (HTTP ${login.status})`);
  }
  const cookie = `css-account=${login.json.authorization}`;

  const controls = (await jfetch(accountRoot, { gateToken, cookie })).json?.controls;
  const ccUrl = controls?.account?.clientCredentials;
  if (!ccUrl) throw new Error('clientCredentials control missing — issuer is not a CSS account API');

  let wid = webId;
  if (!wid) {
    const linkCtl = controls?.account?.webId;
    const links = linkCtl ? (await jfetch(linkCtl, { gateToken, cookie })).json?.webIdLinks : null;
    const all = links ? Object.keys(links) : [];
    // An account may own several pods, each with its own WebID. Taking the
    // first is right only by luck: bound to another pod's WebID the credential
    // authenticates fine and then 403s every write, which reads as a broken
    // server rather than a mis-bound token.
    let origins = [];
    try { origins = podUrl ? all.filter(w => new URL(w).origin === new URL(podUrl).origin) : []; } catch {}
    wid = origins[0] || all[0];
    if (!wid) throw new Error('no WebID is linked to this account');
    if (podUrl && !origins.length && all.length > 1) {
      throw new Error(`this account has ${all.length} WebIDs and none of them is on ${new URL(podUrl).origin} `
        + '— the pod and the credential would not match');
    }
  }

  const made = await jfetch(ccUrl, { method: 'POST', gateToken, cookie, body: { name, webId: wid } });
  if (made.status >= 400 || !made.json?.secret) {
    throw new Error(`mint failed (HTTP ${made.status}): ${made.json?.message || ''}`);
  }
  const tokenEndpoint = await discoverTokenEndpoint(origin, gateToken);
  return { clientId: made.json.id, secret: made.json.secret, webId: wid, tokenEndpoint, resource: made.json.resource, issuerOrigin: origin };
}

/** Discover an issuer's OIDC token endpoint. gateToken only for the local origin. */
async function discoverTokenEndpoint(origin, gateToken) {
  const headers = { accept: 'application/json' };
  if (gateToken) headers['x-dk-token'] = gateToken;
  const res = await fetch(`${origin}/.well-known/openid-configuration`, { headers });
  const cfg = await res.json().catch(() => ({}));
  if (!cfg.token_endpoint) throw new Error('no token_endpoint in OIDC configuration');
  return cfg.token_endpoint;
}

/**
 * Revoke a credential server-side (best-effort), so forgetting truly unlinks it.
 * Needs the account password to re-authenticate, so this is only possible where we
 * still hold it (the local pod). The credential's `resource` URL is returned by
 * mintCredential and kept in the vault for exactly this.
 */
async function revokeCredentialViaAccount({ origin, email, password, gateToken, resource }) {
  if (!resource) return false;
  const accountRoot = `${origin}/.account/`;
  const pre = (await jfetch(accountRoot, { gateToken })).json;
  const loginUrl = pre?.controls?.password?.login || `${accountRoot}login/password/`;
  const login = await jfetch(loginUrl, { method: 'POST', gateToken, body: { email, password } });
  if (!login.json?.authorization) return false;
  const cookie = `css-account=${login.json.authorization}`;
  const res = await fetch(resource, { method: 'DELETE', headers: { cookie, ...(gateToken ? { 'x-dk-token': gateToken } : {}) } });
  return res.ok;
}

/**
 * Build a headless authenticated session from a stored credential. Manages one
 * DPoP key pair and a cached access token (re-granted on expiry/401), and
 * handles the use_dpop_nonce challenge on both the token and resource servers.
 * @param {{clientId, secret, webId, tokenEndpoint, issuerOrigin}} rec
 * @param {object} [o]
 * @param {string} [o.gateToken]   x-dk-token value
 * @param {string} [o.gatedOrigin] the origin x-dk-token applies to (local pod only)
 * @returns {{webId, issuer, fetch}}
 */
// Every token request costs the issuer an OIDC replay-detection write, and that
// write takes a lock — so retrying one without backoff compounds the contention
// that slowed it down. solidcommunity.net's operators measured ~30 of our token
// requests in 5 seconds during their 2026-07-29 outage: one forced grant per 401
// across a sweep, with nothing coalescing them. Hence one grant in flight at a
// time, a breaker shut for a jittered exponential interval after each failure
// (or for Retry-After when offered), and a floor on how often a 401 may force a
// fresh grant.
const TOKEN_BACKOFF_MIN_MS = 1_000;
const TOKEN_BACKOFF_MAX_MS = 60_000;
const FORCE_COOLDOWN_MS = 10_000;

// Identify ourselves. An operator reading their access log should be able to
// tell who we are and where to complain: solidcommunity.net's incident report
// had to infer us from client-credential names because every request said only
// "node", which is undici's default.
const { version: AGENT_VERSION } = require('../package.json');
// This is the one on the token grants, so it is the one scn actually logged.
// Renamed 2026-07-31 in lockstep with lib/ua.mjs — changing only that leaves
// the grants still announcing the old name.
const USER_AGENT = `solid-activitypub/${AGENT_VERSION} (+https://github.com/jeff-zucker/solid-activitypub)`;

// A ceiling no timer, retry or future bug can exceed. Steady state is ~3
// requests/minute, so the default sits 20x above normal use and only engages
// when something has gone wrong.
const DEFAULT_MAX_PER_MIN = 60;

// A crash loop would otherwise reset the breaker on every boot and force a
// grant immediately — systemd restarts us on failure, so backoff has to outlive
// the process. One small file, best-effort: an unreadable or unwritable one just
// means we behave as before.
// --- token reuse across restarts -------------------------------------------
function readSavedToken(file) {
  if (!file) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d.accessToken || !d.privateJwk) return null;
    if (!(Number(d.expiresAt) > Date.now() + 60_000)) return null;   // too near expiry to bother
    return d;
  } catch { return null; }
}

async function importSavedKey(saved) {
  const { importJWK } = require('jose');
  const privateKey = await importJWK(saved.privateJwk, 'ES256');
  const publicKey = await importJWK(saved.publicJwk, 'ES256');
  return { privateKey, publicKey };
}

async function saveToken(file, keyPair, accessToken, expiresAt) {
  if (!file) return;
  try {
    const { exportJWK } = require('jose');
    fs.writeFileSync(file, JSON.stringify({
      accessToken, expiresAt,
      privateJwk: await exportJWK(keyPair.privateKey),
      publicJwk: await exportJWK(keyPair.publicKey),
    }) + '\n', { mode: 0o600 });
  } catch { /* best-effort: a fresh grant next start is the only cost */ }
}

function readBackoff(file) {
  if (!file) return { breakerUntil: 0, failures: 0 };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { breakerUntil: Number(d.breakerUntil) || 0, failures: Number(d.failures) || 0 };
  } catch { return { breakerUntil: 0, failures: 0 }; }
}

function writeBackoff(file, breakerUntil, failures) {
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify({ breakerUntil, failures }) + '\n', { mode: 0o600 }); }
  catch { /* best-effort */ }
}

function createGrantSession(rec, { gateToken, gatedOrigin, backoffFile = null, tokenFile = null } = {}) {
  const { clientId, secret, webId, tokenEndpoint, issuerOrigin } = rec;
  // A DPoP token is bound to the key that requested it, so reusing one across a
  // restart means reusing the key too. Both go in one 0600 file beside the
  // credential that could mint them anyway. Any problem reading it falls back
  // to a fresh key and a fresh grant.
  const saved = readSavedToken(tokenFile);
  const keyPairP = saved
    // `extractable: true` because the DPoP key is exported two ways: as the
    // public JWK that rides in every proof header, and to token.json so a
    // restart resumes the same session instead of minting a fresh grant. jose 6
    // makes generated keys non-extractable by default, which turns both of
    // those into "non-extractable CryptoKey cannot be exported as a JWK".
    ? importSavedKey(saved).catch(() => generateKeyPair('ES256', { extractable: true }))
    : generateKeyPair('ES256', { extractable: true });
  let accessToken = saved?.accessToken || null;
  let expiresAt = saved?.expiresAt || 0;
  let rsNonce = null;
  let inFlight = null;                           // single-flight: N callers, one grant
  const carried = readBackoff(backoffFile);
  let failures = carried.failures, breakerUntil = carried.breakerUntil, lastForced = 0;
  const maxPerMin = Number(process.env.AP_MAX_REQUESTS_PER_MIN) || DEFAULT_MAX_PER_MIN;
  let allowance = maxPerMin, lastRefill = Date.now();
  // Token bucket over every request this session makes — resource and token
  // endpoint alike, since both cost the issuer a lock.
  // Accounting, so "are we the problem?" is a question the agent can answer
  // rather than one that takes an evening of reading. Counts every request this
  // session makes, by outcome, plus a rolling one-minute rate.
  const counts = { requests: 0, tokenGrants: 0, ok: 0, client4xx: 0, server5xx: 0, refused: 0, failed: 0 };
  const recent = [];                              // request timestamps, last 60s
  const note = (bucket) => { counts[bucket]++; };
  const rate = () => {
    const cutoff = Date.now() - 60_000;
    while (recent.length && recent[0] < cutoff) recent.shift();
    return recent.length;
  };
  const takeSlot = () => {
    const now = Date.now();
    allowance = Math.min(maxPerMin, allowance + ((now - lastRefill) * maxPerMin) / 60_000);
    lastRefill = now;
    if (allowance < 1) return false;
    allowance -= 1;
    counts.requests++;
    recent.push(now);
    return true;
  };
  // The ceiling is OUR politeness, not the server's refusal, so hitting it must
  // WAIT rather than fail: a first-run setup legitimately needs ~60 writes, and
  // throwing there left an account, a pod and a half-published actor behind.
  // Refusing outright is also not the polite option — it just moves the retry
  // somewhere with less information. The cap is a backstop so a genuinely
  // wedged bucket still surfaces instead of hanging for ever.
  const SLOT_WAIT_MAX_MS = Number(process.env.AP_SLOT_WAIT_MAX_MS) || 120_000;
  const waitForSlot = async (what) => {
    if (takeSlot()) return;
    const deadline = Date.now() + SLOT_WAIT_MAX_MS;
    const step = Math.max(50, Math.ceil(60_000 / maxPerMin));
    for (;;) {
      await new Promise(r => setTimeout(r, step));
      if (takeSlot()) return;
      if (Date.now() >= deadline) {
        note('refused');
        throw new Error(`local ceiling of ${maxPerMin} requests/min: no slot after `
          + `${Math.round(SLOT_WAIT_MAX_MS / 1000)}s — ${what}`);
      }
    }
  };

  const stats = () => ({
    ...counts,
    perMinuteNow: rate(),
    ceilingPerMinute: maxPerMin,
    backingOffFor: Math.max(0, Math.round((breakerUntil - Date.now()) / 1000)),
  });
  const gateFor = (url) => (gatedOrigin && new URL(url).origin === gatedOrigin) ? gateToken : undefined;

  async function requestToken(keyPair, nonce) {
    const proof = await dpopProof({ keyPair, htm: 'POST', htu: htuOf(tokenEndpoint), nonce });
    const headers = {
      authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
      dpop: proof,
    };
    const gate = gateFor(tokenEndpoint); if (gate) headers['x-dk-token'] = gate;
    // Deliberately shorter than the 60s nginx in front of a typical CSS: if a
    // grant has not landed in 30s the server is in trouble, and holding its
    // worker to the wire makes that worse. We back off and try later instead.
    // AP_HTTP_TIMEOUT_MS raises it for a knowingly slow issuer.
    await waitForSlot('token request');
    const res = await fetch(tokenEndpoint, {
      method: 'POST', headers, body: 'grant_type=client_credentials&scope=webid',
      signal: AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 30_000),
    });
    if ((res.status === 400 || res.status === 401) && !nonce) {
      const n = res.headers.get('dpop-nonce');
      if (n) return requestToken(keyPair, n);
    }
    // Truncated: an ailing issuer answers with a whole HTML page (a
    // Cloudflare 504, say) and this message goes into the log.
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      note(res.status >= 500 ? 'server5xx' : 'client4xx');
      const err = new Error(`token request failed (HTTP ${res.status}): ${body}`);
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = Math.min(ra * 1000, TOKEN_BACKOFF_MAX_MS);
      throw err;
    }
    counts.tokenGrants++;
    note('ok');
    return res.json();
  }

  async function ensureToken(force) {
    const keyPair = await keyPairP;
    if (!force && accessToken && Date.now() < expiresAt - 30_000) return keyPair;
    if (inFlight) { await inFlight; return keyPair; }   // someone else is already asking
    const shut = breakerUntil - Date.now();
    if (shut > 0) throw new Error(`token endpoint backing off — ${Math.ceil(shut / 1000)}s left`);
    inFlight = (async () => {
      try {
        const tok = await requestToken(keyPair, null);
        accessToken = tok.access_token;
        expiresAt = Date.now() + (Number(tok.expires_in) || 300) * 1000;
        failures = 0;
        writeBackoff(backoffFile, 0, 0);
        await saveToken(tokenFile, keyPair, accessToken, expiresAt);
      } catch (e) {
        failures++;
        const capped = Math.min(TOKEN_BACKOFF_MIN_MS * 2 ** (failures - 1), TOKEN_BACKOFF_MAX_MS);
        breakerUntil = Date.now() + (e.retryAfterMs ?? Math.round(capped * (0.8 + Math.random() * 0.4)));
        writeBackoff(backoffFile, breakerUntil, failures);
        throw e;
      } finally { inFlight = null; }
    })();
    await inFlight;
    return keyPair;
  }

  async function doFetch(url, init = {}, retried = false) {
    const keyPair = await ensureToken(false);
    const method = (init.method || 'GET').toUpperCase();
    const proof = await dpopProof({ keyPair, htm: method, htu: htuOf(url), accessToken, nonce: rsNonce });
    const headers = {
      'user-agent': USER_AGENT,
      ...(init.headers || {}),
      authorization: `DPoP ${accessToken}`, dpop: proof,
    };
    const gate = gateFor(url); if (gate) headers['x-dk-token'] = gate;
    await waitForSlot(`${method} ${url}`);
    const res = await fetch(url, {
      signal: AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 20_000), ...init, headers,
    });
    if (res.status >= 500) note('server5xx');
    else if (res.status >= 400) note('client4xx');
    else note('ok');
    if (res.status === 401 && !retried) {
      const n = res.headers.get('dpop-nonce');
      if (n) { rsNonce = n; return doFetch(url, init, true); }   // server wants a nonce
      // Or the token expired — but a sweep whose every request 401s must not
      // mint a token per request, so force at most one grant per window and
      // otherwise retry with what we already hold.
      if (Date.now() - lastForced > FORCE_COOLDOWN_MS) {
        lastForced = Date.now();
        await ensureToken(true);
      }
      return doFetch(url, init, true);
    }
    return res;
  }

  // Confirms the credential works before the session is used — but a token we
  // already hold IS that confirmation, and forcing a grant here was defeating
  // the persisted one entirely: every restart paid the issuer for a token it
  // already had. Cold start still mints (and so still fails loudly on a revoked
  // credential); a warm one costs nothing.
  async function warmup() { await ensureToken(false); return webId; }

  return { webId, issuer: issuerOrigin, fetch: doFetch, warmup, stats };
}

module.exports = { mintCredential, discoverTokenEndpoint, revokeCredentialViaAccount, createGrantSession };
