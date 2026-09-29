// gateway.mjs — the forum as fedipod.net runs it, with nothing running
// anywhere else. Two entries: placeAtDoor(), called by the door with the
// delivery it just wrote into the forum's inbox, places it in the same
// request; keepOnce(), the forum's run, carries what the door placed, drains
// what it left, applies moderators' asks and writes the heartbeat. Both work
// as the gateway's keeper identity, from the copies the gateway holds of the
// forum's and each category's state, under the forum's one copy lease.

import { PodTransport } from 'fedipod/pod/transport.mjs';
import { podBaseOfWebId } from 'fedipod/pod/urls.mjs';
import * as podInbox from 'fedipod/pod/inbox.mjs';
import { HttpStorage } from 'fedipod/core/storage.mjs';
import { Lease } from 'fedipod/core/lease.mjs';
import { CopyStorage, copyMeta, copyLease, lockCopy, GATEWAY_HOLDER } from 'fedipod/gateway/copy.mjs';
import { ensureCopy } from 'fedipod/gateway/state-api.mjs';
import { keeperSession } from 'fedipod/gateway/keeper-session.mjs';
import { ForumAgent } from './forum-agent.mjs';
import * as publish from './publish.mjs';

// How soon a run comes back for an ask that could not be applied yet.
const ASK_RETRY_MS = 60_000;

/** A forum's own row, or one of its categories': both write into one inbox. */
export const isForumRow = (rec) => !!rec?.inboxUrl && (rec.kind === 'group' || rec.kind === 'application');

/** The forum a row belongs to: its handle and row, and where it is on the pod. */
export async function forumFor(ctx, handle, rec) {
  const forumHandle = rec.kind === 'application' ? handle : rec.forum;
  if (!forumHandle) return { skipped: 'the category names no forum; run `fedipod-bb keep` again' };
  // Read fresh where the front offers it: the forum's row is switched on
  // last, and its first run starts in the same breath.
  const forumRec = forumHandle === handle ? rec : await (ctx.lookupFresh || ctx.lookup)(forumHandle);
  if (!forumRec || !isForumRow(forumRec) || !forumRec.keeper) return { skipped: `@${forumHandle} is not a forum this gateway keeps` };
  if (!forumRec.webId || !forumRec.podHome) return { skipped: 'the forum row names no owner or pod' };
  const home = forumRec.podHome.replace(/\/?$/u, '/');
  const pod = podBaseOfWebId(forumRec.webId);
  if (!home.startsWith(pod)) return { skipped: "the forum's folder is not on its owner's pod" };
  return { forumHandle, forumRec, home, pod, root: home.slice(pod.length) };
}

// The gateway's pod fetch, as the keeper: a session handed in, the keeper's
// credential, or the front's own keeperFetch.
async function keeperFetchFor(ctx, session) {
  if (session) return (u, i) => session.fetch(u, i);
  if (ctx.keeperCredential) { const s = keeperSession(ctx.keeperCredential); return (u, i) => s.fetch(u, i); }
  return ctx.keeperFetch ? ctx.keeperFetch() : null;
}

function transportFor(ctx, f, podFetch, log) {
  const remote = new PodTransport({ fetch: podFetch }, { webId: ctx.keeperWebId, log, role: 'keeper', runtime: 'node', cooldownMode: 'refuse' });
  // Any rule it writes names the forum's owner, and the keeper beside them.
  remote.aclOwner = f.forumRec.webId;
  remote.keepers = [ctx.keeperWebId];
  remote.aclIfChanged = true;
  return remote;
}

// Which copy holds a state container: the forum's own, or a category's. The
// inbox archive and anything else stays the pod's.
function copyHandleOf(base, f) {
  if (base === f.home + 'ap-state/') return f.forumHandle;
  const m = base.startsWith(f.home + 'c/') ? /^c\/([^/]+)\/ap-state\/$/u.exec(base.slice(f.home.length)) : null;
  return m ? m[1] : null;
}

