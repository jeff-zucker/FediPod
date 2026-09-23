// signup.mjs — the setup flow of `fedipod setup`, run in the browser, on the
// pod session the person already holds. The pod exists before this runs: a
// new one is made on the provider's own sign-up page, an existing one is
// signed in to as it is. So there is no account API here, no credential and
// no password — the session that signed in at the pod is the session that
// writes to it. Publishing the actor is the agent's first-run job, exactly as
// `connect()` publishes after `setup` mints — so this module needs nothing
// from lib beyond the pod helpers.
//
// What it writes to the pod: an owner-only state container holding the
// signing key and the account config; and, with a gateway, the attach.

import { generateKeys, isKeyEnvelope } from './keystore.mjs';
import { BrowserRemotePod } from './pod-remote.mjs';
import * as podState from '../../lib/pod/state.mjs';
import { resourceExists } from '../../lib/pod/root.mjs';
import { podBaseOfWebId } from '../../lib/pod/urls.mjs';
import { cacheOpenedKeys } from './keys-browser.mjs';

// The container everything the agent publishes hangs under. New pods made here
// use `fedipod/`; new installs default to `fedipod/` too, and older ones keep
// that predate this, so those pods are untouched. The name is stored on the
// config, so the agent reads it rather than guessing.
export const AP_ROOT = 'fedipod/';
const actorUrlFor = (pod) => `${pod}${AP_ROOT}ap/actor`;
const keysDocFor = (pod) => `${pod}${AP_ROOT}ap-state/keys.json`;

const HANDLE_RE = /^[a-z0-9-]{2,30}$/;

export function handleProblem(handle) {
  if (!handle) return 'a handle is required';
  if (!HANDLE_RE.test(handle)) return 'letters, digits and hyphens only, 2–30 characters';
  if (handle.startsWith('-') || handle.endsWith('-')) return 'cannot start or end with a hyphen';
  return null;
}

// Resume across a failed attempt. A run that throws part-way keeps what it
// already achieved in this page session — the gateway it attached, the key it
// wrote — so a second attempt (the failure screen's Try again) continues from
// the first unfinished step instead of restarting. The record lives only in
// memory here and is dropped the moment the run completes. Keyed by the
// identity being built, so changing the handle on the form starts a clean
// attempt.
const PROGRESS = new Map();
const progressKey = (webId, a) => [webId, a.handle, a.shape || 'pod'].join('|');

/** A fronted name is one per gateway; a taken one is refused before anything is made. */
async function assertFrontNameFree(frontOrigin, handle) {
  const res = await fetch(`${frontOrigin.replace(/\/$/, '')}/api/handle?handle=${encodeURIComponent(handle)}`,
    { headers: { accept: 'application/json' } }).catch(() => null);
  const d = res ? await res.json().catch(() => ({})) : null;
  if (!d) throw new Error(`${new URL(frontOrigin).host} did not answer whether @${handle} is free`);
  if (!d.available) throw new Error(d.reason || `the name @${handle}@${new URL(frontOrigin).host} is taken — choose another handle`);
}

/**
 * Run sign-up on a pod session. Steps are reported through onStep(key, state,
 * note) so a page can draw the same tick list the CLI setup shows. Resumable:
 * see PROGRESS above.
 *
 * answers: { handle, shape?: 'pod'|'front', gateway? }
 * session: { webId, issuer, fetch } — the Solid-OIDC session from the pod's
 *          own login (oidc-session.mjs). The pod is where the WebID lives.
 *
 * `shape` is where the address lives. On the pod, `@handle@yourpod`, with the
 * gateway as a mail door only — the default. At the gateway, `@handle@front`,
 * a fronted identity whose documents still live on the pod. A pod on a path of
 * a suffix-based host cannot answer WebFinger, so it is fronted whatever was asked.
 *
 * returns: { config, actorUrl, address, pod, keys, keysPublic }
 */
