// run.js — the opt-in / opt-out page's script, in a file of its own.
//
// It lived inline in run.html until 2026-09-09. Out here the page can be served
// under `script-src 'self'`, which is what stops a stray bit of markup from
// becoming running code; inline script cannot be told apart from injected
// script by any policy. Served by the front beside the page it belongs to.
//
// A module, because it awaits an import of /solid-oidc-client.js at the top
// level — which is itself the proof this mechanism works: that file has been
// loaded from a route by this page all along.
const $ = (id) => document.getElementById(id);

// The Solid-OIDC client for the sign-in round trip. Constructed once; the
// redirect state (PKCE, csrf) lives in this tab's sessionStorage, so the same
// session finishes the login on the way back.
// This page's own address. The identity provider is told it and sends the
// reader back to it, so a hard-coded name would end the sign-in on a page that
// does not exist wherever the operator put this one.
const HERE = location.origin + location.pathname.replace(/\/$/u, '');
let session = null;
try {
  const { SessionCore } = await import('/solid-oidc-client.js');
  session = new SessionCore({ redirect_uris: [HERE], client_name: 'FediPod gateway' });
} catch { /* leave null — the "did not load" notes below fire */ }

// What this server knows before anything is typed. 501: it runs no
// identities. A pod server that issued the reader's session names their pod
// and its address, and the page shows one button per pod. Not signed in
// there: one button, to its login. A Gateway knows nothing: the form below.
let offered = true;
const say = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
(async () => {
  const res = await fetch('/api/agent', { credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => null);
  const d = res && res.ok ? await res.json().catch(() => ({})) : {};
  const n = $('run-note');
  if (!res || res.status === 501) {
    offered = false;
    n.hidden = false;
    n.textContent = 'This server does not run identities. Your agent stays where it is.';
  } else if (d.session === 'none') {
    $('run-form').hidden = true;
    showSignIn(d.loginUrl);
  } else if (d.session === 'ok' && Array.isArray(d.pods) && d.pods.length) {
    $('run-form').hidden = true;
    showPods(d.pods);
  }
  runFormCheck();
})();

async function refreshKnown() {
  const res = await fetch('/api/agent', { credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => null);
  const d = res && res.ok ? await res.json().catch(() => ({})) : {};
  if (d.session === 'ok' && Array.isArray(d.pods) && d.pods.length) showPods(d.pods);
}

function showSignIn(loginUrl) {
  const k = $('run-known');
  k.hidden = false;
  k.replaceChildren();
  k.append(say('p', 'You are not signed in at this server.'));
  if (loginUrl) {
    const go = say('button', 'Sign in');
    go.type = 'button'; go.className = 'primary';
    go.onclick = () => { location.href = loginUrl; };
    const p = document.createElement('p'); p.className = 'actions'; p.append(go);
    k.append(p, say('p', 'Sign in, then come back to this page.'));
    k.lastChild.className = 'hint';
  }
}

function showPods(pods) {
  const k = $('run-known');
  k.hidden = false;
  k.replaceChildren();
  for (const pod of pods) {
    const box = document.createElement('div'); box.className = 'pod';
    // The names stand out from the sentences around them.
    const line = (before, id, after = '.') => { const p = say('p', before); p.append(say('code', id), after); return p; };
    box.append(line('Solid Identity (WebID): ', pod.webId, ''));
    const actions = document.createElement('p'); actions.className = 'actions';
    box.append(line('Fediverse Identity: ', pod.address, ''));
    if (pod.running) {
      const links = say('p', 'Manage your account: ');
      const m = say('a', pod.manage.split('?')[0]); m.href = pod.manage;
      links.append(m);
      box.append(links);
      const stop = say('button', 'Close this Fediverse account'); stop.type = 'button'; stop.className = 'primary';
      stop.onclick = () => runStart('opt-out', pod.podBase);
      actions.append(stop);
    } else {
      // Where on the pod the account goes: a container named fedipod, inside
      // the one named here (empty: the pod's own root).
      const field = document.createElement('p'); field.className = 'field';
      const id = `container-${k.children.length}`;
      const label = say('label', 'Store your data in a container named fedipod, inside this container');
      label.htmlFor = id;
      const input = document.createElement('input');
      input.type = 'text'; input.id = id; input.autocomplete = 'off'; input.spellcheck = false;
      try { input.placeholder = new URL(pod.podBase).pathname; } catch { input.placeholder = '/'; }
      field.append(label, input);
      box.append(field);
      const go = say('button', 'Create a Fediverse account'); go.type = 'button'; go.className = 'primary';
      go.onclick = () => runStart('opt-in', pod.podBase, input.value.trim());
      actions.append(go);
    }
    box.append(actions);
    k.append(box);
  }
}

function runFormCheck() {
  let ok = false;
  try { ok = /^https?:$/.test(new URL($('run-pod-url').value.trim()).protocol); } catch { /* not yet */ }
  const issuerOk = /^https?:\/\/\S+/.test($('run-issuer').value.trim());
  $('run-continue').disabled = !(offered && ok && issuerOk);
  $('run-leave').disabled = !(offered && ok && issuerOk);
}
$('run-pod-url').addEventListener('input', () => {
  runFormCheck();
  // The identity provider is usually the server itself — still editable.
  try {
    const u = new URL($('run-pod-url').value.trim());
    const apex = u.hostname.split('.').slice(1).join('.');
    if (!$('run-issuer').value && apex) $('run-issuer').value = `${u.protocol}//${apex}${u.port ? ':' + u.port : ''}`;
  } catch { /* not a URL yet */ }
  runFormCheck();
});
$('run-issuer').addEventListener('input', runFormCheck);
// A browser that puts back what was in these boxes — a reload, the back
// button, its own remembered values — fills them without anybody typing, and
// no typing meant the button was never asked to wake up. It stayed grey over
// a filled-in form, with nothing to say why.
runFormCheck();

const runStart = async (action, podBase = null, container = null, createIndex = false) => {
  const n = $('run-note');
  const u = new URL(podBase || $('run-pod-url').value.trim());
  if (u.pathname === '') u.pathname = '/';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = ''; u.hash = '';
  const p = { podBase: u.href, action,
    container: container ?? ($('run-container') ? $('run-container').value.trim() : ''),
    ...(createIndex ? { createIndex: true } : {}) };

  // A pod server issued the session this page is being read with, so ask it
  // first: where it knows who you are, there is nothing to sign in to again.
  // A Gateway fronting somebody else's pod answers 401 here and the login
  // below is the only way.
  n.hidden = false;
  n.textContent = 'asking the server…';
  const known = await fetch('/api/agent', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(p),
  }).catch(() => null);
  if (known && known.status !== 401) { await showReply(known, p); return; }

  if (!session) { n.textContent = 'the sign-in library did not load — reload and try again'; return; }
  sessionStorage.setItem('fp-run', JSON.stringify(p));
  session.login($('run-issuer').value.trim(), HERE)
    .catch((e) => { n.textContent = 'sign-in failed to start: ' + e.message; });
};
$('run-continue').onclick = () => runStart('opt-in');
$('run-leave').onclick = () => runStart('opt-out');

// What came of it, however the server was satisfied — the session it already
// had, or a login proved afterwards.
async function showReply(res, p) {
  const n = $('run-note');
  n.hidden = false;
  const d = res ? await res.json().catch(() => ({})) : {};
  // No public type index: nothing has been written. Ask.
  if (res && res.status === 409 && d.code === 'needs-index') {
    n.replaceChildren(say('p', `${d.error} Create it? It will be readable by anyone, like your profile.`));
    const yes = say('button', 'Create it and continue'); yes.type = 'button'; yes.className = 'primary';
    const no = say('button', 'No, stop'); no.type = 'button';
    yes.onclick = () => runStart(p.action, p.podBase, p.container || '', true);
    no.onclick = () => { n.textContent = 'Stopped. Nothing was written to your pod.'; };
    const row = document.createElement('p'); row.className = 'actions'; row.append(no, yes);
    n.append(row);
    yes.focus();
    return;
  }
  if (res && res.status === 201 && d.doorSecret) {
    // Built as nodes, not as a string of HTML. Three of the pieces below come
    // back from the server and one comes from sessionStorage, and pasting any
    // of them into innerHTML means whatever markup they contain is rendered.
    // Only the fixed wording is markup here; everything variable is text.
    const manage = `${p.podBase.replace(/\/$/, '')}${d.doorPath}?dk-token=${encodeURIComponent(d.doorSecret)}`;
    n.textContent = 'Your Fediverse account is ready. Manage it at ';
    const a = say('a', p.podBase.replace(/\/$/, '') + d.doorPath); a.href = manage;
    n.append(a, '.');
    refreshKnown();
  } else if (res && res.status === 200) {
    n.textContent = 'Your Fediverse account is closed. Your pod and its data are untouched.';
    refreshKnown();
  } else {
    n.textContent = (p.action === 'opt-in' ? 'opt-in' : 'opt-out') + ' failed: '
      + (d.error || (res ? 'HTTP ' + res.status : 'no response'));
  }
}

// Back from the identity provider: finish with the proven login.
(async () => {
  if (!session) return;
  await session.handleRedirectFromLogin().catch(() => {});
  const pending = sessionStorage.getItem('fp-run');
  if (!session.isActive || !pending) return;
  sessionStorage.removeItem('fp-run');
  const p = JSON.parse(pending);
  const n = $('run-note');
  n.hidden = false;
  n.textContent = 'signed in as ' + session.webId + ' — asking the server…';
  // The signed fetch builds a DPoP proof from the URL, so it must be absolute.
  const res = await session.authFetch(location.origin + '/api/agent', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: p.action, podBase: p.podBase, container: p.container || '',
      ...(p.createIndex ? { createIndex: true } : {}) }),
  }).catch(() => null);
  await showReply(res, p);
})();