/** State storage for the forum: the copy where one exists, fenced by the forum's lease; the pod otherwise. */
export function storageFactory(ctx, f, podFetch, copies) {
  return (base) => {
    const pod = new HttpStorage(base, podFetch);
    const h = copyHandleOf(base, f);
    if (!h || !copies.has(h)) return pod;
    return new CopyStorage(ctx.copyKv, h, { holder: GATEWAY_HOLDER, pod, podNames: ['keys.json'], fence: f.forumHandle });
  };
}

async function readConfig(ctx, f, podFetch) {
  const storage = await copyMeta(ctx.copyKv, f.forumHandle)
    ? new CopyStorage(ctx.copyKv, f.forumHandle, { holder: GATEWAY_HOLDER })
    : new HttpStorage(f.home + 'ap-state/', podFetch);
  const r = await storage.read('config.json', { accept: 'application/json' }).catch(() => null);
  if (!r?.ok || !r.body) return null;
  try { return JSON.parse(r.body); } catch { return null; }
}

/**
 * The copies the forum works from, the forum's and each category's, made
 * from the pod where missing. A copy cannot be made while another host
 * holds the pod's lease, which is how a forum still run elsewhere is left
 * alone until that host stops.
 */
export async function ensureForumCopies(ctx, f, config, log) {
  const rows = [[f.forumHandle, f.forumRec]];
  for (const c of config?.categories || []) {
    const r = await (ctx.lookupFresh || ctx.lookup)(c.slug);
    if (r && isForumRow(r)) rows.push([c.slug, r]);
  }
  const have = new Set();
  for (const [h, r] of rows) {
    if (await copyMeta(ctx.copyKv, h)) { have.add(h); continue; }
    const made = await ensureCopy(ctx, h, r, log);
    if (made.ok) have.add(h); else log(`copy @${h}: ${made.why}`);
  }
  return have;
}

/** Which copies exist now, without making any. */
async function copiesOf(ctx, f, config) {
  const have = new Set();
  if (await copyMeta(ctx.copyKv, f.forumHandle)) have.add(f.forumHandle);
  for (const c of config?.categories || []) if (await copyMeta(ctx.copyKv, c.slug)) have.add(c.slug);
  return have;
}

function agentFor(ctx, f, { remote, podFetch, copies, log, mode }) {
  const lease = copies.has(f.forumHandle)
    ? copyLease(ctx.copyKv, f.forumHandle, { id: GATEWAY_HOLDER, log })
    : new Lease({ url: f.home + 'ap-state/lease.json', fetchImpl: podFetch, log, id: `keeper:${ctx.keeperWebId}` });
  return new ForumAgent({
    log, remote, storageFor: storageFactory(ctx, f, podFetch, copies), push: false,
    credential: { remotePod: f.pod, root: f.root, webId: f.forumRec.webId },
    lease, holderId: GATEWAY_HOLDER, keepers: [ctx.keeperWebId],
    // The run may mint a new forum's first keys; the door never mints.
    mintKeys: mode === 'run', defer: mode === 'door',
  });
}

// When the run should come back on its own: a delivery's next try, or an ask
// that could not be applied yet.
function nextRun(forum, asksPending) {
  const times = [];
  for (const s of [forum.store, ...forum.categories.map((c) => c.store)]) {
    for (const item of s.getQueue?.() || []) if (item.nextAt) times.push(item.nextAt);
  }
  if (asksPending) times.push(Date.now() + ASK_RETRY_MS);
  return times.length ? Math.min(...times) : null;
}

/**
 * One run of the forum: what the door left in the inbox is drained, what it
 * placed is carried, moderators' asks are applied, the heartbeat is written.
 * Returns what the keeper's bookkeeping expects: { drained, waiting, nextAt }
 * or { skipped, retry }.
 */
