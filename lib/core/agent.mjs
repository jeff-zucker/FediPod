// agent.mjs — one identity: its store, keys, lease, intake, deliverer,
// publisher and connections, and the actions its owner takes on it. Runs
// wherever a Node process hosts it; the DeviceAgent's entry (run-agent.mjs)
// and a pod server (lib/server/embed.mjs) both build one of these.

import fs from 'node:fs';
import path from 'node:path';

import { PodStore } from './store.mjs';
import { writeJsonAtomic } from '../shared/files.mjs';
import { storageFor } from './storage.mjs';
import { resolveKeys } from './keys.mjs';
import { completeGatewayMove } from './gateway-move.mjs';
import { RemotePod } from './remote.mjs';
import { Deliverer } from './deliver.mjs';
import { Publisher } from './publisher/index.mjs';
import { Intake } from './intake/index.mjs';
import { C2S } from '../client/c2s.mjs';
import { TagFeed } from '../connections/tagfeed.mjs';
import { ImportWorker } from '../connections/import.mjs';
import { Atproto } from '../connections/atproto.mjs';
import { FediAccounts } from '../connections/fediacct.mjs';
import { vaultsFor } from '../connections/vault.mjs';
import { AcctFeed } from '../connections/acctfeed.mjs';
import { BskyFeed } from '../connections/bskyfeed.mjs';
import { BskyGroup } from '../connections/bskygroup.mjs';
import { Lease } from './lease.mjs';
import { publishDue, nextToPublish } from './scheduled.mjs';
import { apUrls, assertionKeyId, publicHandle } from './wire.mjs';
import { followActor, unfollowActor, resolveHandle } from './social.mjs';
import * as podInbox from '../pod/inbox.mjs';

export class Agent {
  // `upgradeCheck(credential)` names the layout steps an install still owes;
  // the DeviceAgent passes its own, an agent hosted elsewhere passes none.
  constructor({ home, log, upgradeCheck = null }) {
    this.home = home;
    this.log = log;
    this.upgradeCheck = upgradeCheck;
    this.logRing = [];
    this.store = new PodStore({ log });
  }

  readCredential() {
    try { return JSON.parse(fs.readFileSync(path.join(this.home, 'credential.json'), 'utf8')); }
    catch { return null; }
  }

  configured() { return !!this.remote && !!this.store.getConfig(); }

  // Where the private half lives. `privateRoot` in the credential file names a
  // container — by default a plain directory beside the credential, and a pod
  // on this machine if you move it there. Absent means on the pod, so an
  // existing install is untouched.
  privateUrls(cred, urls = this.urls) {
    if (!cred.privateRoot) {
      return { state: urls.state, archive: urls.home + 'inbox-archive/', elsewhere: false };
    }
    const base = cred.privateRoot.endsWith('/') ? cred.privateRoot : cred.privateRoot + '/';
    return { state: base + 'ap-state/', archive: base + 'inbox-archive/', elsewhere: true };
  }

  // A container to keep the private half in. On the pod it is reached with the
  // credential; a local pod plainly, with a token header when it is gated
  // (dk's is); a directory is not reached over anything at all.
  privateStorage(cred, which, urls = this.urls) {
    const url = this.privateUrls(cred, urls)[which];
    if (!cred.privateRoot) return storageFor(url, (u, i) => this.remote.fetch(u, i));
    const token = process.env.AP_STATE_TOKEN || '';
    return storageFor(url, (u, i) => fetch(u, token
      ? { ...i, headers: { ...(i?.headers || {}), 'x-dk-token': token } }
      : i));
  }

  logLines(n = 100) { return this.logRing.slice(-n); }

