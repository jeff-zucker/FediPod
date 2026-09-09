// run.js — the opt-in / opt-out page's script, in a file of its own.
//
// It lived inline in run.html until 2026-09-09. Out here the page can be served
// under `script-src 'self'`, which is what stops a stray bit of markup from
// becoming running code; inline script cannot be told apart from injected
// script by any policy. Served by the front at /run.js.
//
// A module, because it awaits an import of /solid-oidc-client.js at the top
// level — which is itself the proof this mechanism works: that file has been
// loaded from a route by this page all along.
const $ = (id) => document.getElementById(id);

// The Solid-OIDC client for the sign-in round trip. Constructed once; the
// redirect state (PKCE, csrf) lives in this tab's sessionStorage, so the same
// session finishes the login on the way back.
let session = null;
try {
  const { SessionCore } = await import('/solid-oidc-client.js');
  session = new SessionCore({ redirect_uris: [location.origin + '/run'], client_name: 'FediPod gateway' });
} catch { /* leave null — the "did not load" notes below fire */ }

// Offered only where this server actually runs identities. An
// unauthenticated probe tells the two apart: 501 = not offered here,
// anything else = offered (a real opt-in still needs the signed-in proof).
let offered = true;
(async () => {
  const res = await fetch('/api/agent', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  if (!res || res.status === 501) {
    offered = false;
    const n = $('run-note');
    n.hidden = false;
    n.textContent = 'This server does not run identities. Your agent stays where it is.';
    runFormCheck();
  }
})();

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

const runStart = (action) => {
  const n = $('run-note');
  if (!session) { n.hidden = false; n.textContent = 'the sign-in library did not load — reload and try again'; return; }
  const u = new URL($('run-pod-url').value.trim());
  if (u.pathname === '') u.pathname = '/';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = ''; u.hash = '';
  sessionStorage.setItem('fp-run', JSON.stringify({ podBase: u.href, action }));
  session.login($('run-issuer').value.trim(), location.origin + '/run')
    .catch((e) => { n.hidden = false; n.textContent = 'sign-in failed to start: ' + e.message; });
};
$('run-continue').onclick = () => runStart('opt-in');
$('run-leave').onclick = () => runStart('opt-out');

// Back from the identity provider: finish the opt-in with the proven login.
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
  const d = res ? await res.json().catch(() => ({})) : {};
  if (res && res.status === 201 && d.doorSecret) {
    // Built as nodes, not as a string of HTML. Three of the pieces below come
    // back from the server and one comes from sessionStorage, and pasting any
    // of them into innerHTML means whatever markup they contain is rendered.
    // Only the fixed wording is markup here; everything variable is text.
    const say = (tag, text) => { const e = document.createElement(tag); e.textContent = text; return e; };
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
})();
