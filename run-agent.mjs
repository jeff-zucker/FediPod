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
import { ensureKeys } from './lib/keys.mjs';
import { RemotePod } from './lib/remote.mjs';
import { PodRdf } from './lib/podrdf.mjs';
import { Deliverer } from './lib/deliver.mjs';
import { Publisher } from './lib/publisher.mjs';
import { Intake } from './lib/intake.mjs';
import { TagFeed } from './lib/tagfeed.mjs';
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
    this.store.setConfig({
      remotePod: cred.remotePod, handle, name: name || handle,
      issuer: cred.issuerOrigin, ...(root ? { root } : {}),
    });
    await this.store.flush();
  }

  // Bring federation up from the credential file + pod state.
  async connect() {
    const cred = this.readCredential();
    if (!cred) return false;
    if (!this.remote) {
      this.remote = new RemotePod(cred);
      await this.remote.warmup();
    }
    const probeUrls = apUrls(cred.remotePod, this.store.getConfig()?.root);
    if (!this.store.fetchImpl) {
      this.store.attach(probeUrls.state, (u, i) => this.remote.fetch(u, i));
      await this.store.load();
    }
    const config = this.store.getConfig();
    if (!config) { this.log('credential present but pod state empty — run setup'); return false; }
    this.urls = apUrls(config.remotePod, config.root);
    const keys = await ensureKeys(this.store);
    this.local = new PodRdf({ base: this.urls.fediverse, fetchImpl: (u, i) => this.remote.fetch(u, i) });
    this.deliverer = new Deliverer({
      store: this.store, rsaPrivate: keys.rsaPrivate, keyId: this.urls.actor + '#main-key', log: this.log,
    });
    this.publisher = new Publisher({
      config, remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publicKeyPem: keys.rsaPublicPem, log: this.log,
    });
    this.intake = new Intake({
      config, urls: this.urls, remote: this.remote, local: this.local, store: this.store,
      deliverer: this.deliverer, publisher: this.publisher, log: this.log,
    });
    await this.intake.start();
    this.tagfeed = new TagFeed({ store: this.store, intake: this.intake, log: this.log });
    this.tagfeed.start();
    this.log(`federating as @${config.handle}@${new URL(this.urls.base).host}`);
    this.backfillStatuses().catch(e => this.log(`statuses backfill failed: ${e.message}`));
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
  await agent.connect()
    .then(up => { if (!up) log('unconfigured — run `bin/activitypod.mjs setup` to begin'); })
    .catch(e => log(`connect failed: ${e.message}`));
  process.on('SIGTERM', () => { agent.store.flush().finally(() => process.exit(0)); });
  process.on('SIGINT', () => { agent.store.flush().finally(() => process.exit(0)); });
  return agent;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgent();
}
