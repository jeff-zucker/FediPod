// prelude.js — globals the bundled Node code expects, set once before it runs.
// Injected as the bundle's banner. Kept minimal and local: Buffer is a subclass
// of Uint8Array (not a prototype patch), so nothing else in the page is touched.
globalThis.process ??= { env: {}, argv: [], platform: 'browser', cwd: () => '/', nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };
globalThis.Buffer ??= (() => {
  const b64 = (u) => btoa(String.fromCharCode(...u));
  const hex = (u) => { let s = ''; for (const b of u) s += b.toString(16).padStart(2, '0'); return s; };
  class Buf extends Uint8Array {
    toString(enc) {
      if (enc === 'hex') return hex(this);
      if (enc === 'base64') return b64(this);
      if (enc === 'base64url') return b64(this).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return new TextDecoder().decode(this);
    }
  }
  const fromString = (s, enc) => {
    if (enc === 'hex') return Buf.from(s.match(/.{1,2}/g) || [], (h) => parseInt(h, 16));
    if (enc === 'base64' || enc === 'base64url') {
      const n = s.replace(/-/g, '+').replace(/_/g, '/');
      return Buf.from(atob(n + '==='.slice((n.length + 3) % 4)), (c) => c.charCodeAt(0));
    }
    return Buf.from(new TextEncoder().encode(s));
  };
  const from = (d, enc) => {
    if (typeof d === 'string') return fromString(d, enc);
    if (typeof d === 'function') { const args = arguments; return Uint8Array.from.call(Buf, args[0], args[1]); }
    const b = new Buf(d.length); b.set(d); return b;
  };
  const fromAny = (d, e) => {
    if (typeof d === 'string') return fromString(d, e);
    if (typeof e === 'function') { const arr = Array.from(d, e); const b = new Buf(arr.length); b.set(arr); return b; }
    if (d instanceof Uint8Array || Array.isArray(d)) { const b = new Buf(d.length); b.set(d); return b; }
    return new Buf(d);
  };
  return {
    from: fromAny,
    concat: (list) => { const n = list.reduce((s, x) => s + x.length, 0); const o = new Buf(n); let i = 0; for (const x of list) { o.set(x, i); i += x.length; } return o; },
    alloc: (n) => new Buf(n),
    isBuffer: (x) => x instanceof Uint8Array,
  };
})();


