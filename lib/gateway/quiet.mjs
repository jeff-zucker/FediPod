// quiet.mjs — accounts that go quiet: what the front knows about an account
// nobody opens, and what its owner may say about it. The router in
// front-core.mjs asks closedState/accountState at the door and on every
// public read, stamps noteOpened from the relay, counts noteReceived after
// a forwarded delivery, and hands /api/open, /api/pause and /api/close here.

// ---- accounts that go quiet -------------------------------------------------
//
// The gateway holds no mail: every delivery it takes is two writes into the
// owner's pod inbox, read only when their browser is open. An account nobody
// opens grows on its pod without limit, and its owner comes back to a drain
// of everything at once. So the front keeps two facts about each browser
// account — when its owner was last here, and how much content has arrived
// since — and acts on them.
//
// `openedAt` is written when the owner signs in (POST /api/open, always) and
// while they act through the relay (at most hourly). The count of content
// deliveries since then lives in its own record, keyed by handle AND
// openedAt: a fresh stamp starts a fresh count with nothing to reset, and a
// delivery's write can never overwrite a sign-in's. Two deliveries landing
// together may each read the same total and one increment is lost — the cap
// comes out slightly soft, never too strict.
//
// PAUSED: the count has reached the cap, or the owner said so. Content is
// accepted and discarded, control (follows, unfollows, moves, deletions,
// blocks) still lands. The owner's next sign-in ends a cap pause by itself; a
// pause they set lasts until they lift it.
//
// CLOSED: the owner said so, or nothing has opened the account for the close
// window. Found closed by time, it is written down so it stays closed. From
// then on the door, the actor and the handle answer 410 — never a failure
// code, which senders retry and count against this whole host, and never a
// success, which would keep them sending. Nothing on the pod is touched. An
// address that moved (see /api/move) keeps answering as moved; closing does
// not take that away.
//
// Only an account whose owner has signed in from a browser carries
// `openedAt`. A DeviceAgent behind this door never does: it drains its own
// inbox as it runs, so it is never counted, never paused and never closed by
// time. Accounts from before this was built are counted from their next
// sign-in.
export const DEFAULT_PAUSE_ITEMS = 5000;
export const DEFAULT_CLOSE_DAYS = 183;                // six months
const OPEN_STAMP_EVERY_MS = 60 * 60_000;              // the relay's stamp, at most hourly
const pauseItemsOf = (ctx) => (Number(ctx.pauseItems) > 0 ? Number(ctx.pauseItems) : DEFAULT_PAUSE_ITEMS);
const closeDaysOf = (ctx) => (Number(ctx.closeDays) > 0 ? Number(ctx.closeDays) : DEFAULT_CLOSE_DAYS);
const receivedKey = (key, rec) => `${key}/${rec.openedAt}`;

export async function receivedSince(ctx, key, rec) {
  if (!ctx.readReceived || !rec.openedAt) return { items: 0, bytes: 0 };
  const got = await ctx.readReceived(receivedKey(key, rec)).catch(() => null);
  return { items: Number(got?.items) || 0, bytes: Number(got?.bytes) || 0 };
}

// One more content delivery reached the pod. Nothing to count against until
// the owner has been here once.
export async function noteReceived(ctx, key, rec, bytes) {
  if (!ctx.readReceived || !ctx.writeReceived || !rec.openedAt) return;
  const so = await receivedSince(ctx, key, rec);
  await ctx.writeReceived(receivedKey(key, rec), { items: so.items + 1, bytes: so.bytes + (Number(bytes) || 0) })
    .catch((e) => console.log(`front @${key}: count not written: ${e?.message || e}`));
}

// The owner is here. `always` is a sign-in; the relay stamps at most hourly,
// so a busy hour of posting is one write. The count that went with the old
// stamp is dropped: it is over, and a store should not keep one per hour.
export async function noteOpened(ctx, key, rec, { always = false } = {}) {
  if (!ctx.putDirectory) return rec;
  if (!always && rec.openedAt && Date.now() - Date.parse(rec.openedAt) < OPEN_STAMP_EVERY_MS) return rec;
  const next = { ...rec, openedAt: new Date().toISOString() };
  await ctx.putDirectory(key, next);
  if (rec.openedAt && ctx.dropReceived) await ctx.dropReceived(receivedKey(key, rec)).catch(() => {});
  return next;
}

// Closed, and why. Reads no count: this is asked on every public read.
export async function closedState(ctx, key, rec) {
  if (rec.movedTo) return { closed: false };
  if (rec.closedAt) return { closed: true, closedAt: rec.closedAt, closedBy: rec.closedBy || 'owner' };
  if (rec.openedAt && Date.now() - Date.parse(rec.openedAt) > closeDaysOf(ctx) * 86400_000) {
    const closedAt = new Date().toISOString();
    if (ctx.putDirectory) await ctx.putDirectory(key, { ...rec, closedAt, closedBy: 'quiet' });
    console.log(`front @${key}: closed — nothing opened it since ${rec.openedAt}`);
    return { closed: true, closedAt, closedBy: 'quiet' };
  }
  return { closed: false };
}

