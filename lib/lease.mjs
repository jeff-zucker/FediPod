// lease.mjs — single-active-agent coordination. The inbox drain is a
// destructive read and the state store is write-through-cached, so exactly
// one agent may ACT on a pod at a time; later arrivals run as read-only
// viewers. The lease is one JSON doc in ap-state, always read and written
// with FRESH fetches (never through the cached store), renewed while held.
// Best-effort by design: a lost renewal just means the other agent takes
// over at the next expiry.

import crypto from 'node:crypto';

const TTL_MS = 90_000;
const RENEW_MS = 30_000;

export class Lease {
  constructor({ url, fetchImpl, log = console.log }) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.id = crypto.randomUUID();
  }

  async readFresh() {
    try {
      const res = await this.fetchImpl(this.url, { headers: { accept: 'application/json' } });
      if (res.status >= 400) return null;
      return JSON.parse(await res.text());
    } catch { return null; }
  }

  async write(doc) {
    const res = await this.fetchImpl(this.url, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc),
    });
    if (res.status >= 400) throw new Error(`lease PUT → ${res.status}`);
  }

  // True when this agent now holds the lease. Write-then-confirm narrows the
  // last-writer-wins race to a small window — acceptable for a human-scale
  // "laptop vs phone" situation.
  async acquire() {
    const cur = await this.readFresh();
    if (cur && cur.holder !== this.id && Date.now() < cur.expiresAt) return false;
    await this.write({ holder: this.id, expiresAt: Date.now() + TTL_MS });
    const confirm = await this.readFresh();
    return confirm?.holder === this.id;
  }

  startRenewal() {
    this.timer = setInterval(() => {
      this.write({ holder: this.id, expiresAt: Date.now() + TTL_MS })
        .catch(e => this.log(`lease renewal: ${e.message}`));
    }, RENEW_MS);
    this.timer.unref?.();
  }

  async release() {
    clearInterval(this.timer);
    await this.write({ holder: this.id, expiresAt: 0 }).catch(() => {});
  }
}
