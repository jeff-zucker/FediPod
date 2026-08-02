// store.mjs — PodStore: the agent's operational state as JSON documents in a
// container. The container is a Storage (lib/storage.mjs) — a pod over HTTP or
// a directory — and this file does not care which. The sync read/write surface
// of dk's fs Store is preserved so every consumer (publisher, intake, facade,
// …) is unchanged: reads come from an in-memory cache loaded once at boot,
// writes update the cache and are flushed through a serialized, debounced,
// retrying queue. Everything here is rebuildable from the /fediverse/ RDF, so
// a lost write degrades, it doesn't destroy. Without a storage the store is
// pure memory (tests, unconfigured boot).

import crypto from 'node:crypto';

const PUT_DEBOUNCE_MS = 300;
const PUT_RETRIES = 5;

// Removing a follower is a DECISION — they unfollowed, or were ejected, or the
// account is gone. Reconciling the local list against the pod's published one
// would otherwise bring every one of them back, so each removal leaves a mark.
// Bounded: the same actor leaving twice is still one entry.
export function dropFollower(contacts, actor, why) {
  contacts.followers = contacts.followers.filter(f => f.actor !== actor);
  const gone = (contacts.removedFollowers || []).filter(r => r.actor !== actor);
  gone.push({ actor, why, at: new Date().toISOString() });
  contacts.removedFollowers = gone.slice(-500);
  return contacts;
}

export class PodStore {
  constructor({ storage = null, log = console.log } = {}) {
    this.storage = storage;
    this.log = log;
    this.cache = new Map();        // name → parsed value
    this.etags = new Map();        // name (or '') → last ETag, for revalidation
    this.timers = new Map();       // name → debounce timer
    this.chain = Promise.resolve();  // serialized writes
  }

  get base() { return this.storage?.base || null; }

  attach(storage) {
    // A different tree is different state: carrying the old cache and its
    // ETags across would serve one container's documents as another's.
    if (this.storage && this.storage.base !== storage.base) { this.cache.clear(); this.etags.clear(); }
    this.storage = storage;
  }

  // Load every state doc in the container into the cache. Missing container
  // (first run) is fine — the cache just starts empty.
  // Throws when the container cannot be read. An empty cache MUST mean "no
  // state yet", never "the pod was unreachable" — the caller treats the
  // former as a fresh install, and silently conflating them would look like
  // an un-set-up agent every time the pod hiccups.
  async load() {
    if (!this.storage) return;
    // Revalidate rather than re-download: a viewer reloads this every minute
    // and it is almost always unchanged. 304 means both the listing and every
    // doc we already hold are current. (Only a pod answers that; a directory
    // has nothing to revalidate against, so it always relists — which is a
    // readdir, not a request.)
    const listing = await this.storage.list('', { etag: this.etags.get('') });
    if (listing.notModified) return;
    this.etags.set('', listing.etag);
    const names = listing.names.filter(n => n.endsWith('.json'));
    let fetched = 0;
    const skipped = [];
    for (const name of names) {
      const etag = this.etags.get(name);
      const r = await this.storage.read(name, { etag: etag && this.cache.has(name) ? etag : null });
      if (r.notModified) continue;                        // ours is current
      if (!r.ok) {
        // One unreadable document must not restart the whole sweep — skip it,
        // keep whatever we already hold, and try again next load (no etag is
        // recorded, so the retry is unconditional). config.json is the
        // exception: without it the caller cannot tell "never set up" from
        // "could not read", and would tell the user to run setup.
        if (name === 'config.json' && !this.cache.has(name)) {
          throw new Error(`state doc ${name} unreadable (HTTP ${r.status})`);
        }
        skipped.push(`${name} (HTTP ${r.status})`);
        continue;
      }
      fetched++;
      this.etags.set(name, r.etag);
      try { this.cache.set(name, JSON.parse(r.body)); }
      catch (e) { this.log(`state load ${name}: unparsable (${e.message})`); }
    }
    if (skipped.length) this.log(`state load skipped ${skipped.length}: ${skipped.join(', ')}`);
    this.log(`state loaded: ${this.cache.size} doc(s) from ${this.base} (${fetched} re-fetched)`);
  }

  has(name) { return this.cache.has(name); }

  read(name, fallback) {
    return this.cache.has(name) ? structuredClone(this.cache.get(name)) : fallback;
  }

