// account-agent.mjs — an account's agent, put together at the gateway for as
// long as one piece of work takes: a keeper run (keeper.mjs), or a request from
// a Mastodon app (masto-gateway.mjs).
//
// It works with the gateway's own pod identity and nothing else, which the
// owner's app named in the rules on the account's folder. The account's state
// is its copy at the gateway when there is one (copy.mjs), and the pod when
// there is not. The signing key is read from the pod when it is needed, never
// kept, never made.
import crypto from 'node:crypto';
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
import { keeperSession } from './keeper-session.mjs';
import { CopyStorage, copyMeta, copyLease, GATEWAY_HOLDER } from './copy.mjs';

const RSA_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// The account's signing key, as its owner's pod holds it. A key the pod does
// not hold in the open (a sealed one from before 1.28.0) cannot be used here.
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
 * Where the account is, and a transport to its pod as the gateway. Returns
 * { remote, podFetch, urls, inCopy } or { skipped } when this gateway cannot
 * act for it.
 */
export async function reachAccount(ctx, handle, rec, { log = console.log, session = null } = {}) {
  if (!rec?.keeper || !ctx.keeperWebId || !(session || ctx.keeperCredential)) return { skipped: 'not kept' };
  if (!rec.webId || !rec.podHome) return { skipped: 'the row names no owner or pod' };
  const remote = new PodTransport(session || keeperSession(ctx.keeperCredential), {
    webId: ctx.keeperWebId, log, role: 'keeper', runtime: 'node', cooldownMode: 'refuse',
  });
  // Any rule it writes names the owner, and itself beside them.
  remote.aclOwner = rec.webId;
  remote.keepers = [ctx.keeperWebId];
  remote.aclIfChanged = true;
  const pod = podBaseOfWebId(rec.webId);
  const root = rec.podHome.startsWith(pod) ? rec.podHome.slice(pod.length) : null;
  if (root === null) return { skipped: 'the row\'s folder is not on the owner\'s pod' };
  const inCopy = !!(ctx.copyKv && await copyMeta(ctx.copyKv, handle));
  return { remote, podFetch: (u, i) => remote.fetch(u, i), pod, root, urls: apUrls(pod, root), inCopy };
}

/**
 * The account's state store and lease, as `holder`: over the copy when there
 * is one, else over the pod.
 */
export function stateAndLease(ctx, handle, at, { log = console.log, holder = GATEWAY_HOLDER } = {}) {
  const podState = new HttpStorage(at.urls.state, at.podFetch);
  if (at.inCopy) {
    return {
      // Of what stays on the pod, only the key: one read per piece of work.
      store: new PodStore({ storage: new CopyStorage(ctx.copyKv, handle, { holder, pod: podState, podNames: ['keys.json'] }), log }),
      lease: copyLease(ctx.copyKv, handle, { id: holder, log }),
    };
  }
  return {
    store: new PodStore({ storage: podState, log }),
    lease: new Lease({ url: at.urls.state + 'lease.json', fetchImpl: at.podFetch, log, id: `keeper:${ctx.keeperWebId}` }),
  };
}

/**
 * The acting pieces over a loaded store: the same ids the owner's app uses
 * (a fronted account advertises the gateway's, and every request is mapped
 * back onto the pod), the key from the pod, a deliverer that sends only when
 * asked, a publisher, and the intake. Returns the agent, or { skipped }.
 */
export async function actingAgent(at, store, lease, { log = console.log, push = false } = {}) {
  const config = store.getConfig();
  if (!config) return { skipped: 'no account on the pod' };
  const publicBase = config.gateway?.frontActor ? config.gateway.frontActor.replace(/ap\/actor\/?$/u, '') : null;
  const urls = apUrls(at.pod, config.root || at.root, { publicBase });
  if (urls.toPod) at.remote.setUrlMap(urls.toPod);
  const keys = await podKeys(store);
  if (!keys) return { skipped: 'the signing key is not readable on the pod' };
  const deliverer = new Deliverer({
    store, rsaPrivate: keys.rsaPrivate, keyId: urls.actor + '#main-key', actorId: urls.actor, log, passive: true,
  });
  const publisher = new Publisher({ config, remote: at.remote, store, deliverer, publicKeyPem: keys.rsaPublicPem, log });
  deliverer.onGone = () => publisher.publishCollections({ followers: true });
  // What the owner's own posts, taken at the outbox door, need of an agent.
  const agent = {
    store, publisher, deliverer, remote: at.remote, urls, config, lease, intake: null, viewer: false,
    configured: () => true, requestTakeover: async () => true,
  };
  const c2s = new C2S({ agent, log });
  agent.intake = new Intake({
    config, urls, remote: at.remote, store, deliverer, publisher, log, lease, push,
    ownerPost: (a, o) => c2s.dispatch(a, o),
  });
  publisher.resolveActor = (u) => agent.intake.fetchAP(u);
  return agent;
}