export async function signUp(answers, { session, onStep = () => {}, frontOrigin = null } = {}) {
  const { handle } = answers;
  const bad = handleProblem(handle);
  if (bad) throw new Error(bad);
  if (!session?.webId || typeof session.fetch !== 'function') throw new Error('sign in at your pod first');
  const wantsFront = answers.shape === 'front';
  if (wantsFront && !frontOrigin) throw new Error('an address at the gateway needs a gateway, and this page has none');
  // A name at the gateway is one per gateway: settle it before making anything.
  if (wantsFront) await assertFrontNameFree(frontOrigin, handle);

  const webId = session.webId;
  const pod = podBaseOfWebId(webId);                 // its own host, or a path on a suffix-based one
  const key = progressKey(webId, answers);
  const prog = PROGRESS.get(key) || {};
  PROGRESS.set(key, prog);                                       // resume record for this identity

  const step = (key) => ({
    running: (note) => onStep(key, 'running', note),
    ok: (note) => onStep(key, 'ok', note),
    skip: (note) => onStep(key, 'skipped', note),
  });

  // --- the pod --- (the session came from it; what is checked is that it has no account yet)
  const podStep = step('pod');
  if (!prog.pod) {
    podStep.running('checking your pod');
    if (await resourceExists(session.fetch, actorUrlFor(pod))) throw new Error('The pod already hosts a FediPod account. If you want a second account, put it on a different pod.');
    prog.pod = pod;
    podStep.ok(pod);
  } else {
    podStep.ok(prog.pod);                                        // resumed
  }

  // WebFinger is answered only at a host root. A pod on a path of a shared
  // host therefore takes its address at the gateway, whatever was asked; a
  // pod at its own root keeps the choice made on the form.
  const pathPod = new URL(pod).pathname !== '/';
  const fronted = pathPod || wantsFront;
  if (fronted && !frontOrigin) {
    throw new Error(`${pod} is a suffix-based host, so its address must live at a gateway, and this page has none.`);
  }
  if (pathPod && !wantsFront) await assertFrontNameFree(frontOrigin, handle);

  const actorUrl = actorUrlFor(pod);                              // where the documents live, always
  const frontActor = fronted ? `${frontOrigin.replace(/\/$/, '')}/u/${handle}/ap/actor` : null;

  // Connect the gateway (fedipod.net) before the key is made, because a
  // fronted identity's key is stamped with the gateway actor. Inbox-only: the
  // actor advertises the door as its inbox and keeps its own ids. Fronted: the
  // gateway answers WebFinger for @handle@front and serves the actor at its own
  // address, rewriting reads onto the pod. Either way the door verifies each
  // delivery and forwards the clean mail to the pod; the agent trusts the
  // door's receipt. The pod session itself proves the pod to the gateway.
  let gateway = answers.gateway || prog.gateway || null;
  if (frontOrigin && !gateway) {
    const gw = step('gateway');
    gw.running(fronted ? `taking your address at ${new URL(frontOrigin).host}` : `connecting your mail door on ${new URL(frontOrigin).host}`);
    const res = await session.fetch(`${frontOrigin.replace(/\/$/, '')}/api/attach`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // podHome is the AP CONTAINER, not the pod root: the front builds the
      // delivery target as `podHome + 'ap/inbox/'` (lib/front-core.mjs), so a
      // bare pod root sends this identity's mail to <pod>/ap/inbox/ — outside
      // the container the agent drains, where nothing would ever read it. The
      // manage surface has always sent `urls.home`; this is the same value.
      body: JSON.stringify({ handle, podHome: `${pod}${AP_ROOT}`, actorUrl, kind: 'person', fronted }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status !== 201 || !d.hmacSecret) {
      throw new Error(`could not connect the gateway (HTTP ${res.status}): ${d.error || ''}`);
    }
    gateway = fronted
      ? { url: `${frontOrigin.replace(/\/$/, '')}/u/${handle}/ap/inbox/`, frontActor: String(d.frontActor || frontActor), hmacSecret: d.hmacSecret, mode: 'trust' }
      : { url: d.doorInbox, hmacSecret: d.hmacSecret, mode: 'trust' };
    prog.gateway = gateway;
    gw.ok();
  } else if (frontOrigin && gateway) {
    step('gateway').ok();                                        // resumed
  }

  // --- keys, in an owner-only container on the pod ---
  //
  // The durable copy is on the pod, because a browser has no disk you can carry
  // to the next machine. It is stored as it is, behind the container's access
  // rule: the same rule every private document on the pod lives under, so it
  // is reachable through the pod's own login and by nobody else.
  //
  // Two things in that order, deliberately: the ACL BEFORE the key. Writing the
  // key first leaves a window where a pod whose root is world-readable serves it
  // to anyone who asks, and a brought pod is exactly the case where that root
  // may be public.
  //
  // The opened copy is kept in this browser (IndexedDB) so the worker can boot
  // itself after an idle kill with no read. A browser that has no copy reads
  // the pod's with its session — see keys-browser.mjs.
  const remote = new BrowserRemotePod(session, { webId, role: 'signup', log: () => {} });
  const keysStep = step('keys');
  let keys;
  if (!prog.keysStored) {
    keysStep.running('making your signing key and storing it on your pod');
    keys = await generateKeys();
    // One key, one actor (lib/keys.mjs): the actor the world knows, which for
    // a fronted identity is the gateway's address for it.
    keys.mintedFor = gateway?.frontActor || actorUrl;
    // Owner-only, and THEN the key — one operation, so the order cannot be got
    // wrong here or anywhere else. A pod that refuses the ACL write is not a
    // pod this key may sit on.
    try {
      await podState.provisionKey(remote, {
        stateUrl: `${pod}${AP_ROOT}ap-state/`,
        keysUrl: keysDocFor(pod),
        keys,
      });
    } catch (e) {
      throw new Error(`could not store the signing key on the pod (${e.message}). `
        + `You are signed in as ${webId} — that WebID must own ${pod} and its ${AP_ROOT} must be writable by it.`);
    }
    // This browser's own opened copy, so the boot that follows needs no read.
    // Best effort: a browser that refuses IndexedDB (private mode) reads the
    // pod's copy on the way back in.
    await cacheOpenedKeys(actorUrl, keys);
    prog.keys = keys; prog.keysStored = true;
    keysStep.ok();
  } else {
    keys = prog.keys;
    keysStep.ok();
  }

  const config = {
    remotePod: pod, root: AP_ROOT, handle, name: handle, issuer: String(session.issuer || '').replace(/\/+$/, ''),
    createdAt: new Date().toISOString(),
    ...(gateway ? { gateway } : {}),
  };
  // Write the config to the pod (owner-only, beside the key) so a returning
  // sign-in — which arrives with only an OIDC session — can read the account's
  // config and key from the pod and boot.
  try {
    await podState.writeConfig(remote, { state: `${pod}${AP_ROOT}ap-state/` }, config);
  } catch (e) {
    throw new Error(`could not store the config on the pod (${e.message})`);
  }

  PROGRESS.delete(key);                                          // finished — nothing left to resume

  const host = gateway?.frontActor ? new URL(gateway.frontActor).host : new URL(pod).host;
  return {
    config, actorUrl, pod,
    address: `@${handle}@${host}`,
    // The opened keys, for booting the agent in THIS browser session right away.
    keys,
    keysPublic: { rsa: keys.rsa.publicPem, ed25519: keys.ed25519?.publicPem || null },
  };
}

// ---- an account already on the pod ----

/**
 * What the pod already holds: null when there is no FediPod account on it,
 * else its config, the pod, and where its address lives — `frontHost` is
 * the gateway's host for an address at a gateway, null for one on the pod.
 */
export async function readAccount(session) {
  const pod = podBaseOfWebId(session.webId);
  const remote = new BrowserRemotePod(session, { webId: session.webId, role: 'signup', log: () => {} });
  const config = await podState.readConfig(remote, { state: `${pod}${AP_ROOT}ap-state/` }).catch(() => null);
  if (!config) return null;
  const frontActor = config.gateway?.frontActor || null;
  let frontHost = null;
  try { frontHost = frontActor ? new URL(frontActor).host : null; } catch { frontHost = null; }
  let podHost = '';
  try { podHost = new URL(config.remotePod || pod).host; } catch { podHost = ''; }
  return { pod, config, frontActor, frontHost, address: `@${config.handle}@${frontHost || podHost}` };
}

/**
 * Move an account whose address lives at another gateway to this one. The
 * pod, its posts, its followers and its key all stay where they are; what
 * changes is the gateway that answers for it. This half does the pod's
 * part: attach here, rewrite the config to name this gateway, restamp the
 * key. The agent's first boot from that config publishes under the new
 * ids, and then tells the old gateway and the followers (gateway-move.mjs).
 *
 * answers: { handle }  — the name here; the old one is the default.
 * returns: { config, address, movedFrom }
 */
export async function moveIn(answers, { session, onStep = () => {}, frontOrigin = null } = {}) {
  const { handle } = answers;
  const bad = handleProblem(handle);
  if (bad) throw new Error(bad);
  if (!session?.webId || typeof session.fetch !== 'function') throw new Error('sign in at your pod first');
  if (!frontOrigin) throw new Error('a move needs a gateway to move to, and this page has none');
  const origin = frontOrigin.replace(/\/$/, '');
  const step = (key) => ({ running: (note) => onStep(key, 'running', note), ok: (note) => onStep(key, 'ok', note) });

  // --- the pod: the account that is there, and its key ---
  const podStep = step('pod');
  podStep.running('reading your account on your pod');
  const here = await readAccount(session);
  if (!here?.frontActor) throw new Error('this pod holds no account at another gateway to move here');
  if (here.frontHost === new URL(origin).host) throw new Error('this account already lives at this gateway');
  const { pod, config: old } = here;
  const remote = new BrowserRemotePod(session, { webId: session.webId, role: 'signup', log: () => {} });
  const urls = { state: `${pod}${AP_ROOT}ap-state/` };
  const keys = await podState.readKeys(remote, urls);
  if (!keys?.rsa) throw new Error('could not read this account\'s signing key on the pod');
  if (isKeyEnvelope(keys)) throw new Error(`this account's key is still under a password from an earlier version — sign in once at ${here.frontHost} first, then come back`);
  podStep.ok(here.address);

  // --- this gateway: the name, then the attach, fronted ---
  const gw = step('gateway');
  gw.running(`taking your address at ${new URL(origin).host}`);
  await assertFrontNameFree(origin, handle);
  const res = await session.fetch(`${origin}/api/attach`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, podHome: `${pod}${AP_ROOT}`, actorUrl: actorUrlFor(pod), kind: old.kind || 'person', fronted: true }),
  });
  const d = await res.json().catch(() => ({}));
  if (res.status !== 201 || !d.hmacSecret) throw new Error(`could not attach to this gateway (HTTP ${res.status}): ${d.error || ''}`);
  const gateway = {
    url: `${origin}/u/${handle}/ap/inbox/`, frontActor: String(d.frontActor || `${origin}/u/${handle}/ap/actor`),
    hmacSecret: d.hmacSecret, mode: 'trust',
  };
  gw.ok();

  // --- the pod again: the config names this gateway, the key is restamped ---
  //
  // The old actor becomes an alias, which is what a server checks on the new
  // actor before it honours a Move. `movedFrom` is the pending half: the
  // agent completes it after its first boot under the new ids.
  const keysStep = step('keys');
  keysStep.running('moving your key and account record to the new address');
  const aliases = [...new Set([...(old.aliases || []), here.frontActor])];
  const config = {
    ...old, handle, gateway, aliases,
    movedFrom: { actor: here.frontActor, gateway: new URL(here.frontActor).origin, handle: old.handle, at: new Date().toISOString() },
  };
  keys.mintedFor = gateway.frontActor;                          // one key, one actor (lib/keys.mjs)
  try {
    await podState.writeKeys(remote, urls, keys);
    await podState.writeConfig(remote, urls, config);
  } catch (e) {
    throw new Error(`could not update your account on the pod (${e.message})`);
  }
  await cacheOpenedKeys(actorUrlFor(pod), keys);
  keysStep.ok();

  return { config, address: `@${handle}@${new URL(origin).host}`, movedFrom: config.movedFrom };
}
