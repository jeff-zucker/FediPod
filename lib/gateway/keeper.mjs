// keeper.mjs — the gateway acting for a browser account while its owner's app
// is closed: follows are accepted, deliveries waiting to go out are sent, and
// scheduled posts and polls' ends happen on time.
//
// The owner lets it: their FediPod names the gateway's key reader in the rule
// on their signing key (and nothing else on the pod), and the row records
// `keeper`. It works from the account's copy and never writes the pod: what it
// changed is handed to the pod inbox at the end (account-agent.mjs: handOver).
// It takes the copy's lease like any other device, and gives it back when
// done.
//
// Mail: while an outside app is signed in (the copy is full), everything held
// is read into the copy, which the app shows. Otherwise only follows are taken
// here, and the rest goes to the pod inbox in batches for FediPod to read.
//
// One run is one account: keepOnce(). The fifteen-minute round (flush-mail.mjs)
// starts one when an account whose app is closed has work due: a follow held
// at the door, a failed delivery's next try, a scheduled post or a poll's end;
// or mail held for an account with an outside app signed in.

import { keeperSession } from './keeper-session.mjs';
import { flushHeld, heldEntries } from './held-mail.mjs';
import { publishDue, nextDue } from '../core/scheduled.mjs';
import { lockCopy } from './copy.mjs';
import { reachAccount, stateAndLease, actingAgent, handOver } from './account-agent.mjs';
import { readsMailHere } from './pod-mail.mjs';

export { keeperSession };

// A follow, or the undoing of one: what the gateway answers while the owner
// is away. Read from the delivery's own bytes.
export function isFollowish(entry) {
  let a = null;
  try { a = JSON.parse(entry.body); } catch { return false; }
  const type = (v) => (Array.isArray(v?.type) ? v.type : [v?.type]);
  return type(a).includes('Follow') || (type(a).includes('Undo') && type(a.object).includes('Follow'));
}

/**
 * One account's pending work, done once. `ctx` is the gateway's: the key
 * reader and the held-mail stores. `session` may be handed in (a test does);
 * otherwise the key reader's grant is used. Returns what happened.
 */
export async function keepOnce(ctx, handle, rec, { log = console.log, session = null } = {}) {
  // A forum, or one of its categories, is run whole by the forum's own code
  // (ctx.forum: the forum package's gateway module), not by an account's.
  if (ctx.forum?.isForumRow(rec)) return ctx.forum.keepOnce(ctx, handle, rec, { log, session });
  const say = (m) => log(`keeper @${handle}: ${m}`);
  const at = await reachAccount(ctx, handle, rec, { log, session });
  if (at.skipped) {
    // Nothing can be done here: the mail goes to the pod for FediPod.
    const flushed = ctx.listHeld ? await flushHeld(ctx, handle, rec).catch((e) => { say(`held mail not delivered: ${e.message}`); return 0; }) : 0;
    return { skipped: at.skipped, flushed };
  }
  const unlock = await lockCopy(ctx.copyKv, handle);
  if (!unlock) return { skipped: 'the gateway is busy with this account', retry: 'soon' };
  try {
    const { store, lease } = stateAndLease(ctx, handle, at, { log });
    if (!await lease.acquire()) return { skipped: 'another device is acting on this account', retry: 'soon' };
    try {
      await store.load();
      const agent = await actingAgent(at, store, lease, { log });
      if (agent.skipped) return { skipped: agent.skipped };
      let taken = 0; let flushed = 0;
      if (ctx.listHeld) {
        const entries = await heldEntries(ctx, handle);
        // The owner's own posts from the outbox door are always taken here.
        const wanted = readsMailHere(at.meta) ? entries : entries.filter((e) => isFollowish(e) || e.receipt?.method === 'c2s');
        const done = new Set(wanted.length ? await agent.intake.takeHeld(wanted) : []);
        for (const e of wanted) if (done.has(e.name)) for (const n of e.held) await ctx.dropHeld(handle, n);
        taken = done.size;
        if (!readsMailHere(at.meta)) flushed = await flushHeld(ctx, handle, rec).catch((e) => { say(`held mail not delivered: ${e.message}`); return 0; });
      }
      const published = await publishDue(store, agent.publisher, say);
      await agent.deliverer.drainQueue();
      agent.publisher.stopPolls?.();
      // A run that changed nothing on the pod sets its changes aside for the
      // round; one that did hands everything over now.
      const handed = await handOver(ctx, handle, rec, at, store, { log, defer: true });
      const waiting = (store.getQueue?.() || []).length;
      const nextAt = nextDue(store);
      say(`done: ${taken} held read here, ${flushed} sent to the pod, ${published} scheduled post(s) published, ${waiting} delivery(ies) waiting`);
      return { taken, flushed, published, waiting, nextAt, handed };
    } finally {
      await lease.release().catch(() => {});
    }
  } finally { await unlock(); }
}
