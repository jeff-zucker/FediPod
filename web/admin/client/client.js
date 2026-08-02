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

  // A deep link into the client — the record links an actor's own page this way
  // — arrives as a hash on THIS page, and the frame never sees it. Forward it,
  // so the link lands where it says while keeping the bar above it.
  const wanted = location.hash && location.hash !== '#' ? location.hash : null;
  const sendTo = (hash) => {
    try { frame.contentWindow.location.hash = hash; } catch { /* not ready yet */ }
  };
  const whenReady = (fn) => {
    if (frame.contentWindow?.location?.href && frame.contentWindow.location.href !== 'about:blank') fn();
    else frame.addEventListener('load', fn, { once: true });
  };

  let accounts = [];
  try { accounts = JSON.parse(localStorage.getItem('accounts') || '[]'); } catch { /* unreadable */ }
  if (accounts.some(a => a?.info?.uri === status.actor)) {          // already ours
    if (wanted) whenReady(() => sendTo(wanted));
    return;
  }

  // Same origin, so the frame's own host is the instance to log into. A deep
  // link is dropped here on purpose: logging in navigates the frame anyway, and
  // arriving somewhere unexpected afterwards is worse than arriving home.
  whenReady(() => sendTo(`#/login?instance=${encodeURIComponent(location.host)}&submit=1`));
})();
