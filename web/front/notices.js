// notices.js — the notices page's script: the admin signs in, then writes,
// changes and removes the notices every account here sees behind the bell.
// Served by the front at /notices.js, like admin.js for the roster.
const $ = (id) => document.getElementById(id);
const note = (text) => { const n = $('notices-note'); n.hidden = !text; n.textContent = text || ''; };

let session = null;
try {
  const { SessionCore } = await import('/solid-oidc-client.js');
  session = new SessionCore({ redirect_uris: [location.origin + '/notices'], client_name: 'FediPod admin' });
} catch { /* leave null — the "did not load" note fires */ }

$('notices-issuer').addEventListener('input', () => {
  $('notices-signin').disabled = !/^https?:\/\/\S+/.test($('notices-issuer').value.trim());
});

$('notices-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (!session) { note('the sign-in library did not load — reload and try again'); return; }
  session.login($('notices-issuer').value.trim(), location.origin + '/notices')
    .catch((e) => note('sign-in failed to start: ' + e.message));
});

(async () => {
  if (!session) return;
  await session.handleRedirectFromLogin().catch(() => {});
  if (!session.isActive) return;
  const webId = session.webId;
  let editing = null;          // the notice being changed, or null for a new one

  const when = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

  const send = async (body) => {
    let res;
    try {
      res = await session.authFetch(location.origin + '/api/notices', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) { note('the request failed: ' + e.message); return null; }
    const d = await res.json().catch(() => ({}));
    if (res.status === 403) { note('signed in as ' + webId + ', which is not this server’s admin'); return null; }
    if (res.status === 501) { note('this server keeps no notices'); return null; }
    if (res.status >= 400) { note('refused: ' + (d.error || 'HTTP ' + res.status)); return null; }
    return d;
  };

  const startEdit = (n) => {
    editing = n;
    $('editor-title').textContent = n ? 'Change this notice' : 'New notice';
    $('notice-title').value = n ? n.title : '';
    $('notice-body').value = n ? n.body : '';
    $('notice-save').textContent = n ? 'Save changes' : 'Publish';
    $('notice-cancel').hidden = !n;
    $('notice-title').focus();
  };

  const load = async () => {
    let res;
    try { res = await fetch(location.origin + '/api/notices', { headers: { accept: 'application/json' }, cache: 'no-store' }); }
    catch (e) { note('the notices could not be read: ' + e.message); return; }
    if (res.status === 501) { note('this server keeps no notices'); return; }
    const d = await res.json().catch(() => ({}));
    const ul = $('notices-list');
    ul.textContent = '';
    for (const n of d.notices || []) {
      const li = document.createElement('li');
      const head = document.createElement('div');
      const t = document.createElement('span'); t.className = 'title'; t.textContent = n.title;
      const w = document.createElement('span'); w.className = 'when';
      w.textContent = when(n.at) + (n.updatedAt && n.updatedAt !== n.at ? ' (changed ' + when(n.updatedAt) + ')' : '');
      head.append(t, w);
      const b = document.createElement('p'); b.className = 'body'; b.textContent = n.body;
      const acts = document.createElement('p'); acts.className = 'actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Change';
      edit.onclick = () => startEdit(n);
      const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'Remove'; rm.className = 'danger';
      rm.onclick = async () => {
        if (!confirm('Remove the notice “' + n.title + '”? Everyone stops seeing it.')) return;
        if (await send({ action: 'delete', id: n.id })) { note('removed “' + n.title + '”'); await load(); }
      };
      acts.append(edit, rm);
      li.append(head, b, acts);
      ul.append(li);
    }
    if (!(d.notices || []).length) { const li = document.createElement('li'); li.textContent = 'No notices yet.'; ul.append(li); }
    $('notices-editor').hidden = false;
  };

  $('editor-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = $('notice-title').value.trim();
    const body = $('notice-body').value.trim();
    if (!title || !body) { note('a title and a text are both needed'); return; }
    $('notice-save').disabled = true;
    const r = await send(editing ? { action: 'update', id: editing.id, title, body } : { action: 'create', title, body });
    $('notice-save').disabled = false;
    if (!r) return;
    note(editing ? 'changed “' + title + '”' : 'published “' + title + '” — everyone sees it within a minute');
    startEdit(null);
    await load();
  });
  $('notice-cancel').addEventListener('click', () => startEdit(null));

  note('signed in as ' + webId);
  $('notices-form').hidden = true;
  await load();
})();