// web/app/pod-auth.mjs
var b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
var sha256 = async (str) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
async function accountFetch(url, { method = "GET", body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== void 0) headers["content-type"] = "application/json";
  if (token) headers.authorization = `CSS-Account-Token ${token}`;
  const res = await fetch(url, { method, headers, body: body === void 0 ? void 0 : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
  }
  return { status: res.status, json };
}
async function createAccountWithPod({ issuer, email, password, podName }) {
  const origin = issuer.replace(/\/+$/, "");
  const accountRoot = `${origin}/.account/`;
  let token;
  const login = await accountFetch(`${accountRoot}login/password/`, { method: "POST", body: { email, password } });
  if (login.status < 400 && login.json?.authorization) {
    token = login.json.authorization;
  } else {
    const create = await accountFetch(`${accountRoot}account/`, { method: "POST" });
    if (!create.json?.authorization) {
      throw new Error(`could not create an account at ${origin} (HTTP ${create.status}) \u2014 is sign-up open there? ${create.json?.message || ""}`);
    }
    token = create.json.authorization;
    const pwCreate = (await accountFetch(accountRoot, { token })).json?.controls?.password?.create;
    if (!pwCreate) throw new Error("this server is not a CSS v7 account API (no password control)");
    const pw = await accountFetch(pwCreate, { method: "POST", token, body: { email, password } });
    if (pw.status >= 400) throw new Error(`could not set the password (HTTP ${pw.status}): ${pw.json?.message || ""}`);
  }
  const podCreate = (await accountFetch(accountRoot, { token })).json?.controls?.account?.pod;
  if (!podCreate) throw new Error("this server does not offer pod creation through its account API");
  const findOwn = async () => {
    const pods = (await accountFetch(podCreate, { token })).json?.pods || {};
    return Object.entries(pods).find(([url]) => {
      try {
        const u = new URL(url);
        return u.hostname === podName || u.hostname.startsWith(`${podName}.`) || u.pathname.split("/").filter(Boolean).includes(podName);
      } catch {
        return false;
      }
    }) || null;
  };
  const owned = Object.keys((await accountFetch(podCreate, { token })).json?.pods || {});
  if (owned.length && !await findOwn()) {
    throw new Error(`${email} already has a pod on ${new URL(origin).host} \u2014 one account, one pod. A second identity needs its own account. Nothing was created.`);
  }
  const made = await accountFetch(podCreate, { method: "POST", token, body: { name: podName } });
  let pod = made.json?.pod || made.json?.podBaseUrl || null;
  let webId = made.json?.webId || null;
  if (made.status >= 400 || !pod) {
    const own = await findOwn();
    if (own) {
      pod = own[0];
      webId = webId || own[1]?.webId || null;
    } else if (made.status >= 400) throw new Error(`pod creation failed (HTTP ${made.status}): ${made.json?.message || ""}`);
  }
  if (!pod) throw new Error("the server did not report a pod URL");
  return { pod: pod.endsWith("/") ? pod : pod + "/", webId, accountToken: token };
}
async function mintCredential({ issuer, email, password, webId, podUrl, accountToken, name = "fedipod" }) {
  const origin = issuer.replace(/\/+$/, "");
  const accountRoot = `${origin}/.account/`;
  let token = accountToken;
  if (!token) {
    const tryLogin = async (id) => {
      const r = await accountFetch(`${accountRoot}login/password/`, { method: "POST", body: { email: id, password } });
      return r.status < 400 && r.json?.authorization ? r.json.authorization : null;
    };
    const ownsPod = async (tok) => {
      if (!podUrl) return true;
      try {
        const ctl = (await accountFetch(accountRoot, { token: tok })).json?.controls?.account?.webId;
        const links = ctl ? (await accountFetch(ctl, { token: tok })).json?.webIdLinks : null;
        return Object.keys(links || {}).some((w) => new URL(w).origin === new URL(podUrl).origin);
      } catch {
        return false;
      }
    };
    token = await tryLogin(email);
    let sub = null;
    try {
      sub = podUrl ? new URL(podUrl).host.split(".")[0] : null;
    } catch {
    }
    if (sub && sub !== email && (!token || !await ownsPod(token))) {
      const alt = await tryLogin(sub);
      if (alt) token = alt;
    }
    if (!token) throw new Error("account login failed \u2014 check the email or username and the password");
  }
  const controls = (await accountFetch(accountRoot, { token })).json?.controls;
  const ccUrl = controls?.account?.clientCredentials;
  if (!ccUrl) throw new Error("this server is not a CSS account API (no clientCredentials control)");
  let wid = webId;
  if (!wid) {
    const linkCtl = controls?.account?.webId;
    const links = linkCtl ? (await accountFetch(linkCtl, { token })).json?.webIdLinks : null;
    const all = links ? Object.keys(links) : [];
    if (!all.length) throw new Error("no WebID is linked to this account");
    if (podUrl) {
      let origins = [];
      try {
        origins = all.filter((w) => new URL(w).origin === new URL(podUrl).origin);
      } catch {
      }
      if (!origins.length) {
        throw new Error(`the account you signed in with does not own ${new URL(podUrl).origin}. It is linked to ${all.length} WebID${all.length > 1 ? "s" : ""} \u2014 on ${all.map((w) => new URL(w).host).join(", ")} \u2014 none of them this pod. Sign in with the account that owns this pod, or let FediPod make you a new one.`);
      }
      wid = origins[0];
    } else {
      wid = all[0];
    }
  }
  const made = await accountFetch(ccUrl, { method: "POST", token, body: { name, webId: wid } });
  if (made.status >= 400 || !made.json?.secret) throw new Error(`mint failed (HTTP ${made.status}): ${made.json?.message || ""}`);
  const tokenEndpoint = await discoverTokenEndpoint(origin);
  return {
    clientId: made.json.id,
    secret: made.json.secret,
    webId: wid,
    tokenEndpoint,
    resource: made.json.resource,
    issuerOrigin: origin
  };
}
async function discoverTokenEndpoint(issuer) {
  const origin = issuer.replace(/\/+$/, "");
  try {
    const res = await fetch(`${origin}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const doc = await res.json();
      if (doc.token_endpoint) return doc.token_endpoint;
    }
  } catch {
  }
  return `${origin}/.oidc/token`;
}
async function makeDpopSession({ clientId, secret, tokenEndpoint }) {
  const proofKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", proofKey.publicKey);
  const publicJwk2 = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const proof = async (htm, htu, ath) => {
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk2 };
    const payload = { htm, htu: htu.split("#")[0], jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1e3), ...ath ? { ath } : {} };
    const data = `${enc(header)}.${enc(payload)}`;
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, proofKey.privateKey, new TextEncoder().encode(data));
    return `${data}.${b64u(sig)}`;
  };
  let token = null;
  let expiresAt = 0;
  const refresh = async () => {
    const basic = btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`);
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", dpop: await proof("POST", tokenEndpoint) },
      body: "grant_type=client_credentials&scope=webid"
    });
    const tok = await res.json().catch(() => ({}));
    if (!tok.access_token) throw new Error(`token request failed (HTTP ${res.status}): ${tok.error || ""}`);
    token = tok.access_token;
    expiresAt = Date.now() + Math.max(30, (tok.expires_in || 300) - 30) * 1e3;
    return token;
  };
  const authFetch = async (url, init = {}) => {
    if (!token || Date.now() > expiresAt) await refresh();
    const ath = b64u(await sha256(token));
    const headers = { ...init.headers || {}, authorization: `DPoP ${token}`, dpop: await proof(init.method || "GET", url, ath) };
    return fetch(url, { ...init, headers });
  };
  return { fetch: authFetch, refresh };
}

