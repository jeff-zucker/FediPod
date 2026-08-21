// run-agent.mjs — fedipod: a standalone single-actor ActivityPub
// agent. The remote pod is a RELAY: it serves the public wire face
// (/activitypods-js/ap/) and buffers inbound mail in a public-append inbox
// while this process is off, and it keeps one private document, the lease,
// because a lock only one machine can reach coordinates nothing.
//
// Everything else private is on THIS machine — the RDF truth and the
// operational state, in a directory beside the credential and the signing key.
// So a machine holding only the credential file does NOT resume the actor: it
// resumes the identity with an empty timeline, contacts, blocklist and
// notifications, and `fedipod rebuild` recovers the posts the pod still
// carries. `privateRoot` absent in credential.json is the pre-2026-08-03
// layout and still means both trees are on the pod; `fedipod upgrade`
// says so and `state --all` moves them.
//
//   node run-agent.mjs                      # or: bin/fedipod.mjs run
//
// Env: AP_HOME (credential dir + local log, default ~/.fedipod, or
//      ~/.activitypod on an install that predates the rename — see lib/home.mjs),
//      AP_PORT (UI/API/admin, default 8030),
//      AP_GATE_TOKEN (optional loopback gate; absent → open, loopback-only).
//
// Until `bin/fedipod.mjs setup` has minted a credential the agent idles:
// UI + admin up, no federation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PodStore } from './lib/store.mjs';
import { apRoot, rootOf, writeJsonAtomic } from './lib/home.mjs';
import { ensureTrustedTls } from './lib/certs.mjs';
import { storageFor } from './lib/storage.mjs';
import { resolveKeys } from './lib/keys.mjs';
import { RemotePod } from './lib/remote.mjs';
import { PodRdf } from './lib/podrdf.mjs';
import { Deliverer } from './lib/deliver.mjs';
import { Publisher } from './lib/publisher.mjs';
import { Intake } from './lib/intake.mjs';
import { TagFeed } from './lib/tagfeed.mjs';
import { ImportWorker } from './lib/import.mjs';
import { Atproto } from './lib/atproto.mjs';
import { BskyFeed } from './lib/bskyfeed.mjs';
import { BskyGroup } from './lib/bskygroup.mjs';
import { Lease } from './lib/lease.mjs';
import { startAdmin } from './lib/admin.mjs';
import { exposureProblem, hostLabel } from './lib/guard.mjs';
import { pendingSteps } from './lib/migrate.mjs';
import { apUrls, assertionKeyId } from './lib/wire.mjs';
import { followActor, unfollowActor, resolveHandle } from './lib/social.mjs';

