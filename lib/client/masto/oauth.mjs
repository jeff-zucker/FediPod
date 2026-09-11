// oauth.mjs — how a client gets in: registered apps and client documents,
// authorization codes and PKCE, the bearer tokens and their scopes, the
// password gate, and the three /oauth endpoints plus app registration.

import crypto from 'node:crypto';
import { isCrossSiteNavigation } from '../../shared/guard.mjs';
import { safeFetch, readCapped } from '../../shared/safefetch.mjs';
import { readBody } from './body.mjs';

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;   // tokens age out after 90 days
const AUTHZ_WINDOW_MS = 60_000;
const AUTHZ_MAX_ATTEMPTS = 5;
const CODE_TTL_MS = 5 * 60_000;                  // an authorization code is short-lived
const MAX_APPS = 200;                            // registered third-party clients, capped
const CLIENT_DOC_TTL_MS = 10 * 60_000;           // how long a fetched client document is trusted
const CLIENT_DOC_MAX_CACHED = 200;               // ids remembered at once; oldest out
const CLIENT_DOC_WINDOW_MS = 60_000;
const CLIENT_DOC_MAX_FETCHES = 20;               // outbound lookups per window
const CLIENT_DOC_MAX = 64 * 1024;                // it names a client; it is not a payload

// scrypt check for the optional UI password ({ saltHex, hashHex } record —
// see hashPassword, used by the passwd CLI).
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return { saltHex: salt.toString('hex'), hashHex: hash.toString('hex') };
}
export function checkPassword(rec, password) {
  try {
    const hash = crypto.scryptSync(String(password), Buffer.from(rec.saltHex, 'hex'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(rec.hashHex, 'hex'));
  } catch { return false; }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The authorize login page: every original OAuth param rides along as a
// hidden field so the POST can complete the flow.
// redirect_uris arrive as an array or a whitespace-separated string (Mastodon
// accepts both); normalise to a trimmed, non-empty list.
const parseRedirects = (v) => (Array.isArray(v) ? v : String(v || '').split(/\s+/))
  .map(s => s.trim()).filter(Boolean);

function sendLoginForm(res, params, error = '', client = null, status = null, headers = {}) {
  const hidden = [...params.entries()].filter(([k]) => k !== 'password')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n');
  // Name what is asking, so the owner approves a client they can see rather
  // than an opaque one. The destination the code will be sent to is the fact
  // that matters for a cross-site client.
  let asking = '<p>Enter the agent password to authorize this client.</p>';
  if (client && (client.name || client.redirect)) {
    let where = '';
    try { where = client.redirect ? new URL(client.redirect).host : ''; } catch { /* oob or blank */ }
    const who = client.name ? escapeHtml(client.name) : (where ? escapeHtml(where) : 'A client');
    asking = `<p><strong>${who}</strong> is asking to access your account`
      + `${where ? `, sending the authorization to <code>${escapeHtml(where)}</code>` : ''}.</p>`
      + `<p>Scope: <code>${escapeHtml(client.scope || 'read')}</code>. Enter the agent password to allow it.</p>`;
  }
  res.writeHead(status || (error ? 401 : 200),
    { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FediPod — authorize</title>
<style>:root{color-scheme:light dark;font-size:125%;--heading:#1a4f8a}
body{font:1rem system-ui,sans-serif;max-width:22rem;margin:15vh auto;padding:0 1rem}
h1{color:var(--heading)}
code{word-break:break-all}
@media (prefers-color-scheme:dark){:root{--heading:#7fb3e8}}
input,button{font:inherit;width:100%;padding:.5rem;margin:.3rem 0;box-sizing:border-box}
.err{color:#b00020}
@media (prefers-color-scheme:dark){.err{color:#ff8a8a}}</style></head><body>
<main>
<h1>FediPod</h1>
${asking}
${error ? `<p class="err" id="login-err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/oauth/authorize">
${hidden}
<label for="password">Agent password</label>
<input type="password" id="password" name="password" autofocus autocomplete="current-password"
  ${error ? 'aria-invalid="true" aria-describedby="login-err"' : ''}>
<button type="submit">Authorize</button>
</form>
</main></body></html>`);
  return true;
}

// What one request needs. Mastodon's four coarse scopes; a client that was
// granted a granular `write:statuses` satisfies `write` here, which is the
// direction that cannot let anything through that `write` would not.
//
// Reads are `read`, writes are `write`, and the two Mastodon carves out are
// kept: relationship changes accept the legacy `follow`, and push
// subscriptions want `push`. Nothing here grants across: `write` does NOT
// imply `read`, exactly as on Mastodon, so a write-only client cannot read
// the owner's direct messages.
export function scopeFor(method, pathname) {
  if (/^\/api\/v\d\/push\//u.test(pathname)) return 'push';
  const relationship = /^\/api\/v1\/(accounts\/[a-f0-9]+\/(follow|unfollow|block|unblock|mute|unmute|remove_from_followers)|follow_requests\/)/u;
  if (method !== 'GET' && method !== 'HEAD') {
    return relationship.test(pathname) ? 'follow' : 'write';
  }
  return 'read';
}

// Whether a token's granted scopes satisfy `need`.
//
// A record with NO scope is a token minted before scopes were kept — it is
// full authority, because that is what it was granted, and quietly demoting
// live 90-day tokens would sign people out of working clients for a bug that
// was ours. New tokens all carry one.
export function scopeAllows(granted, need) {
  if (granted == null) return true;                       // pre-scope token
  const have = String(granted).split(/[\s,+]+/u).filter(Boolean);
  if (!have.length) return true;
  if (need === 'follow') {
    // Mastodon's `follow` is the legacy spelling; `write` covers it too.
    return have.some((g) => g === 'follow' || g === 'write' || g.startsWith('write:'));
  }
  return have.some((g) => g === need || g.startsWith(`${need}:`));
}

/**
 * Whether a redirect the client asked for is one it published.
 *
 * A native client listens on whatever port the machine gave it, so it can
 * only publish the loopback address without one (RFC 8252). The port is
 * therefore not part of the match there, and nowhere else.
 */
export function redirectMatches(published, asked) {
  if (published === asked) return true;
  try {
    const a = new URL(published);
    const b = new URL(asked);
    const loopback = (h) => h === '127.0.0.1' || h === '[::1]' || h === 'localhost';
    if (!loopback(a.hostname) || a.hostname !== b.hostname) return false;
    return a.protocol === b.protocol
      && a.pathname.replace(/\/$/u, '') === b.pathname.replace(/\/$/u, '');
  } catch { return false; }
}

/**
 * Whether this verifier is the one the challenge was made from (RFC 7636).
 * Length is checked because a short verifier is guessable, which is the
 * whole thing this is here to prevent.
 */
export function provesCode(rec, verifier) {
  const v = String(verifier || '');
  if (v.length < 43 || v.length > 128) return false;
  if ((rec.challengeMethod || 'plain') === 'S256') {
    const made = crypto.createHash('sha256').update(v).digest('base64url');
    const given = Buffer.from(made);
    const known = Buffer.from(String(rec.challenge));
    return given.length === known.length && crypto.timingSafeEqual(given, known);
  }
  const given = Buffer.from(v);
  const known = Buffer.from(String(rec.challenge));
  return given.length === known.length && crypto.timingSafeEqual(given, known);
}

// ---- tokens ----
// Tokens are records {token, createdAt} and expire; legacy bare strings
// are read as undated and treated as expired-on-sight only if older
// formats can't be dated (they get an epoch of now on first migration).
export function tokenRecords(api) {
  const raw = api.store.read('masto-tokens.json', []);
  return raw.map(r => (typeof r === 'string' ? { token: r, createdAt: Date.now() } : r));
}

export function tokens(api) {
  const now = Date.now();
  return api.tokenRecords().filter(r => now - (r.createdAt || 0) < TOKEN_TTL_MS).map(r => r.token);
}

// `scope` is what the owner actually granted at /oauth/authorize. It used to
// be discarded: every token was full authority, so a client that asked for
// `read` could post, delete, and edit the profile. Recorded now, and enforced
// at the one gate every client route passes (see scopeFor / authed).
export function mintToken(api, scope = null) {
  const t = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const kept = api.tokenRecords().filter(r => now - (r.createdAt || 0) < TOKEN_TTL_MS);
  api.store.write('masto-tokens.json',
    [...kept, { token: t, createdAt: now, ...(scope ? { scope } : {}) }].slice(-20));
  return t;
}

// Registered OAuth apps. A third-party (browser) client registers here, and
// the authorization code it later receives is bound to the client_id and the
// redirect_uri it registered — so the code reaches only where that client
// said, and only that client, presenting its secret, can exchange it for a
// bearer. A redirect back to this agent's own origin keeps the local flow.
export function apps(api) { return api.store.read('oauth-apps.json', []); }

/**
 * What a client needs to know before it can sign in, at the address RFC 8414
 * puts it. The actor carries the same two endpoints; a client that looks
 * here first finds everything rather than the minimum.
 *
 * `none` among the authentication methods is what says a client keeping no
 * secret is welcome, which is the whole of what a browser app needs to hear.
 */
export function authorizationServerMetadata(api, origin) {
  const at = (p) => `${origin.replace(/\/$/u, '')}${p}`;
  return {
    issuer: origin.replace(/\/$/u, ''),
    authorization_endpoint: at('/oauth/authorize'),
    token_endpoint: at('/oauth/token'),
    revocation_endpoint: at('/oauth/revoke'),
    registration_endpoint: at('/api/v1/apps'),
    response_types_supported: [ 'code' ],
    grant_types_supported: [ 'authorization_code' ],
    code_challenge_methods_supported: [ 'S256', 'plain' ],
    token_endpoint_auth_methods_supported: [ 'client_secret_post', 'none' ],
    scopes_supported: [ 'read', 'write', 'follow', 'push' ],
  };
}

export function findApp(api, clientId) { return clientId ? api.apps().find(a => a.clientId === clientId) || null : null; }

/**
 * A client that publishes its own metadata document is named by that
 * document's URL and registers nothing here: the document says who it is
 * and where it may be sent back to. Such a client keeps no secret, so it
 * always proves itself with a challenge instead.
 *
 * The fetch is the guarded one — a client id is a URL a stranger chose, and
 * an unguarded fetch of it would ask this machine to reach wherever they
 * pointed.
 */
export async function resolveClientDocument(api, clientId) {
  if (!/^https:\/\//iu.test(String(clientId || ''))) return null;   // cleartext is refused
  api.clientDocs = api.clientDocs || new Map();
  const seen = api.clientDocs.get(clientId);
  // A cached FAILURE counts. Only successes were remembered, so a client id
  // that 404s (or is not a client document at all) was re-fetched on every
  // single call — and this runs on an unauthenticated GET, so a page could
  // fire these in a loop and have the owner's machine hammer an address of
  // the attacker's choosing, from the owner's IP, indefinitely.
  if (seen && Date.now() - seen.at < CLIENT_DOC_TTL_MS) return seen.client;
  // And a budget, because caching alone still lets a fresh id per request
  // through. `safeFetch` keeps every one of these to a public address, so
  // this is not internal SSRF — it is amplification, and a cap is what
  // amplification needs.
  if (!api._clientDocFetches || Date.now() - api._clientDocWindow > CLIENT_DOC_WINDOW_MS) {
    api._clientDocWindow = Date.now();
    api._clientDocFetches = 0;
  }
  if (api._clientDocFetches >= CLIENT_DOC_MAX_FETCHES) {
    api.log(`client document ${clientId} not fetched: too many lookups this minute`);
    return null;
  }
  api._clientDocFetches += 1;
  // The Map has a TTL but had no ceiling, so it grew for as long as an
  // attacker cared to serve distinct documents. Oldest out when it is full;
  // Map iterates in insertion order, so the first key is the oldest.
  if (api.clientDocs.size >= CLIENT_DOC_MAX_CACHED) {
    api.clientDocs.delete(api.clientDocs.keys().next().value);
  }
  const remember = (client) => { api.clientDocs.set(clientId, { at: Date.now(), client }); return client; };
  let doc;
  try {
    const res = await safeFetch(clientId, { headers: { accept: 'application/json' } });
    if (res.status >= 400) { api.log(`client document ${clientId} → ${res.status}`); return remember(null); }
    doc = JSON.parse(await readCapped(res, CLIENT_DOC_MAX));
  } catch (e) {
    api.log(`client document ${clientId} could not be read: ${e.message}`);
    return remember(null);
  }
  // It must claim to be itself: a document naming some other id would let
  // one client borrow another's name.
  if (doc?.client_id !== clientId) {
    api.log(`client document ${clientId} names ${doc?.client_id ?? 'nothing'} — refused`);
    return remember(null);
  }
  const redirectUris = [].concat(doc.redirect_uris || []).filter((u) => typeof u === 'string');
  if (!redirectUris.length) { api.log(`client document ${clientId} names no redirect — refused`); return remember(null); }
  const client = {
    clientId, redirectUris,
    name: String(doc.client_name || clientId).slice(0, 200),
    scopes: 'read write follow',
  };
  return remember(client);
}

export function registerApp(api, { name, website, redirectUris, scopes }) {
  const app = {
    clientId: crypto.randomBytes(16).toString('hex'),
    clientSecret: crypto.randomBytes(32).toString('base64url'),
    name: String(name || 'client').slice(0, 200),
    website: String(website || '').slice(0, 500),
    redirectUris, scopes: String(scopes || 'read'), createdAt: Date.now(),
  };
  api.store.write('oauth-apps.json', [...api.apps(), app].slice(-MAX_APPS));
  return app;
}

// A short-lived, single-use authorization code for a registered client, kept
// apart from masto-tokens.json so the code is NOT a bearer until it is
// exchanged with the client secret.
export function mintCode(api, { clientId, redirectUri, scope, challenge = null, challengeMethod = null }) {
  const code = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const kept = api.store.read('oauth-codes.json', []).filter(c => now - c.createdAt < CODE_TTL_MS);
  api.store.write('oauth-codes.json', [ ...kept, {
    code, clientId, redirectUri, scope, createdAt: now,
    // What the client promised to prove when it comes back for the token.
    // A client that cannot keep a secret — anything running in a browser —
    // has this instead, and it is the only thing standing between a stolen
    // code and a token.
    ...(challenge ? { challenge, challengeMethod: challengeMethod || 'plain' } : {}),
  } ].slice(-50));
  return code;
}

export function consumeCode(api, code) {
  const now = Date.now();
  const all = api.store.read('oauth-codes.json', []);
  const rec = all.find(c => c.code === code && now - c.createdAt < CODE_TTL_MS);
  if (rec) api.store.write('oauth-codes.json', all.filter(c => c.code !== code));   // single-use
  return rec || null;
}

// The live record for the bearer on this request, or null.
export function tokenOf(api, req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const now = Date.now();
  return api.tokenRecords().find(
    (r) => r.token === m[1] && now - (r.createdAt || 0) < TOKEN_TTL_MS) || null;
}

export function authed(api, req) { return !!api.tokenOf(req); }

// A redirect_uri must name an authority this agent answers on — otherwise
// a visited page could navigate to /oauth/authorize and have the freshly
// minted code delivered to itself.
export function redirectAllowed(api, redirect) {
  if (!redirect || redirect === 'urn:ietf:wg:oauth:2.0:oob') return true;
  if (!api.allowed) return true;                       // no policy configured (tests)
  try {
    const u = new URL(redirect);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return api.allowed.has(u.host.toLowerCase());
  } catch { return false; }
}

export function rateLimited(api) {
  const now = Date.now();
  api.authzAttempts = api.authzAttempts.filter(t => now - t < AUTHZ_WINDOW_MS);
  if (api.authzAttempts.length >= AUTHZ_MAX_ATTEMPTS) return true;
  api.authzAttempts.push(now);
  return false;
}

export async function handle(api, ctx) {
  const { req, res, pathname, url, send } = ctx;   // eslint-disable-line no-unused-vars

  // --- oauth ---
  // With no UI password configured this is "theater": whoever can reach the
  // loopback surface IS the trusted user, and authorize redirects at once.
  // With a password set (required before any non-loopback exposure), the
  // authorize step becomes a real login form.
  if (pathname === '/api/v1/apps' && req.method === 'POST') {
    const body = await readBody(req);
    const redirectUris = parseRedirects(body.redirect_uris);
    const app = api.registerApp({ name: body.client_name, website: body.website,
      redirectUris, scopes: body.scopes });
    return send(200, {
      id: app.clientId, name: app.name, website: app.website,
      client_id: app.clientId, client_secret: app.clientSecret,
      redirect_uri: redirectUris.join(' ') || 'urn:ietf:wg:oauth:2.0:oob',
      ...(api.webPush ? { vapid_key: api.push.publicKey() } : {}),
    });
  }
  if (pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
    const pw = api.store.getConfig()?.uiPassword;   // { saltHex, hashHex } scrypt record
    let params = url.searchParams;
    let body = null;
    if (req.method === 'POST') { body = await readBody(req); params = new URLSearchParams(body); }
    const redirect = params.get('redirect_uri') || '';
    const app = api.findApp(params.get('client_id') || '');
    // A client that published its own metadata document needs no
    // registration here: the document is its name and says where it may be
    // sent back to.
    const doc = app ? null : await api.resolveClientDocument(params.get('client_id') || '');
    // A REGISTERED client is always the third-party flow — its code is
    // bound to it and exchanged with its secret — even when its redirect
    // points back at this very agent (a web client served from our own
    // origin registers itself exactly like a phone app does). The local
    // code-is-the-token flow is only for the built-in client, which never
    // registers.
    const external = !!app || !!doc;

    // S36. Two doors were open at once, and together they handed a bearer for
    // this account to any page the owner happened to be reading.
    //
    // /api/v1/apps takes any redirect_uri from anyone — as it must, that is
    // how a fediverse client registers — and the instant-authorize path below
    // mints without a password whenever the request "is this machine". A page
    // in another tab is this machine. So: register a client whose redirect is
    // your own server, navigate the owner's browser to /oauth/authorize, and
    // the code arrives at your address. The agent's own CA is in the browser's
    // trust store, so https://localhost:<port> loads without a murmur.
    //
    // Two locks, either of which alone would do, both cheap:
    //
    // 1. A cross-site NAVIGATION may not reach the mint. A client signing in
    //    navigates from its own page and is same-site; a page on somebody
    //    else's site is not. (Absent Sec-Fetch-Site — curl, an old browser —
    //    is not cross-site and still passes, as everywhere else in this
    //    project; the second lock is what covers that case.)
    if (isCrossSiteNavigation(req)) {
      api.log(`authorize refused: cross-site navigation to the mint from ${req.headers.referer || 'nowhere'}`);
      return send(403, { error: 'a cross-site navigation may not authorize a client' });
    }
    // 2. With NO password set there is nothing to authorize a third party
    //    WITH. The password-less path is honest only for a client on an
    //    address this agent itself answers on — where "whoever reaches the
    //    port is the owner" is a statement about the machine rather than
    //    about a web page. Anything pointing elsewhere has to be approved by
    //    somebody who knows the password.
    if (external && !api.store.getConfig()?.uiPassword && !api.redirectAllowed(redirect)) {
      api.log(`authorize refused: no UI password, and "${redirect}" is not an address of this agent`);
      return send(403, {
        error: 'this client asks to be sent somewhere other than this agent, and no password is '
          + 'set to approve that with. Run `fedipod passwd` and try again.',
      });
    }
    const client = { name: app?.name || doc?.name || null, redirect, scope: params.get('scope') || 'read' };
    if (app) {
      if (!app.redirectUris.includes(redirect)) {
        api.log(`authorize refused: redirect_uri "${redirect}" not registered for ${app.clientId}`);
        return send(400, { error: 'redirect_uri was not registered by this client' });
      }
    } else if (doc) {
      if (!doc.redirectUris.some((u) => redirectMatches(u, redirect))) {
        api.log(`authorize refused: redirect_uri "${redirect}" is not one ${doc.clientId} published`);
        return send(400, { error: 'redirect_uri is not one this client published' });
      }
      // It keeps no secret, so the challenge is the only thing that will
      // stand between its code and a token. Refuse now rather than mint a
      // code nothing can prove.
      if (!params.get('code_challenge')) {
        api.log(`authorize refused: ${doc.clientId} keeps no secret and offered no challenge`);
        return send(400, { error: 'a client identified by its own document must send a code_challenge' });
      }
    } else if (!api.redirectAllowed(redirect)) {
      api.log(`authorize refused: redirect_uri "${redirect}" is not this agent`);
      return send(400, { error: 'redirect_uri must be an address of this agent' });
    }
    if (req.method === 'POST') {
      if (api.rateLimited()) {
        api.log('authorize rate limited');
        // 429, not 401: a client that reads this as a wrong password will
        // ask the person to type it again, which is the one thing that
        // cannot help. Retry-After says how long the wait actually is.
        return sendLoginForm(res, params, 'too many attempts — wait a minute', client,
          429, { 'retry-after': String(Math.ceil(AUTHZ_WINDOW_MS / 1000)) });
      }
      if (!pw || !checkPassword(pw, body.password || '')) {
        return sendLoginForm(res, params, 'wrong password — try again', client);
      }
    } else if (pw) {
      // The login/approve screen names what is asking before the owner types
      // the password — a cross-site client cannot forge past that.
      return sendLoginForm(res, params, '', client);
    } else if (api.allowed && !api.allowed.isLocalRequest(req)) {
      // No password set, and this request did not come from this machine.
      //
      // The instant-authorize path is honest theatre on loopback: whoever can
      // reach it IS the trusted user. It stops being theatre the moment an
      // operator takes the documented AP_ALLOWED_HOSTS route and puts the
      // agent on a tailnet name or behind a reverse proxy, because anyone who
      // reaches that name is then handed a 90-day bearer for the whole facade
      // — update_credentials included, which is precisely the authority the
      // isLocal check on /setup and /config exists to withhold. /oauth is
      // dispatched before that check ever runs, so it needs its own.
      api.log(`authorize refused: no UI password, and "${req.headers.host}" is not this machine`);
      return send(403, {
        error: 'this agent answers on an address outside this machine and has no password set — '
          + (api.embedded
            ? 'POST {"password":"…"} to the owner door\'s /config with its door secret before logging in'
            : 'run `fedipod passwd` before logging in over that address'),
      });
    }
    // External clients get a bound code; the local flow keeps code==token.
    const code = external
      ? api.mintCode({ clientId: (app || doc).clientId, redirectUri: redirect, scope: client.scope,
        challenge: params.get('code_challenge') || null,
        challengeMethod: params.get('code_challenge_method') || null })
      : api.mintToken(client.scope);
    if (!redirect || redirect === 'urn:ietf:wg:oauth:2.0:oob') return send(200, { code });
    const target = new URL(redirect);
    target.searchParams.set('code', code);
    if (params.get('state')) target.searchParams.set('state', params.get('state'));
    res.writeHead(302, { location: target.href });
    res.end();
    return true;
  }
  if (pathname === '/oauth/token' && req.method === 'POST') {
    const body = await readBody(req);
    // A registered third-party client exchanges its bound code, proving its
    // secret, for a real bearer — the code alone is not a token.
    const app = api.findApp(body.client_id || '');
    // A client named by its own document keeps no secret at all, so the
    // challenge is the whole of its proof. The code carries the document's
    // URL as the client it was bound to.
    if (!app && body.code_verifier && /^https:\/\//iu.test(String(body.client_id || ''))) {
      const rec = api.consumeCode(body.code || '');
      if (!rec || rec.clientId !== body.client_id
        || (body.redirect_uri && rec.redirectUri !== body.redirect_uri)) {
        api.log('token refused: code is not a live authorization for that client document');
        return send(400, { error: 'invalid_grant' });
      }
      if (!rec.challenge || !provesCode(rec, body.code_verifier)) {
        api.log('token refused: the verifier does not answer the challenge this code was made with');
        return send(400, { error: 'invalid_grant' });
      }
      return send(200, { access_token: api.mintToken(rec.scope || 'read'), token_type: 'Bearer',
        scope: rec.scope || 'read', created_at: Math.floor(Date.now() / 1000),
        ...(api.urls?.actor ? { activitypub_actor_id: api.urls.actor } : {}) });
    }
    // A client that runs in a browser cannot keep a secret, so it proves it
    // is the same caller that asked instead: it sends the verifier for the
    // challenge it presented at authorize (RFC 7636). Sending a verifier is
    // what says which of the two flows this is.
    if (app && body.code_verifier) {
      const rec = api.consumeCode(body.code || '');
      if (!rec || rec.clientId !== app.clientId || (body.redirect_uri && rec.redirectUri !== body.redirect_uri)) {
        api.log('token refused: code is not a live authorization for this client');
        return send(400, { error: 'invalid_grant' });
      }
      // A code minted without a challenge cannot be redeemed with one: that
      // would let anyone holding a stolen code invent the proof for it.
      if (!rec.challenge || !provesCode(rec, body.code_verifier)) {
        api.log('token refused: the verifier does not answer the challenge this code was made with');
        return send(400, { error: 'invalid_grant' });
      }
      return send(200, { access_token: api.mintToken(rec.scope || 'read'), token_type: 'Bearer',
        scope: rec.scope || 'read', created_at: Math.floor(Date.now() / 1000),
        ...(api.urls?.actor ? { activitypub_actor_id: api.urls.actor } : {}) });
    }
    if (app && body.client_secret) {
      const given = Buffer.from(String(body.client_secret));
      const known = Buffer.from(app.clientSecret);
      const okSecret = given.length === known.length && crypto.timingSafeEqual(given, known);
      if (!okSecret) { api.log('token refused: client secret mismatch'); return send(401, { error: 'invalid_client' }); }
      const rec = api.consumeCode(body.code || '');
      if (!rec || rec.clientId !== app.clientId || (body.redirect_uri && rec.redirectUri !== body.redirect_uri)) {
        api.log('token refused: code is not a live authorization for this client');
        return send(400, { error: 'invalid_grant' });
      }
      // A challenge, once made, is not optional: without this a client could
      // present one and then skip past it with the secret alone.
      if (rec.challenge && !provesCode(rec, body.code_verifier)) {
        api.log('token refused: this code was made with a challenge and the verifier does not answer it');
        return send(400, { error: 'invalid_grant' });
      }
      return send(200, { access_token: api.mintToken(rec.scope || 'read'), token_type: 'Bearer',
        scope: rec.scope || 'read', created_at: Math.floor(Date.now() / 1000),
        // Which actor the token acts for. A Mastodon client ignores it; an
        // ActivityPub API client needs it, and asking for it separately
        // would mean a second round trip before it knows who it is.
        ...(api.urls?.actor ? { activitypub_actor_id: api.urls.actor } : {}) });
    }
    // Local flow: the code IS the token, minted by /oauth/authorize after the
    // password gate. Minting one here for an unrecognised code handed a
    // bearer to anyone who could reach the port — and a non-browser client
    // sends no Origin, so the firewall never saw it. That defeated `passwd`
    // on any agent deliberately exposed through AP_ALLOWED_HOSTS.
    if (!body.code || !api.tokens().includes(body.code)) {
      api.log('token refused: code is not a live authorization');
      return send(400, { error: 'invalid_grant' });
    }
    // The scope this token was actually minted with, not whatever the client
    // asks to be told — reporting one and enforcing another is how a client
    // ends up surprised by a 403 it was promised it would not get.
    const granted = api.tokenRecords().find((r) => r.token === body.code)?.scope
      || 'read write follow push';
    return send(200, { access_token: body.code, token_type: 'Bearer',
      scope: granted, created_at: Math.floor(Date.now() / 1000),
      ...(api.urls?.actor ? { activitypub_actor_id: api.urls.actor } : {}) });
  }
  if (pathname === '/oauth/revoke' && req.method === 'POST') {
    // It used to answer 200 and keep the token, so logging out of a client
    // left a working 90-day bearer behind. Mastodon's endpoint takes `token`;
    // an unknown one is still a 200, which is what the spec asks for.
    const body = await readBody(req).catch(() => ({}));
    const gone = body?.token;
    if (gone) {
      const kept = api.tokenRecords().filter(r => r.token !== gone);
      api.store.write('masto-tokens.json', kept);
      api.log('client token revoked');
    }
    return send(200, {});
  }

  return false;
}