  status() {
    const cfg = this.store.getConfig();
    const contacts = this.store.getContacts();
    return {
      configured: this.configured(),
      mode: !this.configured() ? 'unconfigured' : this.viewer ? 'viewer' : 'active',
      kind: cfg?.kind || 'person',
      handle: cfg?.handle || null,
      actor: this.urls?.actor || null,
      followers: contacts.followers.length,
      following: contacts.following.length,
      queue: this.store.getQueue().length,
      deadLetters: this.store.getDeadLetters().length,
      blockedDomains: this.store.getBlocklist().domains.length,
      push: this.intake?.wsState || 'n/a',
      // Measured by the last sweep from the listing it already fetched, so
      // asking costs nothing. What the admin page prompts on.
      inbox: this.intake?.inboxStats || null,
      lastDrain: this.intake?.lastDrain || null,
      tagfeed: this.tagfeed
        ? { ...this.tagfeed.config(), lastSweep: this.tagfeed.lastSweep, lastAdded: this.tagfeed.lastAdded }
        : null,
      atproto: this.atproto?.status() || null,
      // Anyone asking whether this agent is hammering their server can read the
      // answer here instead of in their access log.
      podRequests: this.remote?.stats?.() || null,
      update: this.updateInfo || null,
      inboxCooldownFor: this.intake?.drainCooldownUntil
        ? Math.max(0, Math.round((this.intake.drainCooldownUntil - Date.now()) / 1000)) : 0,
      stateSkipped: this.store.lastSkipped || [],
    };
  }

  // First-run provisioning, called by the setup CLI after the credential file
  // is written: containers, owner-only ACLs on the private trees, config into
  // pod state. publishProfile (via connect) handles the public wire ACLs.
  async bootstrap({ handle, name, root, kind, approveJoins = false, summary, icon, gateway }) {
    const cred = this.readCredential();
    if (!cred) throw new Error('no credential — run setup first');
    if (!this.remote) {
      this.remote = new RemotePod(cred, { log: this.log, home: this.home });
      await this.remote.warmup();
    }
    this.urls = apUrls(cred.remotePod, root);
    const priv = this.privateUrls(cred);
    const stateStore = this.privateStorage(cred, 'state');
    // The pod's own ap-state/ is provisioned either way: even when the rest of
    // the private half lives elsewhere, lease.json stays here, because a lease
    // in a pod only one machine can reach coordinates nothing.
    await this.remote.putJson(this.urls.state + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(this.urls.home, []);
    await this.remote.setAcl(this.urls.state, []);
    if (priv.elsewhere) {
      const r = await stateStore.write('.keep', '{"keep":true}\n', 'application/json');
      if (!r.ok) throw new Error(`private store ${stateStore.base}.keep → ${r.why}`);
      this.log(`private state lives at ${cred.privateRoot} (${stateStore.kind})`);
    }
    this.store.attach(stateStore);
    // Re-running setup must not destroy state set afterwards (the UI
    // password, above all), so load what is there and merge into it.
    await this.store.load().catch(() => {});
    const existing = this.store.getConfig() || {};
    this.store.setConfig({
      ...existing,
      remotePod: cred.remotePod, handle, name: name || existing.name || handle,
      issuer: cred.issuerOrigin, ...(root ? { root } : {}),
      ...(kind ? { kind } : {}),
      ...(approveJoins ? { approveJoins: true } : {}),
      ...(summary ? { summary } : {}), ...(icon ? { icon } : {}),
      // Set before the first publish, so the actor never advertises the pod
      // inbox only to rename it a moment later.
      ...(gateway ? { gateway } : {}),
    });
    await this.store.flush();
  }

  // Cache the handle in agent.json, merging so the port survives. Nothing
  // outside this process can read pod state, so this file is the only place a
  // sibling — or the next start, before it connects — can learn the name to
  // build this identity's origin from.
  recordHandle(handle) {
    if (!handle || !this.home) return;
    const file = path.join(this.home, 'agent.json');
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first run */ }
    if (rec.handle === handle) return;
    try { writeJsonAtomic(file, { ...rec, handle }, { mode: 0o644 }); }
    catch { /* the agent still runs; its links are just bare */ }
  }

