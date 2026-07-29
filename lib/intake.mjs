// intake.mjs — drains the remote pod's public-append inbox and applies side
// effects. Inbound authenticity: LDN bodies don't carry the delivery's
// HTTP-Signature headers, so instead of verifying signatures we VERIFY BY
// DEREFERENCING — re-fetch the claimed object/actor from its origin (signed
// GET, so authorized-fetch instances answer) and trust only what the origin
// itself serves.
//
// Failure policy: a REJECTED item (verification says no) goes to the
// dead-letter store and leaves the inbox; a FAILING item (exception —
// network, remote 5xx) stays in the inbox for the next drain, and moves to
// the dead-letter store after MAX_ITEM_ATTEMPTS. Nothing is silently
// destroyed.
//
// Wake-up: WebSocketChannel2023 push on the inbox container (probe P4), plus
// a poll every POLL_MS as fallback, plus a drain at startup.

import { USER_AGENT } from './ua.mjs';

const POLL_MS = 2 * 60_000;      // the push socket flaps (proxy idle timeout), so poll tight
// A flapping socket used to POST a NEW WebSocketChannel2023 channel every two
// seconds — hundreds an hour against a server that is already struggling, and
// channel churn its operators have to sweep up. Backs off instead, and an open
// only triggers a sweep if we have not just swept.
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
const OPEN_DRAIN_MIN_GAP_MS = 30_000;
// A container that times out will time out again in two minutes, and each
// attempt holds one of the pod's workers for the full timeout. Sweeping stops
// for a while instead, doubling up to half an hour.
const DRAIN_COOLDOWN_MIN_MS = 2 * 60_000;
const DRAIN_COOLDOWN_MAX_MS = 30 * 60_000;
// Our DELETEs take the same container write lock as the deliveries arriving
// into it — a gap between them keeps a sweep from convoying against inbound.
const DELETE_GAP_MS = 150;
// Attempt counts live in pod state, not in memory: a restart used to hand every
// poison item five fresh tries, and under a crash loop that is unbounded.
const ATTEMPTS_DOC = 'intake-attempts.json';
const ATTEMPTS_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ITEM_ATTEMPTS = 5;
const MAX_ITEMS_PER_DRAIN = 50;
const ACCEPT_AP = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export class Intake {
  constructor({ config, urls, remote, local, store, deliverer, publisher, log = console.log }) {
    Object.assign(this, { config, urls, remote, local, store, deliverer, publisher, log });
    this.serial = Date.now();
    this.stopped = false;
    // (attempt counts are kept in pod state — see _bumpAttempt)
    this.lastDrain = null;
    this.lastDrainAtMs = 0;
    this.reconnectTries = 0;
    this.drainCooldownUntil = 0;
    this.drainFailures = 0;
    this.wsState = 'never-connected';
  }

  async start() {
    this.stopped = false;                     // restartable across demote/takeover cycles
    await this.drain().catch(e => this.log(`drain: ${e.message}`));
    const tick = () => {
      this.pollTimer = setTimeout(() => {
        this.drain().catch(e => this.log(`drain: ${e.message}`)).finally(() => { if (!this.stopped) tick(); });
      }, Math.round(POLL_MS * (0.85 + Math.random() * 0.3)));
      this.pollTimer.unref?.();
    };
    tick();
    this.subscribe().catch(e => this.log(`subscribe: ${e.message}`));
  }

  stop() { this.stopped = true; clearTimeout(this.pollTimer); clearTimeout(this.resubTimer); this.ws?.close(); }

  // Attempt bookkeeping, persisted. Written only when an item fails, so a
  // healthy inbox never touches this document.
  _bumpAttempt(url, message) {
    const all = this.store.read(ATTEMPTS_DOC, {});
    const rec = all[url] || { n: 0 };
    rec.n += 1;
    rec.at = new Date().toISOString();
    rec.last = String(message || '').slice(0, 200);
    all[url] = rec;
    this.store.write(ATTEMPTS_DOC, all);
    return rec.n;
  }

  _clearAttempt(url) {
    const all = this.store.read(ATTEMPTS_DOC, {});
    if (!all[url]) return;
    delete all[url];
    this.store.write(ATTEMPTS_DOC, all);
  }

  // Items deleted long ago would otherwise accumulate here forever.
  _pruneAttempts() {
    const all = this.store.read(ATTEMPTS_DOC, {});
    const cutoff = Date.now() - ATTEMPTS_TTL_MS;
    let dropped = 0;
    for (const [url, rec] of Object.entries(all)) {
      if (!rec?.at || Date.parse(rec.at) < cutoff) { delete all[url]; dropped++; }
    }
    if (dropped) { this.store.write(ATTEMPTS_DOC, all); this.log(`pruned ${dropped} stale inbox attempt record(s)`); }
  }

  // Jittered exponential, floor to ceiling, reset by a successful open.
  _reconnectDelay() {
    const capped = Math.min(RECONNECT_MIN_MS * 2 ** this.reconnectTries, RECONNECT_MAX_MS);
    this.reconnectTries++;
    return Math.round(capped * (0.8 + Math.random() * 0.4));
  }

  // --- push ---
  // Any failure in here used to end push for the life of the process: the
  // retry lived only in the "server refused the subscription" branch, so a
  // network blip left wsState at never-connected and the agent silently on
  // polling. Every path now schedules a retry on the same backoff.
  async subscribe() {
    try {
      await this._subscribeOnce();
    } catch (e) {
      this.wsState = 'subscribe-error';
      const wait = this._reconnectDelay();
      this.log(`subscribe failed (${e.message}) — retrying in ${Math.round(wait / 1000)}s (polling meanwhile)`);
      if (!this.stopped) {
        this.resubTimer = setTimeout(() => this.subscribe().catch(() => {}), wait);
        this.resubTimer.unref?.();
      }
    }
  }

  async _subscribeOnce() {
    const descRes = await fetch(this.urls.base + '.well-known/solid', {
      headers: { accept: 'text/turtle', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 20_000),
    });
    const desc = await descRes.text();
    const m = desc.match(/<([^>]*WebSocketChannel2023[^>]*)>/);
    if (!m) { this.wsState = 'unavailable'; this.log('no WebSocketChannel2023 service — polling only'); return; }
    const sub = await this.remote.fetch(m[1], {
      method: 'POST',
      headers: { 'content-type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': ['https://www.w3.org/ns/solid/notification/v1'],
        type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
        topic: this.urls.inbox,
      }),
    });
    const body = await sub.json().catch(() => null);
    if (!body?.receiveFrom) {
      this.wsState = `subscribe-failed-${sub.status}`;
      const wait = this._reconnectDelay();
      this.log(`subscription failed (${sub.status}) — retrying in ${Math.round(wait / 1000)}s (polling meanwhile)`);
      if (!this.stopped) {
        this.resubTimer = setTimeout(() => this.subscribe().catch(e => this.log(`resubscribe: ${e.message}`)), wait);
        this.resubTimer.unref?.();
      }
      return;
    }
    this.ws = new WebSocket(body.receiveFrom);
    this.ws.onopen = () => {
      this.wsState = 'open';
      if (!this._announcedPush) { this.log('inbox push subscription active'); this._announcedPush = true; }
      this.reconnectTries = 0;
      // Anything that arrived while the socket was down is waiting — sweep it,
      // unless a sweep just ran: a flapping socket must not re-list the inbox
      // on every open.
      if (Date.now() - this.lastDrainAtMs > OPEN_DRAIN_MIN_GAP_MS) {
        this.drain().catch(e => this.log(`drain: ${e.message}`));
      }
    };
    this.ws.onmessage = () => this.drain().catch(e => this.log(`drain: ${e.message}`));
    this.ws.onclose = () => {
      this.wsState = 'closed';
      if (!this.stopped) {
        this.resubTimer = setTimeout(() => this.subscribe().catch(e => this.log(`resubscribe: ${e.message}`)), this._reconnectDelay());
        this.resubTimer.unref?.();
      }
    };
    this.ws.onerror = () => { this.wsState = 'error'; };
  }

  // --- drain + dispatch ---
  // Serialized: push events, polls, and manual /drain calls can fire
  // concurrently, and overlapping sweeps double-process items (observed as
  // duplicate Accepts/timeline writes). One sweep at a time; callers that
  // arrive mid-sweep get one follow-up sweep.
  async drain() {
    if (this._draining) { this._drainAgain = true; return this._draining; }
    this._draining = this._drainOnce().finally(() => {
      this._draining = null;
      if (this._drainAgain) { this._drainAgain = false; this.drain().catch(e => this.log(`drain: ${e.message}`)); }
    });
    return this._draining;
  }

  async _drainOnce() {
    const cooling = this.drainCooldownUntil - Date.now();
    if (cooling > 0) {
      this.log(`inbox sweep skipped — backing off for another ${Math.ceil(cooling / 1000)}s`);
      return;
    }
    this.lastDrain = new Date().toISOString();
    this.lastDrainAtMs = Date.now();
    this._pruneAttempts();
    let all;
    try {
      all = await this.remote.listContainer(this.urls.inbox);
      this.drainFailures = 0;
    } catch (e) {
      this.drainFailures++;
      const capped = Math.min(DRAIN_COOLDOWN_MIN_MS * 2 ** (this.drainFailures - 1), DRAIN_COOLDOWN_MAX_MS);
      this.drainCooldownUntil = Date.now() + Math.round(capped * (0.85 + Math.random() * 0.3));
      this.log(`inbox unreadable (${e.message}) — next sweep in ${Math.round(capped / 1000)}s`);
      return;
    }
    // The inbox is public-Append: a flood must not turn one sweep into an
    // unbounded run. The rest waits for the next drain (2 min away).
    const items = all.slice(0, MAX_ITEMS_PER_DRAIN);
    if (all.length > items.length) this.log(`inbox has ${all.length} items — processing ${items.length} this sweep`);
    for (const url of items) {
      if (url.endsWith('.keep')) continue;
      let activity = null;
      try {
        const res = await this.remote.fetch(url, { headers: { accept: '*/*' } });
        const raw = res.status < 400 ? await res.text() : null;
        try { activity = raw ? JSON.parse(raw) : null; } catch { /* kept raw for the dead letter */ }
        const rejection = activity ? await this.handle(activity) : 'unparsable JSON';
        if (rejection) {
          this.store.addDeadLetter({
            inboxUrl: url, reason: rejection, activity,
            ...(activity ? {} : { raw: raw?.slice(0, 2000) ?? null }),
          });
          this.log(`rejected (${rejection}) — dead-lettered: ${url}`);
        }
        await this.remote.delete(url);
        this._clearAttempt(url);
        await new Promise(r => setTimeout(r, DELETE_GAP_MS));
      } catch (e) {
        const n = this._bumpAttempt(url, e.message);
        this.log(`inbox item ${url} attempt ${n}/${MAX_ITEM_ATTEMPTS}: ${e.message}`);
        if (n >= MAX_ITEM_ATTEMPTS) {
          this.store.addDeadLetter({ inboxUrl: url, reason: `failed ${n}x: ${e.message}`, activity });
          await this.remote.delete(url);
          this._clearAttempt(url);
        }
      }
    }
  }

  async fetchAP(url) {
    const res = await this.deliverer.signedFetch(url, { headers: { accept: ACCEPT_AP } });
    if (res.status >= 400) return null;
    // Remote servers are untrusted: read with a byte budget rather than
    // letting res.json() buffer whatever they choose to send.
    const { readCapped } = await import('./safefetch.mjs');
    let doc = null;
    try { doc = JSON.parse(await readCapped(res)); }
    catch (e) { this.log(`fetch ${url}: ${e.message}`); return null; }
    if (doc?.type === 'Person' && doc.id) this.store.cacheActor(doc.id, doc);
    return doc;
  }

  sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }

  // Returns a rejection reason string, or undefined when handled.
  async handle(activity) {
    const actor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!actor) return 'no actor';
    if (this.store.isBlocked(actor)) return `blocked domain (${actor})`;

    switch (activity.type) {
      case 'Follow': return this.onFollow(activity, actor);
      case 'Undo': return this.onUndo(activity, actor);
      case 'Create': return this.onCreate(activity, actor);
      case 'Accept': return this.onAccept(activity, actor);
      case 'Like': case 'Announce': {
        const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
        this.log(`${activity.type} from ${actor} on ${objectId}`);
        if (objectId && objectId.startsWith(this.urls.notes)) {
          this.store.addNotification({
            type: activity.type === 'Like' ? 'favourite' : 'reblog', actor, noteId: objectId,
          });
          return;
        }
        if (activity.type === 'Announce') return this.onAnnounce(activity, actor, objectId);
        return;
      }
      case 'Delete': return;                 // v1: ignore, not an error
      default: this.log(`ignored ${activity.type} from ${actor}`);
    }
  }

  async onFollow(activity, actor) {
    const doc = await this.fetchAP(actor);   // origin must vouch for the actor
    if (!doc) return `actor fetch failed (${actor})`;
    if (doc.id !== actor) return `actor id mismatch (${actor} vs ${doc.id})`;
    if (!doc.inbox) return `actor has no inbox (${actor})`;
    const contacts = this.store.getContacts();
    const existing = contacts.followers.find(f => f.actor === actor);
    if (existing) {
      existing.followId = activity.id || existing.followId;   // refollow supersedes
      this.store.setContacts(contacts);
    } else {
      contacts.followers.push({
        actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox, followId: activity.id,
      });
      this.store.setContacts(contacts);
      this.store.addNotification({ type: 'follow', actor });
      await this.publisher.publishCollections();
      this.log(`new follower: ${actor}`);
    }
    const { acceptActivity } = await import('./wire.mjs');
    await this.deliverer.deliver(doc.inbox,
      acceptActivity({ urls: this.urls, followActivity: activity, serial: this.serial++ }));
    this.log(`Accept sent → ${doc.inbox}`);
  }

  async onUndo(activity, actor) {
    if (activity.object?.type !== 'Follow') return;
    // Deliveries arrive unordered: an Undo may land AFTER the refollow it
    // predates. It names the Follow id it revokes — only honor it when it
    // matches the follow we currently hold for that actor.
    const undoneId = activity.object?.id;
    const contacts = this.store.getContacts();
    const rec = contacts.followers.find(f => f.actor === actor);
    if (!rec) return;
    if (undoneId && rec.followId && undoneId !== rec.followId) {
      this.log(`stale Undo from ${actor} (revokes ${undoneId}, current is ${rec.followId}) — ignored`);
      return;
    }
    contacts.followers = contacts.followers.filter(f => f.actor !== actor);
    this.store.setContacts(contacts);
    await this.publisher.publishCollections();
    this.log(`unfollowed by ${actor}`);
  }

  // Does this activity/note concern us at all? Either it comes from someone
  // we follow, or it names us (to/cc, mention tag) or replies to one of our
  // notes. Anything else is a stranger blasting inboxes — refuse it before
  // spending a dereference on it.
  concernsUs(doc, actor) {
    if (this.store.getContacts().following.some(f => f.actor === actor && f.accepted)) return true;
    const audience = []
      .concat(doc?.to || [], doc?.cc || [], doc?.bto || [], doc?.bcc || [], doc?.audience || [])
      .map(v => (typeof v === 'string' ? v : v?.id)).filter(Boolean);
    if (audience.includes(this.urls.actor) || audience.includes(this.urls.followers)) return true;
    const tagged = [].concat(doc?.tag || [])
      .some(t => t?.type === 'Mention' && (t.href === this.urls.actor || t.name?.includes(this.urls.actor)));
    if (tagged) return true;
    const inReplyTo = typeof doc?.inReplyTo === 'string' ? doc.inReplyTo : doc?.inReplyTo?.id;
    return !!inReplyTo && String(inReplyTo).startsWith(this.urls.notes);
  }

  async onCreate(activity, actor) {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return 'Create without object id';
    if (this.store.isBlocked(objectId)) return `blocked domain (${objectId})`;
    if (!this.sameOrigin(objectId, actor)) return `object/actor origin mismatch (${objectId})`;
    // The delivered copy is untrusted for CONTENT, but its addressing is
    // enough to decide whether to bother fetching the origin's copy.
    const envelope = typeof activity.object === 'object' ? { ...activity, ...activity.object } : activity;
    if (!this.concernsUs(envelope, actor)) return `not addressed to us (${objectId})`;
    return this.ingestNote(objectId, actor);
  }

  // A boost: ingest the boosted note when the booster is someone we follow —
  // that's what following means, their boosts widen the timeline. Anything
  // else is unsolicited and only logged.
  async onAnnounce(activity, actor, objectId) {
    if (!objectId) return 'Announce without object id';
    const followed = this.store.getContacts().following.some(f => f.actor === actor && f.accepted);
    if (!followed) { this.log(`Announce from unfollowed ${actor} — ignored`); return; }
    if (this.store.isBlocked(objectId)) return `blocked domain (${objectId})`;
    if (this.store.getStatuses().some(s => s.noteId === objectId)) return;   // already known
    return this.ingestNote(objectId, actor, { via: actor });
  }

  // Shared tail of Create/Announce: deref the note at its origin (never trust
  // the delivered copy), mirror it into pod RDF + statuses, notify on replies
  // to our own notes. Returns a rejection reason string, or undefined.
  async ingestNote(objectId, actor, { via } = {}) {
    const note = await this.fetchAP(objectId);
    if (!note) return `object fetch failed (${objectId})`;
    if (note.id !== objectId || note.type !== 'Note') return `object not a verifiable Note (${objectId})`;
    const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
    const attachments = attachmentsOf(note);
    const content = sanitizeHtml(note.content);   // hostile markup never reaches pod or client
    const author = note.attributedTo || actor;

    // Anyone can Append to a public inbox, so arriving is not the same as
    // belonging in the home timeline. Follow Mastodon's split: people you
    // follow (and their boosts) are HOME; anyone else is a MENTION — kept,
    // notified, readable in the Mentions view, but out of the timeline, and
    // mirror-only so unsolicited content never accumulates in the pod.
    const followed = via || this.store.getContacts().following.some(f => f.actor === author && f.accepted);
    const kind = followed ? 'timeline' : 'mention';

    const slug = (note.published || new Date().toISOString()).slice(0, 10) + '-' +
      (await import('node:crypto')).createHash('sha256').update(note.id).digest('hex').slice(0, 8);
    if (kind === 'timeline') {
      await this.local.writeNote('timeline', slug, {
        noteId: note.id, actor: author, published: note.published, content,
        inReplyTo: note.inReplyTo, attachments,
      });
    }
    this.store.addStatus({
      noteId: note.id, actor: author, content,
      published: note.published, inReplyTo: note.inReplyTo, kind,
      ...(kind === 'timeline' ? { slug } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(via ? { via } : {}),
    });
    if (!followed || (note.inReplyTo && String(note.inReplyTo).startsWith(this.urls.notes))) {
      this.store.addNotification({ type: 'mention', actor: author, noteId: note.id });
    }
    this.log(`${kind}: ${note.id}${via ? ` (boosted by ${via})` : ''}`);
  }

  async onAccept(activity, actor) {
    const contacts = this.store.getContacts();
    const rec = contacts.following.find(f => f.actor === actor);
    if (rec && !rec.accepted) {
      rec.accepted = true;
      this.store.setContacts(contacts);
      await this.publisher.publishCollections();
      this.log(`follow accepted by ${actor}`);
    }
  }
}
