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
import { PUBLIC } from './wire.mjs';
import { HTTP_TIMEOUT_MS } from './safefetch.mjs';
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
// A note's replies collection is rewritten WHOLE every time one is added, so
// without a cap the bytes are quadratic in a number a stranger chooses.
const MAX_REPLIES_RECORDED = 500;
// How many posts may wait for a group operator's decision. A ceiling, not a
// window: full refuses the newest rather than dropping the oldest.
const MAX_PENDING_REVIEW = 500;
// A group's membership, cached: it changes when someone joins or leaves, and
// re-reading it on every arriving post would spend one stranger's fetch per
// message on a list that moves in days.
const CO_MEMBER_TTL_MS = 24 * 60 * 60_000;
const CO_MEMBER_MAX = 5000;
// An activity is a few kB. This is generous by two orders of magnitude and
// still bounds what one Append can make us hold in memory.
const MAX_ITEM_BYTES = 512 * 1024;
// The AS2 actor types. A group is as much an actor as a person is.
const ACTOR_TYPES = new Set(['Person', 'Group', 'Service', 'Application', 'Organization']);
// The AS2 types the fediverse actually posts. `Note` alone is Mastodon's world
// and not the fediverse's: an Article is a Plume or WriteFreely post, a
// Question is a poll, a Video is PeerTube, a Page is Lemmy, an Audio is
// Funkwhale. Insisting on Note dead-lettered every one of them as "not a
// verifiable Note" — from people the owner had chosen to follow, silently.
//
// They share the shape this code reads: attributedTo, content, published,
// inReplyTo, tag, attachment. A poll's options are dropped, which is a
// degraded rendering rather than a lost post.
const CONTENT_TYPES = new Set(['Note', 'Article', 'Question', 'Page', 'Video', 'Audio', 'Image', 'Event']);

// A Question is a poll: its options live in oneOf (pick one) or anyOf (pick
// several), each carrying the tally its author's server maintains.
// Custom emojis ride the tag list; the images live at the author's server and
// the client fetches them from there.
function emojisOf(note) {
  return [].concat(note?.tag || [])
    .filter(t => t?.type === 'Emoji' && t.icon?.url && t.name)
    .map(t => ({ shortcode: String(t.name).replace(/^:|:$/g, ''), url: String(t.icon.url) }));
}

function pollOf(note) {
  const opts = note?.oneOf || note?.anyOf;
  if (!Array.isArray(opts) || !opts.length) return null;
  return {
    multiple: !!note.anyOf,
    expiresAt: note.endTime || null,
    closed: !!note.closed,
    options: opts.map(o => ({
      title: String(o?.name ?? ''),
      votes: Number(o?.replies?.totalItems) || 0,
    })),
  };
}
export const isContentType = (t) => CONTENT_TYPES.has(t);
const ACCEPT_AP = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// Is this socket URL the pod's own? The scheme has to be the socket form of the
// pod's — wss for https, ws for http — so a downgrade to plaintext from an https
// pod is somewhere else, not the same place unencrypted.
//
// The host may be the pod's, or a PARENT of it. Not a loosening for
// convenience: a CSS server that gives every pod a subdomain answers
// notifications from the server root, so jeff-zucker.teamid.live is served by
// wss://teamid.live/.notifications/… — which is the deployment this project
// actually runs on. Requiring an exact match dropped it to polling, and the
// live agents are how that was found rather than the suite.
//
// A sibling subdomain is still refused: only a suffix of our own host passes,
// and two labels minimum so `.live` cannot pose as everyone's parent. Not a
// public-suffix list — that is a dependency and a data file to keep current,
// and the party this guards against is the pod you already chose to trust.
export function sameSocketOrigin(socketUrl, podBase) {
  let s, p;
  try { s = new URL(socketUrl); p = new URL(podBase); } catch { return false; }
  if (s.protocol !== (p.protocol === 'https:' ? 'wss:' : 'ws:')) return false;
  if (s.host === p.host) return true;
  const parent = s.hostname.toLowerCase();
  return parent.split('.').length >= 2
    && s.port === p.port
    && p.hostname.toLowerCase().endsWith('.' + parent);
}

