// deliver.mjs — signed outbound delivery + retry queue. Fedify's signRequest
// does draft-cavage HTTP Signatures (what Mastodon verifies). Failures go to
// a JSON-file queue with exponential backoff; peers that stay down are
// dropped after MAX_ATTEMPTS (~3 days).

import { signRequest } from '@fedify/fedify/sig';
import { pinnedFor } from './safefetch.mjs';

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
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const dispatcher = await pinnedFor(current);
      const req = new Request(current, init);
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
    if (res.status >= 400) throw new Error(`POST ${inbox} → ${res.status}`);
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

  async drainQueue() {
    const q = this.store.getQueue();
    if (!q.length) return;
    const now = Date.now();
    const keep = [];
    for (const item of q) {
      if (item.nextAt > now) { keep.push(item); continue; }
      try {
        await this.deliverNow(item.inbox, item.activity);
        this.log(`retry ok: ${item.activity.type} → ${item.inbox}`);
      } catch (e) {
        item.attempts += 1;
        if (item.attempts > MAX_ATTEMPTS) {
          this.log(`giving up on ${item.inbox} after ${MAX_ATTEMPTS} attempts`);
          continue;
        }
        item.nextAt = now + Math.min(2 ** item.attempts, 2 ** MAX_ATTEMPTS) * 60_000;
        keep.push(item);
      }
    }
    this.store.setQueue(keep);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}
