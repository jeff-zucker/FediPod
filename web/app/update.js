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
  if (!mine || !('serviceWorker' in navigator)) return;
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
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (Date.now() - loadedAt > 5000) go(); });
  const check = async () => {
    try {
      const r = await fetch('/api/handle?handle=__probe__', { cache: 'no-store', headers: { accept: 'application/json' } });
      const v = (await r.json())?.version;
      if (!v || v === mine) return;
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update().catch(() => {});
      setTimeout(go, 4000);   // a pages-only change: no new worker will take over
    } catch { /* offline, or the site did not answer: try again later */ }
  };
  setTimeout(check, 20000);
  setInterval(check, 5 * 60 * 1000);
})();
