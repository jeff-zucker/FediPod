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
// One run is one account: keepOnce(). Runs happen on the fifteen-minute round
// (flush-mail.mjs) for accounts whose app is closed.

import crypto from 'node:crypto';
import grant from '../../vendor/idp-grant.cjs';
import { PodTransport } from '../pod/transport.mjs';
import { podBaseOfWebId } from '../pod/urls.mjs';
import { apUrls } from '../core/wire.mjs';
import { PodStore } from '../core/store.mjs';
import { HttpStorage } from '../core/storage.mjs';
import { Lease } from '../core/lease.mjs';
import { Deliverer } from '../core/deliver.mjs';
import { Publisher } from '../core/publisher/index.mjs';
import { Intake } from '../core/intake/index.mjs';
import { C2S } from '../client/c2s.mjs';
import { flushHeld } from './held-mail.mjs';
import { publishDue, nextDue } from '../core/scheduled.mjs';

const RSA_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// One pod session per running copy: the keeper's grant, shared by every
// account it works for, so a round is one token, not one per account.
let shared = null;
export function keeperSession(cred) {
  if (!shared || shared.cred !== cred) shared = { cred, session: grant.createGrantSession(cred) };
  return shared.session;
}

// The account's signing key, as its owner's pod holds it. A key the pod does
// not hold in the open (a sealed one from before 1.28.0) is not something the
// keeper can use, and it says so rather than making one.
async function podKeys(store) {
  const rec = store.read('keys.json', null);
  if (!rec?.rsa?.privatePem || !rec.rsa.publicPem) return null;
  const der = crypto.createPrivateKey(rec.rsa.privatePem).export({ type: 'pkcs8', format: 'der' });
  return {
    rsaPrivate: await crypto.subtle.importKey('pkcs8', der, RSA_ALG, true, ['sign']),
    rsaPublicPem: rec.rsa.publicPem,
  };
}

/**
 * One account's pending work, done once. `ctx` is the gateway's: keeperWebId,
 * keeperCredential and the held-mail stores. `session` may be handed in (a
 * test does); otherwise the keeper's grant is used. Returns what happened.
 */
export async function keepOnce(ctx, handle, rec, { log = console.log, session = null } = {}) {
  const say = (m) => log(`keeper @${handle}: ${m}`);
  if (!rec?.keeper || !ctx.keeperWebId || !(session || ctx.keeperCredential)) return { skipped: 'not kept' };
  if (!rec.webId || !rec.podHome) return { skipped: 'the row names no owner or pod' };

  const remote = new PodTransport(session || keeperSession(ctx.keeperCredential), {
    webId: ctx.keeperWebId, log, role: 'keeper', runtime: 'node', cooldownMode: 'refuse',
  });
  remote.aclOwner = rec.webId;
  remote.keepers = [ctx.keeperWebId];
  remote.aclIfChanged = true;
  const podFetch = (u, i) => remote.fetch(u, i);

  // Where the account lives: its row names the folder, the WebID names the pod.
  const pod = podBaseOfWebId(rec.webId);
  const root = rec.podHome.startsWith(pod) ? rec.podHome.slice(pod.length) : null;
  if (root === null) return { skipped: 'the row\'s folder is not on the owner\'s pod' };
  let urls = apUrls(pod, root);

  // Held mail goes in first, so this drain reads it.
  const flushed = ctx.listHeld ? await flushHeld(ctx, handle, rec).catch((e) => { say(`held mail not delivered: ${e.message}`); return 0; }) : 0;

  const lease = new Lease({ url: urls.state + 'lease.json', fetchImpl: podFetch, log, id: `keeper:${ctx.keeperWebId}` });
  if (!await lease.acquire()) return { skipped: 'another device is acting on this account', flushed };
  try {
    const store = new PodStore({ storage: new HttpStorage(urls.state, podFetch), log });
    await store.load();
    const config = store.getConfig();
    if (!config) return { skipped: 'no account on the pod', flushed };
    // The same ids the owner's app uses: a fronted account advertises the
    // gateway's, and every request is mapped back onto the pod.
    const publicBase = config.gateway?.frontActor ? config.gateway.frontActor.replace(/ap\/actor\/?$/u, '') : null;
    urls = apUrls(pod, config.root || root, { publicBase });
    if (urls.toPod) remote.setUrlMap(urls.toPod);
    const keys = await podKeys(store);
    if (!keys) return { skipped: 'the signing key is not readable on the pod', flushed };

    const deliverer = new Deliverer({
      store, rsaPrivate: keys.rsaPrivate, keyId: urls.actor + '#main-key', actorId: urls.actor,
      log, passive: true,
    });
    const publisher = new Publisher({ config, remote, store, deliverer, publicKeyPem: keys.rsaPublicPem, log });
    deliverer.onGone = () => publisher.publishCollections({ followers: true });
    // What the owner's own posts, taken at the outbox door, need of an agent.
    const agent = { store, publisher, intake: null, viewer: false, configured: () => true, requestTakeover: async () => true };
    const c2s = new C2S({ agent, log });
    const intake = new Intake({
      config, urls, remote, store, deliverer, publisher, log, lease, push: false,
      ownerPost: (a, o) => c2s.dispatch(a, o),
    });
    agent.intake = intake;
    publisher.resolveActor = (u) => intake.fetchAP(u);

    await intake.drain();
    const published = await publishDue(store, publisher, say);
    await deliverer.drainQueue();
    await store.flush?.();
    publisher.stopPolls?.();
    const waiting = (store.getQueue?.() || []).length;
    const nextAt = nextDue(store);
    say(`done: ${flushed} held delivered, inbox drained, ${published} scheduled post(s) published, ${waiting} delivery(ies) waiting`);
    return { flushed, drained: true, published, waiting, nextAt };
  } finally {
    await lease.release().catch(() => {});
  }
}
