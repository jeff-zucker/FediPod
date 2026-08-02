// client.js — make the framed client be THIS agent's actor.
//
// The client is a general fediverse client: it keeps a list of accounts in
// localStorage and one of them is current. Nothing makes that one agree with
// the agent serving the page. A leftover account from another identity wins,
// and you get somebody else's timeline on this actor's page, with the profile
// editor pointed at a host that cannot answer.
//
// Per-origin storage is what keeps identities apart, and it does work — each
// actor answers at <handle>.localhost:<port> and each origin has its own
// accounts list. What was missing is the other half: telling the client which
// account it is meant to be showing.
//
// The frame's markup declares what it loads (`src="/"`), and that does not
// change. This navigates the loaded app to its own login route, which is app
// navigation, not an include: `?instance=` prefills and `?submit=` runs it, so
// the round trip needs no typing. Hash-routed, so the query lives after the
// hash; `submit` must be non-empty, because the empty string is falsy and the
// auto-submit never fires.

(async () => {
  const frame = document.getElementById('client');
  if (!frame) return;

  // Who this agent is, in the form the client stores: `info.uri` is the actor
  // URI on the pod. Matching on that rather than on the origin is deliberate —
  // "which account logged in here" is a different question, and it is the one
  // that goes wrong when the two origins get mixed.
  const status = await fetch('/status').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!status?.actor) return;                 // not set up yet; setup owns that

  let accounts = [];
  try { accounts = JSON.parse(localStorage.getItem('accounts') || '[]'); } catch { /* unreadable */ }
  if (accounts.some(a => a?.info?.uri === status.actor)) return;   // already ours

  // Same origin, so the frame's own host is the instance to log into.
  const go = () => {
    try {
      frame.contentWindow.location.hash =
        `#/login?instance=${encodeURIComponent(location.host)}&submit=1`;
    } catch { /* frame not ready; the load handler below gets it */ }
  };
  if (frame.contentWindow?.location?.href && frame.contentWindow.location.href !== 'about:blank') go();
  else frame.addEventListener('load', go, { once: true });
})();
