// lease.mjs — single-active-agent coordination. The inbox drain is a
// destructive read and the state store is write-through-cached, so exactly
// one agent may ACT on a pod at a time; later arrivals run as read-only
// viewers. The lease is one JSON doc in ap-state, always read and written
// with FRESH fetches (never through the cached store), renewed while held.
// Best-effort by design: a lost renewal just means the other agent takes
// over at the next expiry.

import crypto from 'node:crypto';

// Renewal is the one thing that writes even when nothing is happening: at 30s
// it was 120 PUTs an hour per agent, each taking a write lock on the pod. 90s
// against a 5-minute TTL leaves three missed renewals of headroom and cuts that
// load by two thirds. The cost is automatic promotion after a crash waiting up
// to the TTL — a user acting on a second device does not wait, since takeover()
// claims the lease outright.
const TTL_MS = 300_000;
const RENEW_MS = 90_000;
const JITTER = () => 0.85 + Math.random() * 0.3;

export class Lease {
  constructor({ url, fetchImpl, log = console.log }) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.id = crypto.randomUUID();
    this.stopped = false;
    this.timer = null;
  }

  async readFresh() {
    try {
      const res = await this.fetchImpl(this.url, { headers: { accept: 'application/json' } });
      if (res.status >= 400) return null;
      this.etag = res.headers?.get?.('etag') || null;
      return JSON.parse(await res.text());
    } catch { return null; }
  }

  // Returns false only for a refused If-Match — that is not an error, it is the
  // answer. Anything else throws.
  async write(doc, { ifMatch = null } = {}) {
    const res = await this.fetchImpl(this.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(ifMatch ? { 'if-match': ifMatch } : {}) },
      body: JSON.stringify(doc),
    });
    if (ifMatch && res.status === 412) return false;
    if (res.status >= 400) throw new Error(`lease PUT → ${res.status}`);
    this.etag = res.headers?.get?.('etag') || null;
    return true;
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

  // Renewal checks ownership first: a takeover by another agent must win,
  // not be clobbered by a blind rewrite. Losing the lease fires onLost once
  // and stops renewing.
  async renewOnce() {
    const doc = { holder: this.id, expiresAt: Date.now() + TTL_MS };
    // The steady path is a single conditional PUT. A 412 means somebody else
    // wrote the lease — the only thing the preceding GET was ever there to
    // detect — so the read is paid for exactly when it matters instead of every
    // 90 seconds forever. No etag (a server that does not return one) falls
    // back to read-then-write.
    if (this.etag && await this.write(doc, { ifMatch: this.etag })) return true;
    const cur = await this.readFresh();
    if (cur && cur.holder !== this.id) {
      // clearTimeout alone was a no-op here — the timer being cleared is the one
      // whose own callback is running, and the chain re-armed in `finally`
      // regardless. Stopping has to outlive this call, so it is a flag.
      this.stopRenewal();
      // readFresh just cached the NEW holder's ETag. Keeping it would let the
      // next conditional PUT succeed and take the lease back, silently, from an
      // agent that has already stood down.
      this.etag = null;
      this.log('lease taken over by another agent');
      this.onLost?.();
      return false;
    }
    await this.write(doc);
    return true;
  }

  // Self-scheduling rather than setInterval, so each agent's renewals drift
  // apart instead of several beating in lockstep against one pod.
  // Idempotent, like Deliverer.startQueue: startActive reaches this twice on the
  // parked path, and two chains against one pod is the doubling this whole file
  // is written to avoid.
  startRenewal() {
    if (this.timer) return;
    this.stopped = false;                    // restartable across demote/takeover
    const tick = () => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.renewOnce()
          .catch(e => this.log(`lease renewal: ${e.message}`))
          .finally(() => { if (!this.stopped) tick(); });
      }, Math.round(RENEW_MS * JITTER()));
      this.timer.unref?.();
    };
    tick();
  }

  // Stop renewing WITHOUT giving the lease up — a demoted agent stands down, it
  // does not release. Unstopped, the chain outlives demotion for the life of the
  // process: ~80 requests an hour from an agent that is no longer acting.
  stopRenewal() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Forcibly claim the lease (a user acting on a viewer device outranks the
  // idle active agent). Write-then-confirm with one retry against the small
  // window where the current holder's renewal lands in between.
  async takeover() {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.write({ holder: this.id, expiresAt: Date.now() + TTL_MS });
      const confirm = await this.readFresh();
      if (confirm?.holder === this.id) return true;
    }
    return false;
  }

  async release() {
    this.stopRenewal();
    await this.write({ holder: this.id, expiresAt: 0 }).catch(() => {});
  }
}
