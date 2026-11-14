// held-mail.mjs — a browser account's mail, held at the gateway while its
// owner's app is closed, and handed to the pod as one batch.
//
// Every delivery the door takes is two writes into the owner's pod inbox, and
// the drain then reads and deletes both: six pod requests a piece. While the
// app is closed nobody reads it, so the door keeps it here instead
// (ctx.holdMail), and writes it to the pod inbox as one document when the app
// says it is open (POST /api/here) or when the timer comes round (flushAll).
// While the app is open, mail goes straight to the pod as it always has. With
// the hold off (copy.mjs: FEDIPOD_HOLD), nothing is held: mail goes straight
// to the pod whether the app is open or not.
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

import { copyMeta, keptNow, holdOn } from './copy.mjs';

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
export const holdsMail = (ctx, rec) => !!(ctx.holdMail && rec?.openedAt && holdOn(ctx));
// A browser account whose app may be closed: its mail is held, or with the
// hold off, sent to the pod, and either way a follow or a notification starts
// the work that answers it (afterHeld).
export const mayBeAway = (ctx, rec) => !!(ctx.holdMail && rec?.openedAt);

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

/**
 * What is held for one account, each delivery with its receipt:
 * [{ name, body, receipt, held: [the held names it came from] }]. A receipt
 * whose delivery is not here has nothing to vouch for, and is let go.
 */
// `max`: at most that many deliveries, the first by name, and no more of the
// pile is listed or read than holds them. Without it, everything.
export async function heldEntries(ctx, handle, { max = Infinity } = {}) {
  // A receipt may sit beside each delivery: twice as many names hold them whole.
  const names = (await ctx.listHeld(handle, Number.isFinite(max) ? { limit: max * 2 } : {})).sort();
  if (!names.length) return [];
  const items = new Map();            // item name -> { body, receipt, held: [names] }
  for (const name of names) {
    const item = name.endsWith(RECEIPT) ? name.slice(0, -RECEIPT.length) : name;
    if (!items.has(item) && items.size >= max) break;
    const e = items.get(item) || { held: [] };
    e.held.push(name);
    items.set(item, e);
  }
  await inTurns([...items], async ([item, e]) => {
    for (const name of e.held) {
      const got = await ctx.readHeld(handle, name);
      if (got == null) continue;
      if (name.endsWith(RECEIPT)) { try { e.receipt = JSON.parse(got); } catch { e.receipt = null; } } else e.body = got;
    }
    if (typeof e.body !== 'string') { for (const n of e.held) await ctx.dropHeld(handle, n); items.delete(item); }
  });
  return [...items].map(([name, e]) => ({ name, body: e.body, receipt: e.receipt || null, held: e.held }));
}

// A few at a time: a pile is read and let go quickly without asking the store
// for all of it at once.
const TOGETHER = 6;
async function inTurns(list, fn) {
  for (let i = 0; i < list.length; i += TOGETHER) await Promise.all(list.slice(i, i + TOGETHER).map(fn));
}

// What is held for one account, written to its pod inbox in batches and then
// let go: every batch, or `batches` of them. Returns how many deliveries
// reached the pod. A batch the pod refuses, or does not take within `podMs`
// where one is given, stays held for the next try.
export async function flushHeld(ctx, handle, rec, { now = Date.now(), batches = Infinity, podMs = null } = {}) {
  let delivered = 0;
  const sent = new Set();
  for (let i = 0; i < batches; i++) {
    // A delivery written once is not written again, should letting it go fail.
    const chunk = (await heldEntries(ctx, handle, { max: BATCH_MAX })).filter((e) => !sent.has(e.name));
    if (!chunk.length) break;
    const batch = chunk.map((e) => ({ name: e.name, body: e.body, receipt: e.receipt || null }));
    const doc = `batch-${now}-${i}-${Math.random().toString(36).slice(2, 8)}.json`;
    const ok = await ctx.podPut(handle, inboxOf(rec) + doc, JSON.stringify({ batch }), 'application/json', podMs ? { timeoutMs: podMs } : undefined);
    if (!ok) break;
    for (const e of chunk) sent.add(e.name);
    await inTurns(chunk.flatMap((e) => e.held), (n) => ctx.dropHeld(handle, n));
    delivered += chunk.length;
  }
  return delivered;
}

