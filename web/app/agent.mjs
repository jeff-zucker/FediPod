// agent.mjs — FediPod's agent, running in the browser.
//
// The Node agent (run-agent.mjs) wires the same pieces; this is that wiring with
// the browser's edges: the pod is reached over the DPoP session (pod-remote),
// the signing key comes from WebCrypto (keys-browser), and delivery goes through
// the relay (deliver-relay). Everything between — wire, the store, the
// publisher, intake, the Mastodon facade — is lib/, unchanged.
import { apUrls } from '../../lib/wire.mjs';
import { PodStore } from '../../lib/store.mjs';
import { HttpStorage } from '../../lib/storage.mjs';
import { PodRdf } from '../../lib/podrdf.mjs';
import { Publisher } from '../../lib/publisher.mjs';
import { Intake } from '../../lib/intake.mjs';
import { Lease } from '../../lib/lease.mjs';
import { MastoApi } from '../../lib/mastoapi.mjs';
import { TagFeed } from '../../lib/tagfeed.mjs';
import { makeDpopSession } from './pod-auth.mjs';
import { BrowserRemotePod } from './pod-remote.mjs';
import { importSigningKey, loadKeysFromPod } from './keys-browser.mjs';
import { generateKeys } from './keystore.mjs';
import { RelayDeliverer } from './deliver-relay.mjs';
import { AdminFacade } from './admin-facade.mjs';
import { BrowserAtproto } from './atproto-browser.mjs';
import { BskyFeed } from '../../lib/bskyfeed.mjs';
import { BrowserFediAccounts } from './fediacct-browser.mjs';
import { AcctFeed } from '../../lib/acctfeed.mjs';
import { unfollowActor } from '../../lib/social.mjs';

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
      await this.publisher.publishProfile();
      await this.store.flush?.();
      await this.intake.start();
      this.startBsky();
      this.startAccts();
      this.tagfeed?.start();
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
    this.stopBsky(); this.stopAccts(); this.tagfeed?.stop?.();
    this.startViewerPoll();
  }

  // A viewer refreshes the feed from the pod (the active device updates it), and
  // promotes the moment the lease is free.
  startViewerPoll() {
    clearTimeout(this._viewerTimer);
    const tick = () => {
      this._viewerTimer = setTimeout(async () => {
        try {
          if (!this.viewer) return;
          await this.store.load().catch(() => {});
          if (await this.lease.acquire()) { await this.goActive(); this.log('lease freed — now active'); return; }
        } catch (e) { this.log(`viewer poll: ${e.message}`); }
        if (this.viewer) tick();
      }, 120_000);
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
  async boot({ oidc, credential, keysRecord, config, frontOrigin }) {
    let session; let webId; let remotePod;
    if (oidc) {
      session = { fetch: (u, i) => oidc.fetch(u, i) };
      webId = oidc.webId;
      remotePod = new URL(webId).origin + '/';
    } else {
      const dpop = await makeDpopSession(credential);
      session = { fetch: (u, i) => dpop.fetch(u, i) };
      webId = credential.webId;
      remotePod = credential.remotePod;
    }
    this.webId = webId;
    const root = (config && config.root) || 'fedipod/';
    this.remote = new BrowserRemotePod(session, { webId, log: this.log });
    this.urls = apUrls(remotePod, root);

    // State store, on the pod.
    this.store = new PodStore({ storage: new HttpStorage(this.urls.state, session.fetch), log: this.log });
    await this.store.load().catch(() => { /* first boot: nothing there yet */ });
    // Config: handed in on sign-up, or read from the pod on a returning sign-in.
    const cfg = config || this.store.getConfig();
    if (!cfg) throw new Error('no account config on this pod — sign up first');
    this.store.setConfig({ ...(this.store.getConfig() || {}), ...cfg });
    // Keys: handed in (offline), or the owner-only keys.json read from the pod.
    const keys = keysRecord ? await importSigningKey(keysRecord) : await loadKeysFromPod(this.remote, this.urls);
    config = this.store.getConfig();

    // The RDF truth (followers, notes) also on the pod.
    this.local = new PodRdf({ storage: new HttpStorage(this.urls.fediverse, session.fetch) });

    this.deliverer = new RelayDeliverer({
      store: this.store, rsaPrivate: keys.rsaPrivate, keyId: this.urls.actor + '#main-key',
      actorId: this.urls.actor, log: this.log,
      relayUrl: `${frontOrigin.replace(/\/$/, '')}/api/relay`, handle: config.handle, sessionFetch: session.fetch,
    });

    this.publisher = new Publisher({
      config: this.store.getConfig(), remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publicKeyPem: keys.rsaPublicPem, assertionKey: null, log: this.log,
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
    this.lease = new Lease({ url: this.urls.state + 'lease.json', fetchImpl: (u, i) => session.fetch(u, i), log: this.log });
    this.intake = new Intake({
      config: this.store.getConfig(), urls: this.urls, remote: this.remote, local: this.local,
      store: this.store, deliverer: this.deliverer, publisher: this.publisher, log: this.log, push: true, lease: this.lease,
    });
    // The Mastodon facade the service worker serves. allowed:null → a same-origin
    // request is treated as local, so the one-click sign-in needs no second
    // password (the account password already unlocked the key to get here).
    this.masto = new MastoApi({ agent: this, log: this.log, allowed: null, scheme: 'https', streaming: false });

    // The owner's record/manage surface (the same web/admin page the Node agent
    // serves), answered by this agent over the worker. Personal only — the
    // group and multi-actor endpoints do not exist here. See admin-facade.mjs.
    this.admin = new AdminFacade({ agent: this, log: this.log });

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
      await this.remote.putJson(this.urls.state + '.keep', { keep: true }, 'application/json');
      await this.remote.setAcl(this.urls.state, []);
      await this.remote.setAcl(this.urls.home, []);
      await this.remote.putJson(this.urls.fediverse + '.keep', { keep: true }, 'application/json');
      await this.remote.setAcl(this.urls.fediverse, []);
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
    };
  }

  // Rotate the signing key (POST /rotate-key). Mint a fresh keypair, replace the
  // owner-only keys.json on the pod, swap it into the live publisher/deliverer,
  // and republish the actor so the new public key is on the wire. The old key
  // stops signing the moment this returns — same one-way change as the Node
  // agent's rotateKey (run-agent.mjs).
  async rotateKey() {
    const before = this.publisher.publicKeyPem;
    const rec = await generateKeys();
    await this.remote.putJson(this.urls.state + 'keys.json', rec, 'application/json');
    const keys = await importSigningKey(rec);
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

  // Hand the identity to another account (POST /move). The federated act is the
  // Move to every follower's server; then this account quiesces — unfollows
  // everyone and closes its inbox — since it is being left behind. Same as the
  // Node agent's moveTo + quiesce (run-agent.mjs). `target` is an actor URL,
  // already resolved by the caller.
  async moveTo(target) {
    const moved = await this.publisher.publishMove(target);
    const following = this.store.getContacts().following.map(f => f.actor).filter(Boolean);
    let unfollowed = 0;
    for (const actor of following) {
      try { await unfollowActor(this, actor); unfollowed++; }
      catch (e) { this.log(`unfollow ${actor} failed: ${e.message}`); }
    }
    const quiescedAt = await this.publisher.closeInbox();
    this.log(`moved to ${target}: unfollowed ${unfollowed}/${following.length}, inbox closed`);
    return { ...moved, unfollowed, following: following.length, quiescedAt, snapshot: following.length };
  }
}
