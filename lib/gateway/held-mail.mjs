// held-mail.mjs — a browser account's mail, held at the gateway while its
// owner's app is closed, and handed to the pod as one batch.
//
// Every delivery the door takes is two writes into the owner's pod inbox, and
// the drain then reads and deletes both: six pod requests a piece. While the
// app is closed nobody reads it, so the door keeps it here instead
// (ctx.holdMail), and writes it to the pod inbox as one document when the app
// says it is open (POST /api/here) or when the timer comes round (flushAll).
// While the app is open, mail goes straight to the pod as it always has.
//
// A batch is plain JSON, `{ "batch": [ { name, body, receipt } ] }`: `name` is
// what the item would have been called in the inbox, `body` its bytes, and
// `receipt` the door's receipt for it, or null. The drain reads it
// (lib/core/intake: batch documents).
//
// ctx, when the deploy holds mail:
//   holdMail(handle, name, body, ct)   keep one inbox item
//   listHeld(handle) -> [name]         what is kept for an account
//   readHeld(handle, name) -> string   one kept item
//   dropHeld(handle, name)             let one go
//   heldAccounts() -> [handle]         every account with something kept
//   markPresent(handle)                the owner's app says it is open
//   presentAt(handle) -> ms            when it last said so
//   noteNext(handle, at, {earliest})   when the account's keeper next has work

// The app says it is open every five minutes; a little over that counts.
export const PRESENT_MS = 8 * 60_000;
// Entries per batch document, so a long backlog is a few documents, not one
// the drain cannot read.
export const BATCH_MAX = 100;
const RECEIPT = '.receipt.json';

const inboxOf = (rec) => rec.inboxUrl || rec.podHome + 'ap/inbox/';

// Only a browser account is held: its owner signs in (so the row has
// `openedAt`), and its app says when it is open. An account run by a DeviceAgent
// drains whenever mail lands, and keeps its mail as it always has.
export const holdsMail = (ctx, rec) => !!(ctx.holdMail && rec?.openedAt);

// Asked on every delivery, so it is remembered a minute per running copy.
const seen = new Map();   // handle -> { at, asked }
export async function isPresent(ctx, handle, now = Date.now()) {
  const had = seen.get(handle);
  if (had && now - had.asked < 60_000) return !!had.at && now - had.at < PRESENT_MS;
  const at = Number(await ctx.presentAt?.(handle).catch(() => 0)) || 0;
  if (seen.size > 10_000) seen.clear();
  seen.set(handle, { at, asked: now });
  return !!at && now - at < PRESENT_MS;
}

// The door's put while the app is closed: the same name the pod would have
// given the item, kept here instead.
export const holdingPut = (ctx, handle, rec) => async (url, body, ct) => {
  const name = url.slice(inboxOf(rec).length);
  await ctx.holdMail(handle, name, body, ct);
  return true;
};

// Everything held for one account, written to its pod inbox in batches and
// then let go. Returns how many deliveries reached the pod. A batch the pod
// refuses stays held for the next try.
export async function flushHeld(ctx, handle, rec, { now = Date.now() } = {}) {
  const names = await ctx.listHeld(handle);
  if (!names.length) return 0;
  const items = new Map();            // item name -> { body, receipt, held: [names] }
  for (const name of names) {
    const got = await ctx.readHeld(handle, name);
    const item = name.endsWith(RECEIPT) ? name.slice(0, -RECEIPT.length) : name;
    const e = items.get(item) || { held: [] };
    e.held.push(name);
    if (got != null) {
      if (name.endsWith(RECEIPT)) { try { e.receipt = JSON.parse(got); } catch { e.receipt = null; } } else e.body = got;
    }
    items.set(item, e);
  }
  // A receipt whose delivery is not here has nothing to vouch for.
  for (const [item, e] of items) {
    if (typeof e.body !== 'string') { for (const n of e.held) await ctx.dropHeld(handle, n); items.delete(item); }
  }
  const all = [...items];
  let delivered = 0;
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    const chunk = all.slice(i, i + BATCH_MAX);
    const batch = chunk.map(([name, e]) => ({ name, body: e.body, receipt: e.receipt || null }));
    const doc = `batch-${now}-${i / BATCH_MAX}-${Math.random().toString(36).slice(2, 8)}.json`;
    const ok = await ctx.podPut(handle, inboxOf(rec) + doc, JSON.stringify({ batch }), 'application/json');
    if (!ok) break;
    for (const [, e] of chunk) for (const n of e.held) await ctx.dropHeld(handle, n);
    delivered += chunk.length;
  }
  return delivered;
}

