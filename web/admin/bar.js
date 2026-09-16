// bar.js — the three destinations, shared by the record, the setup form and the
// client view, so they cannot drift apart. Nothing here touches the client in
// the frame: it is this agent's own root, and framing it is the whole of the
// relationship.

(() => {
  // The three destinations are <a href> now: they are navigations, so they
  // belong in a screen reader's links list, and middle-click and open-in-new-tab
  // work the way they do everywhere else. Nothing here has to drive them.
  //
  // One exception, and it keeps its href as the fallback: on the record page
  // `add new account` opens the form IN PLACE rather than reloading. admin.js
  // binds that and calls preventDefault; without the form it is a plain link to
  // ?new=1, which opens it on arrival.

  // The bar says the product; the TAB says which actor, which is what tells two
  // open windows apart without putting the handle in the page twice.
  // /status, not /config: an agent that is not set up yet answers this one and
  // 409s the other, which logged a failed request on every setup page.
  fetch(location.pathname.replace(/\/admin\/.*$/u, '') + '/status', { headers: { 'x-fedipod-page': '1' } }).then(r => (r.ok ? r.json() : null)).then((s) => {
    if (s?.handle) document.title = `FediPod — ${s.handle}`;
    // The full fediverse handle, centred in the bar on every page.
    const el = document.getElementById('bar-handle');
    if (el && s?.handle && s?.actor) {
      try { el.textContent = `@${s.handle}@${new URL(s.actor).host}`; } catch { /* odd actor url */ }
    }
    // A viewer does nothing: it publishes no profile, carries nothing and
    // leaves the account looking broken from outside. Say so where the
    // account is, and let the owner take it back from here.
    if (s?.mode === 'viewer') viewerBanner();
  }).catch(() => { /* not up yet; the bar still works */ });

  // The actors dropdown, on a page whose bar carries one. The record page
  // wires its own richer version (it can start a stopped actor and open the
  // new-account form in place), so this one stands down there.
  const pick = document.getElementById('actor-pick');
  if (pick && !document.getElementById('new-actor-form')) {
    const base = location.pathname.replace(/\/admin\/.*$/u, '');
    fetch(base + '/profiles', { headers: { 'x-fedipod-page': '1' } }).then(r => (r.ok ? r.json() : null)).then((j) => {
      const actors = j?.identities || [];
      pick.textContent = '';
      const label = (r) => (r.address || r.handle || r.name)
        + (r.mode && r.mode !== 'active' ? ` (${r.mode})` : '') + (r.mode ? '' : ' (stopped)');
      for (const [i, r] of actors.entries()) {
        const o = document.createElement('option');
        o.value = String(i);
        o.selected = !!r.current;
        o.textContent = label(r);
        pick.appendChild(o);
      }
      const add = document.createElement('option');
      add.value = '__add';
      add.textContent = '+ add a new account…';
      pick.appendChild(add);
      pick.addEventListener('change', () => {
        if (pick.value === '__add') { location.href = base + '/admin/?new=1'; return; }
        const r2 = actors[Number(pick.value)];
        if (!r2 || r2.current) return;
        // A running actor's client; a stopped one is started from its record.
        if (r2.mode && r2.admin) location.href = r2.admin + 'client/';
        else if (r2.admin) location.href = r2.admin;
      });
    }).catch(() => { pick.hidden = true; });
  }
})();

// "Another device is active": what it means for this account, and the way out.
// The lease is a document on the pod with a five-minute life; a browser that
// was closed leaves one behind that nothing renews, and every reload asks
// under a new name, so waiting can look like waiting forever.
function viewerBanner() {
  if (document.getElementById('viewer-banner')) return;
  const base = location.pathname.replace(/\/admin\/.*$/u, '');
  const bar = document.createElement('div');
  bar.id = 'viewer-banner';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'padding:.7rem 1rem;background:var(--field-bg,#ececec);color:var(--fg,#1a1a1a);'
    + 'border-bottom:1px solid var(--line,#b0b0b0);display:flex;gap:1rem;align-items:center;flex-wrap:wrap;font:inherit';
  const said = document.createElement('span');
  said.textContent = 'Another device holds this account, so nothing is being published or delivered from here.';
  const go = document.createElement('button');
  go.type = 'button';
  go.textContent = 'Take it over';
  go.style.cssText = 'font:inherit;font-weight:600;padding:.4rem 1rem;border-radius:.4rem;border:1px solid var(--btn,#3a5f43);'
    + 'background:var(--btn,#3a5f43);color:var(--btn-text,#fff);cursor:pointer';
  go.addEventListener('click', async () => {
    go.disabled = true;
    said.textContent = 'Taking it over…';
    try {
      const r = await fetch(base + '/takeover', { method: 'POST', headers: { 'x-fedipod-page': '1' } });
      const j = await r.json().catch(() => null);
      if (r.ok && j?.mode === 'active') { location.reload(); return; }
      said.textContent = j?.error || 'The lease could not be taken.';
    } catch (e) { said.textContent = e.message; }
    go.disabled = false;
  });
  bar.append(said, go);
  document.body.prepend(bar);
}
