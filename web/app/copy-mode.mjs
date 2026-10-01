// copy-mode.mjs — the browser agent working from its account's copy at the
// gateway (lib/gateway/copy.mjs, lib/gateway/state-api.mjs), for an account the
// gateway keeps running.
//
// A person's copy (version 2) holds only what the gateway needs: the slim
// documents, and while an outside app is signed in, what apps show too. Those
// are read and written at the gateway, and every write is made on the pod as
// well; every other document lives on the pod alone. The lease that says which
// agent acts is the copy's. The gateway never writes the pod: what it changed
// reaches the pod through the inbox (lib/core/intake/gateway-writes.mjs). A
// copy from before version 2 is copied to the pod once and started again
// (upgradeCopy).
import { HttpStorage, StateApiStorage, podOnly } from '../../lib/core/storage.mjs';
import { SLIM_DOCS, PUBLIC_CONFIG, publicConfig } from '../../lib/core/pod-only.mjs';
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
    ? { handle: copy.handle, base: copy.base, token: copy.token, expiresAt: copy.expiresAt, podHome: copy.podHome || null,
      v: copy.v || 1, full: !!copy.full, filledAt: copy.filledAt || null, filledFull: copy.filledFull || null }
    : null;
}

// Every request to the copy carries its token, read at the time of asking so a
// renewed one is used at once.
const tokenFetch = (agent) => (u, i = {}) => fetch(u, {
  ...i, headers: { ...(i.headers || {}), authorization: `Bearer ${agent.copy.token}` },
});

// Which documents a person's copy holds: the slim ones, and everything apps
// show while an outside app is signed in. The settings stay on the pod; their
// public part is kept in the copy beside them.
export const copyNamesOf = (copy) => (copy?.v === 2
  ? (name) => (copy.full ? !podOnly(name) && name !== 'config.json' : SLIM_DOCS.has(name))
  : null);

/** The store's storage, and the lease, for working from the copy. */
export function copyStorage(agent, podState) {
  const v2 = agent.copy.v === 2;
  const s = new StateApiStorage(agent.copy.base, {
    fetchImpl: (u, i) => fetch(u, i), token: agent.copy.token, holder: agent.holderId, pod: podState,
    // Refused: another agent (an app at the gateway, another browser) took
    // the lease. This one stops acting at once rather than at its next renewal.
    onRefused: () => standDown(agent),
    inCopy: copyNamesOf(agent.copy), mirror: v2, publicConfig: v2 ? publicConfig : null, log: agent.log,
    // An app signed in, or the last one out: the store follows at once.
    onFull: v2 ? (full) => { if (full !== !!agent.copy?.full && !agent._reshaping) {
      agent._reshaping = refreshCopyMeta(agent).catch((e) => agent.log(`the account's copy: ${e.message}`)).finally(() => { agent._reshaping = null; });
    } } : null,
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
        // Held by anyone but the gateway (copy.mjs: GATEWAY_HOLDER) is another browser's.
        if (cur && typeof cur === 'object' && cur.holder !== 'gateway' && Date.now() < cur.expiresAt) return;
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
  const podState = new HttpStorage(agent.urls.state, (u, i) => agent.remote.fetch(u, i));
  await upgradeCopy(agent, podState);
  await fillCopy(agent, podState).catch((e) => agent.log(`filling the copy: ${e.message}`));
  const lease = copyLeaseOf(agent);
  if (!await lease.acquire()) { agent.log('the account\'s copy is held by another agent; reading only'); }
  agent.store.attach(copyStorage(agent, podState));
  if (agent.intake) agent.intake.inCopy = copyNamesOf(agent.copy);
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
  if (agent.intake) agent.intake.inCopy = null;
  const podFetch = (u, i) => agent.remote.fetch(u, i);
  const lease = new Lease({ url: `${agent.urls.state}lease.json`, fetchImpl: podFetch, log: agent.log, id: agent.holderId });
  agent.store.attach(new HttpStorage(agent.urls.state, podFetch));
  await agent.store.load({ force: true });
  useLease(agent, lease);
  if (await lease.acquire()) lease.startRenewal(); else agent.demote();
  agent.log('working from the pod again');
  return { ok: true };
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
  const podFetch = (u, i) => agent.remote.fetch(u, i);
  const pod = new HttpStorage(agent.urls.state, podFetch);
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
  if (agent.intake) agent.intake.inCopy = null;
  agent.store.attach(pod);
  await agent.store.load({ force: true });
  useLease(agent, podLease);
  podLease.startRenewal();
  agent.log(`handed the account's copy over: ${docs.length} documents written to the pod`);
  return { ok: true };
}

/**
 * A person's copy, filled from the pod where it is empty: the slim documents
 * and the settings' public part when it was just made, and what apps show
 * when an app has signed in and the sign-in page did not fill it. Only what
 * the copy lacks is taken (state-api.mjs: fill). Returns how many were put.
 */
export async function fillCopy(agent, podState) {
  const copy = agent.copy;
  if (copy?.v !== 2 || (copy.filledAt && (!copy.full || copy.filledFull))) return 0;
  const listing = await podState.list('');
  const wanted = copyNamesOf(copy);
  const docs = {};
  for (const name of listing.names || []) {
    if (name === 'config.json') {
      const r = await podState.read(name);
      if (r.ok) { try { docs[PUBLIC_CONFIG] = JSON.stringify(publicConfig(JSON.parse(r.body)), null, 2) + '\n'; } catch { /* unreadable: left out */ } }
      continue;
    }
    if (!wanted(name)) continue;
    const r = await podState.read(name);
    if (r.ok) docs[name] = r.body;
  }
  const res = await tokenFetch(agent)(`${copy.base}fill`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ docs, full: copy.full }),
  }).catch((e) => ({ status: 0, e }));
  if (res.status !== 200) { agent.log(`the account's copy was not filled (${res.status || res.e?.message})`); return 0; }
  const out = await res.json().catch(() => ({}));
  copy.filledAt = copy.filledAt || Date.now();
  if (copy.full) copy.filledFull = Date.now();
  agent.log(`the account's copy at the gateway: ${out.put || 0} document(s) filled from the pod`);
  return out.put || 0;
}

