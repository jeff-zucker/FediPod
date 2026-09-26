// copy-mode.mjs — the browser agent working from its account's copy at the
// gateway (lib/gateway/copy.mjs, lib/gateway/state-api.mjs), for an account the
// gateway keeps running.
//
// The state documents are read and written at the gateway instead of on the
// pod, and the lease that says which agent acts is the copy's. What stays on
// the pod (the key, connected-account passwords) is still read there. The
// gateway writes the copy to the pod every fifteen minutes.
import { HttpStorage, StateApiStorage } from '../../lib/core/storage.mjs';
import { Lease } from '../../lib/core/lease.mjs';

// A token this much short of its end is renewed before it is used again.
const RENEW_BEFORE_MS = 2 * 3600_000;

/**
 * Ask the gateway for this account's copy, making it if there is none yet.
 * `handle` names the account when the agent knows it. Returns the copy
 * ({ handle, base, token, expiresAt }) or null, in which case the account
 * works from its pod.
 */
export async function openCopy(agent, frontOrigin, { handle = null, kept = null } = {}) {
  if (kept && kept.expiresAt - Date.now() > RENEW_BEFORE_MS) return kept;
  if (!agent.sessionFetch || !frontOrigin) return null;
  let res;
  try {
    res = await agent.sessionFetch(`${frontOrigin.replace(/\/$/u, '')}/api/state/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(handle ? { handle } : {}),
    });
  } catch (e) { agent.log(`the account's copy: ${e.message}`); return null; }
  if (res.status !== 200) {
    // 404, 409 and 501 are answers (no copy for this account here); anything
    // else is worth saying.
    if (![404, 409, 501].includes(res.status)) agent.log(`the account's copy: the gateway answered ${res.status}`);
    return null;
  }
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
    onRefused: () => { if (!agent.viewer) agent.demote(); },
  });
  Object.defineProperty(s, 'token', { get: () => agent.copy.token, set() {} });
  return s;
}

export function copyLeaseOf(agent) {
  return new Lease({ url: `${agent.copy.base}lease.json`, fetchImpl: tokenFetch(agent), log: agent.log, id: agent.holderId });
}

// Swap the lease the agent and its drain go by.
function useLease(agent, lease) {
  agent.lease.stopRenewal();
  agent.lease = lease;
  if (agent.intake) agent.intake.lease = lease;
  lease.onLost = () => agent.demote();
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
  const copy = await openCopy(agent, frontOrigin, { handle: agent.doorKey });
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
  const podFetch = (u, i) => agent.remote.fetch(u, i);
  const lease = new Lease({ url: `${agent.urls.state}lease.json`, fetchImpl: podFetch, log: agent.log, id: agent.holderId });
  agent.store.attach(new HttpStorage(agent.urls.state, podFetch));
  await agent.store.load({ force: true });
  useLease(agent, lease);
  if (await lease.acquire()) lease.startRenewal(); else agent.demote();
  agent.log('working from the pod again');
  return { ok: true };
}

/** A token near its end, renewed; the hourly check-in asks. */
export async function renewCopyToken(agent, frontOrigin) {
  if (!agent.copy || agent.copy.expiresAt - Date.now() > RENEW_BEFORE_MS) return;
  const fresh = await openCopy(agent, frontOrigin, { handle: agent.copy.handle });
  if (fresh) agent.copy = fresh;
}