// web/app/keystore.mjs
var PEM = (der, label) => {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----
${lines}
-----END ${label}-----
`;
};
async function generateKeys() {
  const rsa = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const rec = {
    rsa: {
      publicPem: PEM(await crypto.subtle.exportKey("spki", rsa.publicKey), "PUBLIC KEY"),
      privatePem: PEM(await crypto.subtle.exportKey("pkcs8", rsa.privateKey), "PRIVATE KEY")
    }
  };
  try {
    const ed = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
    rec.ed25519 = {
      publicPem: PEM(await crypto.subtle.exportKey("spki", ed.publicKey), "PUBLIC KEY"),
      privatePem: PEM(await crypto.subtle.exportKey("pkcs8", ed.privateKey), "PRIVATE KEY")
    };
  } catch {
  }
  return rec;
}

// web/app/signup.mjs
var AP_ROOT = "fedipod/";
var actorUrlFor = (pod) => `${pod}${AP_ROOT}ap/actor`;
var keysDocFor = (pod) => `${pod}${AP_ROOT}ap-state/keys.json`;
var HANDLE_RE = /^[a-z0-9-]{2,30}$/;
function handleProblem(handle) {
  if (!handle) return "a handle is required";
  if (!HANDLE_RE.test(handle)) return "letters, digits and hyphens only, 2\u201330 characters";
  if (handle.startsWith("-") || handle.endsWith("-")) return "cannot start or end with a hyphen";
  return null;
}
var PROGRESS = /* @__PURE__ */ new Map();
var progressKey = (a) => [a.issuer, a.mode, a.handle, a.mode === "new" ? a.podName || a.handle : a.pod].join("|");
async function signUp(answers, { onStep = () => {
}, frontOrigin = null } = {}) {
  const { mode, issuer, email, password, handle } = answers;
  const bad = handleProblem(handle);
  if (bad) throw new Error(bad);
  if (!email) throw new Error("an email is required");
  if (!password) throw new Error("a password is required");
  if (mode === "existing" && !answers.pod) throw new Error("a pod address is required");
  const key = progressKey(answers);
  const prog = PROGRESS.get(key) || {};
  PROGRESS.set(key, prog);
  const step = (key2) => ({
    running: (note) => onStep(key2, "running", note),
    ok: (note) => onStep(key2, "ok", note),
    skip: (note) => onStep(key2, "skipped", note)
  });
  let accountToken = null;
  const acct = step("account");
  if (!prog.pod) {
    if (mode === "new") {
      acct.running("creating the account and pod");
      const made = await createAccountWithPod({ issuer, email, password, podName: answers.podName || handle });
      prog.pod = made.pod;
      prog.webId = made.webId;
      accountToken = made.accountToken;
      acct.ok(made.pod);
    } else {
      const brought = answers.pod.endsWith("/") ? answers.pod : answers.pod + "/";
      acct.running("checking your pod");
      const head = await fetch(brought, { method: "HEAD" }).catch(() => null);
      if (!head || head.status >= 400) throw new Error(`the pod at ${brought} did not answer (HTTP ${head?.status || "no response"})`);
      prog.pod = brought;
      acct.skip("using the pod you brought");
    }
  } else {
    acct.ok(prog.pod);
  }
  const pod = prog.pod;
  const webId = prog.webId || null;
  const podUrl = new URL(pod);
  if (podUrl.pathname !== "/") {
    throw new Error(`${pod} is a path on ${podUrl.host}, not its own host. A Fediverse address lives at a host root, so this pod cannot carry one. Use a pod that is the root of its own subdomain.`);
  }
  const actorUrl = actorUrlFor(pod);
  const cred = step("credential");
  let credential;
  if (!prog.credential) {
    cred.running("minting a credential for this browser");
    credential = await mintCredential({ issuer, email, password, webId, podUrl: pod, accountToken });
    credential.remotePod = pod;
    credential.root = AP_ROOT;
    prog.credential = credential;
    cred.ok();
  } else {
    credential = prog.credential;
    cred.ok();
  }
  const session = await makeDpopSession(credential);
  const keysStep = step("keys");
  let keys;
  if (!prog.keysStored) {
    keysStep.running("making your signing key and storing it on the pod");
    keys = await generateKeys();
    keys.mintedFor = actorUrl;
    const put = await session.fetch(keysDocFor(pod), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(keys)
    });
    if (put.status >= 400) throw new Error(`could not store the signing key on the pod (HTTP ${put.status}). The credential is for ${credential.webId} \u2014 that WebID must own ${pod} and its ${AP_ROOT} must be writable by it.`);
    prog.keys = keys;
    prog.keysStored = true;
    keysStep.ok();
  } else {
    keys = prog.keys;
    keysStep.ok();
  }
  let gateway = answers.gateway || prog.gateway || null;
  if (frontOrigin && !gateway) {
    const gw = step("gateway");
    gw.running(`connecting your mail door on ${new URL(frontOrigin).host}`);
    const res = await session.fetch(`${frontOrigin.replace(/\/$/, "")}/api/attach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, podHome: pod, actorUrl, kind: "person" })
    });
    const d = await res.json().catch(() => ({}));
    if (res.status !== 201 || !d.hmacSecret) {
      throw new Error(`could not connect the mail door (HTTP ${res.status}): ${d.error || ""}`);
    }
    gateway = { url: d.doorInbox, hmacSecret: d.hmacSecret, mode: "trust" };
    prog.gateway = gateway;
    gw.ok();
  } else if (frontOrigin && gateway) {
    step("gateway").ok();
  }
  const config = {
    remotePod: pod,
    root: AP_ROOT,
    handle,
    name: handle,
    issuer: credential.issuerOrigin,
    ...gateway ? { gateway } : {}
  };
  const cfgPut = await session.fetch(`${pod}${AP_ROOT}ap-state/config.json`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config)
  });
  if (cfgPut.status >= 400) throw new Error(`could not store the config on the pod (HTTP ${cfgPut.status})`);
  PROGRESS.delete(key);
  const host = new URL(pod).host;
  return {
    credential,
    config,
    actorUrl,
    address: `@${handle}@${host}`,
    // The plaintext keys, for booting the agent in THIS browser session right
    // away. They live in memory only; the durable copy is the owner-only one on
    // the pod. A fresh browser gets them by reading that with its OIDC session.
    keys,
    keysPublic: { rsa: keys.rsa.publicPem, ed25519: keys.ed25519?.publicPem || null }
  };
}

