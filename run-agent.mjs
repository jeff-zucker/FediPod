// run-agent.mjs — activitypod-js: a standalone single-actor ActivityPub
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
    };
  }

  // First-run provisioning, called by the setup CLI after the credential file
  // is written: containers, owner-only ACLs on the private trees, config into
  // pod state. publishProfile (via connect) handles the public wire ACLs.
  async bootstrap({ handle, name, root }) {
    const cred = this.readCredential();
    if (!cred) throw new Error('no credential — run setup first');
    this.remote = new RemotePod(cred);
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
    });
    await this.store.flush();
  }

  // Bring federation up from the credential file + pod state. `name` (from
  // `run --name "…"`) updates the display name other servers show, without
  // the collateral of re-running setup.
  async connect({ name = null } = {}) {
    const cred = this.readCredential();
    if (!cred) return false;
    if (!this.remote) {
      this.remote = new RemotePod(cred);
      await this.remote.warmup();
    }
    const probeUrls = apUrls(cred.remotePod, cred.root);
    if (!this.store.fetchImpl) {
      this.store.attach(probeUrls.state, (u, i) => this.remote.fetch(u, i));
      await this.store.load();
    }
    let config = this.store.getConfig();
    if (!config) { this.log('credential present but pod state empty — run setup'); return false; }
    // A rename is a merge into the existing config, never a rewrite — the
    // UI password and anything else set later must survive it.
    if (name && name !== config.name) {
      this.store.setConfig({ ...config, name });
      config = this.store.getConfig();
      this.renamed = true;                   // republish the actor once connected
      this.log(`display name set to "${name}"`);
    }
    this.urls = apUrls(config.remotePod, config.root);

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
    await this.startActive();
    return true;
  }

  // Read-only mode: refresh the state cache periodically, and take over the
  // moment the active agent's lease frees.
  startViewer() {
    this.viewer = true;
    this.refreshTimer = setInterval(async () => {
      try {
        if (this.viewer && await this.lease.acquire()) {
          this.log('lease freed — promoting to ACTIVE');
          await this.startActive();
          return;
        }
        if (this.viewer) await this.store.load();
      } catch (e) { this.log(`viewer refresh: ${e.message}`); }
    }, 60_000);
    this.refreshTimer.unref?.();
  }

  // The acting half: lease renewal, inbox drain, tag feed, delivery queue.
  // Called at connect when the lease is ours, or on viewer promotion.
  async startActive() {
    this.viewer = false;
    clearInterval(this.refreshTimer);
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    this.deliverer.startQueue();
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
} = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
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
  startAdmin({ port, gateToken, agent, log });

  // The pod (or its issuer) can be briefly unreachable — a 504 from the
  // token endpoint, or no network yet at boot under install-service. Keep
  // retrying with backoff instead of sitting unconfigured until someone
  // notices; the UI stays up throughout.
  const connectWithRetry = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const up = await agent.connect({ name });
        if (up) return;
        log('unconfigured — run `bin/activitypod.mjs setup` to begin');
        return;                                    // no credential: retrying won't help
      } catch (e) {
        const wait = Math.min(30 * 2 ** (attempt - 1), 600);   // 30s → 10min
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