  // Bring federation up from the credential file + pod state. `name` (from
  // `run --name "…"`) updates the display name other servers show, without
  // the collateral of re-running setup.
  // `act: false` reads the identity and stops. Everything a confirmation prompt
  // needs — the handle, the host, the follow counts — is in pod state that is
  // loaded by then, while acquiring the lease, draining the inbox, subscribing a
  // notification channel, probing the ACLs and sweeping the tag feed are all
  // things a command you are about to decline should never have spent. The
  // command calls connect() again, without the flag, if you say yes.
  async connect({ name = null, repair = true, act = true } = {}) {
    const cred = this.readCredential();
    if (!cred) return false;
    if (!this.remote) {
      this.remote = new RemotePod(cred, { log: this.log, home: this.home });
      await this.remote.warmup();
    }
    const probeUrls = apUrls(cred.remotePod, cred.root);
    // Load until it actually succeeds: attaching is not the same as having
    // read the state, and a retry that skipped the load would see an empty
    // cache and wrongly conclude the agent was never set up.
    if (!this.store.storage) this.store.attach(this.privateStorage(cred, 'state', probeUrls));
    if (!this.stateLoaded) {
      await this.store.load();
      this.stateLoaded = true;
    }
    let config = this.store.getConfig();
    if (!config) { this.log('credential present but pod state empty — run setup'); return false; }
    // The store had to be attached from the credential, because only the config
    // it holds says where the state really lives. If the two disagree,
    // everything past here reads one tree and writes another.
    // Only meaningful when the state follows the pod. With privateRoot set it
    // is pinned by configuration and a moved pod does not move it.
    if (!cred.privateRoot && apUrls(config.remotePod, config.root).state !== probeUrls.state) {
      const moved = apUrls(config.remotePod, config.root).state;
      this.log(`state tree moved (${probeUrls.state} → ${moved}) — reattaching`);
      this.store.attach(storageFor(moved, (u, i) => this.remote.fetch(u, i)));
      await this.store.load();
      config = this.store.getConfig();
      if (!config) { this.log('no state at the pod its own config names — run setup'); return false; }
    }
    // Resurrecting a tombstoned actor would contradict the Delete every server
    // has already acted on, so a retired identity stays retired.
    if (config.retiredAt) {
      this.log(`this actor was retired on ${config.retiredAt} — run setup for a new identity`);
      return false;
    }
    // A rename is a merge into the existing config, never a rewrite — the
    // UI password and anything else set later must survive it.
    if (name && name !== config.name) {
      this.store.setConfig({ ...config, name });
      config = this.store.getConfig();
      this.renamed = true;                   // republish the actor once connected
      this.log(`display name set to "${name}"`);
    }
    // A fronted identity (config.gateway.frontActor) advertises its ids on a
    // shared domain; RemotePod gets the map so writes still land on the pod.
    const publicBase = config.gateway?.frontActor
      ? config.gateway.frontActor.replace(/ap\/actor\/?$/, '') : null;
    this.urls = apUrls(config.remotePod, config.root, { publicBase });
    if (this.urls.toPod) this.remote.setUrlMap(this.urls.toPod);
    // The agent answers at <handle>.localhost too, so each identity on a
    // machine gets a browser origin of its own. Known only now: the admin
    // server was listening before any of this was read.
    this.authorities?.setHandle(config.handle);
    // And write it down beside the port. Everything that links to this identity
    // from OUTSIDE the process builds the origin from agent.json — the Actors
    // list, a sibling's page, the next start — and an identity set up before the
    // handle was recorded has only a port there, so every one of those links
    // came out bare. Pod state is the authority; this is the cache of it.
    this.recordHandle(config.handle);

    // Said once, where the config is finally known. Exposure without a gate
    // token is refused before the socket opens (startAgent), so reaching here
    // means the token is set and the whole surface is behind it. A UI password
    // is the second, per-person half: without one, anyone who has the token
    // gets a client bearer for the asking.
    // An install made before the shape changed goes on working, which is why
    // nothing here refuses — but it should not go on SILENTLY. The whole reason
    // this is said out loud is that bbba587 changed a default and every install
    // that already existed kept the old layout with nothing to show for it.
    const pending = this.upgradeCheck ? this.upgradeCheck(cred) : [];
    for (const step of pending) {
      this.log(`this identity is on an older layout: ${step.what} (${step.why}). `
        + 'Run `fedipod upgrade` to see what is pending.');
    }
    // The record page says the same thing on its software row — the log is
    // read by nobody who lives in the GUI.
    this.pendingUpgrade = pending.map(s => s.what);

    if (process.env.AP_ALLOWED_HOSTS && !config.uiPassword) {
      this.log('WARNING: AP_ALLOWED_HOSTS is set and no UI password is — anyone holding '
        + 'AP_GATE_TOKEN can mint a client token. Run `fedipod passwd`.');
    }

    if (!act) return true;                   // reading only — see the note above

    // Exactly one agent may act on a pod (inbox drains are destructive
    // reads); later arrivals become read-only viewers of the same state.
    // Deliberately the REMOTE pod's ap-state/, never privateRoot's: a lease
    // that only one machine can reach is not a lease.
    this.lease = new Lease({
      url: this.urls.state + 'lease.json',
      fetchImpl: (u, i) => this.remote.fetch(u, i), log: this.log,
    });
    this.viewer = !(await this.lease.acquire());

    // Keys are LOCAL by default (the pod host never holds them); `setup
    // --keys pod` opts into sharing them through the pod so several devices
    // can sign as the same actor. Per-machine choice, so it rides in the
    // credential file rather than pod state.
    const keys = await resolveKeys(this.store, {
      localDir: cred.keysMode === 'pod' ? null : this.home,
      rotate: !!cred.rotateKeyOnce,
      actorId: this.urls.actor,
      log: this.log,
      // Consulted only when no key material exists anywhere: if the actor
      // already publishes a key, minting a new one would break federation.
      actorHasKey: async () => {
        const doc = await this.remote.getJson(this.urls.actor).catch(() => null);
        return !!doc?.publicKey?.publicKeyPem;
      },
    });
    if (cred.rotateKeyOnce) {                       // one-shot flag
      const { rotateKeyOnce, ...rest } = cred;
      writeJsonAtomic(path.join(this.home, 'credential.json'), rest);
    }
    // connect() can run more than once — connectWithRetry retries after a throw,
    // and the CLI connects for real after its confirmation. Deliverer arms a
    // 60s queue timer in its constructor and Intake owns a poll timer and a
    // websocket, so replacing them without stopping the old ones leaves both
    // ticking for the life of the process.
    this.intake?.stop();
    this.deliverer?.stop();
    this.tagfeed?.stop();
    clearInterval(this.schedTimer);
    this.publisher?.stopPolls();
    this.deliverer = new Deliverer({
      store: this.store, rsaPrivate: keys.rsaPrivate, keyId: this.urls.actor + '#main-key',
      actorId: this.urls.actor, edPrivate: keys.edPrivate,
      proofKeyId: assertionKeyId(this.urls),
      log: this.log, passive: this.viewer,
      onGone: () => this.publisher.publishCollections({ followers: true }),
      // Inside a pod server, a long-lived process: several followers' servers
      // at once rather than one after another.
      parallel: this.embedded ? 6 : 1,
    });
    this.publisher = new Publisher({
      config, remote: this.remote, store: this.store,
      deliverer: this.deliverer, publicKeyPem: keys.rsaPublicPem,
      assertionKey: keys.edPublicMultibase, log: this.log,
      resolveMention: (h) => resolveHandle(this, h),
      resolveActor: (u) => this.intake.fetchAP(u),
      // Inside a pod server the client surface answers on the pod's own
      // origin, so it can be advertised. Standalone it is on loopback, and
      // naming it in a world-readable actor would send clients nowhere.
      clientOrigin: this.embedded ? this.urls.base : null,
      // There, a post is answered once it is on the pod and delivery carries
      // on behind; a process that may be stopped any moment waits for it.
      background: this.embedded,
    });
    // Intake is constructed even for viewers — its signed fetchAP powers
    // search/deref; start() (draining) is active-only.
    // The dispatcher the admin surface also builds; this one is for what the
    // Gateway's outbox door took on the owner's behalf and the drain finds.
    this.c2s = new C2S({ agent: this, log: this.log });
    this.intake = new Intake({
      config, urls: this.urls, remote: this.remote, store: this.store,
      deliverer: this.deliverer, publisher: this.publisher, log: this.log, lease: this.lease,
      archive: this.privateStorage(cred, 'archive'),
      push: !this.embedded, pollSeconds: this.pollSeconds || null,
      ownerPost: (a, o) => this.c2s.dispatch(a, o),
    });
    // The CSV-import worker: paced, resumable, armed only while active.
    this.importer?.stop();
    this.importer = new ImportWorker({ agent: this, log: this.log });
    // Where the credentials for accounts held on OTHER servers are kept.
    const vaults = vaultsFor({ embedded: this.embedded, home: this.home, store: this.store });
    // The Bluesky connection, when one exists. Stamped to this actor; a
    // credential connected for another identity is treated as absent.
    this.atproto = new Atproto({
      localDir: this.home, actorId: this.urls.actor, log: this.log, vault: vaults.bluesky,
    });
    this.publisher.atproto = this.atproto;
    // Fediverse accounts the owner holds elsewhere. Same custody rules as the
    // Bluesky credential, and the same absence when stamped for someone else.
    this.fediaccts = new FediAccounts({
      localDir: this.home, actorId: this.urls.actor, log: this.log,
      vault: vaults.fedi, apps: vaults.apps,
    });
    this.acctfeed?.stop();
    this.acctfeed = null;
    this.bskyfeed?.stop();
    this.bskyfeed = null;
    this.bskygroup = null;
    this.intake.bskyGroup = null;
    if (this.viewer) {
      this.startViewer();
      this.log(this.lease.denied === 'unreadable'
        ? `the pod cannot be read, so the lease is unknown — viewing as @${config.handle} (read-only)`
        : `another agent is active for this pod — viewing as @${config.handle} (read-only)`);
      return true;
    }
    await this.startActive({ repair });
    return true;
  }

