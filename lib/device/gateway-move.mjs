// gateway-move.mjs — the second half of a DeviceAgent moving an address from
// one gateway to another (lib/device/setup.mjs does the first, when a pod
// that already holds an account at another gateway is set up with an address
// at this one). The browser build has the same two halves in
// web/app/gateway-move.mjs; this is the Node one, which signs and delivers
// itself instead of going through a relay.
//
//   1. The old gateway is told the address moved (POST /api/move, proved with
//      the pod session as attach was). From then on it serves the old actor
//      as a moved stub — same key, old id, `movedTo` the new one.
//   2. A Move goes to every follower, FROM the old actor, signed under the
//      old key id: the only signature a follower's server can verify against
//      the old actor. Same key material; only the key id differs.
//
// Runs when the agent starts acting, and is safe to run again: a move left
// pending (the old gateway unreachable) is tried at the next start.
import { Deliverer } from '../core/deliver.mjs';
import { moveActivity } from '../core/wire.mjs';

export async function completeGatewayMove(agent, { makeDeliverer = (o) => new Deliverer(o) } = {}) {
  const cfg = agent.store.getConfig();
  const mv = cfg?.movedFrom;
  if (!mv || mv.completedAt) return null;
  const log = agent.log || (() => {});
  const newActor = agent.urls.actor;

  // 1. the old gateway
  let told;
  try {
    told = await agent.remote.session.fetch(`${mv.gateway}/api/move`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: mv.handle, movedTo: newActor }),
    });
  } catch (e) { told = { status: 0, statusText: e.message }; }
  if (told.status !== 200) {
    log(`gateway move: ${mv.gateway} did not mark @${mv.handle} as moved (${told.status || told.statusText}) — will retry at the next start`);
    return { told: false };
  }

  // 2. the Move, from the old address
  const contacts = agent.store.getContacts();
  const inboxes = [...new Set(contacts.followers.map((f) => f.sharedInbox || f.inbox).filter(Boolean))];
  const activity = moveActivity({ actor: mv.actor }, newActor, Date.now());
  const sender = makeDeliverer({
    store: agent.store, rsaPrivate: agent.deliverer.rsaPrivate,
    keyId: `${mv.actor}#main-key`, actorId: mv.actor, log, passive: true,
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