export function httpUrl(u) {
  try {
    const p = new URL(String(u)).protocol;
    return p === 'https:' || p === 'http:';
  } catch { return false; }
}

// Who a note is BY. A document may only speak for an actor at its own origin.
// `attributedTo` used to be taken at face value, so a note served anywhere
// could name anyone: one at a host the attacker controls, claiming to be by
// someone the owner follows, passed every check we had — the envelope's
// sameOrigin compares the ACTIVITY to its object, never the object to its
// author — and landed in the home timeline and in the pod as them. For a group
// it went further still, because amplify() gates on the author's membership,
// so the group signed an Announce of it and delivered it to every member.
//
// `delivered` is the actor that brought it, used only when the note names no
// author of its own; it has to clear the same test, which is why a boost of an
// unattributed note is refused rather than credited to the booster.
//
// Returns the author, or null when nothing at the note's origin vouches for one.
export function authorOf(note, delivered = null) {
  const claimed = [].concat(note?.attributedTo || [])
    .map(a => (typeof a === 'string' ? a : a?.id)).find(Boolean) || null;
  const author = claimed || delivered;
  if (!author) return null;
  return sameOrigin(note?.id, author) ? author : null;
}

export class Intake {
  constructor({ config, urls, remote, local, store, deliverer, publisher, log = console.log, lease = null }) {
    Object.assign(this, { config, urls, remote, local, store, deliverer, publisher, log, lease });
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
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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

  // The socket URL arrives in the pod's own subscription response, and it was
  // the one outbound address in the project that reached the network without
  // passing anything — safefetch guards every fetch, and `new WebSocket()` is
  // not a fetch. A pod that answered with somebody else's address had us open a
  // long-lived connection there and treat what came back as our inbox waking up.
  //
  // Same origin as the pod, not assertPublicUrl: a pod on this machine is a
  // documented setup and its socket is legitimately ws://localhost:3000, which
  // a public-address check would refuse.
  _openSocket(receiveFrom, reused) {
    if (!sameSocketOrigin(receiveFrom, this.urls.base)) {
      this.wsState = 'refused';
      this.log(`subscription named ${receiveFrom}, which is not this pod — polling only`);
      if (reused) this.store.write(CHANNEL_DOC, null);
      return;
    }
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
    // Held for the whole sweep, released however it ends. The debounce cannot
    // coalesce a drain — every handler awaits somebody else's server first — so
    // the writes are left to the commit boundaries the drain already has. See
    // PodStore.hold.
    // Optional: this is a throughput hint, not part of the commit-before-delete
    // invariant — commit() flushes whatever is pending either way — so a store
    // that does not implement it behaves exactly as before.
    this._inSweep = true;
    this.store.hold?.();
    this._draining = this._drainOnce().finally(async () => {
      this._inSweep = false;
      await this._publishPending();
      this.store.release?.();
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
        const res = await this.remote.fetch(url, { headers: { accept: '*/*' } });
        // A pod that would not GIVE us the item has told us nothing about it.
        // Reading a 500 as an empty body made it "unparsable JSON", which is a
        // REJECTION: dead-lettered with both `activity` and `raw` null, and then
        // DELETEd — a delivery destroyed by a transient fault, with no record of
        // what it was. Throwing puts it on the retry path the header promises.
        // 404 is the exception: the item is already gone, so deleting is right.
        if (res.status >= 400 && res.status !== 404) throw new Error(`inbox item GET → ${res.status}`);
        // Capped rather than res.text(): the listing's size is advisory, and the
        // inbox is public-Append, so the body is whatever a stranger chose.
        const { readCapped } = await import('./safefetch.mjs');
        const raw = res.status < 400 ? await readCapped(res, MAX_ITEM_BYTES) : null;
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
    // Under the id the document CLAIMS, but only when its own origin vouches
    // for that id. A stranger's actor document naming someone else's id used to
    // overwrite that actor's cached name, bio, avatar and Person/Group flag —
    // one appended Follow was enough, and the id-mismatch checks in onFollow
    // and ingestNote both run after this line and never undid it.
    //
    // Same origin rather than exact equality: signedFetch follows redirects
    // without reporting where it landed, so a server that redirects its own
    // canonical actor URL would otherwise stop being cached at all.
    if (ACTOR_TYPES.has(doc?.type) && doc.id && sameOrigin(doc.id, url)) {
      this.store.cacheActor(doc.id, doc);
    }
    return doc;
  }

  sameOrigin(a, b) { return sameOrigin(a, b); }

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
    // An actor is a URL that can be dereferenced. Most arms here go on to fetch
    // it, and safefetch refuses a bad scheme there — but Like and Announce on
    // one of our own notes record a notification without dereferencing
    // anything, so `javascript:` and `data:` reached the client as an account
    // url. The store already guards avatars this way (safeUrl); actors were
    // simply never put through it.
    if (!httpUrl(actor)) return `actor is not an http(s) URL (${actor})`;
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
      case 'Reject': return this.onReject(activity, actor);
      case 'Move': return this.onMove(activity, actor);
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
      // Deliberately NOT updating followId. An inbound Follow is unverifiable —
      // that is what the queue above exists for — so letting one rewrite the id
      // of a follower we already hold hands an attacker the exact value onUndo
      // matches on: POST a Follow naming any follower in the published
      // collection, then POST an Undo naming the id you just chose, and they are
      // gone permanently. A genuine refollow needs nothing from us but the
      // Accept below, which is idempotent.
    } else {
      contacts.followers.push({
        actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox, followId: activity.id,
      });
      this.store.setContacts(contacts);
      this.store.addNotification({ type: 'follow', actor });
      await this.republish({ followers: true });
      this.log(`new follower: ${actor}`);
    }
    const { acceptActivity } = await import('./wire.mjs');
    await this.deliverer.deliver(doc.inbox,
      acceptActivity({ urls: this.urls, followActivity: activity, serial: this.serial++ }));
    this.log(`Accept sent → ${doc.inbox}`);
  }

  async onUndo(activity, actor) {
    // AS2 allows `object` to be a bare IRI, and that IRI is exactly the Follow
    // id we stored. Reading `.type` off a string gives undefined, so the whole
    // Undo was dropped — silently, since handle() reads that as handled, so no
    // dead letter was kept and the item was DELETEd. The follower stayed, we
    // kept delivering to them, and their server had recorded the unfollow as
    // done and would never resend. Only a TYPED non-Follow is not ours.
    if (typeof activity.object === 'object' && activity.object?.type
        && activity.object.type !== 'Follow') return;
    // And it must NAME something. Widening the type test to admit a bare IRI
    // also admitted `object: undefined`, `null` and `{}` — which land on the
    // no-followId carve-out below and evict, which is the very hole the
    // followId check was added to close. An Undo that identifies nothing is
    // not an Undo of ours.
    const named = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    if (!named) return;
    // Deliveries arrive unordered: an Undo may land AFTER the refollow it
    // predates. It names the Follow id it revokes — only honor it when it
    // matches the follow we currently hold for that actor.
    const undoneId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
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
    // The follow id is the ONLY thing binding an Undo to the follower. LDN
    // bodies carry no signature, and unlike every other inbound type this path
    // dereferences nothing, so there is no origin to disagree. Matching works
    // because the id was chosen by their server and delivered in a Follow we
    // accepted: we publish the followers collection, but never the ids.
    //
    // Which means a record with NO id cannot be matched at all — and the
    // carve-out that used to let those through turned "we cannot tell" into
    // "anyone may evict". reconcileFollowers writes exactly such records when a
    // restored machine recovers its followers from the pod, so after a restore
    // every follower could be removed by one unauthenticated POST, permanently:
    // dropFollower leaves a mark and the next reconcile will not bring them
    // back, their server recorded no unfollow so it never resends, and neither
    // side has anything to notice.
    //
    // Unmatchable is refused now. The cost is a follower who really did leave
    // staying on the list until the operator ejects them, which is the right way
    // round: `eject` is one command, and the alternative was silent, permanent,
    // and available to anyone.
    if (!rec.followId) {
      this.log(`Undo from ${actor} cannot be matched — this follower was `
        + `${rec.recovered ? 'recovered from the pod' : 'recorded before follow ids were kept'}, `
        + `so its follow id is unknown. Ignored; \`fedipod eject ${actor}\` if they did leave.`);
      return;
    }
    if (undoneId !== rec.followId) {
      this.log(`Undo from ${actor} does not name the follow we hold `
        + `(revokes ${undoneId || 'nothing'}, current is ${rec.followId}) — ignored`);
      return;
    }
    dropFollower(contacts, actor, 'undo-follow');
    this.store.setContacts(contacts);
    await this.republish({ followers: true });
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
    // The check onAnnounce has had all along. A re-delivered Create — a remote
    // retry, a group fan-out, or our own sweep seeing an item whose DELETE was
    // refused — cost a fresh signed GET to the origin and rewrote the private
    // RDF note every time, because addStatus only dedupes AFTER the deref.
    // Gated around the INGEST alone: a group must still reach amplify below,
    // which is separately idempotent on announcedAt.
    // Only a status that came from an INGEST counts as already done. TagFeed
    // writes a bare `kind:'tag'` row straight into the index — no pod RDF note,
    // no mention notification, no replies-collection entry — so treating that
    // as ingested loses all three when the same note is then delivered to us.
    const ingested = this.store.getStatuses()
      .some(x => x.noteId === objectId && (x.kind === 'timeline' || x.kind === 'mention'));
    if (!ingested) {
      const rejected = await this.ingestNote(objectId, actor);
      if (rejected) return rejected;
    }
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
    // A DM to the group, or a followers-only post it happened to receive, was
    // addressed to less than the world — carrying it would widen the author's
    // audience for them. A group only ever amplifies public posts.
    if (s.direct || s.nonPublic) {
      this.log(`not amplified — ${noteId} was not addressed publicly, and a group never widens a post's audience`);
      return;
    }
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
        // Full means refuse the new one, not evict the oldest. `slice(0, 500)`
        // dropped from the tail, so one member posting 500 notes silently
        // discarded everything the operator was still deciding about — the
        // posts were never carried, never refused, and left no record that they
        // had ever arrived. Becoming a member costs one Follow when joins are
        // unmoderated, which is the default.
        //
        // Not carrying it is what a reviewed group does with anything it has
        // not approved, so refusing is the same outcome the queue was for.
        if (pending.length >= MAX_PENDING_REVIEW) {
          this.log(`review queue is full (${MAX_PENDING_REVIEW}) — ${noteId} not held. `
            + 'Approve or decline what is waiting and it will be carried on redelivery.');
          return;
        }
        // The activity rides along: approving later still has to wrap the one
        // the member actually sent, not a reconstruction of it.
        pending.unshift({ noteId, actor: s.actor, activity, at: new Date().toISOString() });
        this.store.setPending(pending);
      }
      this.log(`held for review: ${noteId}`);
      return;
    }
    // A member's Bluesky post: the carry is a native repost by the group's
    // account. It reaches AP followers only through the author's own bridge —
    // the group never fabricates an AP object for someone else's words.
    if (s.kind === 'bsky') {
      if (!this.bskyGroup) { this.log(`not amplified — ${noteId} is a bluesky post and no account is connected`); return; }
      return this.bskyGroup.carry(s);
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
    // The same carry, shown natively to the group's Bluesky followers.
    await this.bskyGroup?.mirrorCarry(s)
      .catch(e => this.log(`bluesky mirror of the carry failed: ${e.message}`));
  }