  // Claim the lease from whoever holds it and start acting. For the case where
  // the holder is gone but its lease has not expired — a crash, or a one-shot
  // command that exited without releasing — the only alternative is waiting out
  // the TTL, which is five minutes.
  async takeOver() {
    if (!this.viewer) return false;
    if (!await this.lease.takeover()) return false;
    this.log('took the lease over');
    await this.startActive({ promoted: true });
    return true;
  }

  // Mint a replacement signing key and republish the actor that advertises it.
  // These are one operation: a rotation without the republish leaves remote
  // servers verifying against a key we no longer hold, which fails every
  // delivery silently. The live deliverer and publisher are updated too, so the
  // running agent signs with the new key from here on.
  async rotateKey() {
    const cred = this.readCredential();
    const before = this.publisher.publicKeyPem;
    const keys = await resolveKeys(this.store, {
      localDir: cred.keysMode === 'pod' ? null : this.home,
      rotate: true,
      actorId: this.urls.actor,
      log: this.log,
    });
    this.publisher.publicKeyPem = keys.rsaPublicPem;
    this.publisher.assertionKey = keys.edPublicMultibase;
    this.deliverer.rsaPrivate = keys.rsaPrivate;
    this.deliverer.edPrivate = keys.edPrivate;
    await this.publisher.publishProfile();
    return { changed: before !== keys.rsaPublicPem, publicKeyPem: keys.rsaPublicPem };
  }