export class Agent {
  constructor({ home, log }) {
    this.home = home;
    this.log = log;
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
  // on this machine if you move it there — under which the same two trees are
  // laid out as on the pod. Absent means on the pod, exactly as before, so an
  // existing install is untouched.
  privateUrls(cred, urls = this.urls) {
    if (!cred.privateRoot) {
      return { state: urls.state, fediverse: urls.fediverse, archive: urls.home + 'inbox-archive/', elsewhere: false };
    }
    const base = cred.privateRoot.endsWith('/') ? cred.privateRoot : cred.privateRoot + '/';
    return { state: base + 'ap-state/', fediverse: base + 'fediverse/', archive: base + 'inbox-archive/', elsewhere: true };
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
      for (const s of [stateStore, this.privateStorage(cred, 'fediverse')]) {
        const r = await s.write('.keep', '{"keep":true}\n', 'application/json');
        if (!r.ok) throw new Error(`private store ${s.base}.keep → ${r.why}`);
      }
      this.log(`private state lives at ${cred.privateRoot} (${stateStore.kind})`);
    } else {
      await this.remote.putJson(this.urls.fediverse + '.keep', { keep: true }, 'application/json');
      await this.remote.setAcl(this.urls.fediverse, []);
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
    const pending = pendingSteps(cred);
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
    this.local = new PodRdf({ storage: this.privateStorage(cred, 'fediverse') });
    // connect() can run more than once — connectWithRetry retries after a throw,
    // and the CLI connects for real after its confirmation. Deliverer arms a
    // 60s queue timer in its constructor and Intake owns a poll timer and a
    // websocket, so replacing them without stopping the old ones leaves both
    // ticking for the life of the process.
    this.intake?.stop();
    this.deliverer?.stop();
    this.tagfeed?.stop();
    clearInterval(this.schedTimer);
    this.deliverer = new Deliverer({
      store: this.store, rsaPrivate: keys.rsaPrivate, keyId: this.urls.actor + '#main-key',
      actorId: this.urls.actor, edPrivate: keys.edPrivate,
      proofKeyId: assertionKeyId(this.urls),
      log: this.log, passive: this.viewer,
    });
    this.publisher = new Publisher({
      config, remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publicKeyPem: keys.rsaPublicPem,
      assertionKey: keys.edPublicMultibase, log: this.log,
      resolveMention: (h) => resolveHandle(this, h),
      // Whether the fediverse tree is on the pod at all, so the ACL check does
      // not probe for something the default layout keeps on local disk.
      privateOnPod: !cred.privateRoot,
    });
    // Intake is constructed even for viewers — its signed fetchAP powers
    // search/deref; start() (draining) is active-only.
    this.intake = new Intake({
      config, urls: this.urls, remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publisher: this.publisher, log: this.log, lease: this.lease,
      archive: this.privateStorage(cred, 'archive'),
      push: !this.embedded, pollSeconds: this.pollSeconds || null,
    });
    // The CSV-import worker: paced, resumable, armed only while active.
    this.importer?.stop();
    this.importer = new ImportWorker({ agent: this, log: this.log });
    // The Bluesky connection, when one exists. Stamped to this actor; a
    // credential connected for another identity is treated as absent.
    this.atproto = new Atproto({ localDir: this.home, actorId: this.urls.actor, log: this.log });
    this.publisher.atproto = this.atproto;
    this.bskyfeed?.stop();
    this.bskyfeed = null;
    this.bskygroup = null;
    this.intake.bskyGroup = null;
    if (this.viewer) {
      this.startViewer();
      this.log(`another agent is active for this pod — viewing as @${config.handle} (read-only)`);
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
    // Reused, not replaced: demote() stops this instance but does not clear it,
    // so constructing a new one over the top orphaned the old chain beyond the
    // reach of any later stop().
    this.tagfeed ||= new TagFeed({ store: this.store, intake: this.intake, log: this.log });
    this.tagfeed.start();
    this.startBsky();
    // Scheduled posts: a 30s sweep publishes what has come due. The entry is
    // removed before publishing, so a slow publish cannot double-post; a
    // failed one is dropped with its reason in the log.
    clearInterval(this.schedTimer);
    this.schedTimer = setInterval(() => {
      const due = this.store.getScheduled().filter(e => Date.parse(e.scheduledAt) <= Date.now());
      for (const e of due) {
        this.store.setScheduled(this.store.getScheduled().filter(x => x.id !== e.id));
        this.publisher.publishNote(e.params.status, {
          inReplyTo: e.params.inReplyTo, attachments: e.params.attachments,
          visibility: e.params.visibility, spoilerText: e.params.spoilerText,
        }).then(() => this.log(`scheduled post published (${e.id})`))
          .catch(err => this.log(`scheduled post ${e.id} failed: ${err.message} — dropped`));
      }
    }, 30_000);
    this.schedTimer.unref();
    // A CSV import interrupted by a restart or a handoff picks back up here.
    this.importer?.resume();
    this.log(`federating as @${this.store.getConfig()?.handle}@${new URL(this.urls.base).host}`);
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
    }
    this.backfillStatuses().catch(e => this.log(`statuses backfill failed: ${e.message}`));
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

  demote() {
    if (this.viewer) return;
    this.log('another device took over — demoting to viewer');
    this.intake?.stop();
    this.tagfeed?.stop();
    this.bskyfeed?.stop();
    this.deliverer?.stop();
    this.importer?.stop();
    clearInterval(this.schedTimer);
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
        // A stranded CSV import resumes here too — startActive is not on the
        // takeover path, so without this the rows sat pending until a restart.
        this.importer?.resume();
        this.log('takeover complete — draining resumed on this device');
      } catch (e) { this.log(`takeover drain start: ${e.message}`); }
    }, 35_000).unref?.();                      // > one renewal interval: old agent has demoted
    return true;
  }

  // The statuses index is an operational mirror of the pod's RDF — rebuild it
  // from /fediverse/ when absent (fresh state, or state loss).
  async backfillStatuses() {
    if (!this.store.has('notifications.json')) {
      for (const f of this.store.getContacts().followers) {
        this.store.addNotification({ type: 'follow', actor: f.actor });
      }
    }
    if (this.store.has('statuses.json')) return;
    const entries = [];
    for (const [container, kind] of [['timeline', 'timeline'], ['posts', 'post']]) {
      for (const url of await this.local.listNotes(container)) {
        try {
          const n = await this.local.readNote(url);
          if (n.noteId) entries.push({ ...n, kind, slug: url.split('/').pop() });
        } catch (e) { this.log(`backfill: skipped ${url}: ${e.message}`); }
      }
    }
    entries.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    this.store.write('statuses.json', entries.slice(0, 1000));
    this.log(`backfilled ${entries.length} statuses from pod RDF`);
  }
}

// Two megabytes is a few weeks of an ordinary agent's chatter, and small
// enough that reading the whole thing is still reasonable.
const LOG_MAX_BYTES = 2 * 1024 * 1024;

