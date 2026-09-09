// admin.js — the roster page's script, in a file of its own.
//
// It lived inline in admin.html until 2026-09-09. Out here the page can be
// served under `script-src 'self'`, which is what stops a stray bit of markup
// from becoming running code; inline script cannot be told apart from injected
// script by any policy. Served by the front at /admin.js.
const $ = (id) => document.getElementById(id);
const note = (text) => { const n = $('roster-note'); n.hidden = !text; n.textContent = text || ''; };

// The Solid-OIDC client for the sign-in round trip. Constructed once; the
// redirect state lives in this tab's sessionStorage, so the same session
// finishes the login on the way back.
let session = null;
try {
  const { SessionCore } = await import('/solid-oidc-client.js');
  session = new SessionCore({ redirect_uris: [location.origin + '/roster'], client_name: 'FediPod admin' });
} catch { /* leave null — the "did not load" note fires */ }

$('roster-issuer').addEventListener('input', () => {
  $('roster-signin').disabled = !/^https?:\/\/\S+/.test($('roster-issuer').value.trim());
});

$('roster-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!session) { note('the sign-in library did not load — reload and try again'); return; }
  session.login($('roster-issuer').value.trim(), location.origin + '/roster')
    .catch((e) => note('sign-in failed to start: ' + e.message));
});

// Back from the identity provider: read the roster with the proven login.
(async () => {
  if (!session) return;
  await session.handleRedirectFromLogin().catch(() => {});
  if (!session.isActive) return;
  const webId = session.webId;

  // Signed fetches build a DPoP proof from the URL, so it must be absolute.
  const load = async () => {
    let res;
    try { res = await session.authFetch(location.origin + '/api/roster'); }
    catch (e) { note('the roster request failed: ' + e.message); return; }
    const d = await res.json().catch(() => ({}));
    if (res.status === 403) { note('signed in as ' + webId + ', which is not this server’s admin'); return; }
    if (res.status === 501) { note('this server names no admin — set FEDIPOD_ADMIN_WEBID and redeploy'); return; }
    if (res.status !== 200) { note('roster unavailable: ' + (d.error || 'HTTP ' + res.status)); return; }
    const rows = $('roster-rows');
    rows.textContent = '';
    for (const a of d.accounts || []) {
      const tr = document.createElement('tr');
      const cell = (child) => { const td = document.createElement('td'); td.append(child); tr.append(td); };
      cell(a.address);
      cell(a.kind);
      cell(a.fronted ? 'lives here' : 'gateway only');
      const pod = document.createElement('a');
      pod.href = a.podHome; pod.textContent = new URL(a.podHome).host;
      cell(pod);
      const rm = document.createElement('button');
      rm.type = 'button'; rm.textContent = 'Remove';
      rm.onclick = () => revoke(a);
      cell(rm);
      rows.append(tr);
    }
    $('roster-table').hidden = false;
    note((d.accounts || []).length + ' account(s) on ' + d.host);
  };

  const revoke = async (a) => {
    if (!confirm('Remove ' + a.address + ' from this server? The name stops resolving here; nothing on their pod is touched.')) return;
    let res;
    try {
      res = await session.authFetch(location.origin + '/api/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: a.handle }),
      });
    } catch (e) { note('the remove request failed: ' + e.message); return; }
    const d = await res.json().catch(() => ({}));
    if (res.status !== 200) { note('remove refused: ' + (d.error || 'HTTP ' + res.status)); return; }
    if (!d.removed) { note(a.address + ' stays: ' + d.reason); return; }
    await load();
    note('removed ' + a.address);
  };

  note('signed in as ' + webId + ' — reading the roster…');
  await load();
})();
