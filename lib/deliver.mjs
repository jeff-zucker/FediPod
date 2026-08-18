// deliver.mjs — signed outbound delivery + retry queue. Fedify's signRequest
// does draft-cavage HTTP Signatures (what Mastodon verifies). Failures go to
// a JSON-file queue with exponential backoff; peers that stay down are
// dropped after MAX_ATTEMPTS (~3 days).

import { signRequest } from '@fedify/fedify/sig';
import { pinnedFor, retryAfterMs, HTTP_TIMEOUT_MS } from './safefetch.mjs';
import { USER_AGENT } from './ua.mjs';

const MAX_REDIRECTS = 3;

const MAX_ATTEMPTS = 12;                       // 2^12 min ≈ 68h of backoff
const TICK_MS = 60_000;
const MAX_QUEUE = 2000;                        // beyond it, overflow dead-letters

// Is this failure about the SERVER, or about this one recipient? A 410 Gone,
// a 403, a 401 from an authorized-fetch instance are answers about one inbox;
// cooling the whole host for them starves every other recipient on it — which
// on a big instance is most of your followers. Only a refusal that is about
// the server, or no answer at all, is grounds to leave it alone.
const hostOf = (inbox) => { try { return new URL(inbox).host; } catch { return inbox; } };
const aboutTheHost = (e) => !e.status || e.status >= 500 || e.status === 429;

export class Deliverer {
  // passive: signing-only (viewer-mode agents) — no queue drain timer, so a
  // read-only agent never mutates shared delivery state. startQueue() flips
  // it live when a viewer is promoted to active.
  constructor({ store, keyId, rsaPrivate, log = console.log, passive = false }) {
    this.store = store;
    this.keyId = keyId;
    this.rsaPrivate = rsaPrivate;
    this.log = log;
    if (!passive) this.startQueue();
  }

  startQueue() {
    if (this.timer) return;
    this.timer = setInterval(() => this.drainQueue().catch(e => this.log(`queue: ${e.message}`)), TICK_MS);
    this.timer.unref?.();
  }

