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
  fetch(location.pathname.replace(/\/admin\/.*$/u, '') + '/status').then(r => (r.ok ? r.json() : null)).then((s) => {
    if (s?.handle) document.title = `FediPod — ${s.handle}`;
    // The full fediverse handle, centred in the bar on every page.
    const el = document.getElementById('bar-handle');
    if (el && s?.handle && s?.actor) {
      try { el.textContent = `@${s.handle}@${new URL(s.actor).host}`; } catch { /* odd actor url */ }
    }
  }).catch(() => { /* not up yet; the bar still works */ });

  // The actors dropdown, on a page whose bar carries one. The record page
  // wires its own richer version (it can start a stopped actor and open the
  // new-account form in place), so this one stands down there.
  const pick = document.getElementById('actor-pick');
  if (pick && !document.getElementById('new-actor-form')) {
    const base = location.pathname.replace(/\/admin\/.*$/u, '');
    fetch(base + '/profiles').then(r => (r.ok ? r.json() : null)).then((j) => {
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