// A queued delivery's identity: where it goes and what it carries.
const queueKey = (item) => `${item.inbox}\u0000${typeof item.activity === 'string' ? item.activity : JSON.stringify(item.activity)}`;

/**
 * The queue after a carry that ran with nobody holding the forum: `before`
 * is what the run took out to carry, `after` what the carry left of it
 * (delivered items gone, failed ones with their next time), `fresh` the
 * queue as the copy holds it now, which the door may have added to in the
 * meantime. A door only ever appends, so: an item the run took out is kept
 * as the carry left it or dropped if delivered; anything else is the door's
 * and stays.
 */
export function mergeQueues(before, after, fresh) {
  const taken = new Set(before.map(queueKey));
  const left = new Map(after.map((i) => [queueKey(i), i]));
  const out = [];
  for (const item of fresh) {
    const k = queueKey(item);
    if (!taken.has(k)) { out.push(item); continue; }
    if (left.has(k)) out.push(left.get(k));
  }
  return out;
}

const storesOf = (forum) => [forum.store, ...forum.categories.map((c) => c.store)];
const deliverersOf = (forum) => [...forum.categories.map((c) => c.deliverer), forum.siteAgent.deliverer];

export async function keepOnce(ctx, handle, rec, { log = console.log, session = null, remote: given = null, prepare = null } = {}) {
  const f = await forumFor(ctx, handle, rec);
  if (f.skipped) return { skipped: f.skipped };
  const say = (m) => log(`forum @${f.forumHandle}: ${m}`);
  const podFetch = given ? (u, i) => given.fetch(u, i) : await keeperFetchFor(ctx, session);
  if (!podFetch) return { skipped: 'this gateway cannot reach pods for accounts' };
  const remote = given || transportFor(ctx, f, podFetch, say);
  const config = await readConfig(ctx, f, podFetch);
  if (!config) return { skipped: 'no forum on the pod' };
  const copies = await ensureForumCopies(ctx, f, config, say);
  // The forum is held only while its state changes: the drain, the asks, the
  // queue, the heartbeat, the write to the copies. The carry — one signed
  // POST per follower server, each with its own timeout — runs with the forum
  // free, so a post arriving at the door meanwhile is placed at once instead
  // of waiting for the run to end. The queue the carry changes is written
  // back under the lock, merged with whatever the door queued in between.
  const unlock = await lockCopy(ctx.copyKv, f.forumHandle);
  if (!unlock) return { skipped: 'the gateway is busy with this forum', retry: 'soon' };
  let forum;
  let before;
  let asks = 0;
  try {
    forum = agentFor(ctx, f, { remote, podFetch, copies, log: say, mode: 'run' });
    if (!await forum.connect({ act: false })) return { skipped: 'no forum on the pod' };
    prepare?.(forum);   // a test's origins, in place of the network
    if (!await forum.lease.acquire()) return { skipped: 'another host has the forum', retry: 'soon' };
    try {
      await forum.publishAll();
      await forum.intake.drain();
      await forum.applyVerifiedAsks().catch((e) => say(`asks: ${e.message}`));
      await forum.publishModQueue().catch((e) => say(`queue: ${e.message}`));
      await publish.publishHeartbeat(forum.siteAgent).catch((e) => say(`heartbeat: ${e.message}`));
      await Promise.allSettled(storesOf(forum).map((s) => s.flush()));
      asks = storesOf(forum).reduce((n, s) => n + s.read('modqueue.json', []).length, 0);
      before = new Map(storesOf(forum).map((s) => [s, s.getQueue?.() || []]));
    } finally { await forum.lease.release().catch(() => {}); }
  } finally { await unlock(); }

  // The carry, with the forum free.
  for (const d of deliverersOf(forum)) await d.drainQueue().catch((e) => say(`carry: ${e.message}`));
  const after = new Map(storesOf(forum).map((s) => [s, s.getQueue?.() || []]));

  // What the carry left, written back under the lock beside what the door
  // queued meanwhile. The door holds the forum for seconds, so the wait is short.
  const relock = await lockCopy(ctx.copyKv, f.forumHandle, { waitMs: 20_000 });
  if (!relock) { say('the queue could not be written back: the forum stayed busy'); return { drained: true, waiting: null, retry: 'soon' }; }
  let waiting = 0;
  try {
    // The copy takes a write only from the lease's holder; the lease again, briefly.
    if (!await forum.lease.acquire()) { say('the queue could not be written back: another host has the forum'); return { drained: true, waiting: null, retry: 'soon' }; }
    for (const s of storesOf(forum)) {
      let fresh = null;
      try { await s.load(); fresh = s.getQueue?.() || []; } catch { fresh = null; }
      const merged = fresh ? mergeQueues(before.get(s) || [], after.get(s) || [], fresh) : (after.get(s) || []);
      s.setQueue?.(merged);
      waiting += merged.length;
    }
    await Promise.allSettled(storesOf(forum).map((s) => s.flush()));
  } finally { await forum.lease.release().catch(() => {}); await relock(); }
  // The run wrote on the pod (what the door could not place, the queue, the
  // heartbeat): the edge's copies of the forum's documents go.
  if (ctx.purge) {
    const tags = [`u-${f.forumHandle}`, ...(config.categories || []).map((c) => `u-${c.slug}`)];
    await ctx.purge(tags).catch((e) => say(`purge: ${e.message}`));
  }
  say(`done: inbox drained, ${waiting} delivery(ies) waiting, ${asks} ask(s) pending`);
  return { drained: true, waiting, nextAt: nextRun(forum, asks) };
}

