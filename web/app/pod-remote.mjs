// pod-remote.mjs — the browser's pod transport, over a DPoP/OIDC session.
//
// The conversation with the pod — verbs, ACL documents, the deletion deny-list,
// the Retry-After cooldown, container listings — is lib/pod/transport.mjs, the
// same code the Node agent runs. This used to be a hand-kept fork of that file,
// and the fork had drifted: no cooldown at all for a 429 without a Retry-After
// header, no byte cap on a listing from a public-Append inbox, a swallowed
// parse failure, and probes that were neither counted nor held back. Those are
// gone with the fork.
//
// What genuinely differs, and all that is left here: this side retries a
// dropped connection, and waits a throttle out instead of failing fast.

import { PodTransport } from '../../lib/pod/transport.mjs';

export { protectedFromDeletion } from '../../lib/pod/transport.mjs';

// Retry transient edge throttling (dropped connections, 429/503) with backoff.
const RETRY_MAX = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(5000, 400 * 2 ** n) + Math.floor(Math.random() * 250);

// A tighter ceiling than the Node side's thirty minutes: a tab is a person
// waiting, and a hostile or confused header must not park them for half an hour.
const COOLDOWN_MAX_MS = 5 * 60_000;

export class BrowserRemotePod extends PodTransport {
  constructor(session, { webId, log = () => {}, role = 'agent' } = {}) {
    super(session, {
      webId,
      log,
      role,
      runtime: 'browser',
      // Wait the throttle out rather than refusing: there is a person here, and
      // an operation that resumes in four seconds beats one that fails and asks
      // them to try again.
      cooldownMode: 'wait',
      maxCooldownMs: COOLDOWN_MAX_MS,
    });
  }

  async warmup() { /* the DPoP session refreshes lazily */ }

  /**
   * solidcommunity.net sits behind an edge (Cloudflare) that throttles a burst
   * of requests: during first-boot provisioning the agent makes ~15 rapid
   * calls, and one comes back as a dropped connection ("Failed to fetch") or a
   * 429/503. A single dropped write used to abort the whole boot. Retry those
   * with escalating backoff — the throttle window clears in under a few seconds.
   * Safe to retry: a thrown request never reached the server, and a 429/503 was
   * refused, not applied.
   *
   * This overrides `_send`, not `fetch`, so it cannot skip the url map, the
   * cooldown accounting or the deletion deny-list — all of which sit in `fetch`
   * above it. The pod-wide pause is armed there too, so a retry here waits for
   * the whole pod rather than each call climbing its own ladder.
   */
  async _send(url, init) {
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.session.fetch(url, init);
        if ((res.status === 429 || res.status === 503) && attempt < RETRY_MAX) {
          // Arm the pod-wide pause from THIS answer before retrying. The retry
          // happens inside `fetch`, so waiting for the outer `_observe` would
          // mean climbing the whole ladder while ignoring the Retry-After the
          // server just gave us. `_cooldownGate` then sleeps whatever was
          // armed; when the server named no delay, nothing is armed and the
          // backoff below paces it instead.
          this._observe(res);
          if (this.pausedUntil > Date.now()) await this._cooldownGate();
          else await sleep(backoff(attempt));
          attempt++;
          continue;
        }
        return res;
      } catch (e) {
        if (attempt >= RETRY_MAX) throw e;
        this.log(`[${this.label}] ${init?.method || 'GET'} ${url} failed (${e.message}); retry ${attempt + 1}/${RETRY_MAX}`);
        await sleep(backoff(attempt++));
      }
    }
  }
}
