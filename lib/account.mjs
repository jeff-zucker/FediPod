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

  // Create the pod (server picks root-path or subdomain layout). When the
  // name is already taken BY THIS ACCOUNT — a setup re-run, or a pod made
  // earlier by hand — reuse it; taken by someone else stays a hard error.
  const controls = (await jfetch(accountRoot, { cookie })).json?.controls;
  const podCreate = controls?.account?.pod;
  if (!podCreate) throw new Error('pod create control missing — not a CSS v7 account API');
  // Scheme-agnostic on purpose: matching `https://name.` missed every pod on an
  // http server, so a re-run after a crashed setup always tried to create again
  // and died on "already registered to this account".
  const findOwn = async () => {
    const pods = (await jfetch(podCreate, { cookie })).json?.pods || {};
    return Object.entries(pods).find(([url]) => {
      try {
        const u = new URL(url);
        return u.hostname === podName || u.hostname.startsWith(`${podName}.`)
          || u.pathname.split('/').filter(Boolean).includes(podName);
      } catch { return false; }
    }) || null;
  };
  const made = await jfetch(podCreate, { method: 'POST', cookie, body: { name: podName } });
  let pod = made.json?.pod || made.json?.podBaseUrl || null;
  let webId = made.json?.webId || null;
  if (made.status >= 400 || !pod) {
    const own = await findOwn();
    if (own) {
      pod = own[0];
      webId = webId || own[1]?.webId || null;
    } else if (made.status >= 400) {
      throw new Error(`pod create failed (HTTP ${made.status}): ${made.json?.message || `is the name "${podName}" taken by another account?`}`);
    }
  }
  if (!pod) throw new Error('pod created but its URL was not reported — check the account dashboard');
  pod = pod.endsWith('/') ? pod : pod + '/';
  return { pod, webId: webId || new URL('profile/card#me', pod).href };
}
