// account-agent.mjs — an account's agent, put together at the gateway for as
// long as one piece of work takes: a keeper run (keeper.mjs), or a request from
// a Mastodon app (masto-gateway.mjs).
//
// For a personal account the gateway may read the signing key on the pod and
// nothing else there, and never writes the pod: it works from the account's
// copy (copy.mjs), and whatever it would have written to the pod is handed to
// the pod inbox at the end (pod-mail.mjs: handOver), for the owner's FediPod to
// apply. The key is read when it is needed, never kept, never made.
import crypto from 'node:crypto';
import { PodTransport } from '../pod/transport.mjs';
import { podBaseOfWebId } from '../pod/urls.mjs';
import { apUrls } from '../core/wire.mjs';
import { PodStore } from '../core/store.mjs';
import { HttpStorage } from '../core/storage.mjs';
import { Deliverer } from '../core/deliver.mjs';
import { Publisher } from '../core/publisher/index.mjs';
import { Intake } from '../core/intake/index.mjs';
import { C2S } from '../client/c2s.mjs';
import { keeperSession } from './keeper-session.mjs';
import { CopyStorage, copyMeta, copyLease, keptBefore, GATEWAY_HOLDER } from './copy.mjs';
import { mailSession, flushMail, storageOver } from './pod-mail.mjs';

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

// The identity that reads this person's key: the one their row records, when
// the gateway holds its credential (the key reader's, or the keeper's while the
// owner's FediPod has not yet named the key reader).
export function keyReaderOf(ctx, rec) {
  const webId = rec?.keeper?.webId || ctx.keyReaderWebId || ctx.keeperWebId || null;
  const credential = webId && webId === ctx.keyReaderWebId ? ctx.keyReaderCredential
    : webId && webId === ctx.keeperWebId ? ctx.keeperCredential : null;
  return { webId, credential };
}

/**
 * Where the account is, and a transport for it as the gateway: reading the key
 * on the pod and nothing else, and holding every write for handOver. Returns
 * { remote, session, pod, root, urls, meta, stateUrl, keyFetch } or { skipped }
 * when this gateway cannot act for it.
 */
export async function reachAccount(ctx, handle, rec, { log = console.log, session = null } = {}) {
  const reader = keyReaderOf(ctx, rec);
  if (!rec?.keeper || !reader.webId || !(session || reader.credential)) return { skipped: 'not kept' };
  if (keptBefore(ctx, rec)) return { skipped: 'kept under the gateway\'s former identity; the owner\'s FediPod moves it over on its next start' };
  if (!rec.webId || !rec.podHome) return { skipped: 'the row names no owner or pod' };
  const meta = ctx.copyKv ? await copyMeta(ctx.copyKv, handle) : null;
  if (!meta) return { skipped: 'no copy of this account here yet; FediPod makes one when it next opens' };
  const pod = podBaseOfWebId(rec.webId);
  const root = rec.podHome.startsWith(pod) ? rec.podHome.slice(pod.length) : null;
  if (root === null) return { skipped: 'the row\'s folder is not on the owner\'s pod' };
  const stateUrl = rec.podHome.replace(/\/?$/u, '/') + 'ap-state/';
  const keyUrl = stateUrl + 'keys.json';
  // A copy from before version 2: worked on as it always was, with the
  // keeper's access its owner's rules still give, until the owner's FediPod
  // starts it again (state-api.mjs: reset).
  if (meta.v !== 2) {
    const keeper = session || keeperSession(ctx.keeperCredential);
    const remote = new PodTransport(keeper, { webId: ctx.keeperWebId, log, role: 'keeper', runtime: 'node', cooldownMode: 'refuse' });
    remote.aclOwner = rec.webId;
    remote.keepers = [ctx.keeperWebId];
    remote.aclIfChanged = true;
    return { remote, legacy: true, pod, root, urls: apUrls(pod, root), meta, stateUrl, keyFetch: (u, i) => remote.fetch(u, i), inCopy: true };
  }
  const keySession = session || keeperSession(reader.credential);
  const keyFetch = (u, i) => keySession.fetch(u, i);
  const mail = mailSession({ keyUrl, keyFetch, publicFetch: ctx.publicFetch || globalThis.fetch });
  const remote = new PodTransport(mail, { webId: reader.webId, log, role: 'keeper', runtime: 'node', cooldownMode: 'refuse' });
  // Any rule it writes names the owner alone.
  remote.aclOwner = rec.webId;
  remote.keepers = [];
  remote.aclIfChanged = true;
  const mediaBase = ctx.frontOrigin ? `${ctx.frontOrigin.replace(/\/$/u, '')}/u/${encodeURIComponent(handle)}/ap/media/` : null;
  return { remote, session: mail, pod, root, urls: apUrls(pod, root), meta, stateUrl, keyFetch, inCopy: true, mediaBase };
}

/**
 * The account's state store and lease, as `holder`: the copy, with the key
 * read from the pod and every change recorded for handOver.
 */
export function stateAndLease(ctx, handle, at, { log = console.log, holder = GATEWAY_HOLDER } = {}) {
  const copy = new CopyStorage(ctx.copyKv, handle, { holder, pod: new HttpStorage(at.stateUrl, at.keyFetch), podNames: ['keys.json'] });
  const storage = storageOver(copy, at.meta);
  return {
    store: new PodStore({ storage, log }),
    storage,
    lease: copyLease(ctx.copyKv, handle, { id: holder, log }),
  };
}

/**
 * What this piece of work changed, handed to the pod inbox (pod-mail.mjs).
 * The store is committed first, so every change is in. Returns flushMail's
 * answer; never throws, since the work is done either way: a failure is logged
 * and what it held is lost to the pod only, the copy keeping it.
 */
export async function handOver(ctx, handle, rec, at, store, { log = console.log, defer = false } = {}) {
  await store.commit?.();
  // An old copy is written to the pod by the round, as it always was.
  if (at.legacy) return { legacy: true };
  return flushMail(ctx, handle, rec, { storage: store.storage, session: at.session, log, defer })
    .catch((e) => { log(`@${handle}: not handed to the pod: ${e?.message || e}`); return { failed: e?.message || String(e) }; });
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
    // A picture an app uploads is fetched by other servers the moment the
    // post arrives, before the owner's FediPod has put it on the pod: its
    // address is here, which serves it until then and points at the pod after.
    ...(at.legacy || !at.mediaBase ? {} : { mediaUrlFor: (podUrl) => at.mediaBase + podUrl.slice(urls.media.length) }),
  };
  const c2s = new C2S({ agent, log });
  agent.intake = new Intake({
    config, urls, remote: at.remote, store, deliverer, publisher, log, lease, push,
    ownerPost: (a, o) => c2s.dispatch(a, o),
  });
  publisher.resolveActor = (u) => agent.intake.fetchAP(u);
  return agent;
}
