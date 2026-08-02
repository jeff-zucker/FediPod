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

import * as $rdf from 'rdflib';
import { USER_AGENT } from './ua.mjs';
import { dropFollower } from './store.mjs';

const RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const NOTIFY = $rdf.Namespace('http://www.w3.org/ns/solid/notifications#');

const POLL_MS = 2 * 60_000;      // fallback cadence when there is no push
// With a live socket the poll is pure redundancy: it exists for the case where
// push is down, so it slows right down while push is up.
const POLL_PUSH_OK_MS = 10 * 60_000;
// The channel a subscription returns outlives a dropped socket, so reconnecting
// reuses it. Creating a new one per reconnect is what buried solidcommunity.net
// in channel records they then had to sweep.
const CHANNEL_DOC = 'inbox-channel.json';
// A flapping socket used to POST a NEW WebSocketChannel2023 channel every two
// seconds — hundreds an hour against a server that is already struggling, and
// channel churn its operators have to sweep up. Backs off instead, and an open
// only triggers a sweep if we have not just swept.
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 5 * 60_000;
// How long a socket must stay up before the backoff counts it as a success and
// resets. Shorter than that is a flap, not a connection.
const RECONNECT_STABLE_MS = 60_000;
const OPEN_DRAIN_MIN_GAP_MS = 30_000;
// A container that times out will time out again in two minutes, and each
// attempt holds one of the pod's workers for the full timeout. Sweeping stops
// for a while instead, doubling up to half an hour.
const DRAIN_COOLDOWN_MIN_MS = 2 * 60_000;
const DRAIN_COOLDOWN_MAX_MS = 30 * 60_000;
// Our DELETEs take the same container write lock as the deliveries arriving
// into it — a gap between them keeps a sweep from convoying against inbound.
const DELETE_GAP_MS = 150;
// How many handled items ride on one commit before they are deleted. Small
// enough that a crash re-does little, large enough that a flood of fast
// rejections does not become a pod write per item.
const DELETE_BATCH = 10;
// Attempt counts live in pod state, not in memory: a restart used to hand every
// poison item five fresh tries, and under a crash loop that is unbounded.
const ATTEMPTS_DOC = 'intake-attempts.json';
const ATTEMPTS_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ITEM_ATTEMPTS = 5;
const MAX_ITEMS_PER_DRAIN = 50;
// The AS2 actor types. A group is as much an actor as a person is.
const ACTOR_TYPES = new Set(['Person', 'Group', 'Service', 'Application', 'Organization']);
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

  // Draining is a destructive read — an item is gone from the pod once we
  // DELETE it — so the result of handling it must be on disk first.
  //
  // This used to be skipped whenever the state and the inbox shared an origin,
  // on the reasoning that a pod we cannot write to is a pod we cannot list
  // either, so the drain never starts. That covers the pod being unreachable
  // and nothing else: it does not cover a crash inside the 300ms debounce
  // window, and it does not cover a pod that refuses a write while still
  // serving reads and deletes — a quota, a 507, a 403 on one document. In
  // either case every item drained since the last successful write is gone,
  // and what goes is the mentions, replies, join requests and dead-letter
  // records that nothing else can rebuild.
  async _persisted() {
    return this.store.commit();
  }

  _backOff(why) {
    this.drainFailures++;
    const capped = Math.min(DRAIN_COOLDOWN_MIN_MS * 2 ** (this.drainFailures - 1), DRAIN_COOLDOWN_MAX_MS);
    this.drainCooldownUntil = Date.now() + Math.round(capped * (0.85 + Math.random() * 0.3));
    this.log(`${why} — next sweep in ${Math.round(capped / 1000)}s`);
  }

  async start() {
    this.stopped = false;                     // restartable across demote/takeover cycles
    await this.drain().catch(e => this.log(`drain: ${e.message}`));
    const tick = () => {
      this.pollTimer = setTimeout(() => {
        this.drain().catch(e => this.log(`drain: ${e.message}`)).finally(() => { if (!this.stopped) tick(); });
      }, Math.round((this.wsState === 'open' ? POLL_PUSH_OK_MS : POLL_MS) * (0.85 + Math.random() * 0.3)));
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
    // Reuse a channel we already have rather than asking for another one.
    const saved = this.store.read(CHANNEL_DOC, null);
    if (saved?.receiveFrom && (!saved.endAt || Date.parse(saved.endAt) - Date.now() > 60_000)) {
      this._openSocket(saved.receiveFrom, true);
      return;
    }
    const descRes = await fetch(this.urls.base + '.well-known/solid', {
      headers: { accept: 'text/turtle', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 20_000),
    });
    // The service description is RDF; ask rdflib which subject is the
    // WebSocketChannel2023 service rather than pattern-matching the document.
    const descUrl = this.urls.base + '.well-known/solid';
    const g = $rdf.graph();
    try { $rdf.parse(await descRes.text(), g, descUrl, 'text/turtle'); }
    catch (e) { this.wsState = 'unavailable'; this.log(`service description unparsable (${e.message}) — polling only`); return; }
    const channel = g.each(null, RDF('type'), NOTIFY('WebSocketChannel2023'), null)
      .map(n => n.value)
      .find(Boolean)
      || g.each(null, NOTIFY('channelType'), NOTIFY('WebSocketChannel2023'), null)
        .map(n => n.value).find(Boolean);
    if (!channel) { this.wsState = 'unavailable'; this.log('no WebSocketChannel2023 service — polling only'); return; }
    const sub = await this.remote.fetch(channel, {
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
    this.store.write(CHANNEL_DOC, { receiveFrom: body.receiveFrom, endAt: body.endAt || null });
    this._openSocket(body.receiveFrom, false);
  }

  _openSocket(receiveFrom, reused) {
    this.ws = new WebSocket(receiveFrom);
    this.ws.onopen = () => {
      this.wsState = 'open';
      if (!this._announcedPush) { this.log('inbox push subscription active'); this._announcedPush = true; }
      this._openedAt = Date.now();
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
      // Only a connection that STAYED up counts as a success. Resetting on open
      // alone meant the 2026-07-29 failure — a server that accepts the upgrade
      // and then drops the socket on a crash cycle — reconnected at the 2s
      // floor indefinitely: every cycle "succeeded", so the exponential cap was
      // never reached, and each open also drained the inbox.
      if (this._openedAt && Date.now() - this._openedAt >= RECONNECT_STABLE_MS) this.reconnectTries = 0;
      this._openedAt = 0;
      if (!this.stopped) {
        this.resubTimer = setTimeout(() => this.subscribe().catch(e => this.log(`resubscribe: ${e.message}`)), this._reconnectDelay());
        this.resubTimer.unref?.();
      }
    };
    this.ws.onerror = () => {
      this.wsState = 'error';
      // A channel we reused may simply be gone: forget it so the next attempt
      // asks for a fresh one instead of retrying a dead URL forever.
      if (reused) this.store.write(CHANNEL_DOC, null);
    };
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

  // Discard the content waiting in the inbox from before `before`, on the
  // owner's say-so — the admin page asks, this does it. NOT a blind sweep:
  //
  //   small  → read it. Once read the type is known, so a Follow, Undo, Accept
  //            or Delete is APPLIED (the follow graph stays correct) and only a
  //            Create is dropped. Reading is what buys precision.
  //   large  → deleted unread. One request instead of two, and at this size it
  //            is content, which is exactly what was asked to go.
  //
  // The threshold errs high on purpose. Mistaking content for control costs one
  // extra GET; mistaking control for content loses a follower or keeps a post
  // its author retracted, silently and permanently. Everything whose loss
  // actually corrupts state — Follow, Undo, Accept, Delete — is a few IRIs and
  // sits far below 2 kB. The one control-ish activity that gets large is
  // Update{Person}, and losing one of those means a stale avatar.
  async prune({ before, sizeThreshold = 2048 } = {}) {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) throw new Error(`"${before}" is not a date`);
    const all = await this.remote.listContainer(this.urls.inbox);
    const older = all.filter(e => !e.url.endsWith('.keep')
      && e.modified && Date.parse(e.modified) < cutoff);
    const out = { considered: older.length, applied: 0, dropped: 0, discarded: 0, failed: 0 };

    for (const item of older) {
      try {
        if (item.size >= sizeThreshold) {
          await this.remote.delete(item.url);       // unread: content, by weight
          out.discarded++;
        } else {
          const res = await this.remote.fetch(item.url, { headers: { accept: '*/*' } });
          // Same rule as the drain: a read we could not make is not a Create to
          // be dropped. Let it count as failed and stay for the next pass.
          if (res.status >= 400 && res.status !== 404) throw new Error(`inbox item GET → ${res.status}`);
          const activity = res.status < 400 ? await res.json().catch(() => null) : null;
          // A Create is the content the owner just asked to be rid of. Anything
          // else changes state and is applied exactly as a drain would.
          if (activity && activity.type !== 'Create') {
            await this.handle(activity);
            out.applied++;
          } else {
            out.dropped++;
          }
          if (!await this._persisted()) {
            this.log(`state not written — stopping the prune with ${older.length - out.applied - out.dropped - out.discarded} left`);
            break;
          }
          await this.remote.delete(item.url);
        }
        this._clearAttempt(item.url);
        await new Promise(r => setTimeout(r, DELETE_GAP_MS));
      } catch (e) {
        out.failed++;
        this.log(`prune ${item.url}: ${e.message}`);
      }
    }
    this.log(`pruned before ${before}: applied ${out.applied}, dropped ${out.dropped} `
      + `small Create(s), discarded ${out.discarded} unread${out.failed ? `, ${out.failed} failed` : ''}`);
    await this.store.flush();
    // Adjust the measurement in place rather than kicking a drain to re-take
    // it: an un-awaited drain would still be running when this returns, which
    // races whoever called us. The poll picks the rest up soon enough.
    const removed = out.applied + out.dropped + out.discarded;
    if (this.inboxStats && removed) {
      this.inboxStats = { ...this.inboxStats, count: Math.max(0, this.inboxStats.count - removed) };
    }
    return out;
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
      this._backOff(`inbox unreadable (${e.message})`);
      return;
    }
    // What is waiting, measured from the listing we already fetched: no extra
    // request, and it is what /status reports and what the admin page prompts
    // on. The listing arrives oldest-first (lib/remote.mjs).
    const real = all.filter(e => !e.url.endsWith('.keep'));
    this.inboxStats = {
      count: real.length,
      bytes: real.reduce((n, e) => n + e.size, 0),
      oldest: real[0]?.modified || null,
      newest: real[real.length - 1]?.modified || null,
      at: new Date().toISOString(),
    };
    // The inbox is public-Append: a flood must not turn one sweep into an
    // unbounded run. But stopping there is why a backlog never cleared — 50
    // items every two minutes does not converge on an agent that is only
    // running while a laptop is open. So a sweep that made progress and left
    // work behind goes straight round again.
    const items = all.slice(0, MAX_ITEMS_PER_DRAIN);
    if (all.length > items.length) this.log(`inbox has ${all.length} items — processing ${items.length} this sweep`);
    let handled = 0;
    // Deletes are batched behind ONE commit rather than a commit per item.
    // Per-item, the 300ms debounce that coalesces a sweep's writes never gets
    // to do its job: on a flood of fast rejections that is fifty writes of
    // deadletter.json where one would do, and a flood is exactly when the pod
    // should be asked for less rather than more.
    const pending = [];
    const flush = async () => {
      if (!pending.length) return true;
      // Written down before any of them leaves the mailbox. A failure here
      // leaves them where they are: the next sweep sees them again, and a
      // re-delivered activity is handled idempotently.
      if (!await this._persisted()) {
        this._backOff(`state not written — ${pending.length} item(s) left in the inbox`);
        pending.length = 0;
        return false;
      }
      for (const url of pending.splice(0)) {
        if (!await this.remote.delete(url)) {
          // Still in the mailbox. Handling is idempotent so seeing it again is
          // harmless, but counting it would clear the attempt record and report
          // progress that did not happen.
          this.log(`inbox item ${url} was handled but NOT removed — it will be seen again`);
          continue;
        }
        this._clearAttempt(url);
        handled++;
        await new Promise(r => setTimeout(r, DELETE_GAP_MS));
      }
      return true;
    };

    for (const { url } of items) {
      if (url.endsWith('.keep')) continue;
      let activity = null;
      try {
        const res = await this.remote.fetch(url, { headers: { accept: '*/*' } });
        // A pod that would not GIVE us the item has told us nothing about it.
        // Reading a 500 as an empty body made it "unparsable JSON", which is a
        // REJECTION: dead-lettered with both `activity` and `raw` null, and then
        // DELETEd — a delivery destroyed by a transient fault, with no record of
        // what it was. Throwing puts it on the retry path the header promises.
        // 404 is the exception: the item is already gone, so deleting is right.
        if (res.status >= 400 && res.status !== 404) throw new Error(`inbox item GET → ${res.status}`);
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
        pending.push(url);
      } catch (e) {
        const n = this._bumpAttempt(url, e.message);
        this.log(`inbox item ${url} attempt ${n}/${MAX_ITEM_ATTEMPTS}: ${e.message}`);
        if (n >= MAX_ITEM_ATTEMPTS) {
          this.store.addDeadLetter({ inboxUrl: url, reason: `failed ${n}x: ${e.message}`, activity });
          // The dead letter IS the record of this item — deleting before it is
          // written down would lose the only evidence it ever arrived, so it
          // goes through the same commit-then-delete batch as everything else.
          pending.push(url);
        }
      }
      if (pending.length >= DELETE_BATCH && !await flush()) return;
    }
    if (!await flush()) return;
    // Made progress and there is more waiting: go straight round rather than
    // sleeping. Gated on progress so a sweep that achieved nothing — a
    // cooldown, an unwritable store, poison at the head — cannot spin.
    if (handled > 0 && all.length > items.length && !this.stopped) this._drainAgain = true;
  }

  async fetchAP(url) {
    const res = await this.deliverer.signedFetch(url, { headers: { accept: ACCEPT_AP } });
    if (res.status >= 400) return null;
    // Remote servers are untrusted: read with a byte budget rather than
    // letting res.json() buffer whatever they choose to send.
    const { readCapped } = await import('./safefetch.mjs');
    // Plenty of servers answer 200 text/html however politely we ask for AS2 —
    // people reply to ordinary web pages, and their id is that page. Say so,
    // rather than handing the HTML to JSON.parse and logging the parser's
    // complaint about an unexpected `<`.
    // Not logged: people reply to ordinary web pages, so the reply's object id
    // is that page and this is the expected answer, not a fault. Only a server
    // that CLAIMS to be sending JSON and then does not is worth a line.
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (ct && !ct.endsWith('json')) return null;
    let doc = null;
    try { doc = JSON.parse(await readCapped(res)); }
    catch (e) { this.log(`fetch ${url}: unreadable as JSON — ${e.message}`); return null; }
    // Every actor type, not just Person. A Group was fetched, used and thrown
    // away, so nothing knew its preferredUsername — and a client rendering it
    // fell back to the last path segment of the actor URL, which is the literal
    // word `actor`. That is where @actor@host came from.
    if (ACTOR_TYPES.has(doc?.type) && doc.id) this.store.cacheActor(doc.id, doc);
    return doc;
  }

  sameOrigin(a, b) {
    try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
  }

  // Have we ever heard of this actor or object? Answered entirely from local
  // state, so asking costs nothing. It is what stops a stranger's Delete or
  // Update — of which Mastodon broadcasts a great many, and of which anyone at
  // all can Append one — turning into a signed request to a host they chose.
  known(id) {
    const c = this.store.getContacts();
    return c.followers.some(f => f.actor === id)
      || c.following.some(f => f.actor === id)
      || this.store.getStatuses().some(s => s.noteId === id || s.actor === id)
      || !!this.store.getActors()[id];
  }

  // Returns a rejection reason string, or undefined when handled.
  async handle(activity) {
    const actor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!actor) return 'no actor';
    if (this.store.isBlocked(actor)) return `blocked sender (${actor})`;

    switch (activity.type) {
      case 'Follow': return this.onFollow(activity, actor);
      case 'Undo': return this.onUndo(activity, actor);
      case 'Create': return this.onCreate(activity, actor);
      case 'Accept': return this.onAccept(activity, actor);
      case 'Like': case 'Announce': {
        // FEP-1b12: a group Announces the member's whole Create, not the note.
        // Without unwrapping we try to ingest a Create as if it were a Note and
        // dead-letter every post a group ever carries — including our own.
        const wrapped = activity.object;
        const inner = (wrapped && typeof wrapped === 'object'
          && (wrapped.type === 'Create' || wrapped.type === 'Update')) ? wrapped.object : wrapped;
        const objectId = typeof inner === 'string' ? inner : inner?.id;
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
      case 'Delete': return this.onDelete(activity, actor);
      case 'Update': return this.onUpdate(activity, actor);
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
    // NOTHING binds a delivered Follow to the actor it names. LDN bodies carry
    // no signature, and unlike Create, Delete and Update there is no object at
    // the origin to re-fetch and compare — dereferencing the actor proves only
    // that the actor EXISTS. So anyone at all could Append a Follow naming
    // anyone at all, and we would sign an Accept, deliver it to that person,
    // and send them everything published from then on.
    //
    // Until deliveries terminate somewhere their signature survives, a follow
    // we cannot verify is a REQUEST, waiting in the same queue a gated group
    // uses. The requester's client shows "Requested", which is the ordinary
    // locked-account state that manuallyApprovesFollowers tells it to expect.
    // `autoAcceptFollows: true` in config restores the old behaviour.
    // A GROUP is left alone: `approveJoins: false` is its operator saying, in
    // as many words, that anyone may join, and mute/eject are the remedy there.
    // A person has no such setting, so this is their default.
    const unverifiedNeedsOk = this.config.kind !== 'group' && !this.config.autoAcceptFollows;
    const mustApprove = this.config.approveJoins || unverifiedNeedsOk;
    if (mustApprove && !existing) {
      const reqs = this.store.getRequests();
      if (!reqs.some(r => r.actor === actor)) {
        reqs.unshift({
          actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox,
          activity, at: new Date().toISOString(),
        });
        this.store.setRequests(reqs.slice(0, 500));
        this.store.addNotification({ type: 'follow-request', actor });
      }
      this.log(`join requested: ${actor}`);
      return;
    }
    if (existing) {
      existing.followId = activity.id || existing.followId;   // refollow supersedes
      this.store.setContacts(contacts);
    } else {
      contacts.followers.push({
        actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox, followId: activity.id,
      });
      this.store.setContacts(contacts);
      this.store.addNotification({ type: 'follow', actor });
      await this.publisher.publishCollections({ followers: true });
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
    // Withdrawing a request that was never answered: drop it, or it sits in the
    // operator's queue forever asking about someone who left.
    if (!rec) {
      const reqs = this.store.getRequests();
      if (reqs.some(r => r.actor === actor)) {
        this.store.setRequests(reqs.filter(r => r.actor !== actor));
        this.log(`join request withdrawn: ${actor}`);
      }
      return;
    }
    // An Undo must NAME the Follow it revokes, and name the one we hold.
    //
    // Guarding only the mismatch left the check open to anyone who omitted the
    // id: `undoneId && ...` is false when there is no id, so a three-line
    // unauthenticated POST into the public-Append inbox evicted any follower it
    // named. Nothing else stood in the way — unlike every other inbound type,
    // this path dereferences nothing, so there was no origin to disagree.
    //
    // A follow we hold with no recorded followId predates that bookkeeping;
    // requiring an id we never stored would strand it, so those still pass.
    if (rec.followId && undoneId !== rec.followId) {
      this.log(`Undo from ${actor} does not name the follow we hold `
        + `(revokes ${undoneId || 'nothing'}, current is ${rec.followId}) — ignored`);
      return;
    }
    dropFollower(contacts, actor, 'undo-follow');
    this.store.setContacts(contacts);
    await this.publisher.publishCollections({ followers: true });
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
    if (!inReplyTo) return false;
    if (String(inReplyTo).startsWith(this.urls.notes)) return true;
    // A group also owns the conversation under anything it carried. Without
    // this, a reply that lost the group's mention on its way round the
    // fediverse is refused, and the thread breaks for everyone who was only
    // ever following the group.
    return this.config.kind === 'group'
      && this.store.getStatuses().some(s => s.noteId === String(inReplyTo));
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
    const rejected = await this.ingestNote(objectId, actor);
    if (rejected) return rejected;
    // A group carries its members' posts onward. Only reached from Create, so an
    // inbound Announce is never re-announced. The activity is passed through
    // untouched — FEP-1b12 wants the original wrapped, not a summary of it.
    if (this.config.kind === 'group') await this.amplify(objectId, { activity });
  }

  // Anyone can Append to a public inbox, so arriving is not the same as being
  // carried to every follower. Membership is the gate: you cannot post to a
  // group you have not joined, and declining to carry a member is the only
  // moderation a group can actually enforce.
  async amplify(noteId, { approved = false, activity = null } = {}) {
    const s = this.store.getStatuses().find(x => x.noteId === noteId);
    if (!s) return;
    if (s.announcedAt) return;                      // a re-delivered Create announces once
    const contacts = this.store.getContacts();
    if (!contacts.followers.some(f => f.actor === s.actor)) {
      this.log(`not amplified — ${s.actor} is not a member`);
      return;
    }
    if (this.store.getMuted().actors.includes(s.actor)) {
      this.log(`not amplified — ${s.actor} is muted`);
      return;
    }
    // A reviewed group carries nothing until its operator says so.
    if (this.config.review && !approved) {
      const pending = this.store.getPending();
      if (!pending.some(p => p.noteId === noteId)) {
        // The activity rides along: approving later still has to wrap the one
        // the member actually sent, not a reconstruction of it.
        pending.unshift({ noteId, actor: s.actor, activity, at: new Date().toISOString() });
        this.store.setPending(pending.slice(0, 500));
      }
      this.log(`held for review: ${noteId}`);
      return;
    }
    const held = this.store.getPending().find(p => p.noteId === noteId);
    const inboxes = this.announceTargets(s.actor);
    const { announceActivity } = await import('./wire.mjs');
    // Wrap the member's own activity when we have it; a bare note URL is the
    // fallback, and renders as a plain boost rather than a group carry.
    const act = announceActivity({
      urls: this.urls, object: activity || held?.activity || noteId, serial: this.serial++,
    });
    await this.deliverer.deliverToAll(inboxes, act);
    // Marked carried before recorded: a failed outbox write costs one missing
    // entry, a failed status write would carry the same post twice.
    this.store.updateStatus(noteId, { announcedAt: new Date().toISOString(), announceActivity: act });
    await this.publisher.recordOutbox(act);
    this.store.setPending(this.store.getPending().filter(p => p.noteId !== noteId));
    this.log(`amplified ${noteId} → ${inboxes.length} inbox(es)`);
  }

  // Who an Announce for `author` goes to. Shared with the retract path: an Undo
  // that reached a different set than the Announce did would leave the post
  // standing for whoever the two sets disagreed about.
  // The author's own target is dropped only when it serves nobody else — a
  // shared inbox carries the whole server's members.
  announceTargets(author) {
    const byTarget = new Map();
    for (const f of this.store.getContacts().followers) {
      const t = f.sharedInbox || f.inbox;
      if (!t) continue;
      if (!byTarget.has(t)) byTarget.set(t, new Set());
      byTarget.get(t).add(f.actor);
    }
    return [...byTarget]
      .filter(([, who]) => !(who.size === 1 && who.has(author)))
      .map(([t]) => t);
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
    // The delivering actor was checked on arrival; the author is only known once
    // the note is dereferenced. This is the check that catches a blocked actor
    // reaching us through somebody else's boost, or through a hashtag feed.
    if (this.store.isBlocked(author)) return `blocked author (${author})`;

    // Anyone can Append to a public inbox, so arriving is not the same as
    // belonging in the home timeline. Follow Mastodon's split: people you
    // follow (and their boosts) are HOME; anyone else is a MENTION — kept,
    // notified, readable in the Mentions view, but out of the timeline, and
    // mirror-only so unsolicited content never accumulates in the pod.
    // A group's people are its FOLLOWERS — it follows nobody. Reading the
    // following list for one filed every member's post as a stranger's mention,
    // so nothing reached the pod RDF and each post raised a notification.
    const contacts = this.store.getContacts();
    const known = this.config.kind === 'group'
      ? contacts.followers.some(f => f.actor === author)
      : contacts.following.some(f => f.actor === author && f.accepted);
    const followed = via || known;
    const kind = followed ? 'timeline' : 'mention';

    // `published` comes from a document at someone else's origin, and its first
    // ten characters become the leading component of a storage path. A date is
    // a date or it is not used: a value carrying `../` would otherwise be a
    // remote party choosing where we write.
    const day = String(note.published || '').slice(0, 10);
    const slug = (/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : new Date().toISOString().slice(0, 10)) + '-' +
      (await import('node:crypto')).createHash('sha256').update(note.id).digest('hex').slice(0, 8);
    if (kind === 'timeline') {
      await this.local.writeNote('timeline', slug, {
        noteId: note.id, actor: author, published: note.published, content,
        inReplyTo: note.inReplyTo, attachments,
      });
    }
    // Mastodon carries a thread's mentions into every reply, which is the only
    // reason a reply ever reaches a group. Keep them so our composer can too.
    const mentions = [].concat(note.tag || [])
      .filter(t => t?.type === 'Mention' && t.href && t.name)
      .map(t => ({ href: t.href, name: t.name }));
    this.store.addStatus({
      noteId: note.id, actor: author, content,
      published: note.published, inReplyTo: note.inReplyTo, kind,
      ...(mentions.length ? { mentions } : {}),
      ...(kind === 'timeline' ? { slug } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(via ? { via } : {}),
    });
    if (!followed || (note.inReplyTo && String(note.inReplyTo).startsWith(this.urls.notes))) {
      this.store.addNotification({ type: 'mention', actor: author, noteId: note.id });
    }
    if (note.inReplyTo && String(note.inReplyTo).startsWith(this.urls.notes)) {
      await this.addReply(String(note.inReplyTo), note.id)
        .catch(e => this.log(`replies collection: ${e.message}`));
    }
    this.log(`${kind}: ${note.id}${via ? ` (boosted by ${via})` : ''}`);
  }

  // Is this really gone at its origin? true / false / null when the origin
  // could not be asked. Delivered bodies carry no signature, so this is how a
  // Delete is verified — the same verify-by-dereference the rest of intake uses.
  async isGone(url) {
    let res;
    try { res = await this.deliverer.signedFetch(url, { headers: { accept: ACCEPT_AP } }); }
    catch { return null; }
    if (res.status === 404 || res.status === 410) return true;
    if (res.status < 400) {
      // A Tombstone answers 200 and still means deleted.
      try {
        const { readCapped } = await import('./safefetch.mjs');
        return JSON.parse(await readCapped(res))?.type === 'Tombstone';
      } catch { return false; }
    }
    return null;                       // 401/403/5xx — no answer, not a denial
  }

  // Mastodon sends these constantly; ignoring them left deleted posts standing
  // for good. Two guards, because a forged Delete would otherwise erase anyone's
  // content: it must come from the object's own origin, and the object must
  // really be gone there. An origin we cannot reach is a retry, never a delete.
  async onDelete(activity, actor) {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return 'Delete without object id';
    if (!this.sameOrigin(objectId, actor)) return `Delete crosses origins (${objectId})`;
    // `objectId === actor` is NOT evidence we care: it is true of EVERY account
    // deletion, and Mastodon broadcasts those constantly. Taking it as known
    // meant a signed dereference to a stranger's server for each one.
    if (!this.known(objectId)) return;                    // nothing of ours to remove
    const gone = await this.isGone(objectId);
    if (gone === null) throw new Error(`cannot confirm ${objectId} is gone — will retry`);
    if (!gone) return `Delete for something still published (${objectId})`;

    if (objectId === actor) {                             // the account itself
      const contacts = this.store.getContacts();
      dropFollower(contacts, actor, 'account-deleted');
      contacts.following = contacts.following.filter(f => f.actor !== actor);
      this.store.setContacts(contacts);
      for (const s of this.store.getStatuses().filter(s => s.actor === actor)) {
        await this.forget(s);
      }
      // Both: an account deletion drops them from followers AND following.
      await this.publisher.publishCollections({ followers: true, following: true });
      this.log(`account deleted upstream: ${actor}`);
      return;
    }
    const s = this.store.getStatuses().find(x => x.noteId === objectId);
    if (s) await this.forget(s);
    this.log(`deleted upstream: ${objectId}`);
  }

  // Drop a post we were holding. A group that carried it also unsays its own
  // Announce — forwarding the author's Delete would be signed by us and not by
  // them, which receivers are right to refuse.
  async forget(s) {
    if (s.announceActivity) await this.retract(s.noteId).catch(e => this.log(`retract: ${e.message}`));
    if (s.slug) await this.local.delete(this.local.fedi + 'timeline/' + s.slug).catch(() => {});
    this.store.removeStatus(s.noteId);
  }

  // Undo an Announce this group made. Shared with the operator's `retract`.
  async retract(noteId) {
    const s = this.store.getStatuses().find(x => x.noteId === noteId);
    if (!s) throw new Error('no such post');
    if (!s.announceActivity) throw new Error('that post was never carried');
    const { undoActivity } = await import('./wire.mjs');
    const inboxes = this.announceTargets(s.actor);
    await this.deliverer.deliverToAll(inboxes,
      undoActivity({ urls: this.urls, activity: s.announceActivity, serial: this.serial++ }));
    await this.publisher.unrecordOutbox(i => i?.id === s.announceActivity.id);
    this.store.updateStatus(noteId, {
      announcedAt: undefined, announceActivity: undefined, retractedAt: new Date().toISOString(),
    });
    return { ok: true, noteId, inboxes: inboxes.length };
  }

  // An edited post, or a changed profile. Verified the only way we can: by
  // refetching at the origin and believing that, not the delivered copy.
  async onUpdate(activity, actor) {
    const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!objectId) return 'Update without object id';
    if (!this.sameOrigin(objectId, actor)) return `Update crosses origins (${objectId})`;
    if (objectId === actor) {                             // display name, avatar, bio
      // The same guard onDelete has, for the same reason: the inbox is
      // public-Append, so without it anyone can name any host and make us spend
      // a signed GET on it — and because the failure below THROWS rather than
      // returning a rejection, one planted item buys five of them, plus five
      // pod reads and the head of the inbox held for five sweeps.
      if (!this.known(actor)) return;                     // nothing of ours to update
      const doc = await this.fetchAP(actor);
      if (!doc) throw new Error(`cannot refetch ${actor} — will retry`);
      this.store.cacheActor(actor, doc);                  // fetchAP caches Persons; Groups too
      this.log(`profile updated: ${actor}`);
      return;
    }
    const s = this.store.getStatuses().find(x => x.noteId === objectId);
    if (!s) return;                                       // not one we hold
    const note = await this.fetchAP(objectId);
    if (!note) throw new Error(`cannot refetch ${objectId} — will retry`);
    if (note.id !== objectId || note.type !== 'Note') return `object not a verifiable Note (${objectId})`;
    const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
    const content = sanitizeHtml(note.content);
    const attachments = attachmentsOf(note);
    this.store.updateStatus(objectId, {
      content, ...(attachments.length ? { attachments } : {}), editedAt: new Date().toISOString(),
    });
    if (s.slug) {
      await this.local.writeNote('timeline', s.slug, {
        noteId: note.id, actor: s.actor, published: note.published, content,
        inReplyTo: note.inReplyTo, attachments,
      }).catch(e => this.log(`rewrite ${s.slug}: ${e.message}`));
    }
    this.log(`edited upstream: ${objectId}`);
  }

  // Read-modify-write, and the drain is serialized, so two replies in one sweep
  // do not race. Nothing else writes this document.
  async addReply(parentId, replyId) {
    const { repliesId, collection } = await import('./wire.mjs');
    const url = repliesId(parentId);
    // Deliberately NOT caught: a read we could not make is not an empty
    // collection, and rewriting on top of one erases every reply already
    // recorded. getJson returns null only for a genuine 404 — the document does
    // not exist yet — and throws otherwise, which the caller logs and retries.
    const cur = await this.remote.getJson(url);
    const items = Array.isArray(cur?.items) ? cur.items : [];
    if (items.includes(replyId)) return;
    items.push(replyId);
    await this.remote.putJson(url, collection(url, items));
    this.log(`reply recorded on ${parentId}`);
  }

  async onAccept(activity, actor) {
    const contacts = this.store.getContacts();
    const rec = contacts.following.find(f => f.actor === actor);
    if (rec && !rec.accepted) {
      rec.accepted = true;
      this.store.setContacts(contacts);
      await this.publisher.publishCollections({ following: true });
      this.log(`follow accepted by ${actor}`);
    }
  }
}