/**
 * The delivery the door just wrote into the forum's inbox, placed now: the
 * forum handles it with every send deferred, and when it is done the item
 * and its receipt leave the inbox. Returns { placed, forum, why }. Whatever
 * is not placed here stays in the inbox for the run the caller starts.
 */
export async function placeAtDoor(ctx, handle, rec, { name, raw, receipt = null, log = console.log, waitMs = 3000, remote: given = null, prepare = null } = {}) {
  const f = await forumFor(ctx, handle, rec);
  if (f.skipped) return { placed: false, why: f.skipped };
  const out = { placed: false, forum: f.forumHandle };
  if (!await copyMeta(ctx.copyKv, f.forumHandle)) return { ...out, why: 'the forum has no copy yet' };
  const podFetch = given ? (u, i) => given.fetch(u, i) : await keeperFetchFor(ctx, null);
  if (!podFetch) return { ...out, why: 'this gateway cannot reach pods for accounts' };
  const say = (m) => log(`door @${f.forumHandle}: ${m}`);
  const remote = given || transportFor(ctx, f, podFetch, say);
  const config = await readConfig(ctx, f, podFetch);
  if (!config) return { ...out, why: 'no forum on the pod' };
  const copies = await copiesOf(ctx, f, config);
  const unlock = await lockCopy(ctx.copyKv, f.forumHandle, { waitMs });
  if (!unlock) return { ...out, why: 'the forum is busy' };
  try {
    const forum = agentFor(ctx, f, { remote, podFetch, copies, log: say, mode: 'door' });
    if (!await forum.connect({ act: false })) return { ...out, why: 'no forum on the pod' };
    prepare?.(forum);   // a test's origins, in place of the network
    if (!await forum.lease.acquire()) return { ...out, why: 'another host has the forum' };
    try {
      if (!await forum.placeOne(name, raw, receipt)) return { ...out, why: 'not done here; left for the run' };
      const item = f.home + 'ap/inbox/' + name;
      await podInbox.dropHandledItem(remote, item).catch(() => false);
      await podInbox.dropReceiptBeside(remote, item);
      return { ...out, placed: true };
    } finally { await forum.lease.release().catch(() => {}); }
  } finally { await unlock(); }
}