  write(name, obj) {
    this.cache.set(name, structuredClone(obj));
    if (!this.storage) return;
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); this._put(name); }, PUT_DEBOUNCE_MS));
    this.timers.get(name).unref?.();
  }

  // Resolves true when the document is on the pod, false when it is not — a
  // caller that is about to destroy the only other copy of something needs to
  // be able to tell. `chain` stays the bare serializer; the boolean rides on
  // the returned promise so one failure cannot poison the queue.
  _put(name) {
    const done = this.chain.then(async () => {
      const body = JSON.stringify(this.cache.get(name), null, 2) + '\n';
      for (let attempt = 1; attempt <= PUT_RETRIES; attempt++) {
        // A storage that throws is a bug, not a hiccup — but it must not
        // escape into the write queue, where it would look like success.
        const r = await this.storage.write(name, body, 'application/json')
          .catch(e => ({ ok: false, retry: false, why: e.message }));
        if (r.ok) return true;
        // The storage says whether trying again could possibly help: a pod's
        // 4xx is an answer rather than a hiccup, and a directory's EACCES will
        // still be an EACCES in two seconds.
        if (!r.retry) { this.log(`state write ${name} refused (${r.why}) — not retrying`); return false; }
        if (attempt === PUT_RETRIES) { this.log(`state write ${name} gave up: ${r.why}`); return false; }
        const ladder = Math.min(attempt * 2000, 30_000);
        await new Promise(res => setTimeout(res, r.retryAfterMs || Math.round(ladder * (0.8 + Math.random() * 0.4))));
      }
      return false;
    });
    this.chain = done.catch(() => {});
    return done;
  }

  // Remove a state doc from the cache AND the pod (used when key material
  // migrates to the local machine — leaving the copy behind would defeat it).
  async remove(name) {
    this.cache.delete(name);
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    if (!this.storage) return true;
    return this.storage.remove(name);
  }

  // Force every pending write out NOW and say whether they all landed.
  // The caller that needs this is the inbox drain: taking an item out of the
  // pod's inbox is a destructive read, so it must not happen until the result
  // of handling it is written down. With no storage the store is pure memory
  // and there is nothing to land, so that counts as written.
  async commit() {
    const pending = [];
    for (const [name, t] of this.timers) {
      clearTimeout(t);
      this.timers.delete(name);
      pending.push(this._put(name));
    }
    await this.chain;                      // includes anything already in flight
    const results = await Promise.all(pending);
    return results.every(Boolean);
  }

  // Flush pending debounced writes (shutdown path). Same work, result ignored.
  async flush() { await this.commit(); }

  // ---- the domain helpers, unchanged from dk's Store ----

  // config: { remotePod, handle, name, issuer }  (credential lives ONLY in
  // the local credential file, never in pod state)
  getConfig() { return this.read('config.json', null); }
  setConfig(cfg) { this.write('config.json', cfg); }

  // queue: [{ inbox, activity, attempts, nextAt }]
  getQueue() { return this.read('queue.json', []); }
  setQueue(q) { this.write('queue.json', q); }

  // blocklist: { domains: ["spam.example", ...], actors: ["https://host/actor", ...] }
  // Two granularities because a whole instance is usually the wrong unit: one
  // bad neighbour should not cost you everyone else on their server.
  getBlocklist() {
    const b = this.read('blocklist.json', {});
    return { domains: b.domains || [], actors: b.actors || [] };
  }
  setBlocklist(b) { this.write('blocklist.json', b); }
  // Takes an actor URL or an object URL: the actor list only ever matches the
  // former, the domain list matches either.
  isBlocked(url) {
    let host;
    try { host = new URL(url).hostname; } catch { return true; }   // unparsable → treat as hostile
    const { domains, actors } = this.getBlocklist();
    if (actors.includes(url)) return true;
    return domains.some(d => host === d || host.endsWith('.' + d));
  }

  // contacts: { followers: [{actor, inbox, sharedInbox}], following: [{actor, inbox, accepted}] }
  getContacts() { return this.read('contacts.json', { followers: [], following: [] }); }
  setContacts(c) { this.write('contacts.json', c); }

  // muted: { actors: [...] } — members whose posts a group declines to carry.
  // A group cannot force an unfollow, so declining to amplify is the only
  // lever it actually holds.
  getMuted() { return this.read('muted.json', { actors: [] }); }
  setMuted(m) { this.write('muted.json', m); }

  // pending: [{ noteId, actor, at }] — posts a reviewed group has ingested but
  // not carried, awaiting the operator.
  getPending() { return this.read('pending.json', []); }
  setPending(p) { this.write('pending.json', p); }

  // requests: [{ actor, inbox, sharedInbox, activity, at }] — Follows a group
  // with approveJoins has neither accepted nor rejected. The whole Follow is
  // kept because the Accept or Reject has to name it.
  getRequests() { return this.read('requests.json', []); }
  setRequests(r) { this.write('requests.json', r); }

  // dead letters: inbox items that failed verification or exhausted retries —
  // kept for inspection (GET /deadletter) instead of being destroyed.
  getDeadLetters() { return this.read('deadletter.json', []); }
  addDeadLetter(entry) {
    const dl = this.getDeadLetters();
    dl.unshift({ at: new Date().toISOString(), ...entry });
    this.write('deadletter.json', dl.slice(0, 200));
  }

  // statuses index: operational mirror of what lives in the pod as RDF, in
  // arrival order — the Mastodon-API facade serves timelines from this.
  // [{ noteId, actor, content, published, inReplyTo, kind: 'timeline'|'post'|'tag' }]
  getStatuses() { return this.read('statuses.json', []); }
  addStatus(s) {
    const all = this.getStatuses();
    if (all.some(x => x.noteId === s.noteId)) return;
    all.unshift(s);
    this.write('statuses.json', all.slice(0, 1000));
    this.onEvent?.('status', s);            // streaming subscribers
  }
  updateStatus(noteId, patch) {
    const all = this.getStatuses();
    const i = all.findIndex(x => x.noteId === noteId);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch };
    this.write('statuses.json', all);
    return all[i];
  }
  removeStatus(noteId) {
    this.write('statuses.json', this.getStatuses().filter(x => x.noteId !== noteId));
  }

  // notifications: what other actors did to us — the facade serves
  // /api/v1/notifications from this. [{ id, type, actor, noteId?, at }]
  // The id is a content hash, so a re-delivered activity dedupes.
  getNotifications() { return this.read('notifications.json', []); }
  addNotification(n) {
    const all = this.getNotifications();
    const id = crypto.createHash('sha256').update(JSON.stringify(n)).digest('hex').slice(0, 16);
    if (all.some(x => x.id === id)) return;
    const entry = { id, at: new Date().toISOString(), ...n };
    all.unshift(entry);
    this.write('notifications.json', all.slice(0, 500));
    this.onEvent?.('notification', entry);  // streaming subscribers
  }

  // uploaded media registry: opaque id → { url, mediaType, description }
  getMedia() { return this.read('media.json', {}); }
  setMedia(id, entry) {
    const m = this.getMedia();
    m[id] = entry;
    this.write('media.json', m);
  }

  // actor-doc cache for account rendering (display name, avatar).
  getActors() { return this.read('actors.json', {}); }
  cacheActor(url, doc) {
    const a = this.getActors();
    a[url] = {
      name: doc.name || doc.preferredUsername || '',
      preferredUsername: doc.preferredUsername || '',
      icon: typeof doc.icon === 'object' ? doc.icon?.url : doc.icon,
      image: typeof doc.image === 'object' ? doc.image?.url : doc.image,
      summary: doc.summary || '',
      // A Group is an actor too, and a client that cannot tell shows it as a
      // person. The counts are NOT in this document — they are the collections'
      // totalItems, filled in only when someone asks about this actor by name.
      type: doc.type || 'Person',
      followers: doc.followers || null,
      following: doc.following || null,
      ...(a[url]?.counts ? { counts: a[url].counts } : {}),
      fetchedAt: new Date().toISOString(),
    };
    this.write('actors.json', a);
  }

  // @user@host for an actor we have cached. Null when we have not, rather than
  // a last-segment guess off the URL: that guess is what rendered a group as
  // @actor@host, because our own actors all end in /actor.
  handleOf(actorUrl) {
    const user = this.getActors()[actorUrl]?.preferredUsername;
    if (!user) return null;
    try { return `@${user}@${new URL(actorUrl).host}`; } catch { return null; }
  }

  // Mastodon-API opaque ids ↔ URLs (snac-style: hashes are fine for clients).
  getIds() { return this.read('ids.json', {}); }
  idFor(url) {
    const ids = this.getIds();
    for (const [id, u] of Object.entries(ids)) if (u === url) return id;
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    ids[id] = url;
    this.write('ids.json', ids);
    return id;
  }
  urlFor(id) { return this.getIds()[id] || null; }
}