  // Park: as quiet as a pod can be while keeping its name, and revivable.
  // The following list is snapshotted FIRST — unfollowing is what stops the
  // traffic at source, but it also destroys the only record of who was being
  // followed, and "until I want to revive it" needs that record.
  async park({ unfollow = unfollowActor } = {}) {
    const following = await this._snapshotFollowing();
    const r = await this.quiesce({ unfollow });
    this.log(`parked: ${r.unfollowed} unfollow(s) recorded for revival, inbox closed`);
    return { ...r, snapshot: following.length };
  }

  // Undo a park: re-open the inbox, then re-follow everyone from the snapshot.
  // Each Follow needs the far end to Accept, so this is a request, not a
  // restoration — some will not come back, which is the nature of the thing.
  async revive({ follow = followActor } = {}) {
    const parked = this.store.read('parked.json', null);
    await this.publisher.openInbox();
    let refollowed = 0;
    for (const f of parked?.following || []) {
      try { await follow(this, f.actor); refollowed++; }
      catch (e) { this.log(`re-follow ${f.actor} failed: ${e.message}`); }
    }
    if (parked) this.store.remove('parked.json').catch(() => {});
    await this.store.flush();
    this.log(`revived: inbox open, ${refollowed}/${parked?.following?.length || 0} follow(s) re-sent`);
    return { refollowed, of: parked?.following?.length || 0, parkedAt: parked?.parkedAt || null };
  }