// Held mail the keeper should not leave until the owner's app opens: a
// follow, so it is accepted while they are away. Anything else waits, in the
// pod inbox, for the app or for the keeper's next run.
const WAKES_KEEPER = new Set(['Follow']);
export async function wakesKeeper(ctx, handle, rec, type) {
  if (!keptNow(ctx, rec) || !ctx.noteNext || !WAKES_KEEPER.has(type)) return false;
  await ctx.noteNext(handle, new Date().toISOString(), { earliest: true }).catch(() => {});
  return true;
}

// A notice that an account was deleted, arriving for a forum this gateway
// keeps, starts no run of its own: the forum is marked as having work, and the
// round's run reads the notice from the inbox. False where that cannot be
// noted, so the caller starts the run as for any delivery.
export async function waitsForRound(ctx, handle, rec, { accountDeleted = false } = {}) {
  const forum = rec.kind === 'application' ? handle : rec.forum;
  if (!accountDeleted || !forum || !ctx.noteNext) return false;
  const noted = await ctx.noteNext(forum, new Date().toISOString(), { earliest: true }).then(() => true, () => false);
  if (noted) console.log(`door @${handle}: an account's deletion, left for the round's run of @${forum}`);
  return noted;
}

// After a delivery is held: a follow wakes the keeper, and anything that
// becomes a notification is read in and pushed at once to the phones and
// browsers the owner signed up for notifications (masto-gateway.mjs: pushHeld).
export async function afterHeld(ctx, handle, rec, { type, notifies = false } = {}) {
  await wakesKeeper(ctx, handle, rec, type);
  if (notifies && keptNow(ctx, rec) && ctx.startPush && await ctx.pushWanted?.(handle).catch(() => false)) {
    await ctx.startPush(handle).catch((e) => console.log(`push @${handle}: not started: ${e?.message || e}`));
  }
}

