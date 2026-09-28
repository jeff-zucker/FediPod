// forum-agent.mjs — the forum's host: one process that runs a FediPod group
// agent for every category, drains the forum's one inbox and routes each
// activity to the category it names, places carried posts into topics, and
// holds one lease for the whole forum so several moderators' devices can
// share the job — whichever is up acts, the rest watch and take over.
//
// What is reused is the whole group: a category's store, publisher,
// deliverer and intake are FediPod's own, configured as a group. What is new
// is the routing, the topic placement, and the lifecycle around N of them.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { PodStore } from 'fedipod/core/store.mjs';
import { storageFor as defaultStorageFor } from 'fedipod/core/storage.mjs';
import { Deliverer } from 'fedipod/core/deliver.mjs';
import { Publisher } from 'fedipod/core/publisher/index.mjs';
import { Intake } from 'fedipod/core/intake/index.mjs';
import { C2S } from 'fedipod/client/c2s.mjs';
import { Lease } from 'fedipod/core/lease.mjs';
import { resolveKeys } from 'fedipod/core/keys.mjs';
import { assertionKeyId, orderedCollection } from 'fedipod/core/wire.mjs';
import * as podFeatured from 'fedipod/pod/featured.mjs';
import { resolveHandle } from 'fedipod/core/social.mjs';
import * as podInbox from 'fedipod/pod/inbox.mjs';
import { forumUrls, ROOT, isSlug } from './urls.mjs';
import * as topics from './topics.mjs';
import * as publish from './publish.mjs';
import * as moderation from './moderation.mjs';
import * as access from './access.mjs';
import { provisionForum, provisionCategory } from './provision.mjs';
import * as settings from './settings.mjs';
import { keepForum, restateForumRules } from './keep.mjs';
import { writeForumConfig, attachRows } from './setup.mjs';
import * as place from './place.mjs';

import { ForumIntake } from './forum-intake.mjs';
export { ForumIntake };

const idOf = (v) => (typeof v === 'string' ? v : v?.id);
const arr =(v) => (v === undefined || v === null ? [] : [].concat(v));
const HEARTBEAT_MS = 10 * 60_000;
// How often a moderator's ask is looked at again. Short enough that asking for
// something and watching it happen feels like one act.
const ASK_SWEEP_MS = 60_000;
const VIEWER_REFRESH_MS = 5 * 60_000;

export class ForumAgent {
  // `remote` and `storageFor` are injectable so a test can stand a pod in.
  // A host with no directory of its own — fedipod.net's door or its keeper —
  // hands in the credential, the lease and its holder id instead of files,
  // names the keeper the pod's rules must carry, reads keys and never mints
  // them, and defers every send to the run that follows.
  constructor({ home = null, log = () => {}, remote = null, storageFor = defaultStorageFor, push = true, pollSeconds = null,
    credential = null, lease = null, holderId = null, keepers = [], mintKeys = true, defer = false }) {
    this.home = home;
    this.log = log;
    this.remote = remote;
    this.storageFor = storageFor;
    this.push = push;
    this.pollSeconds = pollSeconds;
    this.credential = credential;
    this.givenLease = lease;
    this.holderId = holderId;
    this.keepers = keepers;
    this.mintKeys = mintKeys;
    this.defer = defer;
    this.categories = [];
    this.viewer = true;
  }

  // This installation's name for itself, minted once and kept beside the
  // credential. The lease lets a holder reclaim its own without waiting, so
  // whether this is stable decides whether a RESTART is the same host coming
  // back or a second one arriving: left to the lease's own default it was a
  // fresh name every time, the old lease still had minutes of its five to run,
  // and the forum came back up read-only — not draining its inbox, not applying
  // a moderator's ask — until it expired. Which is what a restart to pick up a
  // fix looked like from the outside: the fix changing nothing.
  hostId() {
    if (this.holderId) return this.holderId;
    if (!this.home) return null;
    const at = path.join(this.home, 'host-id');
    try { return fs.readFileSync(at, 'utf8').trim() || null; } catch { /* not yet */ }
    try {
      const made = crypto.randomUUID();
      fs.writeFileSync(at, made + '\n', { mode: 0o600 });
      return made;
    } catch {
      // Unwritable: a fresh name each time is honest, since this host cannot
      // prove it is the one that held the lease.
      return null;
    }
  }

