// copy-mode.mjs — the browser agent working from its account's copy at the
// gateway (lib/gateway/copy.mjs, lib/gateway/state-api.mjs), for an account the
// gateway keeps running.
//
// The state documents are read and written at the gateway instead of on the
// pod, and the lease that says which agent acts is the copy's. What stays on
// the pod (the key, connected-account passwords) is still read there. Every
// fifteen minutes the gateway writes the copy to the pod and deletes it, and
// makes it again from the pod when this browser next reads or writes (the
// hold); the copy's lease stays, so nothing here notices.
//
// With the hold off, the gateway keeps no copy, and this browser works on the
// pod while the gateway acts there too for an app. The pod's lease decides
// which acts, and every write first checks this browser still holds it
// (fencePod), as the copy checks every write.
import { HttpStorage, StateApiStorage, FencedStorage, podOnly } from '../../lib/core/storage.mjs';
import { Lease } from '../../lib/core/lease.mjs';
import { kvGet, kvPut, kvDel } from './idb-kv.mjs';

// A token this much short of its end is renewed before it is used again.
const RENEW_BEFORE_MS = 2 * 3600_000;

// After the gateway could not find or make the copy, this browser does not
// ask again for this long: its worker is restarted whenever a client checks
// for posts, about once a minute, and every ask cost the gateway a try at the
// pod. The account works from its pod meanwhile, as after any failed ask. A
// sign-in, as against a restart, asks anyway, and turning keeping on forgets
// the failure (agent.mjs setKeeper). A network failure or a refused sign-in is
// not remembered: those are this browser's to put right. Nor is "held by
// another device" after this browser lets go of the pod (moveIntoCopy): what
// the gateway found held may have been this browser's own lease.
const ASK_AGAIN_MS = 15 * 60_000;
const REMEMBERED = [404, 409, 501, 502, 503];
const failedKey = (agent, frontOrigin) => `copy-open-failed:${frontOrigin}:${agent.webId}`;
export const forgetFailedOpen = (agent, frontOrigin) => kvDel(failedKey(agent, frontOrigin)).catch(() => {});

/**
 * Ask the gateway for this account's copy, making it if there is none yet.
 * `handle` names the account when the agent knows it. Returns the copy
 * ({ handle, base, token, expiresAt }) or null, in which case the account
 * works from its pod.
 */