// web/app/oidc-session.mjs
var DB = "fedipod-oidc";
var STORE = "session";
var b64u2 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var enc2 = (o) => b64u2(new TextEncoder().encode(JSON.stringify(o)));
var sha2562 = (s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
var rand = (n = 32) => b64u2(crypto.getRandomValues(new Uint8Array(n)));
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
  return new Promise((res, rej) => {
    const t = db.transaction(STORE).objectStore(STORE).get(key);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbPut(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbDel(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function dpopKey() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function publicJwk(pair) {
  const j = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
}
async function dpopProof(pair, jwk, htm, htu, ath) {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk };
  const payload = { htm, htu: htu.split("#")[0], jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1e3), ...ath ? { ath } : {} };
  const data = `${enc2(header)}.${enc2(payload)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(data));
  return `${data}.${b64u2(sig)}`;
}
var jwtPayload = (jwt) => {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
};
async function discover(issuer) {
  const res = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`OIDC discovery failed at ${issuer} (HTTP ${res.status})`);
  return res.json();
}
async function registerClient(cfg, redirectUri, clientName) {
  const res = await fetch(cfg.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      application_type: "web",
      scope: "openid webid offline_access"
    })
  });
  if (!res.ok) throw new Error(`client registration failed (HTTP ${res.status})`);
  return (await res.json()).client_id;
}
async function beginLogin({ issuer, redirectUri, clientName = "FediPod" }) {
  const cfg = await discover(issuer);
  const client_id = await registerClient(cfg, redirectUri, clientName);
  const pair = await dpopKey();
  const verifier = rand(48);
  const challenge = b64u2(await sha2562(verifier));
  const state = rand(16);
  await idbPut("pending", {
    issuer,
    client_id,
    redirectUri,
    verifier,
    state,
    pair,
    tokenEndpoint: cfg.token_endpoint,
    authorizationEndpoint: cfg.authorization_endpoint
  });
  const url = new URL(cfg.authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid webid offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "consent"
  })) url.searchParams.set(k, v);
  return { authorizationUrl: url.href };
}
async function completeLogin({ currentUrl }) {
  const u = new URL(currentUrl);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code) return null;
  const p = await idbGet("pending");
  if (!p || p.state !== state) throw new Error("login state mismatch");
  const jwk = await publicJwk(p.pair);
  const res = await fetch(p.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", dpop: await dpopProof(p.pair, jwk, "POST", p.tokenEndpoint) },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: p.redirectUri, client_id: p.client_id, code_verifier: p.verifier })
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new Error(`token exchange failed (HTTP ${res.status}): ${tok.error || ""}`);
  const webId = jwtPayload(tok.access_token).webid || jwtPayload(tok.id_token || "").webid || null;
  const session = {
    issuer: p.issuer,
    client_id: p.client_id,
    tokenEndpoint: p.tokenEndpoint,
    pair: p.pair,
    refreshToken: tok.refresh_token || null,
    accessToken: tok.access_token,
    expiresAt: Date.now() + Math.max(30, tok.expires_in || 300) * 1e3,
    webId
  };
  await idbPut("session", session);
  await idbDel("pending");
  return sessionHandle(session);
}
async function getSession() {
  const s = await idbGet("session");
  return s ? sessionHandle(s) : null;
}
async function signOut() {
  await idbDel("session");
  await idbDel("pending");
}
function sessionHandle(s) {
  let { accessToken, expiresAt, refreshToken } = s;
  const jwkP = publicJwk(s.pair);
  const refresh = async () => {
    if (!refreshToken) throw new Error("session expired and there is no refresh token \u2014 sign in again");
    const jwk = await jwkP;
    const res = await fetch(s.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", dpop: await dpopProof(s.pair, jwk, "POST", s.tokenEndpoint) },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: s.client_id, scope: "openid webid offline_access" })
    });
    const tok = await res.json().catch(() => ({}));
    if (!res.ok || !tok.access_token) {
      await idbDel("session");
      throw new Error("refresh failed \u2014 sign in again");
    }
    accessToken = tok.access_token;
    expiresAt = Date.now() + Math.max(30, tok.expires_in || 300) * 1e3;
    if (tok.refresh_token) refreshToken = tok.refresh_token;
    await idbPut("session", { ...s, accessToken, expiresAt, refreshToken });
  };
  const authFetch = async (url, init = {}) => {
    if (Date.now() > expiresAt - 3e4) await refresh();
    const jwk = await jwkP;
    const ath = b64u2(await sha2562(accessToken));
    const headers = { ...init.headers || {}, authorization: `DPoP ${accessToken}`, dpop: await dpopProof(s.pair, jwk, init.method || "GET", url, ath) };
    return fetch(url, { ...init, headers });
  };
  return { webId: s.webId, fetch: authFetch, refresh, signOut };
}

// web/app/boot.mjs
var REDIRECT = `${location.origin}/`;
async function bootWorker() {
  const reg = await navigator.serviceWorker.register("/sw.js", { type: "module" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  }
  const worker = reg.active || navigator.serviceWorker.controller;
  const booted = new Promise((res, rej) => {
    const on = (e) => {
      if (e.data?.type === "booted") {
        navigator.serviceWorker.removeEventListener("message", on);
        res();
      }
      if (e.data?.type === "boot-error") {
        navigator.serviceWorker.removeEventListener("message", on);
        const err = new Error(e.data.error);
        err.detail = e.data.stack || "";
        rej(err);
      }
    };
    navigator.serviceWorker.addEventListener("message", on);
  });
  worker.postMessage({ type: "boot", frontOrigin: location.origin });
  await booted;
}
window.fedipodSignup = async ({ onStep, ...answers }) => {
  await signUp(answers, { onStep, frontOrigin: location.origin });
  const { authorizationUrl } = await beginLogin({ issuer: answers.issuer, redirectUri: REDIRECT });
  location.href = authorizationUrl;
};
function parseAddress(input) {
  let s = String(input || "").trim();
  if (s.startsWith("@")) s = s.slice(1);
  const at = s.indexOf("@");
  if (at < 1) return null;
  const handle = s.slice(0, at).toLowerCase();
  const host = s.slice(at + 1).toLowerCase().replace(/\/+$/, "");
  if (!handle || !host || !host.includes(".")) return null;
  return { handle, host };
}
async function issuerForPod(pod) {
  try {
    const actor = await (await fetch(`${pod}fedipod/ap/actor`, { headers: { accept: "application/activity+json" } })).json();
    const authz = actor?.endpoints?.oauthAuthorizationEndpoint;
    if (authz) return new URL(authz).origin;
  } catch {
  }
  const host = new URL(pod).host;
  const parent = host.split(".").slice(1).join(".");
  return `https://${parent || host}`;
}
window.fedipodSignin = async ({ address }) => {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error("Enter your address as @you@yourpod (for example @alice@alice.solidcommunity.net).");
  const bad = handleProblem(parsed.handle);
  if (bad) throw new Error(bad);
  const pod = `https://${parsed.host}/`;
  const issuer = await issuerForPod(pod);
  const { authorizationUrl } = await beginLogin({ issuer, redirectUri: REDIRECT });
  location.href = authorizationUrl;
};
window.fedipodOnLoad = async () => {
  if (new URLSearchParams(location.search).get("code")) {
    await completeLogin({ currentUrl: location.href });
    history.replaceState({}, "", REDIRECT);
    await bootWorker();
    return "signed-in";
  }
  if (await getSession()) {
    await bootWorker();
    return "restored";
  }
  return "anonymous";
};
window.fedipodSignOut = async () => {
  await signOut();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
  }
  const reg = await navigator.serviceWorker.getRegistration();
  await reg?.unregister();
  await new Promise((res) => {
    let req;
    try {
      req = indexedDB.deleteDatabase("fedipod-accounts");
    } catch {
      res();
      return;
    }
    req.onsuccess = req.onerror = req.onblocked = () => res();
  });
};
window.fedipodHandleProblem = handleProblem;
if (typeof document !== "undefined") (async () => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  if (params.has("signout") || params.has("add")) {
    if (params.has("signout")) {
      try {
        await window.fedipodSignOut();
      } catch {
      }
    }
    history.replaceState({}, "", "/");
    $("loading").hidden = true;
    $("landing").hidden = false;
  } else {
    let state = "anonymous";
    try {
      state = await window.fedipodOnLoad();
    } catch (e) {
      console.error(e);
      $("loading").hidden = true;
      $("hero").hidden = true;
      $("landing").hidden = true;
      $("brand").hidden = false;
      $("running").hidden = false;
      $("running-title").textContent = "Signed in, but the agent could not start";
      $("run-error").style.whiteSpace = "pre-wrap";
      $("run-error").textContent = (e.message || String(e)) + (e.detail ? `

${e.detail}` : "");
      $("run-actions").hidden = false;
      $("run-retry").textContent = "Reload";
      $("run-retry").addEventListener("click", () => location.reload());
      $("run-back").textContent = "Sign out";
      $("run-back").addEventListener("click", async () => {
        try {
          await window.fedipodSignOut();
        } catch {
        }
        location.href = "/";
      });
      return;
    }
    if (state === "signed-in" || state === "restored") {
      location.href = "/admin/client/";
      return;
    }
    $("loading").hidden = true;
    $("landing").hidden = false;
  }
  const showLanding = () => {
    $("pane-form").hidden = true;
    $("running").hidden = true;
    $("brand").hidden = true;
    $("hero").hidden = false;
    $("landing").hidden = false;
  };
  const showForm = () => {
    $("hero").hidden = true;
    $("landing").hidden = true;
    $("brand").hidden = false;
    $("pane-form").hidden = false;
    goStep(1);
  };
  const doSignin = async () => {
    $("signin-error").textContent = "";
    try {
      await window.fedipodSignin({ address: $("signin-address").value });
    } catch (err) {
      $("signin-error").textContent = err.message;
    }
  };
  $("signin").addEventListener("click", doSignin);
  $("signin-address").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      doSignin();
    }
  });
  const f = () => $("form").elements;
  const providerUrl = () => {
    let v = f().provider.value.trim();
    if (!v) v = "https://solidcommunity.net";
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    return v;
  };
  const providerHost = () => {
    try {
      return new URL(providerUrl()).host;
    } catch {
      return "";
    }
  };
  const podHostOf = () => {
    const sub = f().podName.value.trim().toLowerCase();
    const ph = providerHost();
    return sub && ph ? `${sub}.${ph}` : "";
  };
  const answers = () => {
    const mode = f().mode.value;
    const a = {
      mode,
      handle: f().handle.value.trim().toLowerCase(),
      email: f().email.value.trim(),
      password: f().password.value,
      issuer: providerUrl()
    };
    if (mode === "new") a.podName = f().podName.value.trim().toLowerCase();
    else a.pod = `https://${podHostOf()}/`;
    return a;
  };
  const previewAddr = () => {
    const handle = f().handle.value.trim().toLowerCase();
    const ph = podHostOf();
    $("preview").textContent = handle && ph ? `@${handle}@${ph}` : "@\u2026@\u2026";
  };
  for (const el of $("form").elements) el.addEventListener("input", previewAddr);
  const STEP_IDS = ["step-1", "step-2"];
  const FOCUS = { 1: "provider", 2: "handle" };
  const goStep = (n) => {
    STEP_IDS.forEach((id, i) => {
      $(id).hidden = i !== n - 1;
    });
    $("err-1").textContent = "";
    $("form-error").textContent = "";
    if (n === 2) previewAddr();
    if (FOCUS[n]) $(FOCUS[n]).focus();
  };
  const validateStep1 = () => {
    if (!providerHost()) return "A valid pod provider URL is required.";
    const sub = f().podName.value.trim().toLowerCase();
    if (!sub) return "A pod username/subdomain is required.";
    const sp = window.fedipodHandleProblem(sub);
    if (sp) return `Pod username: ${sp}`;
    if (!f().email.value.trim()) return "A pod email is required.";
    if (!f().password.value) return "A pod password is required.";
    return null;
  };
  const validateStep2 = () => {
    const hp = window.fedipodHandleProblem(f().handle.value.trim().toLowerCase());
    if (hp) return `Fediverse handle: ${hp}`;
    return null;
  };
  $("create").addEventListener("click", showForm);
  $("cancel").addEventListener("click", () => {
    showLanding();
    goStep(1);
  });
  $("to-2").addEventListener("click", () => {
    const e = validateStep1();
    if (e) {
      $("err-1").textContent = e;
      return;
    }
    goStep(2);
  });
  $("back-1").addEventListener("click", () => goStep(1));
  const backToForm = (errMsg) => {
    $("running").hidden = true;
    $("brand").hidden = false;
    $("pane-form").hidden = false;
    goStep(1);
    if (errMsg) $("err-1").textContent = errMsg;
  };
  $("run-retry").addEventListener("click", () => backToForm($("run-error").textContent));
  $("run-back").addEventListener("click", () => {
    showLanding();
    goStep(1);
  });
  const LABELS = { account: "Creating your account and pod", credential: "Preparing this browser", keys: "Making your signing key", gateway: "Connecting your mail door" };
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("form-error").textContent = "";
    const e1 = validateStep1();
    if (e1) {
      $("form-error").textContent = e1;
      goStep(1);
      $("err-1").textContent = e1;
      return;
    }
    const e2 = validateStep2();
    if (e2) {
      $("form-error").textContent = e2;
      goStep(2);
      return;
    }
    const a = answers();
    $("pane-form").hidden = true;
    $("running").hidden = false;
    $("running-title").textContent = "Setting up\u2026";
    $("run-error").textContent = "";
    $("run-actions").hidden = true;
    const steps = $("steps");
    steps.textContent = "";
    const mark = {};
    const onStep = (k, st) => {
      if (!mark[k]) {
        const li = document.createElement("li");
        steps.appendChild(li);
        mark[k] = li;
      }
      mark[k].textContent = (st === "ok" ? "\u2713 " : st === "running" ? "\u2026 " : "") + (LABELS[k] || k);
    };
    try {
      await window.fedipodSignup({ ...a, onStep });
    } catch (err) {
      $("running-title").textContent = "Setup did not finish";
      $("run-error").textContent = err.message || String(err);
      $("run-actions").hidden = false;
    }
  });
})();
export {
  parseAddress
};
//# sourceMappingURL=boot.js.map