  // The follow graph, written down before it is torn down. Both going quiet
  // and moving away unfollow everyone, and the record page offers "active"
  // afterwards for either — so both have to leave something to come back from,
  // or setting it back re-follows nobody and says so only in a count.
  async _snapshotFollowing() {
    const following = this.store.getContacts().following;
    this.store.write('parked.json', {
      parkedAt: new Date().toISOString(),
      following: following.map(f => ({ actor: f.actor, handle: f.handle || null })),
    });
    await this.store.flush();
    return following;
  }

  // Keep the handle, take no more mail. Unfollowing is what actually stops the
  // volume — every account you follow pushes its posts into your inbox — and
  // closing the inbox handles the rest, which no follow graph can gate:
  // stranger mentions, new follow requests, outright spam.
  // `unfollow` is injectable so this is testable without a live pod.
  async quiesce({ unfollow = unfollowActor } = {}) {
    const following = this.store.getContacts().following.map(f => f.actor);
    let unfollowed = 0;
    for (const actor of following) {
      try { await unfollow(this, actor); unfollowed++; }
      catch (e) { this.log(`unfollow ${actor} failed: ${e.message}`); }
    }
    const quiescedAt = await this.publisher.closeInbox();
    this.log(`quiesced: unfollowed ${unfollowed}/${following.length}, inbox closed`);
    return { unfollowed, following: following.length, quiescedAt };
  }

  // Same, plus the fediverse-native redirect: followers are migrated to the
  // target by their own servers, and the old handle keeps resolving.
  async moveTo(target, { unfollow = unfollowActor } = {}) {
    const moved = await this.publisher.publishMove(target);
    const snapshot = await this._snapshotFollowing();
    const quiesced = await this.quiesce({ unfollow });
    return { ...moved, ...quiesced, snapshot: snapshot.length };
  }

  // True when it had to republish. Authenticated read: the question here is
  // whether the document EXISTS, not whether the world can see it —
  // verifyPublicSurface answers that one.
  async ensureActorPublished() {
    const doc = await this.remote.getJson(this.urls.actor);
    if (doc?.id) return false;
    this.log('actor document missing from the pod — republishing');
    await this.publisher.publishProfile({ force: true });   // the digest cannot know this
    return true;
  }

  // The featured collection was once written only on the first pin, so an
  // account from before then has none, and every server that shows the
  // profile is refused and asks again. One authenticated GET; the empty
  // collection goes up when the pod lacks it. True when it had to.
  async ensureFeaturedPublished() {
    const doc = await this.remote.getJson(this.urls.featured);
    if (doc?.id) return false;
    this.log('featured collection missing from the pod — publishing it');
    await this.publisher.publishFeatured();
    return true;
  }

  // The inbox's door must be open to the world (or to the gateway alone, in
  // locked mode) or nothing anyone sends ever lands. The permission is written
  // at setup, and a container made again later — a root move, a pod rebuilt —
  // came back without it: the group's inbox on fp2 refused every delivery for
  // nine days while its agent ran on, healthy-looking. One write per start,
  // and it is idempotent.
  async ensureInboxOpen() {
    const g = this.store.getConfig()?.gateway;
    const posture = g?.mode === 'locked' && g.webId ? { gatewayWebId: g.webId } : 'open';
    await podInbox.setPosture(this.remote, this.urls, posture);
    return posture;
  }

  // Read-only mode: refresh the state cache periodically, and take over the
  // moment the active agent's lease frees.
  startViewer() {
    this.viewer = true;
    // Five minutes, not one: with revalidation a quiet refresh is a single 304,
    // but a viewer still has no reason to ask twelve times an hour.
    this.refreshTimer = setInterval(async () => {
      try {
        if (this.viewer && await this.lease.acquire()) {
          this.log('lease freed — promoting to ACTIVE');
          await this.startActive({ promoted: true });
          return;
        }
        if (this.viewer) await this.store.load();
      } catch (e) { this.log(`viewer refresh: ${e.message}`); }
    }, Math.round(5 * 60_000 * (0.85 + Math.random() * 0.3)));
    this.refreshTimer.unref?.();
  }

