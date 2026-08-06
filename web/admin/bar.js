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
  fetch('/status').then(r => (r.ok ? r.json() : null)).then((s) => {
    if (s?.handle) document.title = `Solid ActivityPub — ${s.handle}`;
    // The full fediverse handle, centred in the bar on every page.
    const el = document.getElementById('bar-handle');
    if (el && s?.handle && s?.actor) {
      try { el.textContent = `@${s.handle}@${new URL(s.actor).host}`; } catch { /* odd actor url */ }
    }
  }).catch(() => { /* not up yet; the bar still works */ });
})();
