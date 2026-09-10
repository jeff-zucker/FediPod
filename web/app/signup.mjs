// signup.mjs — the setup flow of `fedipod setup`, run in the browser. It does
// what lib/setup.mjs's runSetup does up to the publish step: create the account
// and pod (or accept one you bring), mint a credential, make the signing keys
// and lock them on the pod under the password. Publishing the actor is the
// agent's first-run job, exactly as `connect()` publishes after `setup` mints —
// so this module needs nothing from lib.
//
// It returns the two things a browser must keep for itself: the credential and
// the config. Neither is secret to the pod owner, but the credential is a pod
// write key, so the caller stores it in this browser only, never on the pod.
// The only thing this writes to the pod is the password-wrapped signing key.

import { createAccountWithPod, mintCredential, makeDpopSession, revokeCredential } from './pod-auth.mjs';
import { generateKeys, wrapKeys } from './keystore.mjs';
import { BrowserRemotePod } from './pod-remote.mjs';
import { kvPut } from './idb-kv.mjs';
import { keyCacheKey } from './keys-browser.mjs';

// The container everything the agent publishes hangs under. New pods made here
// use `fedipod/`; the agent's own default stays `activitypods-js/` for installs
// that predate this, so those pods are untouched. The name is stored on the
// credential and the config, so the agent reads it rather than guessing.
const AP_ROOT = 'fedipod/';
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
// already achieved in this page session — the pod it made, the credential it
// minted, the key it wrote — so a second attempt (the failure screen's Try
// again) continues from the first unfinished step instead of restarting. The
// record lives only in memory here: no secret is written to disk, and it is
// dropped the moment the run completes. Keyed by the identity being built, so
// changing the handle or pod on the form starts a clean attempt.
const PROGRESS = new Map();
const progressKey = (a) => [a.issuer, a.mode, a.handle, a.mode === 'new' ? (a.podName || a.handle) : a.pod].join('|');

/**
 * Run sign-up. Steps are reported through onStep(key, state, note) so a page can
 * draw the same tick list the CLI setup shows. Resumable: see PROGRESS above.
 *
 * answers: { mode:'new'|'existing', issuer, email, password, handle,
 *            podName?, pod?, gateway? }
 * returns: { credential, config, actorUrl, address, keysPublic }
 */
