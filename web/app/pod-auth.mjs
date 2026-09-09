// pod-auth.mjs — the pod side of sign-in, done in the browser with no server
// in between. It is the browser-native twin of lib/account.mjs and
// vendor/idp-grant.cjs: create a Community Solid Server account and pod, mint a
// client credential, and turn that credential into a DPoP-bound session whose
// fetch writes to the pod. Everything a Node agent did against a CSS account
// API, a page does here — proven cross-origin against solidcommunity.net on
// 2026-09-06 (claude/validation/scn-cross-origin-spike.html).
//
// No dependency on lib/: lib is Node (node:crypto, undici, @fedify). This uses
// only WebCrypto and fetch, so it runs in a tab and in a service worker.

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
const sha256 = async (str) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));

// A CSS account-API call: JSON in, JSON out, the account token carried the way
// CSS wants it (a bearer with its own scheme, not a cookie, in v7).
async function accountFetch(url, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `CSS-Account-Token ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error bodies exist */ }
  return { status: res.status, json };
}

/** Is this origin a CSS v7 account API at all? Cheap pre-flight for the form. */
export async function accountApiControls(issuer) {
  const origin = issuer.replace(/\/+$/, '');
  const { status, json } = await accountFetch(`${origin}/.account/`);
  if (status >= 400 || !json?.controls) return null;
  return json.controls;
}

/**
 * Create an account and a pod named `podName`. Idempotent on re-run: an
 * existing account logs in, an existing pod of the same name is reused. Refuses
 * to make a second pod on an account that already has one, which would give it
 * a second WebID a single credential could not match. Mirrors
 * lib/account.mjs's guards exactly, because the failure it prevents (a
 * credential bound to the wrong WebID that 403s every write) is the same here.
 */
export async function createAccountWithPod({ issuer, email, password, podName }) {
  const origin = issuer.replace(/\/+$/, '');
  const accountRoot = `${origin}/.account/`;

  let token;
  const login = await accountFetch(`${accountRoot}login/password/`, { method: 'POST', body: { email, password } });
  if (login.status < 400 && login.json?.authorization) {
    token = login.json.authorization;
  } else {
    const create = await accountFetch(`${accountRoot}account/`, { method: 'POST' });
    if (!create.json?.authorization) {
      throw new Error(`could not create an account at ${origin} (HTTP ${create.status})`
        + ` — is sign-up open there? ${create.json?.message || ''}`);
    }
    token = create.json.authorization;
    const pwCreate = (await accountFetch(accountRoot, { token })).json?.controls?.password?.create;
    if (!pwCreate) throw new Error('this server is not a CSS v7 account API (no password control)');
    const pw = await accountFetch(pwCreate, { method: 'POST', token, body: { email, password } });
    if (pw.status >= 400) throw new Error(`could not set the password (HTTP ${pw.status}): ${pw.json?.message || ''}`);
  }

  const podCreate = (await accountFetch(accountRoot, { token })).json?.controls?.account?.pod;
  if (!podCreate) throw new Error('this server does not offer pod creation through its account API');

  const findOwn = async () => {
    const pods = (await accountFetch(podCreate, { token })).json?.pods || {};
    return Object.entries(pods).find(([url]) => {
      try {
        const u = new URL(url);
        return u.hostname === podName || u.hostname.startsWith(`${podName}.`)
          || u.pathname.split('/').filter(Boolean).includes(podName);
      } catch { return false; }
    }) || null;
  };
  const owned = Object.keys((await accountFetch(podCreate, { token })).json?.pods || {});
  if (owned.length && !(await findOwn())) {
    throw new Error(`${email} already has a pod on ${new URL(origin).host} — one account, one pod.`
      + ' A second identity needs its own account. Nothing was created.');
  }
  const made = await accountFetch(podCreate, { method: 'POST', token, body: { name: podName } });
  let pod = made.json?.pod || made.json?.podBaseUrl || null;
  let webId = made.json?.webId || null;
  if (made.status >= 400 || !pod) {
    const own = await findOwn();
    if (own) { pod = own[0]; webId = webId || own[1]?.webId || null; }
    else if (made.status >= 400) throw new Error(`pod creation failed (HTTP ${made.status}): ${made.json?.message || ''}`);
  }
  if (!pod) throw new Error('the server did not report a pod URL');
  return { pod: pod.endsWith('/') ? pod : pod + '/', webId, accountToken: token };
}

/**
 * Mint a client credential against the account. `accountToken` reuses a login
 * from createAccountWithPod; otherwise email+password logs in. Returns the
 * credential record the agent expects, minus remotePod (the caller adds it).
 */
export async function mintCredential({ issuer, email, password, webId, podUrl, accountToken, name = 'fedipod' }) {
  const origin = issuer.replace(/\/+$/, '');
  const accountRoot = `${origin}/.account/`;

  let token = accountToken;
  if (!token) {
    // Sign in with the identifier the form gave (an email). If that account does
    // not own the target pod — or the sign-in fails outright — fall back to the
    // pod's subdomain as a username: older solidcommunity.net accounts sign in by
    // username, not email. Done behind the scenes so the form only asks for an email.
    const tryLogin = async (id) => {
      const r = await accountFetch(`${accountRoot}login/password/`, { method: 'POST', body: { email: id, password } });
      return (r.status < 400 && r.json?.authorization) ? r.json.authorization : null;
    };
    const ownsPod = async (tok) => {
      if (!podUrl) return true;
      try {
        const ctl = (await accountFetch(accountRoot, { token: tok })).json?.controls?.account?.webId;
        const links = ctl ? (await accountFetch(ctl, { token: tok })).json?.webIdLinks : null;
        return Object.keys(links || {}).some((w) => new URL(w).origin === new URL(podUrl).origin);
      } catch { return false; }
    };
    token = await tryLogin(email);
    let sub = null; try { sub = podUrl ? new URL(podUrl).host.split('.')[0] : null; } catch { /* podUrl not a URL */ }
    if (sub && sub !== email && (!token || !(await ownsPod(token)))) {
      const alt = await tryLogin(sub);
      if (alt) token = alt;
    }
    if (!token) throw new Error('account login failed — check the email or username and the password');
  }

  const controls = (await accountFetch(accountRoot, { token })).json?.controls;
  const ccUrl = controls?.account?.clientCredentials;
  if (!ccUrl) throw new Error('this server is not a CSS account API (no clientCredentials control)');

  let wid = webId;
  if (!wid) {
    const linkCtl = controls?.account?.webId;
    const links = linkCtl ? (await accountFetch(linkCtl, { token })).json?.webIdLinks : null;
    const all = links ? Object.keys(links) : [];
    if (!all.length) throw new Error('no WebID is linked to this account');
    if (podUrl) {
      // The credential MUST be for a WebID that owns the target pod, or every
      // write to it is rejected. Never fall back to an unrelated WebID: a
      // credential bound to the wrong identity 401s/403s on the pod, which is
      // the opaque "could not store the key" people then see.
      let origins = [];
      try { origins = all.filter((w) => new URL(w).origin === new URL(podUrl).origin); } catch { /* podUrl not a URL */ }
      if (!origins.length) {
        throw new Error(`the account you signed in with does not own ${new URL(podUrl).origin}. `
          + `It is linked to ${all.length} WebID${all.length > 1 ? 's' : ''} — on `
          + `${all.map((w) => new URL(w).host).join(', ')} — none of them this pod. `
          + 'Sign in with the account that owns this pod, or let FediPod make you a new one.');
      }
      wid = origins[0];
    } else {
      wid = all[0];
    }
  }

  const made = await accountFetch(ccUrl, { method: 'POST', token, body: { name, webId: wid } });
  if (made.status >= 400 || !made.json?.secret) throw new Error(`mint failed (HTTP ${made.status}): ${made.json?.message || ''}`);
  const tokenEndpoint = await discoverTokenEndpoint(origin);
  return { clientId: made.json.id, secret: made.json.secret, webId: wid, tokenEndpoint,
    resource: made.json.resource, issuerOrigin: origin };
}

/** The OIDC token endpoint, from the issuer's discovery document. */
export async function discoverTokenEndpoint(issuer) {
  const origin = issuer.replace(/\/+$/, '');
  try {
    const res = await fetch(`${origin}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const doc = await res.json();
      if (doc.token_endpoint) return doc.token_endpoint;
    }
  } catch { /* fall through to the CSS default */ }
  return `${origin}/.oidc/token`;
}

