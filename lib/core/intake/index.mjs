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
//
// This file is the drain and the dispatcher. What it does with an activity
// once it has one is in the modules beside it — activity.mjs (what an activity
// is), channel.mjs (the push socket), verify.mjs (what to believe),
// activities.mjs (one handler per type), group.mjs (FEP-1b12), notes.mjs (a
// note on its way in) — each a set of functions taking the Intake as their
// first argument, reached here through one-line delegations so that every
// caller, and every test that overrides a method, sees one object.

import * as podInbox from '../../pod/inbox.mjs';
import { readCapped } from '../../shared/safefetch.mjs';
import { trimActivity, sameIdentity, sameOrigin, httpUrl, MAX_ITEM_BYTES, MAX_FORWARDS_PER_DRAIN } from './activity.mjs';
import * as channel from './channel.mjs';
import * as verify from './verify.mjs';
import * as group from './group.mjs';
import * as activities from './activities.mjs';
import * as notes from './notes.mjs';
export { isContentType, trimActivity, sameIdentity, sameOrigin, sameSocketOrigin, httpUrl, authorOf } from './activity.mjs';

const POLL_MS = 2 * 60_000;      // fallback cadence when there is no push
// With a live socket the poll is pure redundancy: it exists for the case where
// push is down, so it slows right down while push is up.
const POLL_PUSH_OK_MS = 10 * 60_000;
// A container that times out will time out again in two minutes, and each
// attempt holds one of the pod's workers for the full timeout. Sweeping stops
// for a while instead, doubling up to half an hour.
const DRAIN_COOLDOWN_MIN_MS = 2 * 60_000;
const DRAIN_COOLDOWN_MAX_MS = 30 * 60_000;
// Our DELETEs take the same container write lock as the deliveries arriving
// into it — a gap between them keeps a sweep from convoying against inbound.
const DELETE_GAP_MS = 150;
const CHAIN_GAP_MS = 5_000;      // pause between chained backlog sweeps
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