  // Signed fetch — also used for GETs so authorized-fetch instances answer
  // us. Targets come from attacker-supplied documents, so every hop is
  // address-checked and the connection is pinned to the checked address.
  // Redirects are followed by hand because each hop needs its own signature
  // (the signature covers the request target).
  async signedFetch(url, init = {}) {
    let current = url;
    // Named on every hop: a remote operator seeing our deliveries or our
    // verify-by-dereference GETs should know what we are.
    //
    // And bounded. This was the one remote-facing path in the project without a
    // deadline — publisher, intake and the token grant all set one — so a peer
    // that accepted the connection and then stalled held us for undici's 300s
    // default. Against a 60s queue tick that is five overlapping drains
    // re-POSTing the same activity at a server already in trouble. One signal,
    // built once, so it covers all four redirect hops together rather than
    // giving each hop a fresh deadline.
    const withUa = {
      ...init,
      signal: init.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) },
    };
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const dispatcher = await pinnedFor(current);
      const req = new Request(current, withUa);
      const signed = await signRequest(req, this.rsaPrivate, new URL(this.keyId));
      const res = await fetch(signed, { ...(dispatcher ? { dispatcher } : {}), redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).href;
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects from ${url}`);
  }

  async deliverNow(inbox, activity) {
    const res = await this.signedFetch(inbox, {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify(activity),
    });
    if (res.status >= 400) {
      // Carry what the server told us instead of flattening it to a string.
      // The Response used to be discarded here, headers and all, which is why
      // a `Retry-After: 3600` was answered with four more POSTs inside the
      // hour it asked for.
      const err = new Error(`POST ${inbox} → ${res.status}`);
      err.status = res.status;
      // Only when the header is ACTUALLY there. Defaulting made every 503
      // without one — which is most of them — collapse the exponential ladder
      // to a flat 60s, the opposite of the intent. A remote's own instruction
      // is honoured up to a day rather than the pod path's 30-minute ceiling:
      // MAX_ATTEMPTS bounds the wait anyway.
      const ra = retryAfterMs(res, 24 * 60 * 60_000);
      if (ra != null) err.retryAfterMs = ra;
      throw err;
    }
    return res;
  }

  // Deliver, queueing on failure.
  async deliver(inbox, activity) {
    // A host we already know is refusing: queue without asking again. This is
    // the path a FRESH activity takes, so without it a fan-out to a struggling
    // server opened one socket per follower before any of this applied.
    const host = hostOf(inbox);
    const until = this._cooling?.get(host);
    if (until && until > Date.now()) {
      this.log(`${host} is cooling — queueing ${activity.type} rather than asking again`);
      this._enqueue({ inbox, activity, attempts: 1, nextAt: until });
      return;
    }
    try {
      await this.deliverNow(inbox, activity);
      this.log(`delivered ${activity.type} → ${inbox}`);
    } catch (e) {
      this.log(`delivery failed (${e.message}) — queued`);
      const wait = e.retryAfterMs || 60_000;
      if (aboutTheHost(e)) {
        this._cooling ||= new Map();
        this._cooling.set(host, Date.now() + wait);
      }
      this._enqueue({ inbox, activity, attempts: 1, nextAt: Date.now() + wait });
    }
  }

  // The queue has a ceiling: a fan-out into a sea of down servers must not grow
  // queue.json without bound. Overflow keeps the evidence as a dead letter.
  _enqueue(item) {
    const q = this.store.getQueue();
    if (q.length >= MAX_QUEUE) {
      this.log(`delivery queue is full (${MAX_QUEUE}) — dead-lettering ${item.activity?.type} → ${item.inbox}`);
      this.store.addDeadLetter({ inboxUrl: item.inbox, reason: 'delivery queue full', activity: item.activity });
      return;
    }
    q.push(item);
    this.store.setQueue(q);
  }

  async deliverToAll(inboxes, activity) {
    // Shared inboxes deduplicate fan-out to the same server.
    for (const inbox of [...new Set(inboxes)]) await this.deliver(inbox, activity);
  }

  // Serialized, for the same reason Intake.drain is: the tick is 60s and a
  // drain over slow peers outlasts it, so a second run started on top of the
  // first. Both read their own clone of queue.json, so both re-POSTed every due
  // activity — duplicate deliveries at a server that is already failing — and
  // both then wrote `keep` back from a stale snapshot, losing the attempt
  // counts that are supposed to make the backoff converge.
  async drainQueue() {
    if (this._draining) { this._drainAgain = true; return this._draining; }
    this._draining = this._drainQueueOnce().finally(() => {
      this._draining = null;
      if (this._drainAgain) { this._drainAgain = false; this.drainQueue().catch(e => this.log(`queue: ${e.message}`)); }
    });
    return this._draining;
  }

  // The queue is walked per HOST, not per item.
  //
  // It used to be a flat sequential loop, which had two costs against a server
  // that was down. Every due item for that host was POSTed — the first failure
  // told us nothing the code could act on — and because each request carries a
  // 15s deadline, K items for one dead host held the drain for up to 15K
  // seconds while every healthy peer's activity waited behind them. Compounding
  // requests at a struggling server, and head-of-line blocking of everyone
  // else: the shape of the incident this project has a postmortem for.
  //
  // One failure now cools the whole host for the rest of this drain, and a
  // Retry-After it sent decides for how long. The breaker is in memory; what
  // persists is nextAt, which the queue already carried.
  async _drainQueueOnce() {
    const q = this.store.getQueue();
    if (!q.length) return;
    const now = Date.now();
    const keep = [];
    // Whether anything actually moved. The only early return above is on an
    // EMPTY queue, so one item with a far-future nextAt used to rewrite
    // queue.json on all 1440 ticks of a day with byte-identical content —
    // PodStore.write has no equality check, and the ordinary ladder reaches
    // hours-long waits by attempt 6, so any peer that fails a few times got
    // there. A length compare is not enough: getQueue() hands back a clone, so
    // attempts/nextAt are mutated in place and the count stays the same.
    let changed = false;
    // Outlives the drain: a Retry-After only reached items that happened to be
    // due in the same pass, so a sibling due a minute later ignored it entirely.
    this._cooling ||= new Map();             // host → until
    for (const [h, until] of this._cooling) if (until <= now) this._cooling.delete(h);

    const ladderFor = (item) => {
      const base = Math.min(2 ** item.attempts, 2 ** MAX_ATTEMPTS) * 60_000;
      return Math.round(base * (0.85 + Math.random() * 0.3));   // jittered, not lockstep
    };

    for (const item of q) {
      // Due first, THEN cooling: an item that is not yet due must not have its
      // ladder advanced on every 60s tick of a 15-minute cooldown. Once
      // deferred its nextAt IS the cooldown, so it advances exactly once per
      // cooldown — the same rate as the item that opened the socket.
      if (item.nextAt > now) { keep.push(item); continue; }
      const host = hostOf(item.inbox);
      const until = this._cooling.get(host);
      if (until && until > now) {
        // A sibling already failed against this host. Defer without opening a
        // socket — but ADVANCE THE LADDER, or only the one item that actually
        // made a request ever climbs it and a queue of K items takes K times
        // as long to give up as the module promises.
        item.attempts += 1;
        changed = true;
        if (item.attempts > MAX_ATTEMPTS) {
          this.log(`giving up on ${item.inbox} after ${MAX_ATTEMPTS} attempts`);
          continue;
        }
        item.nextAt = Math.max(item.nextAt, until);
        keep.push(item);
        continue;
      }
      try {
        await this.deliverNow(item.inbox, item.activity);
        changed = true;
        this.log(`retry ok: ${item.activity.type} → ${item.inbox}`);
      } catch (e) {
        item.attempts += 1;
        changed = true;
        const wait = e.retryAfterMs || ladderFor(item);
        // Cool the host BEFORE the give-up test: a failure is evidence about
        // the server whether or not the item that produced it survives, and
        // skipping this left the flat behaviour intact for exactly the backlog
        // that has just aged out.
        if (aboutTheHost(e)) {
          this._cooling.set(host, now + wait);
          if (e.retryAfterMs) this.log(`${host} asked for ${Math.round(wait / 1000)}s — honouring it`);
        }
        if (item.attempts > MAX_ATTEMPTS) {
          this.log(`giving up on ${item.inbox} after ${MAX_ATTEMPTS} attempts`);
          continue;
        }
        item.nextAt = now + wait;
        keep.push(item);
      }
    }
    if (changed) this.store.setQueue(keep);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
