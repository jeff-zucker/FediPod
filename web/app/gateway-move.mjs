// gateway-move.mjs — the second half of moving an address from one gateway
// to another (signup.mjs moveIn is the first). It runs on the agent's first
// active boot under the new ids, once the new actor is published with the
// old one as an alias, and it is safe to run again: nothing here is done
// twice with the same result changed.
//
//   1. The old gateway is told the address moved (POST /api/move, proved
//      with the pod session as attach was). It serves the old actor as a
//      moved stub from then on — same key, old id, `movedTo` the new one.
//   2. A Move goes to every follower, FROM the old actor, signed under the
//      old key id, through the old gateway's relay: that is the only
//      signature a follower's server can verify against the old actor.
//
// The followers' servers fetch the old actor, find `movedTo`, fetch the new
// one, find the old among its `alsoKnownAs`, and move the follow.
import { RelayDeliverer } from './deliver-relay.mjs';
import { moveActivity } from '../../lib/core/wire.mjs';

export async function completeGatewayMove(agent) {
  const cfg = agent.store.getConfig();
  const mv = cfg?.movedFrom;
  if (!mv || mv.completedAt) return null;
  const log = agent.log;
  const newActor = agent.urls.actor;

  // 1. the old gateway
  let told;
  try {
    told = await agent.sessionFetch(`${mv.gateway}/api/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: mv.handle, movedTo: newActor }),
    });
  } catch (e) { told = { status: 0, statusText: e.message }; }
  if (told.status !== 200) {
    // Left pending: the next active boot tries again. Followers are not told
    // until the old actor can vouch for the Move.
    log(`gateway move: ${mv.gateway} did not mark @${mv.handle} as moved (${told.status || told.statusText}) — will retry`);
    return { told: false };
  }

  // 2. the Move, from the old address
  const contacts = agent.store.getContacts();
  const inboxes = [...new Set(contacts.followers.map((f) => f.sharedInbox || f.inbox).filter(Boolean))];
  const activity = moveActivity({ actor: mv.actor }, newActor, Date.now());
  const sender = new RelayDeliverer({
    passive: true, store: agent.store, rsaPrivate: agent.deliverer.rsaPrivate,
    keyId: `${mv.actor}#main-key`, actorId: mv.actor, log,
    relayUrl: `${mv.gateway}/api/relay`, handle: mv.handle, sessionFetch: agent.sessionFetch,
  });
  let sent = 0; let failed = 0;
  for (const inbox of inboxes) {
    try { await sender.deliverNow(inbox, activity); sent++; }
    catch (e) { failed++; log(`gateway move: Move to ${inbox} failed: ${e.message}`); }
  }
  const done = { ...mv, completedAt: new Date().toISOString(), moveSent: sent, moveFailed: failed };
  agent.store.setConfig({ ...agent.store.getConfig(), movedFrom: done });
  await agent.store.flush?.();
  log(`moved from ${mv.actor} to ${newActor}: Move sent to ${sent} inbox(es)${failed ? `, ${failed} failed` : ''}`);
  return done;
}