/**
 * A DPoP-bound session: one ES256 proof key, a client-credentials access token
 * bound to it, and a `fetch` that signs every request. The same key must sign
 * the token request and every resource request, or the token's binding fails,
 * so the key is made once and kept.
 */
export async function makeDpopSession({ clientId, secret, tokenEndpoint }) {
  const proofKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', proofKey.publicKey);
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };

  const proof = async (htm, htu, ath) => {
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk };
    const payload = { htm, htu: htu.split('#')[0], jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000), ...(ath ? { ath } : {}) };
    const data = `${enc(header)}.${enc(payload)}`;
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, proofKey.privateKey, new TextEncoder().encode(data));
    return `${data}.${b64u(sig)}`;
  };

  let token = null; let expiresAt = 0;
  const refresh = async () => {
    const basic = btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`);
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', dpop: await proof('POST', tokenEndpoint) },
      body: 'grant_type=client_credentials&scope=webid',
    });
    const tok = await res.json().catch(() => ({}));
    if (!tok.access_token) throw new Error(`token request failed (HTTP ${res.status}): ${tok.error || ''}`);
    token = tok.access_token;
    expiresAt = Date.now() + Math.max(30, (tok.expires_in || 300) - 30) * 1000;
    return token;
  };

  const authFetch = async (url, init = {}) => {
    if (!token || Date.now() > expiresAt) await refresh();
    const ath = b64u(await sha256(token));
    const headers = { ...(init.headers || {}), authorization: `DPoP ${token}`, dpop: await proof((init.method || 'GET'), url, ath) };
    return fetch(url, { ...init, headers });
  };

  return { fetch: authFetch, refresh };
}