// The whole standing of an account, for the door and for its owner's page.
export async function accountState(ctx, key, rec) {
  const c = await closedState(ctx, key, rec);
  const received = c.closed ? { items: 0, bytes: 0 } : await receivedSince(ctx, key, rec);
  const cap = pauseItemsOf(ctx);
  const pausedBy = c.closed ? null : rec.pausedAt ? 'owner' : received.items >= cap ? 'quiet' : null;
  return {
    closed: c.closed, closedAt: c.closedAt || null, closedBy: c.closedBy || null,
    paused: !!pausedBy, pausedBy, pausedAt: rec.pausedAt || null,
    openedAt: rec.openedAt || null, received, pauseItems: cap, closeDays: closeDaysOf(ctx),
  };
}

// A 410 with a reason, the shape every closed or moved id answers with.
export const closedAnswer = (headers = {}, why = 'this address is closed') => ({
  status: 410, headers: { 'cache-control': 'no-store', ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ error: why }) });

// The owner of a row, proved the way the relay proves them: a pod token whose
// WebID is the row's, or lives on the row's pod for a row from before WebIDs
// were recorded.
export async function provedOwner(request, pathname, ctx, rec, { j, verifyPodToken, webidUnderPod }) {
  const webid = await verifyPodToken(request, pathname, ctx.verifier);
  if (!webid) return { error: j(401, { error: 'a Solid-OIDC token proving the pod is required' }) };
  const owner = rec.webId ? webid === rec.webId : webidUnderPod(webid, rec.podHome);
  if (!owner) return { error: j(403, { error: "the token proves a different pod than this account's" }) };
  return { webid };
}

// The owner's three routes. `deps` are front-core's own JSON reply and
// token check, handed in so this module stays free of the router's privates.
// Returns a response, or null when the path is not one of these.
export async function routeQuietApi(request, pathname, ctx, deps) {
  const { j } = deps;
  if (!['/api/open', '/api/pause', '/api/close'].includes(pathname)) return null;
  // A page at another origin asks first whether it may call, and is answered
  // as the relay answers it. Unanswered, the browser never sends the call and
  // some pages asked again every minute.
  if (request.method === 'OPTIONS') return deps.apiPreflight();
  if (request.method !== 'POST') return null;
  // The owner is here: their browser says so as it opens the account. The
  // answer is the account's standing at this gateway, which the manage page
  // shows. A closed address is told so and nothing is written.
  if (pathname === '/api/open' && request.method === 'POST') {
    if (!ctx.putDirectory) return j(501, { error: 'this front keeps no directory' });
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    const handle = String(body.handle || '').toLowerCase();
    let rec = await ctx.lookup(handle);
    if (!rec) return j(404, { error: 'no such account' });
    const who = await provedOwner(request, pathname, ctx, rec, deps);
    if (who.error) return who.error;
    const before = await closedState(ctx, handle, rec);
    if (before.closed) return j(410, { error: 'this address is closed', closedAt: before.closedAt, closedBy: before.closedBy });
    rec = await noteOpened(ctx, handle, rec, { always: true });
    return j(200, { ok: true, handle, ...await accountState(ctx, handle, rec) });
  }

  // The owner pausing their own account, or lifting the pause they set.
  if (pathname === '/api/pause' && request.method === 'POST') {
    if (!ctx.putDirectory) return j(501, { error: 'this front keeps no directory' });
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    const handle = String(body.handle || '').toLowerCase();
    let rec = await ctx.lookup(handle);
    if (!rec) return j(404, { error: 'no such account' });
    const who = await provedOwner(request, pathname, ctx, rec, deps);
    if (who.error) return who.error;
    const before = await closedState(ctx, handle, rec);
    if (before.closed) return j(410, { error: 'this address is closed', closedAt: before.closedAt });
    if (typeof body.paused !== 'boolean') return j(400, { error: 'paused must be true or false' });
    if (body.paused && !rec.pausedAt) rec = { ...rec, pausedAt: new Date().toISOString() };
    if (!body.paused && rec.pausedAt) { rec = { ...rec }; delete rec.pausedAt; }
    // Lifting a pause is a sign-in's worth of "I am here": the count starts over.
    if (!body.paused) rec = { ...rec, openedAt: new Date().toISOString() };
    await ctx.putDirectory(handle, rec);
    console.log(`front @${handle}: ${body.paused ? 'paused' : 'resumed'} by its owner`);
    return j(200, { ok: true, handle, ...await accountState(ctx, handle, rec) });
  }

  // The owner closing their address for good. Repeating it changes nothing.
  if (pathname === '/api/close' && request.method === 'POST') {
    if (!ctx.putDirectory) return j(501, { error: 'this front keeps no directory' });
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    const handle = String(body.handle || '').toLowerCase();
    let rec = await ctx.lookup(handle);
    if (!rec) return j(404, { error: 'no such account' });
    const who = await provedOwner(request, pathname, ctx, rec, deps);
    if (who.error) return who.error;
    if (body.confirm !== true) return j(400, { error: 'closing is for good — send confirm: true' });
    if (!rec.closedAt) {
      rec = { ...rec, closedAt: new Date().toISOString(), closedBy: 'owner' };
      await ctx.putDirectory(handle, rec);
      console.log(`front @${handle}: closed by its owner`);
    }
    return j(200, { ok: true, handle, ...await accountState(ctx, handle, rec) });
  }

  return null;
}
