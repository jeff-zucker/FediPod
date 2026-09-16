// forum-agent.mjs — the forum's host: one process that runs a FediPod group
// agent for every category, drains the forum's one inbox and routes each
// activity to the category it names, places carried posts into topics, and
// holds one lease for the whole forum so several moderators' devices can
// share the job — whichever is up acts, the rest watch and take over.
//
// What is reused is the whole group: a category's store, publisher,
// deliverer and intake are FediPod's own, configured as a group. What is new
// is the routing, the topic placement, and the lifecycle around N of them.

import path from 'node:path';
import fs from 'node:fs';
import { PodStore } from '../../../lib/core/store.mjs';
import { storageFor as defaultStorageFor } from '../../../lib/core/storage.mjs';
import { Deliverer } from '../../../lib/core/deliver.mjs';
import { Publisher } from '../../../lib/core/publisher/index.mjs';
import { Intake } from '../../../lib/core/intake/index.mjs';
import { C2S } from '../../../lib/client/c2s.mjs';
import { Lease } from '../../../lib/core/lease.mjs';
import { resolveKeys } from '../../../lib/core/keys.mjs';
import { assertionKeyId } from '../../../lib/core/wire.mjs';
import { resolveHandle } from '../../../lib/core/social.mjs';
import * as podInbox from '../../../lib/pod/inbox.mjs';
import { forumUrls, ROOT, isSlug } from './urls.mjs';
import * as topics from './topics.mjs';
import * as publish from './publish.mjs';
import * as moderation from './moderation.mjs';
import { provisionForum, provisionCategory } from './provision.mjs';

const idOf = (v) => (typeof v === 'string' ? v : v?.id);
const arr = (v) => (v === undefined || v === null ? [] : [].concat(v));
const HEARTBEAT_MS = 10 * 60_000;
const VIEWER_REFRESH_MS = 5 * 60_000;

// The forum's inbox, drained by one loop and handed out by address. Every
// mechanism of a drain — listing, reading, receipts, dead letters, the
// commit-before-delete rule — is the Intake's; only handle() differs.
export class ForumIntake extends Intake {
  constructor(opts, forum) {
    super(opts);
    this.forum = forum;
  }

  async handle(activity, receipt = null) {
    const cats = this.forum.route(activity);
    if (cats.length) {
      const results = [];
      for (const cat of cats) results.push(await cat.intake.handle(activity, receipt));
      // Accepted by any category is accepted; refused by all is the first reason.
      return results.every(r => r) ? results[0] : undefined;
    }
    if (this.forum.namesSite(activity)) return super.handle(activity, receipt);
    return 'names no category of this forum';
  }

  // Every category's state has to be on the pod before an item leaves the
  // inbox, not only the forum's own.
  async _persisted() {
    let ok = await this.store.commit();
    for (const cat of this.forum.categories) ok = (await cat.store.commit()) && ok;
    return ok;
  }

  // Categories carry (FEP-1b12); the forum's own inbox forwards nothing.
  async _maybeForward() {}

  // A receipt beside an item was signed by the door it came through, and each
  // category's door has its own secret: the receipt is ours if any of them
  // verifies it.
  async _readReceipt(itemUrl) {
    const secrets = [this.config.gateway?.hmacSecret, ...this.forum.categories.map(c => c.config.gateway?.hmacSecret)]
      .filter(Boolean);
    if (!secrets.length) return null;
    try {
      const { readCapped } = await import('../../../lib/shared/safefetch.mjs');
      const { verifyReceipt } = await import('../../../lib/gateway/httpsig.mjs');
      const receipt = await podInbox.readDeliveryReceipt(this.remote, itemUrl, { maxBytes: 64 * 1024, readCapped });
      if (!receipt) return null;
      return secrets.some(s => verifyReceipt(receipt, s)) ? receipt : null;
    } catch { return null; }
  }

  gatewaySecret() {
    return this.config.gateway?.hmacSecret || this.forum.categories.find(c => c.config.gateway?.hmacSecret)?.config.gateway.hmacSecret || null;
  }

  // The forum owner's own post, taken at an outbox door: written by the
  // category it addresses.
  async ownerPostFrom(activity, raw, receipt) {
    const [cat] = this.forum.route(activity);
    if (!cat) return 'an owner post names no category';
    const r = await cat.c2s.dispatch(activity, { raw, slug: receipt?.slug || null });
    return r.status < 300 ? undefined : `owner post refused (${r.status}: ${r.body?.error || ''})`;
  }
}

