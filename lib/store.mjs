// store.mjs — PodStore: the agent's operational state, stored ON the pod
// (owner-only /activitypods-js/ap-state/*.json) instead of a local dir. The
// sync read/write surface of dk's fs Store is preserved so every consumer
// (publisher, intake, facade, …) is unchanged: reads come from an in-memory
// cache loaded once at boot, writes update the cache and are PUT to the pod
// through a serialized, debounced, retrying queue. Everything here is
// rebuildable from the pod's /fediverse/ RDF, so a lost write degrades, it
// doesn't destroy. Without a fetchImpl the store is pure memory (tests,
// unconfigured boot).

import crypto from 'node:crypto';

const PUT_DEBOUNCE_MS = 300;
const PUT_RETRIES = 5;

export class PodStore {
  constructor({ base = null, fetchImpl = null, log = console.log } = {}) {
    this.base = base && !base.endsWith('/') ? base + '/' : base;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.cache = new Map();        // name → parsed value
    this.etags = new Map();        // name (or '') → last ETag, for revalidation
    this.timers = new Map();       // name → debounce timer
    this.chain = Promise.resolve();  // serialized PUTs
  }

  attach(base, fetchImpl) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.fetchImpl = fetchImpl;
  }

  // Load every state doc in the container into the cache. Missing container
  // (first run) is fine — the cache just starts empty.
  // Throws when the container cannot be read. An empty cache MUST mean "no
  // state yet", never "the pod was unreachable" — the caller treats the
  // former as a fresh install, and silently conflating them would look like
  // an un-set-up agent every time the pod hiccups.
  async load() {
    if (!this.fetchImpl) return;
    // Revalidate rather than re-download: a viewer reloads this every minute
    // and it is almost always unchanged. 304 means both the listing and every
    // doc we already hold are current.
    const containerEtag = this.etags.get('');
    const res = await this.fetchImpl(this.base, {
      headers: { accept: 'text/turtle', ...(containerEtag ? { 'if-none-match': containerEtag } : {}) },
    });
    if (res.status === 304) return;
    if (res.status === 404) return;                       // genuinely not created yet
    if (res.status >= 400) throw new Error(`state container unreadable (HTTP ${res.status})`);
    this.etags.set('', res.headers.get('etag'));
    const ttl = await res.text();
    const names = new Set();
    for (const m of ttl.matchAll(/<([^>]*)>/g)) {
      let u;
      try { u = new URL(m[1], this.base).href; } catch { continue; }
      if (u.startsWith(this.base) && u !== this.base && u.endsWith('.json')) {
        names.add(decodeURIComponent(u.slice(this.base.length)));
      }
    }
    let fetched = 0;
    for (const name of names) {
      const etag = this.etags.get(name);
      const r = await this.fetchImpl(this.base + encodeURIComponent(name), {
        headers: { accept: 'application/json', ...(etag && this.cache.has(name) ? { 'if-none-match': etag } : {}) },
      });
      if (r.status === 304) continue;                     // ours is current
      if (r.status >= 400) throw new Error(`state doc ${name} unreadable (HTTP ${r.status})`);
      fetched++;
      this.etags.set(name, r.headers.get('etag'));
      try { this.cache.set(name, JSON.parse(await r.text())); }
      catch (e) { this.log(`state load ${name}: unparsable (${e.message})`); }
    }
    this.log(`state loaded: ${this.cache.size} doc(s) from ${this.base} (${fetched} re-fetched)`);
  }

  has(name) { return this.cache.has(name); }

  read(name, fallback) {
    return this.cache.has(name) ? structuredClone(this.cache.get(name)) : fallback;
  }

  write(name, obj) {
    this.cache.set(name, structuredClone(obj));
    if (!this.fetchImpl) return;
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => { this.timers.delete(name); this._put(name); }, PUT_DEBOUNCE_MS));
    this.timers.get(name).unref?.();
  }

  _put(name) {
    this.chain = this.chain.then(async () => {
      const body = JSON.stringify(this.cache.get(name), null, 2) + '\n';
      for (let attempt = 1; attempt <= PUT_RETRIES; attempt++) {
        try {
          const res = await this.fetchImpl(this.base + encodeURIComponent(name), {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body,
          });
          if (res.status < 400) return;
          throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          if (attempt === PUT_RETRIES) { this.log(`state PUT ${name} gave up: ${e.message}`); return; }
          await new Promise(r => setTimeout(r, attempt * 2000));
        }
      }
    });
    return this.chain;
  }

  // Remove a state doc from the cache AND the pod (used when key material
  // migrates to the local machine — leaving the copy behind would defeat it).
  async remove(name) {
    this.cache.delete(name);
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    if (!this.fetchImpl) return true;
    try {
      const res = await this.fetchImpl(this.base + encodeURIComponent(name), { method: 'DELETE' });
      return res.status < 400 || res.status === 404;
    } catch (e) { this.log(`state DELETE ${name}: ${e.message}`); return false; }
  }

  // Flush pending debounced writes (shutdown path).
  async flush() {
    for (const [name, t] of this.timers) { clearTimeout(t); this.timers.delete(name); this._put(name); }
    await this.chain;
  }

  // ---- the domain helpers, unchanged from dk's Store ----

  // config: { remotePod, handle, name, issuer }  (credential lives ONLY in
  // the local credential file, never in pod state)
  getConfig() { return this.read('config.json', null); }
  setConfig(cfg) { this.write('config.json', cfg); }

  // queue: [{ inbox, activity, attempts, nextAt }]
  getQueue() { return this.read('queue.json', []); }
  setQueue(q) { this.write('queue.json', q); }

  // blocklist: { domains: ["spam.example", ...] }
  getBlocklist() { return this.read('blocklist.json', { domains: [] }); }
  setBlocklist(b) { this.write('blocklist.json', b); }
  isBlocked(url) {
    let host;
    try { host = new URL(url).hostname; } catch { return true; }   // unparsable → treat as hostile
    return this.getBlocklist().domains.some(d => host === d || host.endsWith('.' + d));
  }

  // contacts: { followers: [{actor, inbox, sharedInbox}], following: [{actor, inbox, accepted}] }
  getContacts() { return this.read('contacts.json', { followers: [], following: [] }); }
  setContacts(c) { this.write('contacts.json', c); }

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
      fetchedAt: new Date().toISOString(),
    };
    this.write('actors.json', a);
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