export async function startAgent({
  home = process.env.AP_HOME || apRoot(),
  port = Number(process.env.AP_PORT) || 8030,
  gateToken = process.env.AP_GATE_TOKEN || '',
  name = null,
  takeover = false,
  handle = null,
} = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // connect() sets this from pod state a moment later, but the browser may
  // already be opening — seed it from what setup recorded so the named origin
  // works from the first request.
  // agent.json is how everything else finds this agent afterwards — `profiles`,
  // `stop`, the Actors list. The CLI used to be the only thing that wrote it, so
  // an agent spawned any other way (the admin page starts them now) ran
  // invisibly on a port nobody could look up. Merge, so `handle` survives.
  const agentJson = path.join(home, 'agent.json');
  let recorded = {};
  try { recorded = JSON.parse(fs.readFileSync(agentJson, 'utf8')) || {}; } catch { /* first run */ }
  if (!handle) handle = recorded.handle || null;
  if (recorded.port !== port) {
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      writeJsonAtomic(agentJson, { ...recorded, port }, { mode: 0o644 });
    } catch { /* the agent still runs; it is just harder to find */ }
  }
  const logFile = path.join(home, 'agent.log');
  const agent = new Agent({ home, log: () => {} });
  // The port on every line. Agents sharing a home share agent.log, and without
  // it there is no way to tell which one wrote what — a viewer's startup reads
  // as the active one's work.
  const log = (...a) => {
    const line = `${new Date().toISOString()} :${port} ${a.join(' ')}`;
    console.log(`[ap:${port}]`, ...a);
    agent.logRing.push(line);
    if (agent.logRing.length > 500) agent.logRing.shift();
    try {
      // Rotated, because nothing else was ever going to. This file is appended
      // to on every drain, every delivery and every lease event, for the life
      // of an agent that is meant to run for months — on a phone under Termux
      // especially, an unbounded log is the thing that fills the disk. One
      // previous generation is kept; a crash investigation rarely wants two.
      if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
    } catch { /* no log yet, or a rename we cannot do — appending still works */ }
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* logging must never throw */ }
  };
  agent.log = log;
  agent.store.log = log;
  // Before the socket, not after: an agent that must not be reachable at that
  // address must never have answered there. This used to be a warning said at
  // connect time, which is both too late (the server has been listening for
  // seconds) and too narrow (it only ever described the OAuth login).
  const exposure = exposureProblem({ allowedHosts: process.env.AP_ALLOWED_HOSTS, gateToken });
  if (exposure) {
    log(`refusing to start:\n${exposure}`);
    process.exit(2);
  }
  // https and nothing else, on the one port this agent was given: a
  // per-machine certificate (never packaged — see lib/certs.mjs), covering
  // every identity on this root. A certificate problem stops the start rather
  // than quietly serving the UI and the API in the clear.
  let tls = null;
  try {
    tls = ensureTrustedTls(path.join(rootOf(agent.home), 'certs'),
      { log, names: hostLabel(handle) ? [`${hostLabel(handle)}.localhost`] : [] });
  } catch (e) {
    log(`refusing to start: certificate setup failed (${e.message})`);
    log('the agent serves https only — fix the certificate, or run `fedipod https --trust`');
    process.exit(2);
  }
  startAdmin({ port, gateToken, agent, log, handle, tls });

  // Is a newer FediPod published? Once at boot and daily after; the answer
  // rides /status and the record page offers the update.
  const updateTick = async () => {
    const { checkLatest } = await import('./lib/update.mjs');
    const u = await checkLatest();
    if (u) {
      agent.updateInfo = u;
      if (u.available) log(`FediPod ${u.latest} is available (running ${u.current}) — update from the record page or \`fedipod update\``);
    }
  };
  void updateTick();
  setInterval(updateTick, 24 * 3600e3).unref?.();

  // The pod (or its issuer) can be briefly unreachable — a 504 from the
  // token endpoint, or no network yet at boot under install-service. Keep
  // retrying with backoff instead of sitting unconfigured until someone
  // notices; the UI stays up throughout.
  const connectWithRetry = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const up = await agent.connect({ name });
        if (up) {
          // A lease whose holder is gone but not expired would otherwise leave
          // us read-only for the whole TTL.
          if (takeover && agent.viewer) await agent.takeOver();
          return;
        }
        log('unconfigured — run `bin/fedipod.mjs setup` to begin');
        return;                                    // no credential: retrying won't help
      } catch (e) {
        // Caps at an hour, not ten minutes: a pod that has refused for an hour
        // is not going to be helped by asking six times more per hour, and an
        // agent left running for days should not be a fixture in its logs.
        // Jittered so restarts of several agents do not line up.
        const base = Math.min(30 * 2 ** (attempt - 1), 3600);
        const wait = Math.round(base * (0.8 + Math.random() * 0.4));
        log(`connect failed (attempt ${attempt}): ${e.message} — retrying in ${wait}s`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
    }
  };
  connectWithRetry();
  const shutdown = () => {
    setTimeout(() => process.exit(0), 1500).unref();   // never hang a stop on a slow pod
    try { fs.rmSync(path.join(home, 'agent.pid'), { force: true }); } catch {}
    Promise.allSettled([
      agent.store.flush(),
      agent.viewer ? Promise.resolve() : agent.lease?.release(),
    ]).finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return agent;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgent();
}