export class ForumAgent {
  // `remote` and `storageFor` are injectable so a test can stand a pod in.
  constructor({ home, log = () => {}, remote = null, storageFor = defaultStorageFor, push = true, pollSeconds = null }) {
    this.home = home;
    this.log = log;
    this.remote = remote;
    this.storageFor = storageFor;
    this.push = push;
    this.pollSeconds = pollSeconds;
    this.categories = [];
    this.viewer = true;
  }

  readCredential() {
    try { return JSON.parse(fs.readFileSync(path.join(this.home, 'credential.json'), 'utf8')); }
    catch { return null; }
  }

  status() {
    return {
      mode: !this.store ? 'unconfigured' : this.viewer ? 'viewer' : 'active',
      handle: this.config?.handle || null,
      actor: this.site?.actor || null,
      categories: this.categories.map(c => ({
        slug: c.slug, actor: c.urls.actor,
        members: c.store.getContacts().followers.length,
        topics: topics.list(c.store).length,
        queue: c.store.getQueue().length,
      })),
      inbox: this.intake?.inboxStats || null,
      lastDrain: this.intake?.lastDrain || null,
      push: this.intake?.wsState || 'n/a',
    };
  }

  // The first act on a fresh pod: the forum's containers, its config, and
  // nothing else — the actors are published on the first connect.
  async init({ handle, name, categories = [], moderators = [], approveJoins = false, review = false, replyPolicy = 'review' }) {
    const cred = this.readCredential();
    if (!cred) throw new Error('no credential.json — make one first');
    await this.attachRemote(cred);
    const site = forumUrls(cred.remotePod, cred.root || ROOT);
    await provisionForum(this.remote, site);
    const store = new PodStore({ log: this.log });
    store.attach(this.storageFor(site.state, (u, i) => this.remote.fetch(u, i)));
    await store.load().catch(() => {});
    const existing = store.getConfig() || {};
    const cats = categories.map(c => (typeof c === 'string' ? { slug: c, name: c } : c));
    for (const c of cats) if (!isSlug(c.slug)) throw new Error(`not a category slug: ${c.slug}`);
    // A renamed forum has to be published again: the profile is written only
    // when its digest changed or something asks, and a name lives in the
    // actor document, not in the config alone.
    const renamed = !!existing.handle && (name || handle) !== existing.name;
    store.setConfig({
      ...existing, kind: 'application', handle, name: name || existing.name || handle,
      ...(renamed ? { republish: true } : {}),
      remotePod: cred.remotePod, root: cred.root || ROOT,
      categories: cats, moderators, approveJoins, review, replyPolicy,
    });
    await store.flush();
    this.log(`forum ${handle} initialised with ${cats.length} categor${cats.length === 1 ? 'y' : 'ies'}`);
    return store.getConfig();
  }

  async attachRemote(cred) {
    if (this.remote) return;
    const { RemotePod } = await import('../../../lib/device/remote.mjs');
    this.remote = new RemotePod(cred, { log: this.log, home: this.home });
    await this.remote.warmup();
  }

  async connect({ act = true } = {}) {
    const cred = this.readCredential();
    if (!cred) return false;
    await this.attachRemote(cred);
    // The forum's config says whether it is fronted; the config is on the pod
    // at a place only the pod's own address names, so it is read first.
    const plain = forumUrls(cred.remotePod, cred.root || ROOT);
    this.store = new PodStore({ log: this.log });
    this.store.attach(this.storageFor(plain.state, (u, i) => this.remote.fetch(u, i)));
    await this.store.load();
    this.config = this.store.getConfig();
    if (!this.config) { this.log('credential present but the forum has no config — run init'); return false; }
    const front = this.config.gateway?.front || null;
    this.site = forumUrls(cred.remotePod, cred.root || ROOT, front ? { front, handle: this.config.handle } : {});
    this.lease = new Lease({ url: this.site.state + 'lease.json', fetchImpl: (u, i) => this.remote.fetch(u, i), log: this.log });
    this.viewer = act ? !(await this.lease.acquire()) : true;
    this.categories = [];
    for (const c of this.config.categories || []) this.categories.push(await this.buildCategory(c));
    this.siteAgent = await this.buildSite();
    // One map for every fronted id on this pod. Each Publisher installed its
    // own on construction, and the last would have been the only one; the
    // forum's covers the site and every category.
    if (this.site.toPod && this.remote.setUrlMap) this.remote.setUrlMap((u) => this.toPod(u));
    if (!act) return true;
    if (this.viewer) {
      this.startViewer();
      this.log(`another device hosts ${this.config.handle} — viewing`);
      return true;
    }
    await this.startActive();
    return true;
  }