  // Is this actor in a group we are in? Each followed Group's membership is a
  // public collection, read at most once a day and cached — a membership list
  // is slow-moving, and this runs on arriving mail.
  async isCoMember(actor) {
    if (this.config.kind === 'group') return false;      // a group has members, not peers
    const groups = this.store.getContacts().following
      .filter(f => f.accepted && this.store.getActors()[f.actor]?.type === 'Group')
      .map(f => f.actor);
    if (!groups.length) return false;
    const cache = this.store.read('comembers.json', {});
    const fresh = Date.now() - CO_MEMBER_TTL_MS;
    let changed = false;
    for (const g of groups) {
      const held = cache[g];
      if (held && Date.parse(held.at || 0) > fresh) continue;
      const doc = await this.fetchAP(g).catch(() => null);
      const list = doc?.followers ? await this.collectionMembers(doc.followers) : null;
      // A list we could not read keeps whatever we had: losing it would demote
      // every co-member to a stranger for a day because one fetch failed.
      if (!list) continue;
      cache[g] = { at: new Date().toISOString(), members: list };
      changed = true;
    }
    if (changed) this.store.write('comembers.json', cache);
    return groups.some(g => cache[g]?.members?.includes(actor));
  }

  // The actor ids in a (possibly paged) public collection, capped.
  async collectionMembers(url) {
    const out = [];
    let next = url;
    for (let page = 0; next && page < 10 && out.length < CO_MEMBER_MAX; page++) {
      const doc = await this.fetchAP(next).catch(() => null);
      if (!doc) return out.length ? out : null;
      for (const item of doc.orderedItems || doc.items || []) {
        if (typeof item === 'string') out.push(item);
      }
      next = doc.first && page === 0 ? doc.first : doc.next;
      if (typeof next === 'object') next = next?.id;
    }
    return out;
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
    const existing = this.store.getStatuses().find(s => s.noteId === objectId);
    if (existing) {
      // Known, but possibly as a lesser kind — a stranger's mention, a tag or
      // search mirror — none of which the home timeline shows. A carry from
      // someone we follow is exactly what promotes it there.
      if (!['timeline', 'post'].includes(existing.kind)) {
        this.store.updateStatus(objectId, { kind: 'timeline', via: actor });
        this.log(`promoted to timeline (carried by ${actor}): ${objectId}`);
      }
      return;
    }
    return this.ingestNote(objectId, actor, { via: actor });
  }

