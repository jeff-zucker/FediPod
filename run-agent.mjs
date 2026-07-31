// run-agent.mjs — solid-activitypub: a standalone single-actor ActivityPub
// agent whose entire existence lives on a remote Solid pod. The pod serves
// the public wire face (/activitypods-js/ap/), holds the RDF truth
// (/activitypods-js/fediverse/) and the operational state
// (/activitypods-js/ap-state/); this process is a disposable outbound-only
// worker — any machine holding the credential file resumes the actor.
//
//   node run-agent.mjs                      # or: bin/activitypod.mjs run
//
// Env: AP_HOME (credential dir + local log, default ~/.activitypod),
//      AP_PORT (UI/API/admin, default 8030),
//      AP_GATE_TOKEN (optional loopback gate; absent → open, loopback-only).
//
// Until `bin/activitypod.mjs setup` has minted a credential the agent idles:
// UI + admin up, no federation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PodStore } from './lib/store.mjs';
import { resolveKeys } from './lib/keys.mjs';
import { RemotePod } from './lib/remote.mjs';
import { PodRdf } from './lib/podrdf.mjs';
import { Deliverer } from './lib/deliver.mjs';
import { Publisher } from './lib/publisher.mjs';
import { Intake } from './lib/intake.mjs';
import { TagFeed } from './lib/tagfeed.mjs';
import { Lease } from './lib/lease.mjs';
import { startAdmin } from './lib/admin.mjs';
import { apUrls } from './lib/wire.mjs';
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
      lastDrain: this.intake?.lastDrain || null,
      tagfeed: this.tagfeed
        ? { ...this.tagfeed.config(), lastSweep: this.tagfeed.lastSweep, lastAdded: this.tagfeed.lastAdded }
        : null,
      // Anyone asking whether this agent is hammering their server can read the
      // answer here instead of in their access log.
      podRequests: this.remote?.stats?.() || null,
      inboxCooldownFor: this.intake?.drainCooldownUntil
        ? Math.max(0, Math.round((this.intake.drainCooldownUntil - Date.now()) / 1000)) : 0,
    };
  }

  // First-run provisioning, called by the setup CLI after the credential file
  // is written: containers, owner-only ACLs on the private trees, config into
  // pod state. publishProfile (via connect) handles the public wire ACLs.
  async bootstrap({ handle, name, root, kind, approveJoins = false, summary, icon }) {
    const cred = this.readCredential();
    if (!cred) throw new Error('no credential — run setup first');
    this.remote = new RemotePod(cred, { log: this.log, home: this.home });
    await this.remote.warmup();
    this.urls = apUrls(cred.remotePod, root);
    await this.remote.putJson(this.urls.state + '.keep', { keep: true }, 'application/json');
    await this.remote.putJson(this.urls.fediverse + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(this.urls.home, []);
    await this.remote.setAcl(this.urls.state, []);
    await this.remote.setAcl(this.urls.fediverse, []);
    this.store.attach(this.urls.state, (u, i) => this.remote.fetch(u, i));
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
    });
    await this.store.flush();
  }

  // Bring federation up from the credential file + pod state. `name` (from
  // `run --name "…"`) updates the display name other servers show, without
  // the collateral of re-running setup.
  async connect({ name = null, repair = true } = {}) {
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
    if (!this.store.fetchImpl) this.store.attach(probeUrls.state, (u, i) => this.remote.fetch(u, i));
    if (!this.stateLoaded) {
      await this.store.load();
      this.stateLoaded = true;
    }
    let config = this.store.getConfig();
    if (!config) { this.log('credential present but pod state empty — run setup'); return false; }
    // The store had to be attached from the credential, because only the config
    // it holds says where the state really lives. If the two disagree,
    // everything past here reads one tree and writes another.
    if (apUrls(config.remotePod, config.root).state !== probeUrls.state) {
      const moved = apUrls(config.remotePod, config.root).state;
      this.log(`state tree moved (${probeUrls.state} → ${moved}) — reattaching`);
      this.store.attach(moved, (u, i) => this.remote.fetch(u, i));
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
    this.urls = apUrls(config.remotePod, config.root);
    // The agent answers at <handle>.localhost too, so each identity on a
    // machine gets a browser origin of its own. Known only now: the admin
    // server was listening before any of this was read.
    this.authorities?.setHandle(config.handle);

    // Exactly one agent may act on a pod (inbox drains are destructive
    // reads); later arrivals become read-only viewers of the same state.
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
      fs.writeFileSync(path.join(this.home, 'credential.json'), JSON.stringify(rest, null, 2) + '\n', { mode: 0o600 });
    }
    this.local = new PodRdf({ base: this.urls.fediverse, fetchImpl: (u, i) => this.remote.fetch(u, i) });
    this.deliverer = new Deliverer({
      store: this.store, rsaPrivate: keys.rsaPrivate, keyId: this.urls.actor + '#main-key',
      log: this.log, passive: this.viewer,
    });
    this.publisher = new Publisher({
      config, remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publicKeyPem: keys.rsaPublicPem, log: this.log,
      resolveMention: (h) => resolveHandle(this, h),
    });
    // Intake is constructed even for viewers — its signed fetchAP powers
    // search/deref; start() (draining) is active-only.
    this.intake = new Intake({
      config, urls: this.urls, remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publisher: this.publisher, log: this.log,
    });
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
    await this.startActive();
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
    this.deliverer.rsaPrivate = keys.rsaPrivate;
    await this.publisher.publishProfile();
    return { changed: before !== keys.rsaPublicPem, publicKeyPem: keys.rsaPublicPem };
  }

  // Park: as quiet as a pod can be while keeping its name, and revivable.
  // The following list is snapshotted FIRST — unfollowing is what stops the
  // traffic at source, but it also destroys the only record of who was being
  // followed, and "until I want to revive it" needs that record.
  async park({ unfollow = unfollowActor } = {}) {
    const following = this.store.getContacts().following;
    this.store.write('parked.json', {
      parkedAt: new Date().toISOString(),
      following: following.map(f => ({ actor: f.actor, handle: f.handle || null })),
    });
    await this.store.flush();
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
    const quiesced = await this.quiesce({ unfollow });
    return { ...moved, ...quiesced };
  }

  // True when it had to republish. Authenticated read: the question here is
  // whether the document EXISTS, not whether the world can see it —
  // verifyPublicSurface answers that one.
  async ensureActorPublished() {
    const doc = await this.remote.getJson(this.urls.actor);
    if (doc?.id) return false;
    this.log('actor document missing from the pod — republishing');
    await this.publisher.publishProfile();
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
          await this.startActive();
          return;
        }
        if (this.viewer) await this.store.load();
      } catch (e) { this.log(`viewer refresh: ${e.message}`); }
    }, Math.round(5 * 60_000 * (0.85 + Math.random() * 0.3)));
    this.refreshTimer.unref?.();
  }

  // The acting half: lease renewal, inbox drain, tag feed, delivery queue.
  // Called at connect when the lease is ours, or on viewer promotion.
  async startActive({ repair = true } = {}) {
    this.viewer = false;
    clearInterval(this.refreshTimer);
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    this.deliverer.startQueue();
    // Parked: no draining (the inbox is closed anyway) and no tag feed, so
    // starting the agent by accident does not undo the quiet.
    if (this.store.getConfig()?.quiescedAt) {
      this.log('parked — not draining or polling; run `activitypod revive` to resume');
      this.lease.startRenewal();
      return;
    }
    await this.intake.start();
    this.tagfeed = new TagFeed({ store: this.store, intake: this.intake, log: this.log });
    this.tagfeed.start();
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

  // Another device claimed the lease (its user acted there) — stand down to
  // viewer so exactly one agent keeps draining.
  demote() {
    if (this.viewer) return;
    this.log('another device took over — demoting to viewer');
    this.intake?.stop();
    this.tagfeed?.stop();
    this.deliverer?.stop();
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
        await this.intake.start();
        this.tagfeed = new TagFeed({ store: this.store, intake: this.intake, log: this.log });
        this.tagfeed.start();
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

export async function startAgent({
  home = process.env.AP_HOME || path.join(os.homedir(), '.activitypod'),
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
  if (!handle) {
    try { handle = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).handle || null; }
    catch { handle = null; }
  }
  const logFile = path.join(home, 'agent.log');
  const agent = new Agent({ home, log: () => {} });
  const log = (...a) => {
    const line = `${new Date().toISOString()} ${a.join(' ')}`;
    console.log('[ap]', ...a);
    agent.logRing.push(line);
    if (agent.logRing.length > 500) agent.logRing.shift();
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* logging must never throw */ }
  };
  agent.log = log;
  agent.store.log = log;
  startAdmin({ port, gateToken, agent, log, handle });

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
        log('unconfigured — run `bin/activitypod.mjs setup` to begin');
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
    setTimeout(() => process.exit(0), 5000).unref();   // never hang a stop on a slow pod
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