  // Any advertised id on this pod, fronted or not, to where it is written.
  toPod(u) {
    if (typeof u !== 'string') return u;
    for (const cat of this.categories) { const m = cat.urls.toPod?.(u); if (m !== u) return m; }
    return this.site.toPod ? this.site.toPod(u) : u;
  }

  // One FediPod group per category, its config written from the forum's.
  async buildCategory({ slug, name, summary = null }) {
    const urls = this.site.category(slug);
    const store = new PodStore({ log: this.log });
    store.attach(this.storageFor(urls.state, (u, i) => this.remote.fetch(u, i)));
    await store.load().catch(() => {});
    const prior = store.getConfig() || {};
    const gw = this.config.gateway;
    const config = {
      ...prior,
      kind: 'group', handle: slug, name: name || slug, ...(summary ? { summary } : {}),
      remotePod: this.site.base, root: this.site.root + 'c/' + slug + '/',
      forum: this.site.actor, inboxUrl: this.site.inbox,
      moderators: this.config.moderators || [],
      approveJoins: !!this.config.approveJoins, review: !!this.config.review,
      // Fronted: the category's door at the Gateway, and its front id. The
      // secret is the row's own, handed over once at attach.
      ...(gw?.front ? { gateway: {
        url: `${gw.front}/u/${slug}/ap/inbox/`, frontActor: `${gw.front}/u/${slug}/ap/actor`,
        mode: gw.mode || 'trust', hmacSecret: gw.secrets?.[slug] || prior.gateway?.hmacSecret || null,
      } } : {}),
    };
    store.setConfig(config);
    const keys = await resolveKeys(store, { localDir: null, actorId: urls.actor, log: this.log });
    const cat = { slug, urls, store, config, remote: this.remote };
    cat.deliverer = new Deliverer({
      store, rsaPrivate: keys.rsaPrivate, keyId: urls.actor + '#main-key', actorId: urls.actor,
      edPrivate: keys.edPrivate, proofKeyId: assertionKeyId(urls), log: this.log, passive: true,
      onGone: () => cat.publisher.publishCollections({ followers: true }),
    });
    cat.publisher = new Publisher({
      config, remote: this.remote, store, deliverer: cat.deliverer,
      publicKeyPem: keys.rsaPublicPem, assertionKey: keys.edPublicMultibase, log: this.log,
      resolveMention: (h) => resolveHandle(cat, h),
      resolveActor: (u) => cat.intake.fetchAP(u),
      probeFetch: this.probeFetch || null,
    });
    cat.intake = new Intake({
      config, urls, remote: this.remote, store, deliverer: cat.deliverer, publisher: cat.publisher,
      log: this.log, lease: this.lease, push: false,
    });
    cat.intake.recentNotes = new Map();
    cat.intake.onCarried = (ev) => this.onCarried(cat, ev);
    cat.intake.isModerationAskExtra = (a) => moderation.isForumAsk(cat, a);
    cat.configured = () => true;
    cat.log = this.log;
    cat.c2s = new C2S({ agent: cat, log: this.log });
    return cat;
  }

  // The forum's own actor: an Application that answers for the site, whose
  // inbox is the one every category names. Its store is the forum's.
  async buildSite() {
    const { site, store } = this;
    const gw = this.config.gateway;
    const config = {
      ...this.config, kind: 'application', root: this.site.root, remotePod: this.site.base,
      ...(gw?.front ? { gateway: {
        url: `${gw.front}/u/${this.config.handle}/ap/inbox/`, frontActor: `${gw.front}/u/${this.config.handle}/ap/actor`,
        mode: gw.mode || 'trust', hmacSecret: gw.secrets?.[this.config.handle] || null,
      } } : {}),
    };
    const keys = await resolveKeys(store, { localDir: null, actorId: site.actor, log: this.log });
    const agent = { urls: site, store, config, remote: this.remote, log: this.log, configured: () => true };
    agent.deliverer = new Deliverer({
      store, rsaPrivate: keys.rsaPrivate, keyId: site.actor + '#main-key', actorId: site.actor,
      edPrivate: keys.edPrivate, proofKeyId: assertionKeyId(site), log: this.log, passive: true,
    });
    agent.publisher = new Publisher({
      config, remote: this.remote, store, deliverer: agent.deliverer,
      publicKeyPem: keys.rsaPublicPem, assertionKey: keys.edPublicMultibase, log: this.log,
      resolveActor: (u) => this.intake.fetchAP(u), probeFetch: this.probeFetch || null,
    });
    this.intake = new ForumIntake({
      config, urls: site, remote: this.remote, store, deliverer: agent.deliverer, publisher: agent.publisher,
      log: this.log, lease: this.lease, push: this.push, pollSeconds: this.pollSeconds,
      archive: this.storageFor(site.home + 'inbox-archive/', (u, i) => this.remote.fetch(u, i)),
      ownerPost: () => {},
    }, this);
    agent.intake = this.intake;
    return agent;
  }

