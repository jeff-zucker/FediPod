// agent.mjs — FediPod's agent, running in the browser.
//
// The Node agent (run-agent.mjs) wires the same pieces; this is that wiring with
// the browser's edges: the pod is reached over the DPoP session (pod-remote),
// the signing key comes from WebCrypto (keys-browser), and delivery goes through
// the relay (deliver-relay). Everything between — wire, the store, the
// publisher, intake, the Mastodon facade — is lib/, unchanged.
import { kvGet, kvPut } from './idb-kv.mjs';
import { apUrls } from '../../lib/core/wire.mjs';
import * as containers from '../../lib/pod/containers.mjs';
import * as podState from '../../lib/pod/state.mjs';
import { PodStore } from '../../lib/core/store.mjs';
import { HttpStorage } from '../../lib/core/storage.mjs';
import { Publisher } from '../../lib/core/publisher/index.mjs';
import { Intake } from '../../lib/core/intake/index.mjs';
import { C2S } from '../../lib/client/c2s.mjs';
import { Lease } from '../../lib/core/lease.mjs';
import { MastoApi } from '../../lib/client/masto/index.mjs';
import { TagFeed } from '../../lib/connections/tagfeed.mjs';
import { makeDpopSession } from './pod-auth.mjs';
import { BrowserRemotePod } from './pod-remote.mjs';
import { importSigningKey, loadKeysFromPod, cacheOpenedKeys, podActorOf } from './keys-browser.mjs';
import { generateKeys, wrapKeys } from './keystore.mjs';
import { RelayDeliverer, doorKeyOf } from './deliver-relay.mjs';
import { AdminFacade } from './admin-facade.mjs';
import { BrowserAtproto } from './atproto-browser.mjs';
import { BskyFeed } from '../../lib/connections/bskyfeed.mjs';
import { BrowserFediAccounts } from './fediacct-browser.mjs';
import { AcctFeed } from '../../lib/connections/acctfeed.mjs';
import { followActor, unfollowActor, resolveHandle } from '../../lib/core/social.mjs';
import { podBaseOfWebId } from '../../lib/pod/urls.mjs';
import { ImportWorker } from '../../lib/connections/import.mjs';

// The authorities this identity answers on: exactly one, this origin. The Node
// agent gets this from lib/guard.mjs, which is not in the browser bundle and
// would not fit if it were — its whole subject is loopback and named local
// origins, neither of which means anything here.
//
// Two questions are asked of it. `has()` decides whether an OAuth redirect_uri
// is somewhere this agent actually answers. `isLocalRequest()` decides whether
// a caller is the owner rather than a stranger, and in a browser that question
// has exactly one honest answer: whether the request came from this origin —
// which the service worker has already established before anything reaches the
// facade, and stamps on the request it builds (see sw-src.mjs).
const originAuthorities = (host) => ({
  set: new Set([String(host || '').toLowerCase()]),
  has(authority) { return this.set.has(String(authority || '').toLowerCase()); },
  isLocalRequest(req) { return req?.sameOrigin === true; },
  isLocal(h) { return this.has(h); },
  wsAuthorities() { return []; },     // fetch-only: this build serves no socket
});

