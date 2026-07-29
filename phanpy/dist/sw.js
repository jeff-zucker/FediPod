// sw.js — kill-switch replacing the service worker Phanpy's build installed.
//
// A registered worker outlives the page that registered it and keeps answering
// navigations from its precache, replaying the response headers it stored at
// install time. That made a header change (the CSP script-src hash) invisible
// to any browser that had already installed it, with no way for the server to
// correct itself. Browsers re-fetch this file on navigation and install what
// they find, so old installs land here and clean themselves up; new visitors
// register nothing, because the HTML no longer calls register().
//
// No fetch handler on purpose: a worker without one does not intercept
// requests at all, so pages go straight to the network while this runs.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    // Take the open tabs off the dead worker without waiting for the user.
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      try { await client.navigate(client.url); } catch { /* tab will refresh on its own */ }
    }
  })());
});
