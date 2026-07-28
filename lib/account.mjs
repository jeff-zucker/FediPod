// account.mjs — create a brand-new account + pod on a CSS server (v7 account
// API), the `setup --new-account` path. Public-server sibling of
// data-kitchen's seed-account.cjs, but simpler: the pod.create control makes
// the pod AND its WebID in one step — no ownership challenge, because the
// server authors the WebID itself.
//
// Flow: POST .account/account/ (or login when the email already exists) →
// password.create → account.pod {name} → { pod, webId }.

async function jfetch(url, { method = 'GET', body, cookie } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

export async function createAccountWithPod({ issuer, email, password, podName }) {
  const origin = issuer.replace(/\/+$/, '');
  const accountRoot = `${origin}/.account/`;

  // Authenticate: log in when the email is already registered (idempotent
  // re-runs), otherwise create the account and set its password.
  let cookie;
  const login = await jfetch(`${accountRoot}login/password/`, { method: 'POST', body: { email, password } });
  if (login.status < 400 && login.json?.authorization) {
    cookie = `css-account=${login.json.authorization}`;
  } else {
    const create = await jfetch(`${accountRoot}account/`, { method: 'POST' });
    if (!create.json?.authorization) {
      throw new Error(`account create failed (HTTP ${create.status}): ${create.json?.message || 'is this a CSS server with signup enabled?'}`);
    }
    cookie = `css-account=${create.json.authorization}`;
    const pwCreate = (await jfetch(accountRoot, { cookie })).json?.controls?.password?.create;
    if (!pwCreate) throw new Error('password.create control missing — not a CSS v7 account API');
    const pw = await jfetch(pwCreate, { method: 'POST', cookie, body: { email, password } });
    if (pw.status >= 400) throw new Error(`password create failed (HTTP ${pw.status}): ${pw.json?.message || ''}`);
  }

  // Create the pod (server picks root-path or subdomain layout; both come
  // back in the response). An already-taken name is a hard error — the user
  // picks another rather than us guessing at ownership.
  const controls = (await jfetch(accountRoot, { cookie })).json?.controls;
  const podCreate = controls?.account?.pod;
  if (!podCreate) throw new Error('pod create control missing — not a CSS v7 account API');
  const made = await jfetch(podCreate, { method: 'POST', cookie, body: { name: podName } });
  if (made.status >= 400) {
    throw new Error(`pod create failed (HTTP ${made.status}): ${made.json?.message || `is the name "${podName}" taken?`}`);
  }
  let pod = made.json?.pod || made.json?.podBaseUrl || null;
  let webId = made.json?.webId || null;
  if (!pod || !webId) {
    // Some CSS versions return only a resource URL — the pods listing has both.
    const pods = (await jfetch(podCreate, { cookie })).json?.pods || {};
    const entry = Object.entries(pods).find(([url]) => url.includes(`/${podName}/`) || url.startsWith(`https://${podName}.`));
    if (entry) { pod = pod || entry[0]; webId = webId || entry[1]?.webId || null; }
  }
  if (!pod) throw new Error('pod created but its URL was not reported — check the account dashboard');
  return { pod: pod.endsWith('/') ? pod : pod + '/', webId };
}