export class Intake {
  constructor({ config, urls, remote, store, deliverer, publisher, log = console.log, lease = null, archive = null, push = true, pollSeconds = null }) {
    Object.assign(this, { config, urls, remote, store, deliverer, publisher, log, lease, archive, push, pollSeconds });
    this.serial = Date.now();
    this.stopped = false;
    // (attempt counts are kept in pod state — see _bumpAttempt)
    this.lastDrain = null;
    this._forwardBudget = MAX_FORWARDS_PER_DRAIN;
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

  // Sweep cadence: a configured interval wins, otherwise a live push channel —
  // a notification socket, or the store's own change events in-process — is
  // what makes the fallback poll a slow one.
  _pollMs() {
    if (this.pollSeconds) return this.pollSeconds * 1000;
    return this.wsState === 'open' || this.wsState === 'in-process' ? POLL_PUSH_OK_MS : POLL_MS;
  }

  async start() {
    this.stopped = false;                     // restartable across demote/takeover cycles
    await this.drain().catch(e => this.log(`drain: ${e.message}`));
    const tick = () => {
      this.pollTimer = setTimeout(() => {
        this.drain().catch(e => this.log(`drain: ${e.message}`)).finally(() => { if (!this.stopped) tick(); });
      }, Math.round(this._pollMs() * (0.85 + Math.random() * 0.3)));
      this.pollTimer.unref?.();
    };
    tick();
    // Embedded in the pod server, a notification socket back to that same
    // server buys nothing — the store's own change events wake the drain.
    if (this.push) this.subscribe().catch(e => this.log(`subscribe: ${e.message}`));
    else this.wsState = 'in-process';
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

  // --- drain + dispatch ---
  // Serialized: push events, polls, and manual /drain calls can fire
  // concurrently, and overlapping sweeps double-process items (observed as
  // duplicate Accepts/timeline writes). One sweep at a time; callers that
  // arrive mid-sweep get one follow-up sweep.
  async drain() {
    if (this._draining) { this._drainAgain = true; return this._draining; }
    // Held for the whole sweep, released however it ends. The debounce cannot
    // coalesce a drain — every handler awaits somebody else's server first — so
    // the writes are left to the commit boundaries the drain already has. See
    // PodStore.hold.
    // Optional: this is a throughput hint, not part of the commit-before-delete
    // invariant — commit() flushes whatever is pending either way — so a store
    // that does not implement it behaves exactly as before.
    this._inSweep = true;
    // Fresh per sweep: the cap is on how much this drain may amplify, not a
    // lifetime total (see _maybeForward).
    this._forwardBudget = MAX_FORWARDS_PER_DRAIN;
    this.store.hold?.();
    this._draining = this._drainOnce().finally(async () => {
      this._inSweep = false;
      await this._publishPending();
      this.store.release?.();
      this._draining = null;
      if (this._drainAgain) {
        this._drainAgain = false;
        // Paced, not immediate: chained sweeps put a ceiling on work per unit
        // time, so a delivery flood cannot run the drain back-to-back.
        const t = setTimeout(() => this.drain().catch(e => this.log(`drain: ${e.message}`)), CHAIN_GAP_MS);
        t.unref?.();
      }
    });
    return this._draining;
  }

  // Discard the content waiting in the inbox from before `before`, on the
  // owner's say-so — the admin page asks, this does it. NOT a blind sweep:
  // every item is read, because the type is the only thing that decides its
  // fate and size does not predict it. A Follow, Undo, Accept or Delete is
  // APPLIED whatever it weighs, so the follow graph stays correct and a post
  // its author retracted still goes; only a Create is dropped. Judging by size
  // instead saved one request per item and lost any control activity that
  // happened to be large, silently and permanently.
  //
  // An item past the drain's own byte cap is deleted unread: it could not be
  // handled if it were read, so there is nothing to lose by not reading it.
  //
  // `keepConcerning` narrows the discard to noise: every item is passed to
  // handle(), which ingests a Create only when concernsUs passes — addressed to
  // us, a mention, a reply to ours, or from someone we follow — and drops the
  // rest.
  async prune({ before, keepConcerning = false } = {}) {
    const cutoff = Date.parse(before);
    if (!Number.isFinite(cutoff)) throw new Error(`"${before}" is not a date`);
    const all = await podInbox.list(this.remote, this.urls);
    const older = all.filter(e => !e.url.endsWith('.keep')
      && e.modified && Date.parse(e.modified) < cutoff);
    const out = { considered: older.length, applied: 0, dropped: 0, discarded: 0, failed: 0 };

    for (const item of older) {
      try {
        if (item.size > MAX_ITEM_BYTES) {
          await podInbox.dropHandledItem(this.remote, item.url);   // unreadable by the drain either way
          out.discarded++;
        } else {
          // Same rule as the drain: a read we could not make is not a Create to
          // be dropped. readItem throws on anything but 404, so it counts as
          // failed and stays for the next pass.
          const got = await podInbox.readItem(this.remote, item.url, { maxBytes: MAX_ITEM_BYTES, readCapped });
          const activity = got.raw === null ? null : (() => { try { return JSON.parse(got.raw); } catch { return null; } })();
          // A Create is the content the owner just asked to be rid of. Anything
          // else changes state and is applied exactly as a drain would.
          if (keepConcerning) {
            const rejection = activity ? await this.handle(activity) : 'unparsable JSON';
            if (rejection) out.dropped++; else out.applied++;
          } else if (activity && activity.type !== 'Create') {
            await this.handle(activity);
            out.applied++;
          } else {
            out.dropped++;
          }
          if (!await this._persisted()) {
            this.log(`state not written — stopping the prune with ${older.length - out.applied - out.dropped - out.discarded} left`);
            break;
          }
          await podInbox.dropHandledItem(this.remote, item.url);
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

  // The sender's original bytes, kept after the activity was verified and
  // applied and before the pod DELETE erases the only other copy. The filename
  // is the content's own hash, so a re-delivered activity lands on the same
  // file instead of duplicating. Best-effort history: a failed write logs and
  // the drain goes on — mail must never stall on its own receipt. This is the
  // one category of account data that lives only in the private half; the pod
  // cannot rebuild it because the pod never kept it.
  //
  // The record is JSON-LD: a cnt:ContentAsText whose cnt:chars are the raw
  // bytes, stamped prov:generatedAtTime / prov:wasDerivedFrom / as:actor —
  // plain JSON to everything here, a graph to any RDF reader.
  async _archive(sourceUrl, raw, activity) {
    try {
      if (!this.archive || this.store.getConfig()?.archiveInbox === false) return;
      const { createHash } = await import('node:crypto');
      const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
      const receivedAt = new Date().toISOString();
      const rec = {
        '@context': {
          prov: 'http://www.w3.org/ns/prov#',
          cnt: 'http://www.w3.org/2011/content#',
          as: 'https://www.w3.org/ns/activitystreams#',
          xsd: 'http://www.w3.org/2001/XMLSchema#',
          receivedAt: { '@id': 'prov:generatedAtTime', '@type': 'xsd:dateTime' },
          source: { '@id': 'prov:wasDerivedFrom', '@type': '@id' },
          actor: { '@id': 'as:actor', '@type': '@id' },
          raw: 'cnt:chars',
        },
        '@id': '',
        '@type': 'cnt:ContentAsText',
        receivedAt,
        actor: typeof activity?.actor === 'string' ? activity.actor : activity?.actor?.id || null,
        source: sourceUrl,
        raw,
      };
      const w = await this.archive.write(`${receivedAt.slice(0, 7)}/${hash}.json`,
        JSON.stringify(rec, null, 2), 'application/ld+json');
      if (!w.ok) this.log(`inbox archive: ${w.why || 'write failed'}`);
    } catch (e) {
      this.log(`inbox archive: ${e.message}`);
    }
  }

  async _drainOnce() {
    const cooling = this.drainCooldownUntil - Date.now();
    if (cooling > 0) {
      this.log(`inbox sweep skipped — backing off for another ${Math.ceil(cooling / 1000)}s`);
      return;
    }
    // Draining DELETES from the pod, so it must not run on a lease that has
    // quietly expired. renewOnce notices at its own cadence — up to ~117s — and
    // after the TTL another agent is entitled to start draining the same inbox.
    if (this.lease && !this.lease.stillHeld()) {
      this.log('lease is no longer held — not draining');
      return;
    }
    this.lastDrain = new Date().toISOString();
    this.lastDrainAtMs = Date.now();
    this._pruneAttempts();
    let all;
    try {
      all = await podInbox.list(this.remote, this.urls);
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
        if (!await podInbox.dropHandledItem(this.remote, url)) {
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

    for (const { url, size } of items) {
      if (url.endsWith('.keep')) continue;
      // The listing already carries every child's size, so this costs nothing
      // to ask. An activity is a few kB; anything of this order is not one, and
      // reading it with an unbounded res.text() buffers whatever a stranger
      // chose to Append into memory.
      // A cheap pre-filter only: listContainer coerces a missing posix:size to
      // 0, so a pod that does not publish sizes would wave everything through.
      // The real bound is readCapped on the body below.
      if (size > MAX_ITEM_BYTES) {
        this.store.addDeadLetter({ inboxUrl: url, reason: `oversized (${size} bytes)`, activity: null });
        pending.push(url);
        continue;
      }
      let activity = null;
      try {
        const got = await podInbox.readItem(this.remote, url, { maxBytes: MAX_ITEM_BYTES, readCapped });
        // readItem carries the rule that matters here: a pod that would not
        // GIVE us the item has told us nothing about it, so anything but a 404
        // throws rather than reading as an empty body. Reading a 500 as empty
        // made it "unparsable JSON" — a REJECTION, dead-lettered with both
        // `activity` and `raw` null and then DELETEd, destroying a delivery on
        // a transient fault with no record of what it had been.
        const raw = got.raw;
        try { activity = raw ? JSON.parse(raw) : null; } catch { /* kept raw for the dead letter */ }
        // A gateway that verified this delivery left a receipt beside it. Read
        // it only when a gateway is configured (no config → no fetch, so an
        // install with no gateway pays nothing); a missing or HMAC-invalid
        // receipt reads as null, which is exactly today's unverified behavior.
        const receipt = activity ? await this._readReceipt(url) : null;
        if (activity && this.gatewaySecret()) this._bumpGatewayStat(!!receipt?.verified);
        const rejection = activity ? await this.handle(activity, receipt) : 'unparsable JSON';
        if (!rejection && raw) await this._archive(url, raw, activity);
        if (!rejection) await this._maybeForward(activity);    // §7.1.2, only what we accepted
        if (rejection) {
          this.store.addDeadLetter({
            inboxUrl: url, reason: rejection, activity: trimActivity(activity),
            ...(activity ? {} : { raw: raw?.slice(0, 2000) ?? null }),
          });
          this.log(`rejected (${rejection}) — dead-lettered: ${url}`);
        }
        pending.push(url);
      } catch (e) {
        const n = this._bumpAttempt(url, e.message);
        this.log(`inbox item ${url} attempt ${n}/${MAX_ITEM_ATTEMPTS}: ${e.message}`);
        if (n >= MAX_ITEM_ATTEMPTS) {
          this.store.addDeadLetter({ inboxUrl: url, reason: `failed ${n}x: ${e.message}`, activity: trimActivity(activity) });
          // The dead letter IS the record of this item — deleting before it is
          // written down would lose the only evidence it ever arrived, so it
          // goes through the same commit-then-delete batch as everything else.
          pending.push(url);
        }
      }
      if (pending.length >= DELETE_BATCH && !await flush()) return;
    }
    if (!await this._finishSweep(flush)) return;
    // Made progress and there is more waiting: go straight round rather than
    // sleeping. Gated on progress so a sweep that achieved nothing — a
    // cooldown, an unwritable store, poison at the head — cannot spin.
    if (handled > 0 && all.length > items.length && !this.stopped) this._drainAgain = true;
  }

  // The end of a sweep: publish whatever the follow graph did ONCE, then flush.
  //
  // publishCollections used to run per handled item — every Follow, Undo,
  // Accept, Reject, admit and eject — and each one is a full GET of the pod's
  // followers collection plus a PUT of it. Fifty follows in a sweep were a
  // hundred requests where two would do, and the answer they arrive at is the
  // same either way, because it is built from contacts.json in memory.
  async _finishSweep(flush) {
    await this._publishPending();
    return flush();
  }

  // Idempotent: it clears what it takes, so the drain's own exit path calling
  // it again after a sweep that bailed early — an unwritable store, a delete
  // that failed — is a no-op in the ordinary case and the difference between
  // "published" and "waiting for a sweep that may never come" in the other.
  async _publishPending() {
    const want = this._republish;
    this._republish = null;
    if (!want) return;
    try { await this.publisher.publishCollections(want); }
    catch (e) { this.log(`publishing collections: ${e.message}`); }
  }

  // Ask for a collection to be republished at the end of this sweep. Outside a
  // sweep there is no boundary to wait for, so it happens now.
  async republish(which) {
    if (!this._inSweep) return this.publisher.publishCollections(which);
    this._republish = { ...(this._republish || {}), ...which };
  }

  sameOrigin(a, b) { return sameOrigin(a, b); }
  // Overridable in tests the same way sameOrigin is.
  sameIdentity(a, b) { return sameIdentity(a, b); }

  async handle(activity, receipt = null) {   // eslint-disable-line no-unused-vars
    const actor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (!actor) return 'no actor';
    // An actor is a URL that can be dereferenced. Most arms here go on to fetch
    // it, and safefetch refuses a bad scheme there — but Like and Announce on
    // one of our own notes record a notification without dereferencing
    // anything, so `javascript:` and `data:` reached the client as an account
    // url. The store already guards avatars this way (safeUrl); actors were
    // simply never put through it.
    if (!httpUrl(actor)) return `actor is not an http(s) URL (${actor})`;
    if (this.store.isBlocked(actor)) return `blocked sender (${actor})`;

    // Whether the door vouched for this sender — read by the moderation queue
    // just below as well as by the arms further down, so it is settled here,
    // before its first use.
    const trusted = this.receiptVouchesFor(receipt, actor)
      && this.store.getConfig()?.gateway?.mode === 'trust';

    // FEP-1b12 moderation from a LISTED moderator. A delivery proves nothing
    // about its sender, which is why these are QUEUED for the operator rather
    // than run on arrival — the queue is where a claimed moderator's word
    // waits for the one person who can vouch for it. Everything else about
    // the activity falls through to the ordinary arms.
    if (this.config.kind === 'group'
      && (this.config.moderators || []).includes(actor)
      && this.isModerationAsk(activity)) {
      return this.queueModeration(activity, actor, { trusted });
    }

    // `trusted` was settled above, before the moderation queue reads it. Why it
    // is not simply `receipt.verified`: that says the door checked a signature
    // and the signature was good; it does NOT say whose. The door reports the
    // signing key's owner separately, in `receipt.actor`, and nothing here used
    // to read it — so ANY valid fediverse signing key, over an activity whose
    // `actor` field named someone else entirely, arrived as trusted. In trust
    // mode that is one delivery to evict any of your followers, or to have a
    // Follow naming a third party auto-accepted. See receiptVouchesFor, which
    // also holds the keyId to the actor's origin: a key document is fetched
    // from wherever its id points, so one hosted elsewhere that merely CLAIMS
    // `owner: <you>` would otherwise bind.

    switch (activity.type) {
      case 'Follow': return this.onFollow(activity, actor, { trusted });
      case 'Undo': return this.onUndo(activity, actor, { trusted });
      case 'Create': return this.onCreate(activity, actor);
      case 'Accept': return this.onAccept(activity, actor, { trusted });
      case 'Like': case 'Announce': {
        // FEP-1b12: a group Announces the member's whole Create, not the note.
        // Without unwrapping we try to ingest a Create as if it were a Note and
        // dead-letter every post a group ever carries — including our own.
        const wrapped = activity.object;
        // FEP-1b12: a group announces its moderation too. The one act a
        // follower can honor without trusting anyone new is a Delete of a
        // post that same group carried to us — the carrier unsaying its carry.
        if (activity.type === 'Announce' && wrapped && typeof wrapped === 'object'
          && wrapped.type === 'Delete') {
          return this.onAnnouncedDelete(actor, wrapped);
        }
        const inner = (wrapped && typeof wrapped === 'object'
          && (wrapped.type === 'Create' || wrapped.type === 'Update')) ? wrapped.object : wrapped;
        const objectId = typeof inner === 'string' ? inner : inner?.id;
        this.log(`${activity.type} from ${actor} on ${objectId}`);
        if (objectId && objectId.startsWith(this.urls.notes)) {
          // Nothing vouches for this actor: a Like carries no signature and,
          // unlike a Create, has no object at the sender's origin to re-read.
          // `known()` is answered from local state and costs nothing — a
          // stranger's favourite is still recorded, it is just the first thing
          // the cap evicts, so a flood cannot push out real history.
          this.store.addNotification({
            type: activity.type === 'Like' ? 'favourite' : 'reblog', actor, noteId: objectId,
            ...(this.known(actor) ? {} : { unverified: true }),
          });
          return;
        }
        if (activity.type === 'Announce') return this.onAnnounce(activity, actor, objectId);
        return;
      }
      case 'Delete': return this.onDelete(activity, actor);
      case 'Update': return this.onUpdate(activity, actor);
      case 'Reject': return this.onReject(activity, actor, { trusted });
      case 'Move': return this.onMove(activity, actor);
      case 'Add': case 'Remove': return this.onAddRemove(activity, actor);
      default: this.log(`ignored ${activity.type} from ${actor}`);
    }
  }

  // channel.mjs
  _reconnectDelay(...a) { return channel.reconnectDelay(this, ...a); }
  subscribe(...a) { return channel.subscribe(this, ...a); }
  _storageDescriptionUrl(...a) { return channel.storageDescriptionUrl(this, ...a); }
  _subscribeOnce(...a) { return channel.subscribeOnce(this, ...a); }
  _openSocket(...a) { return channel.openSocket(this, ...a); }

  // verify.mjs
  fetchAP(...a) { return verify.fetchAP(this, ...a); }
  known(...a) { return verify.known(this, ...a); }
  gatewaySecret(...a) { return verify.gatewaySecret(this, ...a); }
  _bumpGatewayStat(...a) { return verify.bumpGatewayStat(this, ...a); }
  _readReceipt(...a) { return verify.readReceipt(this, ...a); }
  receiptVouchesFor(...a) { return verify.receiptVouchesFor(this, ...a); }
  isGone(...a) { return verify.isGone(this, ...a); }

  // group.mjs
  isModerationAsk(...a) { return group.isModerationAsk(this, ...a); }
  queueModeration(...a) { return group.queueModeration(this, ...a); }
  amplify(...a) { return group.amplify(this, ...a); }
  isCoMember(...a) { return group.isCoMember(this, ...a); }
  collectionMembers(...a) { return group.collectionMembers(this, ...a); }
  announceTargets(...a) { return group.announceTargets(this, ...a); }

  // activities.mjs
  onAddRemove(...a) { return activities.onAddRemove(this, ...a); }
  onFollow(...a) { return activities.onFollow(this, ...a); }
  onUndo(...a) { return activities.onUndo(this, ...a); }
  onCreate(...a) { return activities.onCreate(this, ...a); }
  onAnnouncedDelete(...a) { return activities.onAnnouncedDelete(this, ...a); }
  onAnnounce(...a) { return activities.onAnnounce(this, ...a); }
  onDelete(...a) { return activities.onDelete(this, ...a); }
  onUpdate(...a) { return activities.onUpdate(this, ...a); }
  onReject(...a) { return activities.onReject(this, ...a); }
  onMove(...a) { return activities.onMove(this, ...a); }
  onAccept(...a) { return activities.onAccept(this, ...a); }

  // notes.mjs
  concernsUs(...a) { return notes.concernsUs(this, ...a); }
  _maybeForward(...a) { return notes.maybeForward(this, ...a); }
  _referencesOurObject(...a) { return notes.referencesOurObject(this, ...a); }
  ingestNote(...a) { return notes.ingestNote(this, ...a); }
  forget(...a) { return notes.forget(this, ...a); }
  retract(...a) { return notes.retract(this, ...a); }
  addReply(...a) { return notes.addReply(this, ...a); }
}