  // The acting half: lease renewal, inbox drain, tag feed, delivery queue.
  // Called at connect when the lease is ours, or on viewer promotion.
  async startActive({ repair = true, promoted = false } = {}) {
    this.viewer = false;
    clearInterval(this.refreshTimer);
    if (promoted) await this.refreshBeforeActing();
    // Own posts the outbox names and the timeline index lacks come back here,
    // before anything acts on the index.
    await this.publisher.healStatuses().catch(e => this.log(`healing the timeline index: ${e.message}`));
    // Likes made before the liked list existed become its first entries.
    try { this.publisher.backfillLiked(); } catch (e) { this.log(`liked list: ${e.message}`); }
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    this.deliverer.startQueue();
    // Parked: no draining (the inbox is closed anyway) and no tag feed, so
    // starting the agent by accident does not undo the quiet.
    if (this.store.getConfig()?.quiescedAt) {
      this.log('parked — not draining or polling; run `fedipod revive` to resume');
      return;                                // renewal is already running, above
    }
    await this.intake.start();
    // An address that moved here from another gateway, whose move was left
    // pending (the old gateway could not be told): try again now that this
    // agent acts and the actor is published.
    completeGatewayMove(this).catch(e => this.log(`gateway move: ${e.message}`));
    // Reused, not replaced: demote() stops this instance but does not clear it,
    // so constructing a new one over the top orphaned the old chain beyond the
    // reach of any later stop().
    this.tagfeed ||= new TagFeed({ store: this.store, intake: this.intake, log: this.log });
    this.tagfeed.start();
    this.startBsky();
    this.startAccts();
    // Scheduled posts and polls whose time is up: every 30s the clock is
    // compared with the next one due, and only then is anything done
    // (lib/core/scheduled.mjs).
    clearInterval(this.schedTimer);
    let publishing = false;
    this.schedTimer = setInterval(() => {
      const due = nextToPublish(this.store);
      if (publishing || due == null || due > Date.now()) return;
      publishing = true;
      publishDue(this.store, this.publisher, this.log).catch(err => this.log(`scheduled: ${err.message}`))
        .finally(() => { publishing = false; });
    }, 30_000);
    this.schedTimer.unref();
    // A CSV import interrupted by a restart or a handoff picks back up here.
    this.importer?.resume();
    // The identity the fediverse actually sees: a fronted actor's name and
    // host are the front's, not the pod's.
    this.log(`federating as @${publicHandle(this.store.getConfig())}@${new URL(this.urls.actor).host}`);
    if (this.renamed) {
      // The display name lives in the actor document, so a rename only
      // reaches other servers once that is republished.
      this.renamed = false;
      this.publisher.publishProfile()
        .then(() => this.log('actor document republished with the new display name'))
        .catch(e => this.log(`republish after rename failed: ${e.message}`));
    }
    // bootstrap writes the owner-only ACLs once, at setup, and nothing else
    // ever returns to them — so check on every start that the private trees
    // really are private, and repair them if not. Off the critical path.
    this.publisher.ensurePrivateAcls()
      .catch(e => this.log(`private-ACL check failed: ${e.message}`));
    // A publish that died half-way leaves an actor nobody can fetch while
    // everything here looks healthy — one GET to find out, and republishing
    // is idempotent.
    // Skipped during setup, which publishes the profile itself a moment later:
    // running both meant every first run wrote the whole wire face twice.
    if (repair) {
      this.ensureActorPublished()
        .catch(e => this.log(`actor check failed: ${e.message}`));
      this.ensureFeaturedPublished()
        .catch(e => this.log(`featured check failed: ${e.message}`));
      this.ensureInboxOpen()
        .catch(e => this.log(`inbox door check failed: ${e.message}`));
      // The human page, rewritten only when what it shows has changed: one
      // local digest compare, and a write the first time after an upgrade.
      this.publisher.publishProfilePage()
        .catch(e => this.log(`profile page: ${e.message}`));
    }
    this.seedFollowNotifications().catch(e => this.log(`notification seeding failed: ${e.message}`));
  }

  // Re-read state before acting on what we hold. A viewer's cache is kept
  // current by revalidation against the CONTAINER, whose ETag vouches for its
  // children existing rather than for their contents — so a peer rewriting
  // contacts.json or statuses.json in place moves nothing this agent would
  // notice. Only on promotion, never on a timer, and only documents that really
  // changed come back with a body.
  async refreshBeforeActing() {
    if (!this.store.storage) return;
    await this.store.load({ force: true })
      .catch(e => this.log(`state refresh on promotion: ${e.message}`));
  }