// The timer's round: every account with mail kept, delivered. An account that
// is gone, closed or moved has nowhere to deliver to, so its mail is let go.
// `keep(handle, rec)` answers true when the account's keeper will take its mail
// itself (lib/gateway/keeper.mjs), which delivers it and then reads it.
//
// The round has to end. So an account gets one batch a round, a pod has
// ROUND_POD_MS to take it, a few accounts are worked on at a time, and each
// round begins after the account the last one finished with (ctx.roundMark,
// ctx.setRoundMark): a round cut short leaves out different accounts each time.
export const ROUND_POD_MS = 10_000;
const ROUND_TOGETHER = 4;
export async function flushAll(ctx, { log = console.log, isGone = async () => false, keep = async () => false } = {}) {
  const all = [...await ctx.heldAccounts()].sort();
  const mark = await ctx.roundMark?.().catch(() => null);
  const from = mark ? all.findIndex((h) => h > mark) : 0;
  const order = from > 0 ? [...all.slice(from), ...all.slice(0, from)] : all;
  const one = async (handle) => {
    const rec = await ctx.lookup(handle);
    if (!rec || rec.movedTo || await isGone(handle, rec)) {
      await inTurns(await ctx.listHeld(handle, { limit: BATCH_MAX * 2 }), (n) => ctx.dropHeld(handle, n));
      log(`held mail @${handle}: let go (no account to deliver to)`);
      return;
    }
    if (await keep(handle, rec).catch(() => false)) return;
    const n = await flushHeld(ctx, handle, rec, { batches: 1, podMs: ROUND_POD_MS });
    if (n) log(`held mail @${handle}: ${n} delivered to the pod`);
  };
  for (let i = 0; i < order.length; i += ROUND_TOGETHER) {
    const turn = order.slice(i, i + ROUND_TOGETHER);
    await Promise.all(turn.map((h) => one(h).catch((e) => log(`held mail @${h}: ${e?.message || e}`))));
    await ctx.setRoundMark?.(turn.at(-1)).catch(() => {});
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
  // The account's copy goes back to the pod before the gateway stops
  // (state-api.mjs: leave); the owner's app asks for that first.
  if (!on && ctx.copyKv && await copyMeta(ctx.copyKv, handle)) {
    return j(409, { error: "the account's copy is still at the gateway; give it back to the pod first", copy: true });
  }
  const next = { ...rec };
  if (on) next.keeper = { webId: ctx.keeperWebId, at: new Date().toISOString() };
  else delete next.keeper;
  // A forum's category names the forum it belongs to, so a delivery to the
  // category finds the forum's copy and lease.
  if (typeof body.forum === 'string' && /^[a-z0-9][a-z0-9._-]{0,60}$/u.test(body.forum)) next.forum = body.forum;
  await ctx.putDirectory(handle, next);
  console.log(`keeper @${handle}: ${on ? 'on' : 'off'}, at the owner's word`);
  // A forum's own row turned on starts its first run now: the run makes the
  // copies, mints the keys a new forum has none of, and publishes its actors,
  // so there is a forum to read before anyone posts to it. Its categories'
  // rows are turned on before it (setup.mjs in the forum package).
  if (on && next.kind === 'application' && ctx.forum?.isForumRow(next) && ctx.startKeeper) {
    await ctx.startKeeper(handle).catch((e) => console.log(`keeper @${handle}: not started (${e.message})`));
  }
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
  // `hold`: with it off, a browser working from a copy goes back to the pod.
  // `missingLetter`: the gateway's test letter has not arrived (check-letter.mjs).
  const missing = await deps.missingLetter?.(handle).catch(() => null);
  return j(200, { ok: true, handle, flushed, hold: holdOn(ctx), ...(missing ? { missingLetter: missing } : {}) });
}

// FediPod could not read some of its owner's mail: they are told on the phones
// and browsers they signed up for notifications, in FediPod's own words.
// Proved like /api/here. Returns a response, or null for other paths.
export async function routeAlertApi(request, pathname, ctx, deps) {
  if (pathname !== '/api/alert') return null;
  const { j } = deps;
  if (request.method === 'OPTIONS') return deps.apiPreflight();
  if (request.method !== 'POST') return null;
  let body;
  try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
  const handle = String(body.handle || '').toLowerCase();
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 200) : '';
  if (!text) return j(400, { error: 'text required' });
  const rec = await ctx.lookup(handle);
  if (!rec) return j(404, { error: 'no such account' });
  const who = await deps.provedOwner(request, pathname, ctx, rec, deps);
  if (who.error) return who.error;
  if (!ctx.startPush || !await ctx.pushWanted?.(handle).catch(() => false)) return j(200, { ok: true, handle, pushing: 0 });
  await ctx.startPush(handle, { alert: text }).catch((e) => console.log(`alert @${handle}: not started: ${e?.message || e}`));
  return j(200, { ok: true, handle, pushing: 1 });
}

// FediPod open in a browser reads its own mail, so nothing is held for the
// door to push: it names the notifications it made, and they are pushed to the
// phones and browsers its owner signed up (masto-gateway.mjs: pushMade).
// Proved like /api/here. Returns a response, or null for other paths.
const NOTIFICATION_ID = /^[0-9a-f]{16}$/u;
export async function routePushApi(request, pathname, ctx, deps) {
  if (pathname !== '/api/push') return null;
  const { j } = deps;
  if (request.method === 'OPTIONS') return deps.apiPreflight();
  if (request.method !== 'POST') return null;
  let body;
  try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
  const handle = String(body.handle || '').toLowerCase();
  const rec = await ctx.lookup(handle);
  if (!rec) return j(404, { error: 'no such account' });
  const who = await deps.provedOwner(request, pathname, ctx, rec, deps);
  if (who.error) return who.error;
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter((id) => NOTIFICATION_ID.test(String(id))))].slice(0, 50);
  if (!ids.length || !ctx.startPush || !await ctx.pushWanted?.(handle).catch(() => false)) return j(200, { ok: true, handle, pushing: 0 });
  await ctx.startPush(handle, { ids }).catch((e) => console.log(`push @${handle}: not started: ${e?.message || e}`));
  return j(200, { ok: true, handle, pushing: ids.length });
}