  readCredential() {
    if (this.credential) return this.credential;
    if (!this.home) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.home, 'credential.json'), 'utf8')); }
    catch { return null; }
  }

  // The signing key of one actor, from its pod state. A host that may not
  // mint — the door, which must never invent an identity's key — refuses a
  // missing one instead.
  async keysFor(store, actorId) {
    if (!this.mintKeys && !store.read('keys.json', null)) throw new Error(`no signing key on the pod for ${actorId}`);
    return resolveKeys(store, { localDir: null, actorId, log: this.log });
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
  async init({ handle, name, categories = [], moderators = [], moderatorWebIds = [],
    membersOnly = [], memberWebIds = {}, approveJoins = false, review = false, replyPolicy = 'open' }) {
    const cred = this.readCredential();
    if (!cred) throw new Error('no credential.json — make one first');
    await this.attachRemote(cred);
    const { config } = await writeForumConfig(this.remote, this.storageFor, {
      remotePod: cred.remotePod, root: cred.root || ROOT, handle, name, categories, moderators, moderatorWebIds,
      membersOnly, memberWebIds, approveJoins, review, replyPolicy,
    }, { log: this.log });
    return config;
  }

  async attachRemote(cred) {
    if (!this.remote) {
      const { RemotePod } = await import('fedipod/remote');
      this.remote = new RemotePod(cred, { log: this.log, home: this.home });
      await this.remote.warmup();
    }
    // Every rule this host writes names the keeper beside the owner, and the
    // owner is the forum's, whoever holds the pen.
    if (this.keepers.length) {
      this.remote.keepers = [...this.keepers];
      this.remote.aclOwner = cred.webId || this.remote.aclOwner || null;
    }
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
    this.lease = this.givenLease || new Lease({ url: this.site.state + 'lease.json', fetchImpl: (u, i) => this.remote.fetch(u, i), log: this.log,
      id: this.hostId() });
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
    // A category with no front has no mapper; an address it does not map
    // stays itself. Returning nothing here made every address the same as
    // every other to a comparison of mapped addresses.
    for (const cat of this.categories) { const m = cat.urls.toPod?.(u); if (m != null && m !== u) return m; }
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
      // A private category NEVER carries to someone it cannot let read: every
      // join waits for a moderator, and admitting one requires a WebID the
      // pod can grant. Without this a follower on a server with no WebID —
      // Mastodon, Lemmy — would be sent the posts of a category whose pages
      // they are refused, which is not private at all.
      approveJoins: !!this.config.approveJoins || (this.config.membersOnly || []).includes(slug),
      // Private: the posts are written for the people named and nobody else,
      // so the category carries what is addressed to IT rather than to the
      // world. An ordinary group refuses that, and is right to.
      private: (this.config.membersOnly || []).includes(slug),
      review: !!this.config.review,
      // Fronted: the category's door at the Gateway, and its front id. The
      // secret is the row's own, handed over once at attach.
      ...(gw?.front ? { gateway: {
        url: `${gw.front}/u/${slug}/ap/inbox/`, frontActor: `${gw.front}/u/${slug}/ap/actor`,
        mode: gw.mode || 'trust', hmacSecret: gw.secrets?.[slug] || prior.gateway?.hmacSecret || null,
      } } : {}),
    };
    store.setConfig(config);
    const keys = await this.keysFor(store, urls.actor);
    const cat = { slug, urls, store, config, remote: this.remote };
    cat.deliverer = new Deliverer({
      store, rsaPrivate: keys.rsaPrivate, keyId: urls.actor + '#main-key', actorId: urls.actor,
      edPrivate: keys.edPrivate, proofKeyId: assertionKeyId(urls), log: this.log, passive: true, defer: this.defer,
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
    // A private category's posts sit behind their authors' own access rules,
    // and a Solid pod has never heard of an HTTP signature. So when the
    // ordinary fetch is refused, ask again as the forum's own WebID — the one
    // every member's rule names, and the reason the forum is on that list.
    const signedFetchAP = cat.intake.fetchAP.bind(cat.intake);
    cat.intake.fetchAP = async (url) => {
      const doc = await signedFetchAP(url);
      if (doc || !(this.config.membersOnly || []).includes(slug)) return doc;
      return this.podFetchAP(url);
    };
    cat.intake.onCarry = (ev) => this.onCarry(cat, ev);
    cat.intake.onReport = (activity, actor, opts) => cat.intake.queueModeration(activity, actor, opts);
    // What happens to a post from somebody who has not joined: dropped, or
    // held where a moderator will see it (the category's `replyPolicy`).
    cat.intake.onStranger = (ev) => this.onStranger(cat, ev);
    cat.intake.onCarriedEdit = (ev) => this.onCarriedEdit(cat, ev);
    cat.intake.onCarriedGone = (ev) => this.onCarriedGone(cat, ev);
    cat.intake.isModerationAskExtra = (a) => moderation.isForumAsk(cat, a);
    cat.configured = () => true;
    cat.log = this.log;
    cat.c2s = new C2S({ agent: cat, log: this.log });
    return cat;
  }

  // Who moderates, as the forum publishes it. A category writes its own list
  // when its profile is published; this is the forum's, which the website
  // reads, and nothing but a full publish used to rewrite it — so a moderator
  // added while the forum ran did not appear until it was next started.
  async republishAdministrators() {
    const mods = this.config.moderators || [];
    await publish.publishAdministrators(this.siteAgent, mods, { force: true });
    // Every category's list is the forum's, written now rather than at the
    // next start, and kept in the category's own settings so its queue and
    // its actor agree with it.
    for (const cat of this.categories) {
      cat.config.moderators = mods;
      cat.store.setConfig({ ...cat.store.getConfig(), moderators: mods });
      await podFeatured.writeModerators(this.remote, cat.urls, orderedCollection(cat.urls.moderators, mods))
        .catch(e => this.log(`moderators of ${cat.slug}: ${e.message}`));
    }
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
    const keys = await this.keysFor(store, site.actor);
    const agent = { urls: site, store, config, remote: this.remote, log: this.log, configured: () => true };
    agent.deliverer = new Deliverer({
      store, rsaPrivate: keys.rsaPrivate, keyId: site.actor + '#main-key', actorId: site.actor,
      edPrivate: keys.edPrivate, proofKeyId: assertionKeyId(site), log: this.log, passive: true, defer: this.defer,
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

  // Placing a post in its topic, and what an edit or a deletion does to the
  // place: place.mjs.
  onCarry(cat, ev) { return place.placePost(this, cat, ev); }
  onCarriedEdit(cat, ev) { return place.editPlaced(this, cat, ev); }
  onCarriedGone(cat, ev) { return place.dropPlaced(this, cat, ev); }
  countReplies(cat, tid, postId) { return place.countReplies(this, cat, tid, postId); }
  noteLatest(cat, note) { return place.noteLatest(this, cat, note); }
  dropLatest(cat, noteId) { return place.dropLatest(this, cat, noteId); }

  // One delivery, handed in by whoever took it at the forum's door, done the
  // way the drain does one item: handled, every store committed, and only
  // then reported done — so the caller may remove it from the inbox.
  async placeOne(name, body, receipt = null) {
    const done = await this.intake.takeHeld([{ name, body, receipt }]);
    return done.includes(name);
  }

  // Letting a Gateway keep this forum, and taking that back: keep.mjs.
  keep(o) { return keepForum(this, o); }
  restateRules() { return restateForumRules(this); }

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
    // A test hands in the attach itself; otherwise the pod session proves the owner.
    const f = attachOne
      ? async (_url, init) => { const d = await attachOne(JSON.parse(init.body)); return { status: 201, json: async () => d }; }
      : (u, i) => this.remote.session.fetch(u, i);
    const { gateway, handles } = await attachRows({ fetch: f, front: origin, config: this.config, plain }, { log: this.log });
    this.store.setConfig({ ...this.store.getConfig(), gateway, republish: true });
    await this.store.flush();
    return { front: origin, handles };
  }

  // One category's handle at the Gateway, claimed when a moderator creates
  // that category from the settings page and at no other time. A name on a
  // Gateway is public and only its admin can take one back, so nothing here
  // claims names on its own account — not at a start, not on a repair, not
  // for a category that arrived any other way.
  async claimHandle(slug) {
    const gw = this.config.gateway;
    if (!gw?.front) return null;                       // not fronted: nothing to claim
    if (gw.secrets?.[slug]) return null;               // already has one
    const cred = this.readCredential();
    const plain = forumUrls(cred.remotePod, cred.root || ROOT);
    const urls = plain.category(slug);
    const origin = String(gw.front).replace(/\/$/u, '');
    const res = await this.remote.session.fetch(`${origin}/api/attach`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: slug, podHome: urls.home, actorUrl: urls.actor, kind: 'group',
        fronted: true, inboxUrl: plain.inbox }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status !== 201 || !d.hmacSecret) {
      // A name already taken, or a Gateway that refuses: the category is
      // hosted all the same, with no handle until someone sorts it out.
      this.log(`no handle for @${slug}: HTTP ${res.status}${d.error ? ' ' + d.error : ''}`);
      return null;
    }
    const cfg = this.store.getConfig();
    this.store.setConfig({ ...cfg, gateway: { ...cfg.gateway, secrets: { ...(cfg.gateway?.secrets || {}), [slug]: String(d.hmacSecret) } }, republish: true });
    this.config = this.store.getConfig();
    await this.store.flush().catch(() => {});
    this.log(`claimed @${slug}@${new URL(origin).host}`);
    return slug;
  }

  // A queued moderator's ask, applied by the operator.
  // Topics written into a sub-folder before they were flat: read each one at
  // its old address and put it where the state can see it.
  async carryOldTopics(cat) {
    for (const t of topics.list(cat.store)) {
      if (topics.get(cat.store, t.tid)) continue;
      const old = await this.remote.getJson(cat.urls.state + topics.topicDocOld(t.tid)).catch(() => null);
      if (!old) continue;
      cat.store.write(topics.topicDoc(t.tid), old);
      this.log(`topic ${t.tid} carried into the state`);
    }
    await cat.store.flush().catch(() => {});
  }

  // Queued asks from listed moderators that can be verified at their own
  // origin are applied; everything else waits for a person.
  async applyVerifiedAsks() {
    await this.applySettingsAsks().catch(e => this.log(`settings: ${e.message}`));
    for (const cat of this.categories) {
      const q = cat.store.read('modqueue.json', []);
      for (const entry of [...q]) {
        if (!(this.config.moderators || []).includes(entry.moderator)) continue;
        const id = entry.activity?.id;
        if (typeof id !== 'string') continue;
        if (!cat.intake.sameIdentity(id, entry.moderator)) continue;
        const doc = await cat.intake.fetchAP(id).catch(() => null);
        if (!doc || doc.type !== entry.type) continue;
        if (idOf(doc.actor) !== entry.moderator) continue;
        try {
          // Apply the copy fetched at its origin, not the one delivered: the
          // queue keeps a trimmed activity — enough to say what was asked for,
          // not enough to carry a new name — and the origin's copy is the one
          // its author actually published.
          const q2 = cat.store.read('modqueue.json', []);
          const i = q2.findIndex(x => x.id === entry.id);
          if (i >= 0) { q2[i] = { ...q2[i], activity: doc, verified: true }; cat.store.write('modqueue.json', q2); }
          await this.applyModeration(cat.slug, entry.id);
          this.log(`applied ${entry.type} from ${entry.moderator}`);
        } catch (e) {
          this.log(`ask ${entry.id}: ${e.message}`);
          // It stays in the queue and carries why it did not take, so a
          // moderator sees an ask that failed rather than one that silently
          // did nothing. The next sweep tries it again.
          const q3 = cat.store.read('modqueue.json', []);
          const j = q3.findIndex(x => x.id === entry.id);
          if (j >= 0) {
            q3[j] = { ...q3[j], failed: e.message, failedAt: new Date().toISOString() };
            cat.store.write('modqueue.json', q3);
          }
        }
      }
    }
  }

  membersOf(cat) { return access.membersOf(this, cat); }
  readersOf(cat) { return access.readersOf(this, cat); }
  podFetchAP(url) { return access.podFetchAP(this, url); }
  dropUnreadableFollowers(cat) { return access.dropUnreadableFollowers(this, cat); }

  // A pin that holds across the whole forum, not just one category: the site
  // actor has a featured collection of its own, and this is it.
  async sitePin(topicId, on) {
    const { orderedCollection } = await import('fedipod/core/wire.mjs');
    const collection = await import('fedipod/pod/collection.mjs');
    const held = this.store.read('sitepins.json', []).filter(id => id !== topicId);
    const ids = on ? [topicId, ...held] : held;
    this.store.write('sitepins.json', ids);
    await collection.writeFlat(this.remote, this.site.featured,
      orderedCollection(this.site.featured, ids), { publicRead: true });
    return { pinned: ids };
  }

  // A post from someone who is not a member. 'members' drops it, which is
  // what a group does; 'review' holds it for a moderator, which is what a
  // forum usually wants; 'open' is not offered — a forum that carries
  // anything addressed to it is a forum for spam.
  async onStranger(cat, { noteId, actor, activity }) {
    const how = this.config.replyPolicy || 'open';
    // A private category's membership IS the right to read it, and only a
    // moderator gives that; a forum set to review holds a stranger either way.
    const closed = (this.config.membersOnly || []).includes(cat.slug);
    const hold = () => {
      cat.intake.queueModeration(
        { type: 'Create', actor, object: noteId, ...(activity?.id ? { id: activity.id } : {}) },
        actor, { trusted: false },
      );
      return true;
    };
    if (how === 'review' || closed) return hold();
    return (await this.joinOnPost(cat, actor)) ? false : hold();
  }

  // Posting into an open category joins it, which is what the website's own
  // posting does before it posts: a post from elsewhere arrives with no Follow
  // in front of it, and holding it for a moderator made every first post from
  // another server wait. There is nothing to Accept — no Follow was sent — so
  // the member is recorded and the category is published again.
  async joinOnPost(cat, actor) {
    try {
      const contacts = cat.store.getContacts();
      if (contacts.followers.some(f => f.actor === actor)) return true;
      const doc = await cat.intake.fetchAP(actor);
      if (!doc?.inbox) { this.log(`${actor} posted but its actor names no inbox — held instead`); return false; }
      contacts.followers.push({ actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox });
      cat.store.setContacts(contacts);
      cat.store.addNotification({ type: 'follow', actor });
      await cat.intake.republish({ followers: true });
      this.log(`joined by posting: ${actor} → @${cat.slug}`);
      return true;
    } catch (e) {
      this.log(`could not join ${actor} on posting (${e.message}) — held instead`);
      return false;
    }
  }

  // Requests about the forum itself: a category created, a name changed, who
  // moderates, who may read. Checked at the asker's own pod exactly as a
  // moderator's other asks are, then applied.
  async applySettingsAsks() {
    const q = this.store.read('modqueue.json', []);
    for (const entry of [...q]) {
      if (!(this.config.moderators || []).includes(entry.moderator)) continue;
      const id = entry.activity?.id;
      if (typeof id !== 'string' || !this.intake.sameIdentity(id, entry.moderator)) continue;
      const doc = await this.intake.fetchAP(id).catch(() => null);
      if (!doc || doc.type !== entry.type || idOf(doc.actor) !== entry.moderator) continue;
      try {
        const done = await settings.applySettings(this, doc);
        // The one place a name is claimed: a moderator asked for this
        // category by name a moment ago.
        if (done.category && doc.type === 'Create') {
          await this.claimHandle(done.category).catch(e => this.log(`handle for ${done.category}: ${e.message}`));
        }
        this.store.write('modqueue.json', this.store.read('modqueue.json', []).filter(e => e.id !== entry.id));
        await this.store.flush().catch(() => {});
        await this.noteModLog({ ...entry, activity: doc }, done);
        this.log(`applied ${entry.type} from ${entry.moderator}: ${JSON.stringify(done)}`);
        // A forum that has just changed shape publishes itself again.
        if (Object.keys(done).length) await this.reshape();
      } catch (e) { this.log(`settings ask ${entry.id}: ${e.message}`); }
    }
  }

  // What a change of shape needs: any category named in the config that is
  // not being hosted yet is built, and everything is published again.
  async reshape() {
    for (const c of this.config.categories || []) {
      if (this.categories.some(x => x.slug === c.slug)) continue;
      const cat = await this.buildCategory(c);
      this.categories.push(cat);
      this.log(`category added: ${c.slug}`);
    }
    if (this.site.toPod && this.remote.setUrlMap) this.remote.setUrlMap((u) => this.toPod(u));
    await this.publishAll().catch(e => this.log(`after a change of shape: ${e.message}`));
  }

  // The WebID behind a Fediverse actor, when its pod says so. A FediPod
  // account's WebID lists the actor as an account of the person; that link,
  // read at the pod, is what makes it safe to grant them anything.
  async webIdOf(actor) {
    const doc = await this.intake.fetchAP(actor).catch(() => null);
    const said = [doc?.webId, ...[].concat(doc?.alsoKnownAs || [])].find(v => typeof v === 'string' && v.includes('#'));
    if (said) return said;
    // Otherwise the pod the actor is published on, whose card is where a
    // FediPod account records itself.
    const home = new URL(actor).origin;
    for (const card of [`${home}/profile/card`, `${home}/profile/card#me`]) {
      const r = await fetch(card.replace(/#me$/u, ''), { headers: { accept: 'text/turtle' } }).catch(() => null);
      if (!r?.ok) continue;
      const text = await r.text().catch(() => '');
      if (text.includes(actor)) return `${home}/profile/card#me`;
    }
    return null;
  }

  // The moderators' queue, written where only they can read it: what each
  // category is holding, and who asked for what.
  // What was done, and by whom: a record for the moderators, beside their
  // queue and under the same rule.
  async noteModLog(entry, outcome) {
    const log = this.store.read('modlog.json', []);
    log.unshift({
      at: new Date().toISOString(), type: entry.type, by: entry.moderator,
      object: typeof entry.activity?.object === 'string' ? entry.activity.object : entry.activity?.object?.id || null,
      outcome: outcome && typeof outcome === 'object' ? Object.keys(outcome).join(',') : String(outcome ?? ''),
    });
    this.store.write('modlog.json', log.slice(0, 500));
    await this.remote.putJson(this.site.mod + 'log.json', { at: new Date().toISOString(), rows: log.slice(0, 500) }, 'application/json')
      .catch(e => this.log(`mod log: ${e.message}`));
  }

  async publishModQueue() {
    // The rule follows the configuration: moderators come and go, and the
    // container was provisioned once, long before this one was named. Stated
    // when the moderators change, and read rather than rewritten at start.
    const mods = publish.digestOf(this.config.moderatorWebIds || []);
    if (this._modRule !== mods) {
      await this.remote.setAcl(this.site.mod, [], { readAgents: this.config.moderatorWebIds || [], ifChanged: true })
        .catch(e => this.log(`queue rule: ${e.message}`));
      this._modRule = mods;
    }
    const rows = [];
    for (const cat of this.categories) {
      for (const e of cat.store.read('modqueue.json', [])) {
        const object = typeof e.activity?.object === 'string' ? e.activity.object : e.activity?.object?.id || null;
        // Who wrote the thing being complained about, so a moderator acting
        // on a report acts on its author and not on whoever reported it.
        const about = object ? (cat.store.getStatuses().find(st => st.noteId === object)?.actor || null) : null;
        rows.push({ category: cat.slug, id: e.id, type: e.type, by: e.moderator, at: e.at,
          object, about, why: e.activity?.content || null, verified: !!e.verified,
          ...(e.failed ? { failed: e.failed, failedAt: e.failedAt || null } : {}) });
      }
      for (const r of cat.store.getRequests?.() || []) {
        rows.push({ category: cat.slug, id: 'join:' + r.actor, type: 'Join request', by: r.actor, at: r.at || null, object: r.actor });
      }
      for (const p of cat.store.getPending?.() || []) {
        rows.push({ category: cat.slug, id: 'pending:' + p.noteId, type: 'Held', by: p.actor || null, at: p.at || null, object: p.noteId });
      }
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    // Swept every minute, and on a quiet forum every sweep found the same
    // rows: the timestamp alone made each one a write. The rows decide.
    const digest = publish.digestOf(rows);
    if (this._modQueue === digest) return rows.length;
    await this.remote.putJson(this.site.mod + 'queue.json',
      { at: new Date().toISOString(), rows }, 'application/json');
    this._modQueue = digest;
    return rows.length;
  }

  // One vote per person per post, either way. Up is AS2's `likes` on the
  // post's copy, which the website reads with the post. Down has no property
  // in AS2 and none is invented for it: it is published as a collection of
  // its own beside the copy, named for the post it counts.
  //
  // A record written before there were downvotes is a bare list of who voted
  // for the post; it is read as the up list and written back in both parts.
  async countVote({ post, actor, way }) {
    if (!post || !actor) return false;
    const cat = this.categories.find(c => !!topics.topicOf(c.store, post));
    if (!cat) return false;
    const votes = cat.store.read('votes.json', {});
    const was = votes[post];
    const up = new Set(Array.isArray(was) ? was : (was?.up || []));
    const down = new Set(Array.isArray(was) ? [] : (was?.down || []));
    // Changing your mind is not two votes: whichever way it goes now, the
    // other way lets go of you.
    up.delete(actor);
    down.delete(actor);
    if (way === 'up') up.add(actor);
    if (way === 'down') down.add(actor);
    votes[post] = { up: [...up], down: [...down] };
    cat.store.write('votes.json', votes);
    const copy = await this.remote.getJson(cat.urls.cached(post)).catch(() => null);
    if (copy && copy.type !== 'Tombstone') {
      await publish.cachePost(cat, copy, { likes: up.size, dislikes: down.size });
      await publish.publishDislikes(cat, post, down.size).catch(e => this.log(`downvotes on ${post}: ${e.message}`));
      await publish.publishLatest(this.siteAgent).catch(() => {});
    }
    this.log(`${way === 'none' ? 'vote withdrawn' : `vote ${way}`} on ${post} — ${up.size} up, ${down.size} down`);
    return true;
  }

  // Everything the forum already holds, read back out of the topics, for an
  // index that did not exist when those posts arrived.
  // Copies kept before the forum recorded which topic they were in: the
  // topic knows, so the copy is rewritten from it.
  async stampOldCopies(cat) {
    for (const entry of topics.list(cat.store)) {
      const doc = topics.get(cat.store, entry.tid);
      for (const p of doc?.posts || []) {
        const url = cat.urls.cached(p.id);
        const copy = await this.remote.getJson(url).catch(() => null);
        if (!copy || copy.type === 'Tombstone') continue;
        const answers = (doc?.posts || []).filter(x => x.inReplyTo === p.id).length;
        if (copy.context && Number(copy.replies?.totalItems) === answers) continue;
        await publish.cachePost(cat, copy, { topic: cat.urls.topic(entry.tid), replies: answers });
        this.log(`${p.id}: its topic and its answers recorded`);
      }
    }
  }

  rebuildLatest() {
    const rows = [];
    for (const cat of this.categories) {
      for (const entry of topics.list(cat.store)) {
        const doc = topics.get(cat.store, entry.tid);
        for (const p of doc?.posts || []) rows.push({ copy: cat.urls.cached(p.id), at: p.published || entry.created || '' });
      }
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    this.store.write('latest.json', rows.slice(0, publish.LATEST_MAX));
    return rows.length;
  }

  async applyModeration(slug, entryId) {
    const cat = this.categories.find(c => c.slug === slug);
    if (!cat) throw new Error(`no such category: ${slug}`);
    const q = cat.store.read('modqueue.json', []);
    const entry = q.find(e => e.id === entryId);
    if (!entry) throw new Error(`no such queue entry: ${entryId}`);
    const r = await moderation.applyForumModeration(this, cat, entry);
    cat.store.write('modqueue.json', cat.store.read('modqueue.json', []).filter(e => e.id !== entryId));
    await this.noteModLog(entry, r);
    await this.publishModQueue().catch(e => this.log(`queue: ${e.message}`));
    return r;
  }

  // Publish every actor whose document is not yet up, and the forum's lists.
  async publishAll({ force = false } = {}) {
    // Cleared at the END, not here: a publish that dies part-way used to lower
    // the flag on its way in, so the next start thought the work was done and
    // the forum kept the name and ids it was told to replace.
    const asked = !!this.config.republish;
    if (asked) force = true;
    // Containers and their rules are rewritten only when who may read what
    // has changed. A republish otherwise leaves them alone: rewriting dozens
    // of rules on every attempt is what a rate-limited pod refuses, and a
    // refusal used to mean the request was never cleared and never finished.
    const redo = !!this.config.reprovision;
    // Containers and their access rules are written once, not on every start:
    // a forum that re-wrote them each time it came up spent dozens of pod
    // writes saying what the pod already said, and a busy pod answered 429.
    const made = this.store.read('provisioned.json', {});
    if (redo || !made.forum) {
      await provisionForum(this.remote, this.site, { moderatorWebIds: this.config.moderatorWebIds || [] });
      this.store.write('provisioned.json', { ...made, forum: new Date().toISOString() });
    }
    for (const cat of this.categories) {
      const done = this.store.read('provisioned.json', {});
      if (redo || !done[cat.slug]) {
        await provisionCategory(this.remote, cat.urls, { memberWebIds: this.membersOf(cat) });
        this.store.write('provisioned.json', { ...done, [cat.slug]: new Date().toISOString() });
      }
      // Who the category's posts are written for, and letting go of anyone it
      // cannot let read. Both are cheap when nothing changed: the list is
      // written only when its digest moved, and the sweep only for a private
      // category.
      await publish.publishMembers(cat, this.readersOf(cat), { force: redo })
        .catch(e => this.log(`the reader list for ${cat.slug}: ${e.message}`));
      await this.dropUnreadableFollowers(cat)
        .catch(e => this.log(`letting go of ${cat.slug}'s strangers: ${e.message}`));
      // Two passes over what older versions wrote, made once and recorded
      // (upkeep.json): each reads every topic or every copy, which is no way
      // to begin every start.
      const upkeep = cat.store.read('upkeep.json', {});
      if (!upkeep.oldTopicsCarried) {
        await this.carryOldTopics(cat);
        cat.store.write('upkeep.json', { ...cat.store.read('upkeep.json', {}), oldTopicsCarried: new Date().toISOString() });
      }
      if (!upkeep.copiesStamped) {
        try {
          await this.stampOldCopies(cat);
          cat.store.write('upkeep.json', { ...cat.store.read('upkeep.json', {}), copiesStamped: new Date().toISOString() });
        } catch (e) { this.log(`stamping ${cat.slug}: ${e.message}`); }
      }
      const seen = cat.store.read('published.json', {});
      if (force || !seen.actorDigest) {
        await cat.publisher.publishProfile({ force });
        // The category's own inbox container exists because the group's
        // publisher made it; nothing drains it, so nobody may append to it.
        await podInbox.setPosture(this.remote, cat.urls, 'closed');
        // The profile publish above wrote the category's featured list as its
        // pinned posts, of which a forum has none: the pinned topics go back.
        await publish.publishPinnedTopics(cat);
        await publish.publishTopicIndex(cat, { force: true });
        for (const t of topics.list(cat.store)) {
          // A topic the state cannot produce must not stop the forum coming
          // up: say so and publish the rest.
          if (!topics.get(cat.store, t.tid)) { this.log(`topic ${t.tid} has no record — skipped`); continue; }
          await publish.publishTopic(cat, t.tid, { force: true });
        }
      }
    }
    // A reprovision states every rule again, the forum's flat lists' among
    // them. Their rule is written with their first publish, so the record of
    // that publish is forgotten here and the publish below writes it.
    if (redo) this.store.write('published.json', { ...this.store.read('published.json', {}), categories: null, latest: null, administrators: null });
    const seen = this.store.read('published.json', {});
    if (force || !seen.actorDigest) await this.siteAgent.publisher.publishProfile({ force });
    await publish.publishCategories(this.siteAgent, this.categories.map(c => c.urls.actor), { force });
    if (!this.store.read('latest.json', []).length) {
      const n = this.rebuildLatest();
      if (n) this.log(`latest: ${n} post(s) read back out of the topics`);
    }
    await publish.publishLatest(this.siteAgent, { force });
    await publish.publishAdministrators(this.siteAgent, this.config.moderators || [], { force });
    if (asked) {
      this.store.setConfig({ ...this.store.getConfig(), republish: false, reprovision: false });
      this.config = this.store.getConfig();
      await this.store.flush().catch(() => {});
    }
  }

  async startActive() {
    this.viewer = false;
    clearInterval(this.refreshTimer);
    this.lease.onLost = () => this.demote();
    this.lease.startRenewal();
    for (const cat of this.categories) cat.deliverer.startQueue();
    this.siteAgent.deliverer.startQueue();
    await this.publishAll();
    this.intake.afterDrain = () => this.applyVerifiedAsks()
      .then(() => this.publishModQueue())
      .catch(e => this.log(`asks: ${e.message}`));
    await this.intake.start();
    await publish.publishHeartbeat(this.siteAgent).catch(e => this.log(`heartbeat: ${e.message}`));
    this.heartbeatTimer = setInterval(() => {
      publish.publishHeartbeat(this.siteAgent).catch(e => this.log(`heartbeat: ${e.message}`));
    }, HEARTBEAT_MS);
    // An ask is checked at its asker's pod before it is acted on, and that
    // check used to happen only when the inbox was drained. A moderator asking
    // for something on a quiet forum therefore waited for the next person to
    // post — and if the document was a moment from being readable when the ask
    // arrived, it waited for the one after that. So it is swept on its own
    // clock as well.
    this.asksTimer = setInterval(() => {
      this.applyVerifiedAsks()
        .then(() => this.publishModQueue())
        .catch(e => this.log(`asks: ${e.message}`));
    }, ASK_SWEEP_MS);
    this.asksTimer.unref?.();
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
      try {
        await this.startActive();
      } catch (e) {
        // A promotion that dies part-way left the forum neither hosting nor
        // watching: the timer was cleared on the way in and the lease was
        // held by a device doing nothing. Give both back.
        this.log(`could not start hosting (${e.message}) — watching again`);
        for (let i = 0; i < 4; i++) {
          try { await this.lease.release(); break; } catch { await new Promise(r => setTimeout(r, 8000)); }
        }
        this.startViewer();
        return false;
      }
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
    clearInterval(this.asksTimer);
    this.lease?.stopRenewal();
    this.startViewer();
  }

  async stop() {
    clearInterval(this.refreshTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.asksTimer);
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