  // Another device claimed the lease (its user acted there) — stand down to
  // viewer so exactly one agent keeps draining.
  // The Bluesky mirror poll, only ever running when an account is connected.
  // Reused, not replaced, for the same orphaned-timer reason as tagfeed.
  startBsky() {
    if (this.viewer || !this.atproto?.connected()) return;
    if (this.store.getConfig()?.quiescedAt) return;
    // A group's account is the group's presence on Bluesky: follows are joins,
    // mentions are submissions, and both ride the notification hook.
    if (this.store.getConfig()?.kind === 'group') {
      this.bskygroup ||= new BskyGroup({
        store: this.store, atproto: this.atproto, intake: this.intake,
        publisher: this.publisher, log: this.log,
      });
      this.intake.bskyGroup = this.bskygroup;
    }
    this.bskyfeed ||= new BskyFeed({
      store: this.store, atproto: this.atproto, log: this.log,
      onNotification: async (n) => {
        if (!this.bskygroup) return;
        if (n.reason === 'follow') await this.bskygroup.onFollow(n.author);
        else await this.bskygroup.onMention(n);
      },
    });
    this.bskyfeed.start();
  }

  stopBsky() { this.bskyfeed?.stop(); }

  // The connected fediverse accounts' poll, only ever running when at least
  // one is connected. Reused, not replaced, for the same orphaned-timer reason
  // as tagfeed.
  startAccts() {
    if (this.viewer || !this.fediaccts?.connected()) return;
    if (this.store.getConfig()?.quiescedAt) return;
    this.acctfeed ||= new AcctFeed({
      store: this.store, accounts: this.fediaccts, log: this.log,
    });
    this.acctfeed.start();
  }

  stopAccts() { this.acctfeed?.stop(); }

  // Connecting or disconnecting an account changes what there is to poll, and
  // the last one going leaves a timer with nothing to ask.
  restartAccts() {
    this.stopAccts();
    this.startAccts();
  }

  demote() {
    if (this.viewer) return;
    this.log('another device took over — demoting to viewer');
    this.intake?.stop();
    this.tagfeed?.stop();
    this.bskyfeed?.stop();
    this.acctfeed?.stop();
    this.deliverer?.stop();
    this.importer?.stop();
    clearInterval(this.schedTimer);
    this.publisher?.stopPolls();
    // The lease too: standing down means standing down. Left renewing, a viewer
    // keeps writing to the pod on the active agent's behalf and can win the
    // lease back on a conditional PUT it had no business making.
    this.lease?.stopRenewal();
    this.startViewer();
  }

  // A user acting on this viewer outranks the idle active agent elsewhere:
  // claim the lease now (writes are safe immediately — publishing never
  // touches the inbox), but hold the destructive inbox drain until the old
  // active has seen the loss at its next renewal and demoted.
  async requestTakeover() {
    if (!this.viewer) return true;
    if (!(await this.lease.takeover())) return false;
    this.log('taking over from the other device (user action here)');
    this.viewer = false;
    clearInterval(this.refreshTimer);
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    this.deliverer.startQueue();
    setTimeout(async () => {
      if (this.viewer) return;                 // lost it again in the meantime
      try {
        await this.refreshBeforeActing();
        await this.intake.start();
        this.tagfeed ||= new TagFeed({ store: this.store, intake: this.intake, log: this.log });
        this.tagfeed.start();
        this.startBsky();
    this.startAccts();
        // A stranded CSV import resumes here too — startActive is not on the
        // takeover path, so without this the rows sat pending until a restart.
        this.importer?.resume();
        this.log('takeover complete — draining resumed on this device');
      } catch (e) { this.log(`takeover drain start: ${e.message}`); }
    }, 35_000).unref?.();                      // > one renewal interval: old agent has demoted
    return true;
  }

  // A first run inherits followers without ever having seen them arrive, so
  // the notifications list starts empty where it should start full.
  async seedFollowNotifications() {
    if (this.store.has('notifications.json')) return;
    for (const f of this.store.getContacts().followers) {
      this.store.addNotification({ type: 'follow', actor: f.actor });
    }
  }
}