// Why an account did not open, in words for the person it happened to, and a
// `code` the sign-in page turns into a title and the one button that leads
// somewhere (boot.mjs). Every one of these used to be the same sentence —
// "no account config on this pod — sign up first" — which named the wrong
// cause, offered the wrong cure, and left the reader with nothing to press.
//
// Each message says three things and stops: what the pod did, what that means
// for the account, what to do about it. The pod's own wording is carried only
// where it adds something the status code does not.
async function accountNotRead({ unread, podBase, state, webId, actorUrl = null, fetchImpl = globalThis.fetch }) {
  const host = (() => { try { return new URL(podBase).host; } catch { return podBase; } })();
  const of = (code, message) => { const e = new Error(message); e.code = code; return e; };
  if (!unread) {
    // A pod that holds the account's actor and no record is an account a
    // DeviceAgent runs: the record lives on the device, and only the device
    // can open it. Said so, rather than "there is no account".
    const actor = actorUrl
      ? await fetchImpl(actorUrl, { headers: { accept: 'application/activity+json' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      : null;
    if (actor?.preferredUsername) {
      const at = (() => { try { return `@${actor.preferredUsername}@${new URL(actor.id || actorUrl).host}`; } catch { return actor.preferredUsername; } })();
      return of('device-account', `${host} holds the account ${at}, but not its record: this account is run by a`
        + ` DeviceAgent, and its record lives on that device. Open it from that device's admin page, not here.`
        + ` The sign-in used here was ${webId}.`);
    }
    return of('no-account', `${host} answered, and there is no FediPod account in it.`
      + ` Sign in with the pod that holds your account, or make an account in this one —`
      + ` both start from the sign-in page. The sign-in used here was ${webId}.`);
  }
  const status = Number((/HTTP (\d{3})/u.exec(unread.message) || [])[1]) || 0;
  if (status === 401 || status === 403) {
    // The page renews a refused sign-in by itself, and takes the person to
    // their pod's login when the renewal is refused too (boot.mjs). By the
    // time anybody reads this, both have already been tried.
    return of('sign-in-refused', `${host} would not let this sign-in read your account — it answered`
      + ` "not allowed" (HTTP ${status}) — and renewing the sign-in did not change its mind.`
      + ` Your account and everything in it are untouched. Signing in at ${host} again is the`
      + ` one thing that helps.`);
  }
  if (status === 429) {
    return of('pod-busy', `${host} is telling this browser it has asked for too much too quickly`
      + ` (HTTP 429), so your account could not be read. Nothing is wrong with your account, and`
      + ` nothing here needs doing: this page is waiting the throttle out and will ask again by`
      + ` itself. While a pod is rate-limiting you, only time helps.`);
  }
  if (status >= 500) {
    return of('pod-error', `${host} broke while handing your account over (HTTP ${status}).`
      + ` That is the pod's own failure, not your account's. This page asks again by itself in`
      + ` a moment; if it keeps saying this, the pod is down and there is nothing to do here.`);
  }
  if (status === 404) {
    return of('no-account-here', `${host} says there is nothing at ${state} (HTTP 404).`
      + ` Either no FediPod account has ever been set up in this pod, or you signed in with a`
      + ` different pod than the one holding yours. Sign in with that one, or make an account`
      + ` in this one — both start from the sign-in page.`);
  }
  // No status at all: the request never got an answer. The pod's own words are
  // the only thing that says anything here, so they come along.
  return of('pod-unreachable', `This browser could not reach ${host} to read your account`
    + ` (${unread.message}). Your account is still there. This page tries again by itself;`
    + ` if it keeps saying this, check that you are online and that the pod is up.`);
}

export class BrowserAgent {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.viewer = false;
    this.fediaccts = null;
    this.atproto = null;
    this.intake = null;
  }

  configured() { return !!this.store?.getConfig(); }

  // Asked by every write / destructive path before it acts. If we already hold
  // the lease, proceed. If we are a viewer, the owner acting HERE outranks the
  // idle active device: claim the lease outright and become active.
  async requestTakeover() {
    if (!this.viewer) return true;
    if (!(await this.lease.takeover())) return false;
    clearTimeout(this._viewerTimer); this._viewerTimer = null;
    await this.goActive();
    this.log('took over from the other device (action here)');
    return true;
  }

  // Become the active agent: renew the lease, then start what a viewer skips —
  // publish the face, drain the inbox, run the mirrors.
  async goActive() {
    this.viewer = false;
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    try {
      // Forced, not revalidated. While this device watched, the ACTIVE one was
      // writing; our cache is however stale the last viewer poll left it, and
      // the store is write-through — so the first write from here would push a
      // whole document back over newer state. Read what is actually there
      // before acting on it.
      await this.store.load({ force: true }).catch((e) => this.log(`re-reading state: ${e.message}`));
      // Own posts the outbox names and the timeline index lacks come back
      // here, before anything acts on the index.
      await this.publisher.healStatuses().catch((e) => this.log(`healing the timeline index: ${e.message}`));
      await this.publisher.publishProfilePage().catch((e) => this.log(`profile page: ${e.message}`));
      // And start delivering again, since demote() stopped it. startQueue() is
      // idempotent, so a goActive() that was already active costs nothing.
      this.deliverer?.startQueue?.();
      await this.publisher.publishProfile();
      await this.store.flush?.();
      await this.intake.start();
      this.startBsky();
      this.startAccts();
      this.tagfeed?.start();
      // Resumes a run that was staged on another device, or here before a
      // restart — the state lives on the pod, not in this process.
      this.importer?.start();
    } catch (e) { this.log(`going active: ${e.message}`); }
  }

  // Another device took the lease: stop acting (the drain also self-checks the
  // lease), keep serving the feed read-only, and poll to take it back if freed.
  demote() {
    if (this.viewer) return;
    this.viewer = true;
    this.log('another device took over — read-only here');
    this.lease.stopRenewal();
    this.intake?.stop?.();
    // The delivery queue as well. Its timer starts in the Deliverer's
    // constructor and nothing here ever switched it off, so a demoted device
    // went on sending from a queue the active device is also sending from —
    // the same activity delivered twice, from two browsers, over one key.
    this.deliverer?.stop?.();
    this.importer?.stop?.();
    this.stopBsky(); this.stopAccts(); this.tagfeed?.stop?.();
    this.startViewerPoll();
  }

  // A viewer refreshes the feed from the pod (the active device updates it), and
  // promotes the moment the lease is free.
  // Five minutes with jitter, matching the Node agent (run-agent.mjs). Two
  // minutes flat was ~60 pod requests an hour from a device that is not acting,
  // and unjittered meant several idle devices on one pod knocking in lockstep.
  static VIEWER_POLL_MS = 5 * 60_000;

  startViewerPoll() {
    clearTimeout(this._viewerTimer);
    const every = () => BrowserAgent.VIEWER_POLL_MS * (0.85 + Math.random() * 0.3);
    const tick = () => {
      this._viewerTimer = setTimeout(async () => {
        try {
          if (!this.viewer) return;
          await this.store.load().catch(() => {});     // revalidating is enough while watching
          if (await this.lease.acquire()) { await this.goActive(); this.log('lease freed — now active'); return; }
        } catch (e) { this.log(`viewer poll: ${e.message}`); }
        if (this.viewer) tick();
      }, every());
    };
    tick();
  }

  /**
   * Boot from what sign-up (or sign-in) produced.
   * @param credential  the pod credential { clientId, secret, tokenEndpoint, webId, remotePod, root }
   * @param keysRecord  the plaintext signing keys { rsa:{privatePem,publicPem} }
   * @param config      { remotePod, root, handle, name, issuer, gateway? }
   * @param opts.frontOrigin  where the relay lives (for delivery)
   */
  /**
   * Boot the agent. Two ways in:
   *  - { oidc }: a Solid-OIDC session from oidc-session.getSession() (the real,
   *    redirect-login path). Config and keys are read from the pod, which the
   *    session is authenticated to; a fresh sign-up writes them first.
   *  - { credential, keysRecord, config }: a client-credential session with the
   *    material in hand (the offline test path).
   */
  // This browser's name for itself, minted once and kept. Not an identity and
  // not a secret — it says only "the same browser as last time" to the lease.
  // If storage cannot be reached, a fresh one is honest: this browser cannot
  // prove it is the one that held the lease, so it should not claim to be.
  async deviceId() {
    try {
      const had = await kvGet('device-id');
      if (had) return had;
      const made = crypto.randomUUID();
      await kvPut('device-id', made);
      return made;
    } catch {
      return null;
    }
  }

  async boot({ oidc, credential, keysRecord, config, frontOrigin }) {
    let session; let webId; let remotePod;
    if (oidc) {
      session = { fetch: (u, i) => oidc.fetch(u, i) };
      webId = oidc.webId;
      remotePod = podBaseOfWebId(webId);              // the pod, which on a suffix-based host is a path
    } else {
      const dpop = await makeDpopSession(credential);
      session = { fetch: (u, i) => dpop.fetch(u, i) };
      webId = credential.webId;
      remotePod = credential.remotePod;
    }
    this.webId = webId;
    const root = (config && config.root) || 'fedipod/';
    this.remote = new BrowserRemotePod(session, { webId, log: this.log });
    // Pod-native for now: the state store below is read with these, and only
    // the config it holds says whether this identity is fronted.
    this.urls = apUrls(remotePod, root);

    // State store, on the pod.
    // Through the transport, not the raw session: state writes are pod writes,
    // and going round it skipped the Retry-After cooldown, the retry ladder and
    // the deletion deny-list that every other write on this agent observes.
    // The Node agent has always passed remote.fetch here.
    const podFetch = (u, i) => this.remote.fetch(u, i);
    this.store = new PodStore({ storage: new HttpStorage(this.urls.state, podFetch), log: this.log });
    // A read that FAILED is not an account that is not there. load() already
    // tells those apart — a missing container, a refused token, a pod saying
    // "too many requests" each come back with their own reason — and throwing
    // the reason away turned every one of them into "sign up first", said to
    // somebody who had just signed in and whose account was sitting on the pod
    // unread. Keep it: below is the only place that can tell whether it
    // mattered, because a sign-up hands its config in and needs no read at all.
    let unread = null;
    await this.store.load().catch((e) => { unread = e; });
    // Config: handed in on sign-up, or read from the pod on a returning sign-in.
    const cfg = config || this.store.getConfig();
    if (!cfg) throw await accountNotRead({ unread, podBase: remotePod, state: this.urls.state, webId, actorUrl: this.urls.actor });
    // `root` is written INTO the config, not just used above. The Publisher
    // builds its own urls from `config.root` (publisher.mjs), and a config
    // without one falls to the Node default — so an account set up elsewhere
    // and signed into here would keep its state under `fedipod/` while every
    // document it published landed under a different root. One root, decided
    // once, carried by the config everything downstream reads.
    this.store.setConfig({ ...(this.store.getConfig() || {}), ...cfg, root });
    config = this.store.getConfig();
    // A fronted identity (config.gateway.frontActor) advertises its ids at the
    // gateway; the documents stay on the pod. Same three lines as the Node
    // agent (run-agent.mjs connect): the advertised urls, and the map that
    // turns an advertised url back into the pod one at the transport's single
    // write and read choke point. State and media stay pod-native either way.
    const publicBase = config.gateway?.frontActor
      ? config.gateway.frontActor.replace(/ap\/actor\/?$/, '') : null;
    this.urls = apUrls(remotePod, root, { publicBase });
    if (this.urls.toPod) this.remote.setUrlMap(this.urls.toPod);
    // Keys: handed in (offline), or the owner-only keys.json read from the pod.
    const keys = keysRecord ? await importSigningKey(keysRecord) : await loadKeysFromPod(this.remote, this.urls);


    // `passive`: no queue-drain timer until this device is the active one.
    // Whether it IS the active one is not known here — the lease is acquired
    // further down, after everything is constructed — and the timer starts in
    // the Deliverer's constructor, so a viewer used to boot delivering. Start
    // it in goActive() instead, which is the one place that means "act".
    this.deliverer = new RelayDeliverer({
      passive: true,
      store: this.store, rsaPrivate: keys.rsaPrivate, keyId: this.urls.actor + '#main-key',
      actorId: this.urls.actor, log: this.log,
      relayUrl: `${frontOrigin.replace(/\/$/, '')}/api/relay`,
      // The relay finds the account by the front's own key for it, which for a
      // mail-door account is the full address, not the bare handle.
      handle: doorKeyOf(config.gateway?.url) || config.handle, sessionFetch: session.fetch,
      onGone: () => this.publisher.publishCollections({ followers: true }),
    });

    this.publisher = new Publisher({
      config: this.store.getConfig(), remote: this.remote, store: this.store,
      deliverer: this.deliverer, publicKeyPem: keys.rsaPublicPem, assertionKey: null, log: this.log,
      // Who a post names, resolved — the same lookup the DeviceAgent
      // gives its publisher. Without it no mention from the browser ever
      // resolved: a direct message went to nobody, a mention notified no one.
      resolveMention: (h) => resolveHandle(this, h),
      resolveActor: (u) => this.intake.fetchAP(u),
    });

    // The Bluesky connection, stamped to this actor. The same client the Node
    // agent uses; here the credential lives in the owner-only pod state (see
    // atproto-browser.mjs). The publisher cross-posts public notes through it
    // when one is connected and crossPost is on; BskyFeed mirrors Bluesky back.
    this.atproto = new BrowserAtproto({ store: this.store, actorId: this.urls.actor, log: this.log });
    this.publisher.atproto = this.atproto;

    // Fediverse accounts the owner holds on OTHER servers, mirrored into the
    // feed read here. Their full-access tokens live in this browser (IndexedDB),
    // never on the pod — see fediacct-browser.mjs. Records are loaded, and the
    // poll started, in the background provisioning below.
    this.fediaccts = new BrowserFediAccounts({ store: this.store, actorId: this.urls.actor, log: this.log });

    // The facade and the intake object exist synchronously, so the client can be
    // served the instant boot returns. The heavy pod I/O — provisioning the
    // owner-only containers, publishing the public face, and starting the inbox
    // drain — is a burst of ~20 writes that a pod behind an edge (Cloudflare on
    // solidcommunity.net) throttles. Reaching the feed must NOT wait on it, or a
    // throttled request hangs the whole sign-in. So it runs in the background,
    // where per-request retry rides out the throttling; `this.provisioning`
    // resolves when it is done (a test, or a later call, can await it).
    // Single-active-agent lease (lib/lease.mjs): the inbox drain is a
    // destructive read and the state store is write-through-cached, so exactly
    // one browser/device may ACT on a pod at a time — a later arrival runs
    // read-only until the owner acts on it and it takes over. Written with fresh
    // fetches, never the cached store. Passed into Intake so the drain checks it.
    this.lease = new Lease({ url: this.urls.state + 'lease.json', fetchImpl: podFetch, log: this.log,
      // Kept on this origin, so THIS browser is one holder however many times
      // its worker is killed and restarted. Without it every restart was a new
      // holder: the old lease still had minutes to run, so the browser found
      // its own account "active on another device" and asked to take it over.
      // Switching between the clients did it every time, being a navigation.
      id: await this.deviceId() });
    // The client-to-server dispatcher, here only for what the Gateway's
    // outbox door takes on the owner's behalf: the browser answers no
    // /ap/outbox of its own.
    this.c2s = new C2S({ agent: this, log: this.log });
    this.intake = new Intake({
      config: this.store.getConfig(), urls: this.urls, remote: this.remote,
      store: this.store, deliverer: this.deliverer, publisher: this.publisher, log: this.log, push: true, lease: this.lease,
      ownerPost: (a, o) => this.c2s.dispatch(a, o),
    });
    // The Mastodon facade the service worker serves.
    //
    // It used to be handed `allowed: null`, which reads as "no policy" — and
    // `redirectAllowed()` waves through EVERY redirect_uri when there is no
    // policy (lib/mastoapi.mjs:315). So any page could have a freshly minted
    // 90-day bearer delivered to an address of its own. One origin, ours, is
    // the whole of the policy here.
    // Three capabilities this build does not have, declared rather than
    // pretended: no streaming socket (a worker is fetch-only), no web push
    // (shims/web-push.mjs is a no-op), and no scheduling (nothing here runs
    // between now and the scheduled time to publish). Each is omitted from the
    // instance document, so the client hides the control instead of offering
    // one that quietly does nothing.
    this.masto = new MastoApi({
      agent: this, log: this.log, scheme: 'https',
      streaming: false, webPush: false, scheduling: false,
      allowed: originAuthorities(self.location.host),
    });

    // The owner's record/manage surface (the same web/admin page the Node agent
    // serves), answered by this agent over the worker. Personal only — the
    // group and multi-actor endpoints do not exist here. See admin-facade.mjs.
    this.admin = new AdminFacade({ agent: this, log: this.log });

    // The CSV follow/block/mute importer — the same worker the Node agent runs.
    // It needs only `agent.store` and social.mjs, both of which are in this
    // bundle, so the browser answering 501 was a gap rather than a limitation.
    // Started only by goActive(): it follows people over minutes, which is
    // exactly the kind of writing a viewer must not do.
    this.importer = new ImportWorker({ agent: this, log: this.log });

    // The topical (hashtag) feed, so a fresh account is not a blank wall. It
    // polls public tag timelines and mirrors NEW notes as view-only statuses —
    // nothing is written to the pod. A browser cannot fetch arbitrary fediverse
    // servers cross-origin, so every fetch it makes (the tag timeline and each
    // note's verification via intake.fetchAP) goes through the same relay the
    // rest of the agent's remote reads use. The user controls it from the
    // client's Followed Hashtags surface (see MastoApi's tag endpoints).
    const relayGet = (u, i = {}) => this.deliverer.signedFetch(u, { ...i, method: 'GET' });
    this.tagfeed = new TagFeed({ store: this.store, intake: this.intake, log: this.log, fetcher: relayGet });
    // Started only when this browser is the ACTIVE agent (goActive), so two
    // devices do not double-mirror the same hashtags into the pod state.

    this.provisioning = (async () => {
      // Owner-only containers first; idempotent, so a second device provisioning
      // them too is harmless. Each public document sets its own Read ACL inside
      // publishProfile. Mirrors run-agent bootstrap.
      await containers.provisionPrivate(this.remote, this.urls);
      // Connected-account records are reads — safe whether we act or view.
      await this.atproto.load();      // the Bluesky credential, if it is browser-stored
      await this.fediaccts.load();    // connected fediverse accounts, from both backends
      // The lease decides: this device ACTS on the pod, or reads it read-only.
      this.viewer = !(await this.lease.acquire());
      if (this.viewer) {
        this.log(`read-only viewer: another device is active on @${config.handle}`);
        this.startViewerPoll();       // reload the feed, and promote if the lease frees
        return;
      }
      await this.goActive();
      this.log(`browser agent fully provisioned (active): @${config.handle}`);
    })().catch((e) => { this.log(`background provisioning: ${e.message}`); throw e; });
    // Never let an unhandled rejection escape when nobody awaits it.
    this.provisioning.catch(() => {});

    this.log(`browser agent up: @${config.handle} on ${remotePod}`);
    return this;
  }

  // What the record page and the bar read (GET /status). The same shape the
  // Node agent returns (run-agent.mjs), minus what a browser cannot have — no
  // process, no local checkout, no atproto yet, so those are null.
  status() {
    const cfg = this.store?.getConfig();
    const contacts = this.store?.getContacts() || { followers: [], following: [] };
    return {
      configured: this.configured(),
      mode: !this.configured() ? 'unconfigured' : this.viewer ? 'viewer' : 'active',
      kind: cfg?.kind || 'person',
      handle: cfg?.handle || null,
      actor: this.urls?.actor || null,
      followers: contacts.followers.length,
      following: contacts.following.length,
      queue: this.store?.getQueue().length || 0,
      deadLetters: this.store?.getDeadLetters().length || 0,
      blockedDomains: this.store?.getBlocklist().domains.length || 0,
      push: this.intake?.wsState || 'n/a',
      inbox: this.intake?.inboxStats || null,
      lastDrain: this.intake?.lastDrain || null,
      tagfeed: this.tagfeed
        ? { ...this.tagfeed.config(), lastSweep: this.tagfeed.lastSweep, lastAdded: this.tagfeed.lastAdded }
        : null,
      atproto: this.atproto?.status() || null,
      podRequests: this.remote?.stats?.() || null,
      update: null,
      inboxCooldownFor: 0,
      stateSkipped: this.store?.lastSkipped || [],
    };
  }

  // Rotate the signing key (POST /rotate-key). Mint a fresh keypair, replace the
  // pod's copy, swap it into the live publisher/deliverer, and republish the
  // actor so the new public key is on the wire. The old key stops signing the
  // moment this returns — same one-way change as the Node agent's rotateKey
  // (run-agent.mjs).
  //
  // The pod's copy is wrapped, so this needs the account password. There is
  // nowhere to get it from without asking: the worker boots from a stored
  // session and holds no password, and caching one to save a prompt on a
  // once-in-a-while action would put the account password in storage to avoid
  // typing it. So the caller supplies it, and rotating without one is refused
  // rather than quietly writing a bare key back where a wrapped one was.
  async rotateKey({ password } = {}) {
    if (!password) {
      const e = new Error('rotating the signing key needs your account password — '
        + 'it is what the new key is locked under on the pod');
      e.code = 'key-password-needed';
      throw e;
    }
    const before = this.publisher.publicKeyPem;
    const rec = await generateKeys();
    rec.mintedFor = this.urls.actor;                  // one key, one actor (lib/keys.mjs)
    await podState.writeWrappedKeys(this.remote, this.urls, await wrapKeys(rec, password));
    const keys = await cacheOpenedKeys(podActorOf(this.urls), rec);
    this.publisher.publicKeyPem = keys.rsaPublicPem;
    this.deliverer.rsaPrivate = keys.rsaPrivate;
    await this.publisher.publishProfile();
    return { changed: before !== keys.rsaPublicPem, publicKeyPem: keys.rsaPublicPem };
  }

  // The Bluesky mirror poll — Bluesky notifications and replies into the pod —
  // running only while an account is connected. Reused across calls, not
  // replaced, so a reconnect never leaves an orphaned timer (as in run-agent).
  // A person's mirror only; a group's Bluesky presence is not built here.
  startBsky() {
    if (!this.atproto?.feedActive()) return;   // connected AND not paused
    if (this.store.getConfig()?.quiescedAt) return;
    this.bskyfeed ||= new BskyFeed({ store: this.store, atproto: this.atproto, log: this.log });
    this.bskyfeed.start();
  }

  stopBsky() { this.bskyfeed?.stop(); }

  // Pausing/resuming or moving the Bluesky connection changes whether the mirror
  // should run — re-evaluate it.
  restartBsky() { this.stopBsky(); this.bskyfeed = null; this.startBsky(); }

  // The connected-fediverse-accounts mirror — their home timelines and
  // notifications polled into the feed read here — running only while at least
  // one is connected. Reused, not replaced, for the same orphaned-timer reason
  // as the others (run-agent.mjs).
  startAccts() {
    if (!this.fediaccts?.connected()) return;
    if (this.store.getConfig()?.quiescedAt) return;
    this.acctfeed ||= new AcctFeed({ store: this.store, accounts: this.fediaccts, log: this.log });
    this.acctfeed.start();
  }

  stopAccts() { this.acctfeed?.stop(); }

  // Connecting or disconnecting one changes what there is to poll.
  restartAccts() { this.stopAccts(); this.acctfeed = null; this.startAccts(); }

  // The follow graph, written down before it is torn down.
  //
  // Both parking and moving away unfollow everyone, and the record page offers
  // "active" again after either — so both have to leave something to come back
  // from. moveTo used to report `snapshot: following.length` without writing
  // one, so a browser account set back to active re-followed nobody and said so
  // only in a count of zero. Same file, same name, same shape as the Node
  // agent's `_snapshotFollowing` (run-agent.mjs).
  async _snapshotFollowing() {
    const following = this.store.getContacts().following;
    this.store.write('parked.json', {
      parkedAt: new Date().toISOString(),
      following: following.map(f => ({ actor: f.actor, handle: f.handle || null })),
    });
    await this.store.flush();
    return following;
  }

  // Keep the handle, take no more mail.
  //
  // Unfollowing is what actually stops the volume — every account you follow
  // pushes its posts into your inbox — and closing the inbox handles what no
  // follow graph can gate: stranger mentions, new follow requests, spam.
  //
  // This matters more here than it does on Node. A Node agent runs as a service
  // and keeps draining; close the tab on a browser agent and nothing drains,
  // while the gateway goes on delivering into the pod inbox regardless (it
  // writes straight to the pod — see lib/gateway-core.mjs). An unattended
  // browser account is a pod quietly filling up with nobody collecting, and
  // this is the only control that stops it at the source.
  async quiesce() {
    const following = this.store.getContacts().following.map(f => f.actor).filter(Boolean);
    let unfollowed = 0;
    for (const actor of following) {
      try { await unfollowActor(this, actor); unfollowed++; }
      catch (e) { this.log(`unfollow ${actor} failed: ${e.message}`); }
    }
    const quiescedAt = await this.publisher.closeInbox();
    this.log(`quiesced: unfollowed ${unfollowed}/${following.length}, inbox closed`);
    return { unfollowed, following: following.length, quiescedAt };
  }

  // Park (POST /park). The snapshot is taken FIRST: unfollowing is what stops
  // the traffic, but it also destroys the only record of who was being
  // followed, and "until I want this back" needs that record.
  async park() {
    const following = await this._snapshotFollowing();
    const r = await this.quiesce();
    this.log(`parked: ${r.unfollowed} unfollow(s) recorded for revival, inbox closed`);
    return { ...r, snapshot: following.length };
  }

  // Undo a park (POST /revive). Re-open the inbox, then re-follow everyone in
  // the snapshot. Each Follow needs the far end to Accept, so this is a request
  // rather than a restoration — some will not come back, which is the nature of
  // the thing, and why the result counts both numbers.
  async revive() {
    const parked = this.store.read('parked.json', null);
    await this.publisher.openInbox();
    let refollowed = 0;
    for (const f of parked?.following || []) {
      try { await followActor(this, f.actor); refollowed++; }
      catch (e) { this.log(`re-follow ${f.actor} failed: ${e.message}`); }
    }
    if (parked) this.store.remove('parked.json').catch(() => {});
    await this.store.flush();
    this.log(`revived: inbox open, ${refollowed}/${parked?.following?.length || 0} follow(s) re-sent`);
    return { refollowed, of: parked?.following?.length || 0, parkedAt: parked?.parkedAt || null };
  }

  // Hand the identity to another account (POST /move). The federated act is the
  // Move to every follower's server; then this account quiesces — unfollows
  // everyone and closes its inbox — since it is being left behind. Same as the
  // Node agent's moveTo + quiesce (run-agent.mjs). `target` is an actor URL,
  // already resolved by the caller.
  async moveTo(target) {
    const moved = await this.publisher.publishMove(target);
    const following = await this._snapshotFollowing();
    const r = await this.quiesce();
    this.log(`moved to ${target}: unfollowed ${r.unfollowed}/${r.following}, inbox closed`);
    return { ...moved, ...r, snapshot: following.length };
  }
}

export { accountNotRead };