  // Which categories an activity is for: the ones it names, in its
  // addressing or its object's, or whose topic it replies into. Pure
  // addressing; the category's own intake does the verifying.
  route(activity) {
    const ids = new Set();
    const add = (v) => { const id = idOf(v); if (id) ids.add(id); };
    const obj = activity?.object && typeof activity.object === 'object' ? activity.object : null;
    for (const f of ['to', 'cc', 'audience']) {
      arr(activity?.[f]).forEach(add);
      if (obj) arr(obj[f]).forEach(add);
    }
    add(activity?.object); add(activity?.target); add(activity?.origin);
    if (obj) { add(obj.context); add(obj.inReplyTo); add(obj.target); add(obj.object); }
    const out = [];
    for (const cat of this.categories) {
      const u = cat.urls;
      const mine = new Set([u.actor, u.followers, u.moderators, u.featured, u.topics, u.outbox]);
      let hit = [...ids].some(id => mine.has(id) || id.startsWith(u.topicContainer) || id.startsWith(u.notes));
      if (!hit && obj?.inReplyTo) hit = !!topics.topicOf(cat.store, idOf(obj.inReplyTo));
      if (hit) out.push(cat);
    }
    return out;
  }

  namesSite(activity) {
    const s = this.site;
    const ids = [activity?.object, activity?.target, ...arr(activity?.to), ...arr(activity?.cc)].map(idOf).filter(Boolean);
    return ids.some(id => id === s.actor || id === s.followers);
  }

  // After a category carried a post: place it in its topic, keep a copy for
  // readers, and publish what changed.
  async onCarried(cat, { noteId }) {
    let note = cat.intake.recentNotes.get(noteId) || null;
    cat.intake.recentNotes.delete(noteId);
    if (!note) note = await cat.intake.fetchAP(noteId);
    if (!note) { this.log(`carried ${noteId} but could not read it for the topic`); return; }
    const tid = await topics.assign({ store: cat.store, urls: cat.urls, fetchAP: (u) => cat.intake.fetchAP(u) }, note);
    // A locked topic takes no more: the post leaves it again and the carry is
    // unsaid, so members' servers do not keep what the forum does not.
    if (moderation.isLocked(cat, tid) && !topics.list(cat.store).find(t => t.tid === tid && t.op === noteId)) {
      topics.remove(cat.store, tid, noteId);
      await cat.intake.retract(noteId).catch(e => this.log(`retract ${noteId}: ${e.message}`));
      this.log(`${cat.slug}: ${noteId} not placed — topic ${tid} is locked`);
      return;
    }
    await publish.cachePost(cat, note);
    // The author's card, from the actor the intake already holds; fetched
    // once when it does not, so the website can name them.
    const author = idOf([].concat(note.attributedTo || [])[0]);
    if (author) {
      const held = cat.store.getActors?.()[author];
      const doc = held ? { id: author, ...held } : await cat.intake.fetchAP(author).catch(() => null);
      if (doc) await publish.cacheAuthor(cat, doc).catch(e => this.log(`author card for ${author}: ${e.message}`));
    }
    await publish.publishTopic(cat, tid);
    await publish.publishTopicIndex(cat);
    this.log(`${cat.slug}: ${noteId} in topic ${tid}`);
  }

  // Take addresses at a Gateway: one row for the forum and one per category,
  // each a handle at the front, all writing their mail into the forum's one
  // inbox. The pod session proves the pod; no password leaves this machine.
  // The secrets come back once and are kept in the forum's config; every
  // actor is republished with its front ids on the next start.
  async attach({ front, attachOne = null }) {
    const origin = String(front).replace(/\/$/u, '');
    const cred = this.readCredential();
    if (!cred || !this.store || !this.config) throw new Error('connect first');
    const plain = forumUrls(cred.remotePod, cred.root || ROOT);
    const post = attachOne || (async (body) => {
      const res = await this.remote.session.fetch(`${origin}/api/attach`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status !== 201 || !d.hmacSecret) throw new Error(`attach ${body.handle} at ${origin}: HTTP ${res.status}${d.error ? ' ' + d.error : ''}`);
      return d;
    });
    const secrets = {};
    const rows = [
      { handle: this.config.handle, podHome: plain.home, actorUrl: plain.actor, kind: 'application' },
      ...(this.config.categories || []).map(c => ({ handle: c.slug, podHome: plain.category(c.slug).home,
        actorUrl: plain.category(c.slug).actor, kind: 'group' })),
    ];
    for (const row of rows) {
      const d = await post({ ...row, fronted: true, inboxUrl: plain.inbox });
      secrets[row.handle] = String(d.hmacSecret);
      this.log(`attached @${row.handle}@${new URL(origin).host}`);
    }
    this.store.setConfig({ ...this.store.getConfig(), gateway: { front: origin, mode: 'trust', secrets }, republish: true });
    await this.store.flush();
    return { front: origin, handles: rows.map(r => r.handle) };
  }