export async function openCopy(agent, frontOrigin, { handle = null, kept = null, askAnyway = false, letGo = false } = {}) {
  if (kept && kept.expiresAt - Date.now() > RENEW_BEFORE_MS) return kept;
  if (!agent.sessionFetch || !frontOrigin) return null;
  const key = failedKey(agent, frontOrigin);
  const failed = await kvGet(key).catch(() => null);
  const held = letGo && failed?.status === 409;
  if (!askAnyway && !held && failed && Date.now() - failed.at < ASK_AGAIN_MS) return null;
  let res;
  try {
    res = await agent.sessionFetch(`${frontOrigin.replace(/\/$/u, '')}/api/state/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(handle ? { handle } : {}),
    });
  } catch (e) { agent.log(`the account's copy: ${e.message}`); return null; }
  if (res.status !== 200) {
    // 404, 409 and 501 are answers (no copy for this account here); anything
    // else is worth saying.
    if (![404, 409, 501].includes(res.status)) {
      const why = (await res.json().catch(() => null))?.error;
      agent.log(`the account's copy: the gateway answered ${res.status}${why ? ` (${why})` : ''}`);
    }
    if (REMEMBERED.includes(res.status)) await kvPut(key, { at: Date.now(), status: res.status }).catch(() => {});
    return null;
  }
  if (failed) await kvDel(key).catch(() => {});
  const copy = await res.json().catch(() => null);
  return copy?.base && copy?.token
    ? { handle: copy.handle, base: copy.base, token: copy.token, expiresAt: copy.expiresAt, podHome: copy.podHome || null }
    : null;
}

// Every request to the copy carries its token, read at the time of asking so a
// renewed one is used at once.
const tokenFetch = (agent) => (u, i = {}) => fetch(u, {
  ...i, headers: { ...(i.headers || {}), authorization: `Bearer ${agent.copy.token}` },
});

/** The store's storage, and the lease, for working from the copy. */
export function copyStorage(agent, podState) {
  const s = new StateApiStorage(agent.copy.base, {
    fetchImpl: (u, i) => fetch(u, i), token: agent.copy.token, holder: agent.holderId, pod: podState,
    // Refused: another agent (an app at the gateway, another browser) took
    // the lease. This one stops acting at once rather than at its next renewal.
    onRefused: () => standDown(agent),
    // No copy any more, and none to be made: the hold turned off.
    onGone: () => { backToPod(agent).catch((e) => agent.log(`back to the pod: ${e.message}`)); },
  });
  Object.defineProperty(s, 'token', { get: () => agent.copy.token, set() {} });
  return s;
}

export function copyLeaseOf(agent) {
  return new Lease({ url: `${agent.copy.base}lease.json`, fetchImpl: tokenFetch(agent), log: agent.log, id: agent.holderId });
}

const podFetchOf = (agent) => (u, i) => agent.remote.fetch(u, i);

/** The account's state on the pod, fenced when the gateway may act there too. */
export function podStorageOf(agent) {
  const s = new FencedStorage(new HttpStorage(agent.urls.state, podFetchOf(agent)), { onRefused: () => standDown(agent) });
  if (agent._fenced) s.fence = () => stillMine(agent);
  return s;
}

// Whether this browser still holds the pod's lease, asked before a write.
// Unreadable is a yes: the write goes, as it would have without the check.
async function stillMine(agent) {
  const cur = await agent.lease.readFresh().catch(() => null);
  if (!cur || typeof cur !== 'object') return true;
  return cur.holder === agent.lease.id && Date.now() < cur.expiresAt;
}

/**
 * Whether this browser's writes to the pod are fenced: the account kept, with
 * the hold off, and no copy. Set on the store's storage as it is now.
 */
export function fencePod(agent) {
  agent._fenced = !!(agent._keeper?.kept && agent._keeper.hold === false && !agent.copy && !agent.store?.getConfig()?.keeperOff);
  const s = agent.store?.storage;
  if (s instanceof FencedStorage) s.fence = agent._fenced ? () => stillMine(agent) : null;
}

// A lease held by the gateway, which gives it back when its piece of work is
// done: the copy's ('gateway', copy.mjs), or with the hold off the pod's
// (lib/gateway/account-agent.mjs: keeper:<its WebID>).
const byGateway = (holder) => holder === 'gateway' || String(holder || '').startsWith('keeper:');

// Swap the lease the agent and its drain go by.
function useLease(agent, lease) {
  agent.lease.stopRenewal();
  agent.lease = lease;
  if (agent.intake) agent.intake.lease = lease;
  lease.onLost = () => (agent.copy || agent._fenced ? standDown(agent) : agent.demote());
}

/**
 * Before this browser acts: is the copy's lease still its own? An app at the
 * gateway may have taken it and let it go since. Free again, it is taken back
 * and the copy read afresh, so the action starts from what the app wrote.
 * Held by somebody else, the browser stands down and the caller takes over as
 * from any other device. True when this browser holds it now.
 */
export async function ensureCopyLease(agent) {
  const cur = await agent.lease.readFresh().catch(() => null);
  if (!cur || typeof cur !== 'object') return true;           // unreadable: the copy refuses if it is wrong
  if (cur.holder === agent.lease.id && Date.now() < cur.expiresAt) return true;
  // Held by another agent: this browser stands down, dropping what it had
  // queued, and the caller takes over, reading the copy afresh.
  if (Date.now() < cur.expiresAt) { agent.demote(); await agent.store.discardPending(); return false; }
  // Free: an app acted and let it go. Writes queued here since are older than
  // what the app wrote, so they are dropped, not sent.
  agent._ensuring = true;
  try {
    await agent.store.discardPending();
    if (!await agent.lease.acquire()) { agent.demote(); return false; }
    await agent.store.load({ force: true });
    agent.lease.startRenewal();
    return true;
  } finally { agent._ensuring = false; }
}

/**
 * Another agent took the lease: an app acting at the gateway, which gives it
 * back as soon as it is done. This browser stops acting at once, then takes
 * the lease back when it is free, reading the copy afresh first (goActive), so
 * it is not left watching for the viewer poll's five minutes. Another browser
 * that took over keeps it, and the viewer poll carries on as before.
 */
export function standDown(agent) {
  if (agent._retaking || agent._ensuring) return;
  if (!agent.viewer) agent.demote();
  agent._retaking = (async () => {
    try {
      // What was queued before the other agent acted is older than what it wrote.
      await agent.store.discardPending();
      for (const wait of [3000, 20_000]) {
        await new Promise((r) => setTimeout(r, wait));
        if (!agent.viewer) return;
        const cur = await agent.lease.readFresh().catch(() => null);
        // Held by anyone but the gateway is another browser's.
        if (cur && typeof cur === 'object' && !byGateway(cur.holder) && Date.now() < cur.expiresAt) return;
        if (await agent.lease.acquire()) {
          clearTimeout(agent._viewerTimer); agent._viewerTimer = null;
          // Read what the app wrote, then carry on as a restart moments later
          // would: no republishing, one drain, the inbox watched again.
          await agent.store.load({ force: true });
          const now = Date.now();
          await agent.goActive({ warm: { hereAt: now, drainedAt: 0, wakeAt: now, resubscribe: true } });
          agent.log('took the account back from the gateway');
          return;
        }
      }
    } finally { agent._retaking = null; }
  })();
}

/**
 * Move a running agent from its pod onto the copy: everything written, the
 * pod's lease let go, the copy made from the pod, and the agent carried over
 * holding the copy's lease. Returns whether it moved; when it could not, the
 * agent takes the pod's lease back and goes on as it was.
 */
export async function moveIntoCopy(agent, frontOrigin) {
  if (agent.copy) return true;
  await agent.store.commit();
  await agent.lease.release();
  const copy = await openCopy(agent, frontOrigin, { handle: agent.doorKey, letGo: true });
  if (!copy) {
    if (await agent.lease.acquire()) agent.lease.startRenewal();
    return false;
  }
  agent.copy = copy;
  const lease = copyLeaseOf(agent);
  if (!await lease.acquire()) { agent.log('the account\'s copy is held by another agent; reading only'); }
  agent.store.attach(copyStorage(agent, new HttpStorage(agent.urls.state, (u, i) => agent.remote.fetch(u, i))));
  await agent.store.load({ force: true });
  useLease(agent, lease);
  if (lease.heldUntil) lease.startRenewal(); else agent.demote();
  agent.log('working from the account\'s copy at the gateway');
  return true;
}

/**
 * Back to the pod: everything written, the copy's lease let go, the gateway
 * asked to write the copy to the pod and give it up, and the agent carried
 * back onto the pod. Returns { ok } or { ok: false, why }.
 */
export async function leaveCopy(agent) {
  if (!agent.copy) return { ok: true };
  await agent.store.commit();
  await agent.lease.release();
  const res = await tokenFetch(agent)(`${agent.copy.base}leave`, { method: 'POST' }).catch((e) => ({ status: 0, e }));
  if (res.status !== 200) {
    if (await agent.lease.acquire()) agent.lease.startRenewal();
    return { ok: false, why: `the gateway could not write the copy to the pod (${res.status || res.e?.message})` };
  }
  agent.copy = null;
  const lease = new Lease({ url: `${agent.urls.state}lease.json`, fetchImpl: podFetchOf(agent), log: agent.log, id: agent.holderId });
  agent.store.attach(podStorageOf(agent));
  useLease(agent, lease);
  fencePod(agent);
  await agent.store.load({ force: true });
  if (await lease.acquire()) lease.startRenewal(); else agent.demote();
  agent.log('working from the pod again');
  return { ok: true };
}

/**
 * The gateway keeps no copy of this account any more and will make none (its
 * admin turned the hold off): back to the pod, where the gateway wrote the
 * copy. Writes not yet sent are dropped, as when another agent acts, and the
 * state is read afresh from the pod.
 */
export async function backToPod(agent) {
  if (!agent.copy || agent._backToPod) return;
  agent._backToPod = true;
  try {
    await agent.store.discardPending();
    agent.lease.stopRenewal();
    agent.copy = null;
    const lease = new Lease({ url: `${agent.urls.state}lease.json`, fetchImpl: podFetchOf(agent), log: agent.log, id: agent.holderId });
    agent.store.attach(podStorageOf(agent));
    useLease(agent, lease);
    fencePod(agent);
    await agent.store.load({ force: true });
    if (await lease.acquire()) lease.startRenewal(); else agent.demote();
    agent.log('the gateway keeps no copy of this account now: working from the pod');
  } finally { agent._backToPod = false; }
}

/**
 * The gateway has a new identity, and this account's copy was kept under the
 * old one, which the new one cannot write back for (the owner's rules name the
 * old). The owner's own browser does it: every document in the copy written to
 * the pod as the owner, the pod's lease taken, the gateway told to forget the
 * copy, and the agent carried back onto the pod. Its rules then name the new
 * identity as any first start does (setKeeper), and a new copy is made.
 * Returns { ok } or { ok: false, why }; nothing is forgotten unless everything
 * reached the pod.
 */
export async function handOverCopy(agent) {
  if (!agent.copy) return { ok: true };
  await agent.store.commit();
  const podFetch = podFetchOf(agent);
  const pod = podStorageOf(agent);
  const docs = agent.store.names().filter((n) => !podOnly(n)).map((n) => [n, agent.store.read(n, null)]).filter(([, v]) => v !== null);
  for (const [name, value] of docs) {
    const w = await pod.write(name, JSON.stringify(value, null, 2) + '\n', 'application/json');
    if (!w.ok) return { ok: false, why: `${name} could not be written to the pod (${w.why})` };
  }
  const podLease = new Lease({ url: `${agent.urls.state}lease.json`, fetchImpl: podFetch, log: agent.log, id: agent.holderId });
  if (!await podLease.takeover()) return { ok: false, why: 'the pod\'s lease could not be taken' };
  const res = await tokenFetch(agent)(`${agent.copy.base}forget`, { method: 'POST', headers: { 'x-fedipod-holder': agent.holderId } })
    .catch((e) => ({ status: 0, e }));
  if (res.status !== 200) return { ok: false, why: `the gateway would not let the copy go (${res.status || res.e?.message})` };
  agent.copy = null;
  agent.store.attach(pod);
  useLease(agent, podLease);
  fencePod(agent);
  await agent.store.load({ force: true });
  podLease.startRenewal();
  agent.log(`handed the account's copy over: ${docs.length} documents written to the pod`);
  return { ok: true };
}

/**
 * The gateway's admin turned the hold off or on since this browser last
 * heard (agent.mjs: hereAtGateway): off, the copy goes back to the pod and
 * writes there are fenced; on, the account moves onto a copy again.
 */
export async function followHold(agent, frontOrigin, hold) {
  if (!agent._keeper) return;
  const was = agent._keeper.hold;
  agent._keeper.hold = hold;
  // Asked again at every check-in until the copy has gone.
  if (!hold && agent.copy) {
    const left = await leaveCopy(agent);
    if (!left.ok) agent.log(`the gateway keeps no copies now; leaving this one: ${left.why}`);
  } else if (hold && was === false && !agent.copy && agent._keeper.kept && !agent.viewer && !agent.store.getConfig()?.keeperOff) {
    await forgetFailedOpen(agent, frontOrigin);
    await moveIntoCopy(agent, frontOrigin);
  }
  fencePod(agent);
}

/** A token near its end, renewed; the hourly check-in asks. */
export async function renewCopyToken(agent, frontOrigin) {
  if (!agent.copy || agent.copy.expiresAt - Date.now() > RENEW_BEFORE_MS) return;
  const fresh = await openCopy(agent, frontOrigin, { handle: agent.copy.handle });
  if (fresh) agent.copy = fresh;
}