// Held mail the keeper should not leave until the owner's app opens: a
// follow, so it is accepted while they are away. Anything else waits, in the
// pod inbox, for the app or for the keeper's next run.
const WAKES_KEEPER = new Set(['Follow']);
export async function wakesKeeper(ctx, handle, rec, type) {
  if (!rec?.keeper || !ctx.noteNext || !WAKES_KEEPER.has(type)) return false;
  await ctx.noteNext(handle, new Date().toISOString(), { earliest: true }).catch(() => {});
  return true;
}

// The timer's round: every account with mail kept, delivered. An account that
// is gone, closed or moved has nowhere to deliver to, so its mail is let go.
// `keep(handle, rec)` answers true when the account's keeper will take its mail
// itself (lib/gateway/keeper.mjs), which delivers it and then reads it.
export async function flushAll(ctx, { log = console.log, isGone = async () => false, keep = async () => false } = {}) {
  for (const handle of await ctx.heldAccounts()) {
    const rec = await ctx.lookup(handle);
    if (!rec || rec.movedTo || await isGone(handle, rec)) {
      for (const n of await ctx.listHeld(handle)) await ctx.dropHeld(handle, n);
      log(`held mail @${handle}: let go (no account to deliver to)`);
      continue;
    }
    if (await keep(handle, rec).catch(() => false)) continue;
    const n = await flushHeld(ctx, handle, rec).catch((e) => { log(`held mail @${handle}: ${e?.message || e}`); return 0; });
    if (n) log(`held mail @${handle}: ${n} delivered to the pod`);
  }
}

// The owner letting the gateway act for them while the app is closed, or
// stopping it. Their app has already named the gateway in the rules on their
// pod (or taken it out) before it asks. Proved like /api/here.
export async function routeKeeperApi(request, pathname, ctx, deps) {
  if (pathname !== '/api/keeper') return null;
  const { j } = deps;
  if (request.method === 'OPTIONS') return deps.apiPreflight();
  if (request.method !== 'POST') return null;
  if (!ctx.putDirectory) return j(501, { error: 'this front keeps no directory' });
  let body;
  try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
  const handle = String(body.handle || '').toLowerCase();
  const rec = await ctx.lookup(handle);
  if (!rec) return j(404, { error: 'no such account' });
  const who = await deps.provedOwner(request, pathname, ctx, rec, deps);
  if (who.error) return who.error;
  const on = body.on === true;
  if (on && !ctx.keeperWebId) return j(501, { error: 'this gateway cannot act for accounts' });
  const next = { ...rec };
  if (on) next.keeper = { webId: ctx.keeperWebId, at: new Date().toISOString() };
  else delete next.keeper;
  await ctx.putDirectory(handle, next);
  console.log(`keeper @${handle}: ${on ? 'on' : 'off'}, at the owner's word`);
  return j(200, { ok: true, handle, kept: on, keeper: ctx.keeperWebId || null });
}

// The app's "I am open": marks the account present, so mail goes straight to
// the pod, and delivers what was kept while it was closed. The owner is proved
// the way the relay proves them. Returns a response, or null for other paths.
export async function routeHereApi(request, pathname, ctx, deps) {
  if (pathname !== '/api/here') return null;
  const { j } = deps;
  if (request.method === 'OPTIONS') return deps.apiPreflight();
  if (request.method !== 'POST') return null;
  if (!ctx.markPresent) return j(501, { error: 'this gateway holds no mail' });
  let body;
  try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
  const handle = String(body.handle || '').toLowerCase();
  const rec = await ctx.lookup(handle);
  if (!rec) return j(404, { error: 'no such account' });
  const who = await deps.provedOwner(request, pathname, ctx, rec, deps);
  if (who.error) return who.error;
  await ctx.markPresent(handle);
  seen.set(handle, { at: Date.now(), asked: Date.now() });
  // When its next scheduled post falls due, so the keeper publishes it if
  // the app has closed by then (keeper.mjs).
  if (body.nextAt !== undefined && ctx.noteNext) await ctx.noteNext(handle, body.nextAt || null).catch(() => {});
  const flushed = await flushHeld(ctx, handle, rec)
    .catch((e) => { console.log(`here @${handle}: held mail not delivered: ${e?.message || e}`); return 0; });
  return j(200, { ok: true, handle, flushed });
}
