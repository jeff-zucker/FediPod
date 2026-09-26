// keeper.mjs — the gateway acting for a browser account while its owner's app
// is closed: the mail it held reaches the pod, the inbox is drained, follows
// and replies are handled, and deliveries waiting to go out are sent.
//
// The owner lets it (their app names the gateway's pod identity in the rules on
// their account's folder, and the row records `keeper`). It works with that
// identity and nothing else: it reads the signing key from the pod when it
// needs it, keeps no copy, and never makes or changes one. It takes the
// account's lease like any other device, and gives it back when done, so the
// owner's app finds the lease free and takes over as usual.
//
// One run is one account: keepOnce(). The fifteen-minute round (flush-mail.mjs)
// starts one only when an account whose app is closed has work due: a follow
// held at the door, a failed delivery's next try, a scheduled post or a poll's
// end. Other mail waits in the pod inbox for the app.

import { keeperSession } from './keeper-session.mjs';
import { flushHeld, heldEntries } from './held-mail.mjs';
import { publishDue, nextDue } from '../core/scheduled.mjs';
import { lockCopy } from './copy.mjs';
import { reachAccount, stateAndLease, actingAgent } from './account-agent.mjs';

export { keeperSession };

/**
 * One account's pending work, done once. `ctx` is the gateway's: keeperWebId,
 * keeperCredential and the held-mail stores. `session` may be handed in (a
 * test does); otherwise the keeper's grant is used. Returns what happened.
 *
 * An account whose copy the gateway keeps (copy.mjs) is worked on there: its
 * held mail is read straight into the copy, and the pod is written by the
 * round, not here. Otherwise the held mail goes to the pod inbox first, so the
 * drain reads it, as before.
 */
export async function keepOnce(ctx, handle, rec, { log = console.log, session = null } = {}) {
  const say = (m) => log(`keeper @${handle}: ${m}`);
  const at = await reachAccount(ctx, handle, rec, { log, session });
  if (at.skipped) return { skipped: at.skipped };

  const unlock = at.inCopy ? await lockCopy(ctx.copyKv, handle) : async () => {};
  if (!unlock) return { skipped: 'the gateway is busy with this account', retry: 'soon' };
  try {
    // Held mail goes in first, so this drain reads it.
    const flushed = !at.inCopy && ctx.listHeld
      ? await flushHeld(ctx, handle, rec).catch((e) => { say(`held mail not delivered: ${e.message}`); return 0; }) : 0;
    const { store, lease } = stateAndLease(ctx, handle, at, { log });
    if (!await lease.acquire()) return { skipped: 'another device is acting on this account', flushed, retry: 'soon' };
    try {
      await store.load();
      const agent = await actingAgent(at, store, lease, { log });
      if (agent.skipped) return { skipped: agent.skipped, flushed };
      let taken = 0;
      if (at.inCopy && ctx.listHeld) {
        const entries = await heldEntries(ctx, handle);
        const done = new Set(await agent.intake.takeHeld(entries));
        for (const e of entries) if (done.has(e.name)) for (const n of e.held) await ctx.dropHeld(handle, n);
        taken = done.size;
      }
      await agent.intake.drain();
      const published = await publishDue(store, agent.publisher, say);
      await agent.deliverer.drainQueue();
      await store.flush?.();
      agent.publisher.stopPolls?.();
      const waiting = (store.getQueue?.() || []).length;
      const nextAt = nextDue(store);
      say(`done: ${flushed + taken} held delivered, inbox drained, ${published} scheduled post(s) published, ${waiting} delivery(ies) waiting`);
      return { flushed: flushed + taken, drained: true, published, waiting, nextAt };
    } finally {
      await lease.release().catch(() => {});
    }
  } finally { await unlock(); }
}