/**
 * A copy from before version 2: every document in it copied to the pod as the
 * owner, then the gateway asked to start it again as a person's copy is now.
 * The gateway does it only if nothing changed in the copy since it was read,
 * so nothing is lost; asked again when something did. Returns whether it did.
 */
export async function upgradeCopy(agent, podState) {
  const copy = agent.copy;
  if (!copy || copy.v === 2) return true;
  const old = new StateApiStorage(copy.base, { fetchImpl: (u, i) => fetch(u, i), token: copy.token, holder: agent.holderId, pod: null });
  for (let attempt = 0; attempt < 3; attempt++) {
    const listing = await old.list('');
    for (const name of listing.names.filter((n) => !podOnly(n))) {
      const r = await old.read(name);
      if (!r.ok) continue;
      const w = await podState.write(name, r.body, 'application/json');
      if (!w.ok) { agent.log(`${name} could not be copied to the pod (${w.why}); the copy stays as it is`); return false; }
    }
    const res = await tokenFetch(agent)(`${copy.base}reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ etag: listing.etag }),
    }).catch((e) => ({ status: 0, e }));
    if (res.status === 200) {
      const out = await res.json().catch(() => ({}));
      Object.assign(copy, { v: 2, full: !!out.full, filledAt: null, filledFull: null });
      agent.log('the account\'s copy at the gateway was copied to the pod and started again');
      return true;
    }
    if (res.status !== 409) { agent.log(`the account's copy was not started again (${res.status || res.e?.message})`); return false; }
  }
  return false;
}

/**
 * Where the copy stands now: an app signing in makes it full, the last one
 * signing out slim. On a change the store reads its documents from where they
 * now live. The hourly check-in asks.
 */
export async function refreshCopyMeta(agent) {
  if (agent.copy?.v !== 2) return false;
  const res = await tokenFetch(agent)(`${agent.copy.base}meta`).catch(() => null);
  if (!res || res.status !== 200) return false;
  const meta = await res.json().catch(() => null);
  if (!meta || !agent.copy || !!meta.full === !!agent.copy.full) return false;
  await agent.store.commit();
  if (!agent.copy) return false;              // let go of meanwhile
  Object.assign(agent.copy, { full: !!meta.full, filledFull: meta.filledFull || null });
  const podState = new HttpStorage(agent.urls.state, (u, i) => agent.remote.fetch(u, i));
  // Now full and not yet filled: what this agent has is the newest, so it goes in.
  if (agent.copy.full) await fillCopy(agent, podState).catch((e) => agent.log(`filling the copy: ${e.message}`));
  agent.store.attach(copyStorage(agent, podState));
  if (agent.intake) agent.intake.inCopy = copyNamesOf(agent.copy);
  await agent.store.load({ force: true });
  agent.log(agent.copy.full ? 'an outside app signed in: what apps show is kept at the gateway too'
    : 'the last outside app signed out: what apps show is on the pod only');
  return true;
}

/** A token near its end, renewed; the hourly check-in asks. */
export async function renewCopyToken(agent, frontOrigin) {
  if (!agent.copy || agent.copy.expiresAt - Date.now() > RENEW_BEFORE_MS) return;
  const fresh = await openCopy(agent, frontOrigin, { handle: agent.copy.handle });
  // The token and its end are new; where the copy stands is refreshCopyMeta's.
  if (fresh) Object.assign(agent.copy, { token: fresh.token, expiresAt: fresh.expiresAt });
}
