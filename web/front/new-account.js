// new-account.js — the front's root page's script, in a file of its own so
// the page is served under `script-src 'self'`. Served by the front at
// /new-account.js. It fills in the version this gateway runs, nothing more.
fetch('/api/handle?handle=__probe__').then(r => r.json()).then(d => {
  if (d.version) {
    document.getElementById('current-version-num').textContent = d.version;
    document.getElementById('current-version').hidden = false;
  }
}).catch(() => {});
