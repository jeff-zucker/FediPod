// deliver.mjs — signed outbound delivery + retry queue. Fedify's signRequest
// does draft-cavage HTTP Signatures (what Mastodon verifies). Failures go to
// a JSON-file queue with exponential backoff; peers that stay down are
// dropped after MAX_ATTEMPTS (~3 days).

import { signRequest } from '@fedify/fedify/sig';
import { pinnedFor, retryAfterMs } from './safefetch.mjs';
import { USER_AGENT } from './ua.mjs';

const MAX_REDIRECTS = 3;

const MAX_ATTEMPTS = 12;                       // 2^12 min ≈ 68h of backoff
const TICK_MS = 60_000;

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
      signal: init.signal || AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 15_000),
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
      if (res.status === 429 || res.status === 503) err.retryAfterMs = retryAfterMs(res);
      throw err;
    }
    return res;
  }

  // Deliver, queueing on failure.
  async deliver(inbox, activity) {
    try {
      await this.deliverNow(inbox, activity);
      this.log(`delivered ${activity.type} → ${inbox}`);
    } catch (e) {
      this.log(`delivery failed (${e.message}) — queued`);
      const q = this.store.getQueue();
      q.push({ inbox, activity, attempts: 1, nextAt: Date.now() + 60_000 });
      this.store.setQueue(q);
    }
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
    const hostOf = (inbox) => { try { return new URL(inbox).host; } catch { return inbox; } };
    const cooling = new Map();               // host → until, for THIS drain

    for (const item of q) {
      if (item.nextAt > now) { keep.push(item); continue; }
      const host = hostOf(item.inbox);
      const until = cooling.get(host);
      if (until) {
        // A sibling of this item already failed against this host. Defer
        // without opening a socket — that is the whole point.
        item.nextAt = Math.max(item.nextAt, until);
        keep.push(item);
        continue;
      }
      try {
        await this.deliverNow(item.inbox, item.activity);
        this.log(`retry ok: ${item.activity.type} → ${item.inbox}`);
      } catch (e) {
        item.attempts += 1;
        if (item.attempts > MAX_ATTEMPTS) {
          this.log(`giving up on ${item.inbox} after ${MAX_ATTEMPTS} attempts`);
          continue;
        }
        // Jittered, so a burst of failures against one host does not come back
        // in lockstep for the rest of the ladder.
        const ladder = Math.min(2 ** item.attempts, 2 ** MAX_ATTEMPTS) * 60_000;
        const wait = e.retryAfterMs || Math.round(ladder * (0.85 + Math.random() * 0.3));
        item.nextAt = now + wait;
        cooling.set(host, item.nextAt);
        if (e.retryAfterMs) this.log(`${host} asked for ${Math.round(wait / 1000)}s — honouring it`);
        keep.push(item);
      }
    }
    this.store.setQueue(keep);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
