// update.js — a fedipod.net page notices a newer build and reloads itself once.
//
// The page carries the version it was staged with (a meta tag); the site
// answers its current version at the handle probe. When they differ, the
// worker is asked to update — it installs and takes over at once (sw-src.mjs
// skips waiting and claims) — and the page reloads when the new worker takes
// over, or after a moment if only the pages changed. A page with text in a
// composer is not reloaded from under it: it shows a line with a button.
(() => {
  const mine = document.querySelector('meta[name="fedipod-version"]')?.content;
  // The build this page was staged from. A version changes when a release is
  // cut; a build changes every time the site is deployed, which is what a
  // reader with the page open actually needs to hear about.
  const myBuild = document.querySelector('meta[name="fedipod-build"]')?.content || null;
  if (!mine) return;
  const loadedAt = Date.now();
  let acted = false;
  const drafting = () => [...document.querySelectorAll('textarea')].some((t) => t.value.trim());
  const banner = () => {
    if (document.getElementById('fedipod-update')) return;
    const d = document.createElement('div');
    d.id = 'fedipod-update';
    d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:1rem 1.25rem;'
      + 'font:1rem/1.5 Arial, Helvetica, sans-serif;background:#1d1d1d;color:#fff;display:flex;gap:1rem;align-items:center;justify-content:center;flex-wrap:wrap';
    const t = document.createElement('span');
    t.textContent = 'A new version of FediPod is ready. Reload when you have finished writing.';
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Reload now';
    b.style.cssText = 'font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #fff;background:#fff;color:#1d1d1d;cursor:pointer';
    b.addEventListener('click', () => location.reload());
    d.append(t, b);
    document.body.append(d);
  };
  const go = () => {
    if (acted) return;
    acted = true;
    if (drafting()) { acted = false; banner(); return; }
    location.reload();
  };
  // A worker taking over a page that has been open a while is a new build;
  // in a page's first seconds it is the boot, not an update.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (Date.now() - loadedAt > 5000) go(); });
  }
  const check = async () => {
    try {
      // The build first: it moves with every deploy. The version is the
      // fallback for a page staged before builds were stamped.
      if (myBuild) {
        const b = await fetch('/build.json', { cache: 'no-store', headers: { accept: 'application/json' } })
          .then(x => (x.ok ? x.json() : null)).catch(() => null);
        if (b?.build && b.build !== myBuild) { go(); return; }
        // A build that matched is the whole answer. Falling through here asked
        // the site's function the same question once a minute from every open
        // tab, for nothing — a third of everything the site was doing.
        if (b?.build) return;
      }
      const r = await fetch('/api/handle?handle=__probe__', { cache: 'no-store', headers: { accept: 'application/json' } });
      const v = (await r.json())?.version;
      if (!v || v === mine) return;
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update().catch(() => {});
      setTimeout(go, 4000);   // a pages-only change: no new worker will take over
    } catch { /* offline, or the site did not answer: try again later */ }
  };
  // Often enough that a reader watching a page being worked on sees it.
  setTimeout(check, 5000);
  setInterval(check, 60 * 1000);
})();
