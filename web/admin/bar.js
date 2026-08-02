// bar.js — the three destinations, shared by the record, the setup form and the
// client view, so they cannot drift apart. Nothing here touches the client in
// the frame: it is this agent's own root, and framing it is the whole of the
// relationship.

(() => {
  const go = (id, href) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { location.href = href; });
  };
  go('bar-fediverse', '/admin/client/');
  go('bar-manage', '/admin/');
  // The record page has the form already — it opens it in place rather than
  // reloading itself. Everywhere else, ?new opens it on arrival.
  if (!document.getElementById('new-actor-form')) go('bar-add', '/admin/?new=1');

  // The bar says the product; the TAB says which actor, which is what tells two
  // open windows apart without putting the handle in the page twice.
  // /status, not /config: an agent that is not set up yet answers this one and
  // 409s the other, which logged a failed request on every setup page.
  fetch('/status').then(r => (r.ok ? r.json() : null)).then((s) => {
    if (s?.handle) document.title = `Solid ActivityPub — ${s.handle}`;
  }).catch(() => { /* not up yet; the bar still works */ });
})();