export async function signUp(answers, { onStep = () => {}, frontOrigin = null } = {}) {
  const { mode, issuer, email, password, handle } = answers;
  const bad = handleProblem(handle);
  if (bad) throw new Error(bad);
  if (!email) throw new Error('an email is required');           // recovery + account login
  if (!password) throw new Error('a password is required');
  if (mode === 'existing' && !answers.pod) throw new Error('a pod address is required');

  const key = progressKey(answers);
  const prog = PROGRESS.get(key) || {};
  PROGRESS.set(key, prog);                                       // resume record for this identity

  const step = (key) => ({
    running: (note) => onStep(key, 'running', note),
    ok: (note) => onStep(key, 'ok', note),
    skip: (note) => onStep(key, 'skipped', note),
  });

  // --- account + pod --- (skipped outright once a prior attempt has made it)
  let accountToken = null;                                       // valid only within this call
  const acct = step('account');
  if (!prog.pod) {
    if (mode === 'new') {
      acct.running('creating the account and pod');
      const made = await createAccountWithPod({ issuer, email, password, podName: answers.podName || handle });
      prog.pod = made.pod; prog.webId = made.webId; accountToken = made.accountToken;
      acct.ok(made.pod);
    } else {
      const brought = answers.pod.endsWith('/') ? answers.pod : answers.pod + '/';
      acct.running('checking your pod');
      const head = await fetch(brought, { method: 'HEAD' }).catch(() => null);
      if (!head || head.status >= 400) throw new Error(`the pod at ${brought} did not answer (HTTP ${head?.status || 'no response'})`);
      prog.pod = brought;
      acct.skip('using the pod you brought');
    }
  } else {
    acct.ok(prog.pod);                                          // resumed: the pod is already there
  }
  const pod = prog.pod; const webId = prog.webId || null;

  // WebFinger is answered at a host root, so the address only works if the pod
  // is the root of its own host. Refuse a path pod rather than making an
  // account nobody can find.
  const podUrl = new URL(pod);
  if (podUrl.pathname !== '/') {
    throw new Error(`${pod} is a path on ${podUrl.host}, not its own host. `
      + 'A Fediverse address lives at a host root, so this pod cannot carry one. '
      + 'Use a pod that is the root of its own subdomain.');
  }

  const actorUrl = actorUrlFor(pod);

  // --- credential --- (a fresh attempt re-mints; a resumed one reuses it)
  const cred = step('credential');
  let credential;
  if (!prog.credential) {
    cred.running('minting a credential for this browser');
    // accountToken is null when the account step was skipped (a resume), so
    // mintCredential logs in fresh with email+password rather than reusing a
    // token that a prior attempt may have let go stale.
    credential = await mintCredential({ issuer, email, password, webId, podUrl: pod, accountToken });
    credential.remotePod = pod;
    credential.root = AP_ROOT;                                   // the agent reads the container name from here
    prog.credential = credential;
    cred.ok();
  } else {
    credential = prog.credential;
    cred.ok();
  }

  // A pod-writing session for the remaining pod writes and the gateway proof.
  const session = await makeDpopSession(credential);

  // --- keys, encrypted, in an owner-only container on the pod ---
  //
  // The durable copy is on the pod, because a browser has no disk you can carry
  // to the next machine. That copy used to be the bare record, on the argument
  // that the pod's owner-only ACL is protection enough and the pod host already
  // holds your data. It is not the same thing: your data is your data, and the
  // signing key IS you — whoever holds it is you to every server in the
  // fediverse, for as long as the key lives, and no ACL reaches the host itself.
  // So it is wrapped under the account password first, and the host stores
  // ciphertext. (Three documents already said this was happening. Now it is.)
  //
  // Two things in that order, deliberately: the ACL BEFORE the key. Writing the
  // key first leaves a window where a pod whose root is world-readable serves it
  // to anyone who asks, and a brought pod is exactly the case where that root
  // may be public.
  //
  // The opened copy is kept in this browser (IndexedDB) so the worker can boot
  // itself after an idle kill with nobody there to type a password. A browser
  // that has no copy asks for the password once — see boot.mjs.
  const keysStep = step('keys');
  let keys;
  if (!prog.keysStored) {
    keysStep.running('making your signing key and locking it under your password');
    keys = await generateKeys();
    keys.mintedFor = actorUrl;                                   // one key, one actor (lib/keys.mjs)
    const remote = new BrowserRemotePod(session, { webId: credential.webId, log: () => {} });
    // Owner-only: no public modes at all. A pod that refuses the ACL write is
    // not a pod this key may sit on, wrapped or not.
    await remote.setAcl(`${pod}${AP_ROOT}ap-state/`, []);
    const put = await session.fetch(keysDocFor(pod), {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await wrapKeys(keys, password)),
    });
    if (put.status >= 400) throw new Error(`could not store the signing key on the pod (HTTP ${put.status}). `
      + `The credential is for ${credential.webId} — that WebID must own ${pod} and its ${AP_ROOT} must be writable by it.`);
    // This browser's own opened copy, so the boot after the login redirect
    // needs no password. Best effort: a browser that refuses IndexedDB (private
    // mode) simply asks for the password on the way back in.
    await kvPut(keyCacheKey(actorUrl), keys).catch(() => {});
    prog.keys = keys; prog.keysStored = true;
    keysStep.ok();
  } else {
    keys = prog.keys;
    keysStep.ok();
  }

  // Connect the mail door: attach to the gateway (fedipod.net), inbox-only, so
  // the actor advertises the door as its inbox. The door verifies each delivery
  // and forwards the clean mail to the pod; the agent trusts the door's receipt.
  // The same DPoP session proves the pod to the gateway — no password reaches it.
  let gateway = answers.gateway || prog.gateway || null;
  if (frontOrigin && !gateway) {
    const gw = step('gateway');
    gw.running(`connecting your mail door on ${new URL(frontOrigin).host}`);
    const res = await session.fetch(`${frontOrigin.replace(/\/$/, '')}/api/attach`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // podHome is the AP CONTAINER, not the pod root: the front builds the
      // delivery target as `podHome + 'ap/inbox/'` (lib/front-core.mjs), so a
      // bare pod root sends this identity's mail to <pod>/ap/inbox/ — outside
      // the container the agent drains, where nothing would ever read it. The
      // manage surface has always sent `urls.home`; this is the same value.
      body: JSON.stringify({ handle, podHome: `${pod}${AP_ROOT}`, actorUrl, kind: 'person' }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status !== 201 || !d.hmacSecret) {
      throw new Error(`could not connect the mail door (HTTP ${res.status}): ${d.error || ''}`);
    }
    gateway = { url: d.doorInbox, hmacSecret: d.hmacSecret, mode: 'trust' };
    prog.gateway = gateway;
    gw.ok();
  } else if (frontOrigin && gateway) {
    step('gateway').ok();                                        // resumed
  }

  const config = {
    remotePod: pod, root: AP_ROOT, handle, name: handle, issuer: credential.issuerOrigin,
    ...(gateway ? { gateway } : {}),
  };
  // Write the config to the pod (owner-only, beside the key) so a returning
  // sign-in — which arrives with only an OIDC session — can read the account's
  // config and key from the pod and boot with no password.
  const cfgPut = await session.fetch(`${pod}${AP_ROOT}ap-state/config.json`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config),
  });
  if (cfgPut.status >= 400) throw new Error(`could not store the config on the pod (HTTP ${cfgPut.status})`);

  // The credential was for sign-up, and sign-up is over. The agent runs on the
  // Solid-OIDC session from here on and never needs it again, so leaving it
  // alive would leave permanent full access to the pod in a key nothing holds.
  // Best effort: a server that will not delete it is a credential the owner can
  // still revoke from their pod's account page, and not a reason to fail a
  // sign-up that otherwise worked.
  const revoked = await revokeCredential({
    resource: credential.resource, accountToken: credential.accountToken,
  });
  delete credential.accountToken;              // never leaves this function
  if (!revoked && credential.resource) {
    onStep('credential', 'ok', 'this browser is ready (the setup credential could not be '
      + 'revoked automatically — you can remove it from your pod\'s account page)');
  }

  PROGRESS.delete(key);                                          // finished — nothing left to resume

  const host = new URL(pod).host;
  return {
    credential, config, actorUrl,
    address: `@${handle}@${host}`,
    // The opened keys, for booting the agent in THIS browser session right away.
    // The durable copy on the pod is wrapped under the account password; this
    // browser also holds an opened one in IndexedDB (above), which is what the
    // worker reads. A fresh browser asks for the password once and makes its own.
    keys,
    keysPublic: { rsa: keys.rsa.publicPem, ed25519: keys.ed25519?.publicPem || null },
  };
}