  // Shared tail of Create/Announce: deref the note at its origin (never trust
  // the delivered copy), mirror it into pod RDF + statuses, notify on replies
  // to our own notes. Returns a rejection reason string, or undefined.
  async ingestNote(objectId, actor, { via } = {}) {
    const note = await this.fetchAP(objectId);
    if (!note) return `object fetch failed (${objectId})`;
    if (note.id !== objectId || !isContentType(note.type)) return `object not verifiable content (${objectId}, ${note.type})`;
    const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
    const attachments = attachmentsOf(note);
    const content = sanitizeHtml(note.content);   // hostile markup never reaches pod or client
    // The delivering actor was checked on arrival; the author is only known once
    // the note is dereferenced. authorOf refuses an author the note's own origin
    // does not vouch for — see its comment; this is where a forged attribution
    // would otherwise become a timeline entry, a pod document, and for a group a
    // signed Announce to every member.
    const author = authorOf(note, actor);
    if (!author) return `object names an author its origin does not vouch for (${objectId})`;
    // This is the check that catches a blocked actor reaching us through
    // somebody else's boost, or through a hashtag feed.
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
    // Someone in a group you are in is not a stranger: their reply belongs in
    // the room, not in the drawer of unsolicited mail. Whose word this is on
    // is the group's — its published membership — so the group's own door
    // decides who gets in.
    const followed = via || known || (!known && await this.isCoMember(author));
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
    const emojis = emojisOf(note);
    const poll = pollOf(note);
    // Explicitly addressed, but to nobody public and to no followers
    // collection: a direct message, which belongs to the conversations view
    // rather than a timeline. A note with no addressing at all is NOT direct —
    // some servers omit to/cc, and vanishing from home is the wrong reading.
    const audience = [].concat(note.to || [], note.cc || []).map(String);
    const direct = audience.length > 0
      && !audience.includes(PUBLIC) && !audience.some(a => a.endsWith('/followers'));
    // Addressed to less than the world: whatever else happens to it, a group
    // must never widen its audience by carrying it.
    const nonPublic = audience.length > 0 && !audience.includes(PUBLIC);
    this.store.addStatus({
      noteId: note.id, actor: author, content,
      published: note.published, inReplyTo: note.inReplyTo, kind,
      ...(direct ? { direct: true } : {}),
      ...(nonPublic ? { nonPublic: true } : {}),
      // The author's content warning, shown as one: plain text only.
      ...(note.summary ? { spoiler: String(note.summary).replace(/<[^>]*>/g, '') } : {}),
      ...(poll ? { poll } : {}),
      ...(emojis.length ? { emojis } : {}),
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
      // One publish for the lot. Each forget() used to run its own
      // unrecordOutbox, and each of those republished the outbox — so a group
      // that had carried M of this actor's posts paid M full page sweeps for a
      // single inbox item. The Undo deliveries stay per-Announce, because each
      // Announce needs its own; only the pod write is collected.
      const retracted = [];
      for (const s of this.store.getStatuses().filter(s => s.actor === actor)) {
        await this.forget(s, { collect: retracted });
      }
      if (retracted.length) {
        const gone = new Set(retracted);
        await this.publisher.unrecordOutbox(i => gone.has(i?.id));
      }
      // Both: an account deletion drops them from followers AND following.
      await this.republish({ followers: true, following: true });
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
  // `collect` batches the outbox side: retract pushes the Announce id onto it
  // instead of republishing, and the caller writes once for all of them.
  async forget(s, { collect = null } = {}) {
    if (s.announceActivity) {
      await this.retract(s.noteId, { collect }).catch(e => this.log(`retract: ${e.message}`));
    }
    if (s.slug) {
      // Said out loud rather than swallowed: the status row is about to go, so
      // a failure here leaves the note document in the private tree with
      // nothing indexing it, and no other record that it is there.
      await this.local.delete(this.local.fedi + 'timeline/' + s.slug)
        .catch(e => this.log(`forget ${s.noteId}: its RDF note could NOT be removed (${e.message})`));
    }
    this.store.removeStatus(s.noteId);
  }

  // Undo an Announce this group made. Shared with the operator's `retract`.
  async retract(noteId, { collect = null } = {}) {
    const s = this.store.getStatuses().find(x => x.noteId === noteId);
    if (!s) throw new Error('no such post');
    // A Bluesky carry is a repost, and unsaying it is deleting the repost.
    if (s.repostUri) {
      if (!this.bskyGroup) throw new Error('no bluesky account connected');
      return this.bskyGroup.retract(s);
    }
    if (!s.announceActivity) throw new Error('that post was never carried');
    const { undoActivity } = await import('./wire.mjs');
    const inboxes = this.announceTargets(s.actor);
    await this.deliverer.deliverToAll(inboxes,
      undoActivity({ urls: this.urls, activity: s.announceActivity, serial: this.serial++ }));
    if (collect) collect.push(s.announceActivity.id);
    else await this.publisher.unrecordOutbox(i => i?.id === s.announceActivity.id);
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
    if (note.id !== objectId || !isContentType(note.type)) return `object not verifiable content (${objectId}, ${note.type})`;
    const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
    const content = sanitizeHtml(note.content);
    const attachments = attachmentsOf(note);
    const freshPoll = pollOf(note);
    const freshEmojis = emojisOf(note);
    this.store.updateStatus(objectId, {
      content, ...(attachments.length ? { attachments } : {}),
      emojis: freshEmojis.length ? freshEmojis : undefined,
      // The edit's own stamp when the note carries one; tallies and the
      // content warning follow the edit too. A poll refresh keeps our vote.
      editedAt: note.updated || new Date().toISOString(),
      spoiler: note.summary ? String(note.summary).replace(/<[^>]*>/g, '') : undefined,
      ...(freshPoll ? {
        poll: { ...freshPoll, voted: !!s.poll?.voted, ownVotes: s.poll?.ownVotes || [] },
      } : {}),
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
  // MAX_REPLIES_RECORDED caps the collection. It is a discovery aid — a client
  // reading a thread — and the statuses index is what actually holds the
  // replies, so dropping the oldest costs a hop, not a record.
  async addReply(parentId, replyId) {
    // The parent has to be a post we actually made. The only check used to be
    // that the id started with our notes prefix, and `inReplyTo` is read off a
    // document at the sender's own origin — so a stranger could name a note we
    // never wrote, and we would CREATE a document on the pod at a URL of their
    // choosing and then grow it, one whole re-PUT per reply, with no cap. Four
    // pod requests each and bytes quadratic in the number of replies.
    if (!this.store.getStatuses().some(s => s.noteId === parentId && s.kind === 'post')) {
      this.log(`reply names ${parentId}, which is not a post of ours — not recorded`);
      return;
    }
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
    await this.remote.putJson(url, collection(url, items.slice(-MAX_REPLIES_RECORDED)));
    this.log(`reply recorded on ${parentId}`);
  }

  // The other answer to a Follow, and it was dropped on the floor. Their server
  // has recorded that we do not follow them; ours went on saying we did, and
  // published it — so the two disagreed permanently, and a retry would never
  // come because as far as they are concerned the question was answered.
  async onReject(activity, actor) {
    if (activity.object?.type && activity.object.type !== 'Follow') return;
    const contacts = this.store.getContacts();
    const rec = contacts.following.find(f => f.actor === actor);
    if (!rec) return;                                   // nothing of ours to undo
    contacts.following = contacts.following.filter(f => f.actor !== actor);
    this.store.setContacts(contacts);
    await this.republish({ following: true });
    this.log(`follow rejected by ${actor}`);
  }

  // Someone we follow has moved. Their server will stop delivering from the old
  // actor, so without this we keep an entry that can never produce another post
  // and never learn where they went. The new account is not followed
  // automatically — that is a Follow only the owner should send — but it is
  // recorded and raised, so it can be acted on.
  async onMove(activity, actor) {
    const target = typeof activity.target === 'string' ? activity.target : activity.target?.id;
    if (!target) return 'Move without a target';
    const contacts = this.store.getContacts();
    const rec = contacts.following.find(f => f.actor === actor);
    if (!rec) return;                                   // not someone we follow
    // Believed only if the actor we follow says so at its OWN origin: a Move is
    // otherwise a redirect anyone could Append.
    const doc = await this.fetchAP(actor);
    if (!doc) throw new Error(`cannot confirm ${actor} moved — will retry`);
    const movedTo = typeof doc.movedTo === 'string' ? doc.movedTo : doc.movedTo?.id;
    if (movedTo !== target) return `Move not corroborated by ${actor} (says ${movedTo || 'nothing'})`;
    rec.movedTo = target;
    this.store.setContacts(contacts);
    this.store.addNotification({ type: 'move', actor, target });
    this.log(`${actor} moved to ${target} — follow the new account to keep seeing them`);
  }

  async onAccept(activity, actor) {
    const contacts = this.store.getContacts();
    const rec = contacts.following.find(f => f.actor === actor);
    // It has to answer the Follow we actually sent. followActor stores that
    // activity for the later Undo, so the id is here to compare against; without
    // the check any Accept from an actor we happen to follow flips the flag,
    // including one answering a Follow we never made.
    const named = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    const ours = rec?.followActivity?.id;
    if (ours && named && named !== ours) {
      this.log(`Accept from ${actor} answers ${named}, not the follow we sent — ignored`);
      return;
    }
    if (rec && !rec.accepted) {
      rec.accepted = true;
      this.store.setContacts(contacts);
      await this.republish({ following: true });
      this.log(`follow accepted by ${actor}`);
    }
  }
}
