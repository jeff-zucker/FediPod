// new-account.js — the sign-up page's script, in a file of its own.
//
// It lived inline in new-account.html until 2026-09-09. Out here the page can
// be served under `script-src 'self'`, which is what stops a stray bit of
// markup from becoming running code; inline script cannot be told apart from
// injected script by any policy. Served by the front at /new-account.js.
fetch('/api/handle?handle=__probe__').then(r => r.json()).then(d => {
  if (d.version) {
    document.getElementById('current-version-num').textContent = d.version;
    document.getElementById('current-version-cmd').textContent = `curl -fsSL ${location.origin}/install | sh`;
    document.getElementById('current-version').hidden = false;
  }
}).catch(() => {});
