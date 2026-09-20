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
    box.append(say('p', `You are signed in as ${pod.webId}.`));
    box.append(say('p', `Your pod is ${pod.podBase}.`));
    const actions = document.createElement('p'); actions.className = 'actions';
    if (pod.running) {
      box.append(say('p', `This pod is a Fediverse account: ${pod.address}.`));
      const again = say('button', 'Get a new door secret'); again.type = 'button';
      again.onclick = () => runStart('opt-in', pod.podBase);
      const stop = say('button', 'Stop running it here'); stop.type = 'button';
      stop.onclick = () => runStart('opt-out', pod.podBase);
      actions.append(again, ' ', stop);
    } else {
      box.append(say('p', `Your Fediverse address will be ${pod.address}.`));
      const go = say('button', 'Make this pod a Fediverse account'); go.type = 'button'; go.className = 'primary';
      go.onclick = () => runStart('opt-in', pod.podBase);
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

const runStart = async (action, podBase = null) => {
  const n = $('run-note');
  const u = new URL(podBase || $('run-pod-url').value.trim());
  if (u.pathname === '') u.pathname = '/';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = ''; u.hash = '';
  const p = { podBase: u.href, action };

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
  if (res && res.status === 201 && d.doorSecret) {
    // Built as nodes, not as a string of HTML. Three of the pieces below come
    // back from the server and one comes from sessionStorage, and pasting any
    // of them into innerHTML means whatever markup they contain is rendered.
    // Only the fixed wording is markup here; everything variable is text.
    n.textContent = 'Your identity runs here now. This is your door secret — ';
    n.append(say('b', 'save it now'));
    n.append(', it is shown only this once. It opens your admin pages at ');
    n.append(say('code', p.podBase.replace(/\/$/, '') + d.doorPath));
    n.append(':', say('pre', d.doorSecret));
    n.append('To check it works:', say('pre', d.command));
    n.append('Lost it? Opt in again — that mints a fresh one and retires this one.');
  } else if (res && res.status === 200) {
    n.textContent = 'Done — this server no longer runs that identity. Your pod and its data are untouched.';
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
    body: JSON.stringify({ action: p.action, podBase: p.podBase }),
  }).catch(() => null);
  await showReply(res, p);
})();