  // A queued moderator's ask, applied by the operator.
  async applyModeration(slug, entryId) {
    const cat = this.categories.find(c => c.slug === slug);
    if (!cat) throw new Error(`no such category: ${slug}`);
    const q = cat.store.read('modqueue.json', []);
    const entry = q.find(e => e.id === entryId);
    if (!entry) throw new Error(`no such queue entry: ${entryId}`);
    const r = await moderation.applyForumModeration(this, cat, entry);
    cat.store.write('modqueue.json', cat.store.read('modqueue.json', []).filter(e => e.id !== entryId));
    return r;
  }

  // Publish every actor whose document is not yet up, and the forum's lists.
  async publishAll({ force = false } = {}) {
    if (this.config.republish) {
      force = true;
      this.store.setConfig({ ...this.store.getConfig(), republish: false });
      this.config = this.store.getConfig();
    }
    await provisionForum(this.remote, this.site);
    for (const cat of this.categories) {
      await provisionCategory(this.remote, cat.urls);
      const seen = cat.store.read('published.json', {});
      if (force || !seen.actorDigest) {
        await cat.publisher.publishProfile({ force });
        // The category's own inbox container exists because the group's
        // publisher made it; nothing drains it, so nobody may append to it.
        await podInbox.setPosture(this.remote, cat.urls, 'closed');
        await publish.publishTopicIndex(cat, { force: true });
        for (const t of topics.list(cat.store)) await publish.publishTopic(cat, t.tid, { force: true });
      }
    }
    const seen = this.store.read('published.json', {});
    if (force || !seen.actorDigest) await this.siteAgent.publisher.publishProfile({ force });
    await publish.publishCategories(this.siteAgent, this.categories.map(c => c.urls.actor), { force });
    await publish.publishAdministrators(this.siteAgent, this.config.moderators || [], { force });
  }

  async startActive() {
    this.viewer = false;
    clearInterval(this.refreshTimer);
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    for (const cat of this.categories) cat.deliverer.startQueue();
    this.siteAgent.deliverer.startQueue();
    await this.publishAll();
    await this.intake.start();
    await publish.publishHeartbeat(this.siteAgent).catch(e => this.log(`heartbeat: ${e.message}`));
    this.heartbeatTimer = setInterval(() => {
      publish.publishHeartbeat(this.siteAgent).catch(e => this.log(`heartbeat: ${e.message}`));
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    this.log(`hosting ${this.config.handle}: ${this.categories.map(c => '@' + c.slug).join(', ')}`);
  }

  // Watching: refresh what is held, and act the moment the lease frees.
  startViewer() {
    this.viewer = true;
    this.refreshTimer = setInterval(() => this.tryPromote().catch(e => this.log(`viewer: ${e.message}`)),
      Math.round(VIEWER_REFRESH_MS * (0.85 + Math.random() * 0.3)));
    this.refreshTimer.unref?.();
  }

  async tryPromote() {
    if (!this.viewer) return true;
    if (await this.lease.acquire()) {
      this.log('lease freed — this device now hosts the forum');
      await this.store.load({ force: true }).catch(() => {});
      for (const cat of this.categories) await cat.store.load({ force: true }).catch(() => {});
      await this.startActive();
      return true;
    }
    await this.store.load().catch(() => {});
    return false;
  }

  demote() {
    if (this.viewer) return;
    this.log('another device took the forum over — watching');
    this.intake?.stop();
    for (const cat of this.categories) cat.deliverer.stop();
    this.siteAgent?.deliverer.stop();
    clearInterval(this.heartbeatTimer);
    this.lease?.stopRenewal();
    this.startViewer();
  }

  async stop() {
    clearInterval(this.refreshTimer);
    clearInterval(this.heartbeatTimer);
    this.intake?.stop();
    for (const cat of this.categories) cat.deliverer.stop();
    this.siteAgent?.deliverer.stop();
    this.lease?.stopRenewal();
    await Promise.allSettled([
      this.store?.flush(), ...this.categories.map(c => c.store.flush()),
      this.viewer ? Promise.resolve() : this.lease?.release(),
    ]);
  }
}
