// deliver-relay.mjs — delivery for the in-browser agent.
//
// The Node deliverer opens a signed connection straight to the remote inbox. A
// browser cannot: it may not set Date or Host, and it is blocked from posting
// cross-origin to a fediverse server anyway. So it signs with the agent's key
// and hands the signed request to the relay (POST /api/relay on the front),
// which sends it verbatim. Everything else — the retry queue, the cooling
// hosts, the dead-letter, FEP-8b32 proofs — is the Node Deliverer, reused by
// overriding only the one network step.
import { Deliverer } from '../../lib/core/deliver.mjs';
import { sign } from './shims/fedify-sig.mjs';

// What one relay call may carry (lib/gateway/front-core.mjs RELAY_MAX_REQUESTS).
const RELAY_MAX_REQUESTS = 20;

/**
 * The name the front keys this account's row by, read off its door inbox:
 * `<front>/u/<key>/ap/inbox/`. A mail-door account is keyed by its full
 * address (`you@your.pod`), not the bare handle, because "you" alone is not
 * unique across pods — and the relay looks the account up by that key.
 * Null when the URL is not a door of that shape.
 */
export function doorKeyOf(doorInboxUrl) {
  try {
    const seg = new URL(doorInboxUrl).pathname.split('/');
    return seg[1] === 'u' && seg[2] ? decodeURIComponent(seg[2]) : null;
  } catch { return null; }
}

export class RelayDeliverer extends Deliverer {
  constructor(opts) {
    super(opts);
    this.relayUrl = opts.relayUrl;       // <front>/api/relay
    this.handle = opts.handle;
    this.sessionFetch = opts.sessionFetch;   // the DPoP session's fetch, to authenticate to the relay
    this.batchSize = RELAY_MAX_REQUESTS;
  }

  // Same contract as Deliverer.signedFetch, DEFAULT INCLUDED: an init with no
  // method is a read. The Node one builds a `Request`, whose default is GET, and
  // every caller that means POST says so (deliver.mjs deliverNow). Defaulting to
  // POST here sent every dereference — an actor, a note, a reply — to the relay
  // as a delivery, and the relay returns a body only for a GET. So the agent
  // never saw the document it asked for: a Follow from anyone new was rejected
  // with "actor fetch failed", and nothing needing a lookup could be ingested.
  async signedFetch(url, init = {}) {
    const req = await this._signedRequest(url, init);
    const [r0] = await this._relay([req]);
    return this._outcome(r0, url, init.method || 'GET');
  }

  // A fan-out in one call: the relay takes a list, so a post to twenty
  // followers is one call, not twenty (Deliverer.deliverToAll, batchSize).
  async deliverManyNow(targets) {
    const reqs = await Promise.all(targets.map((t) => this._signedRequest(t.inbox, {
      method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(t.activity),
    })));
    let results;
    try { results = await this._relay(reqs); } catch (error) { return targets.map(() => ({ error })); }
    return targets.map((t, i) => {
      try { this._outcome(results[i] || {}, t.inbox, 'POST'); return { ok: true }; }
      catch (error) { return { error }; }
    });
  }

  // Signed here, sent verbatim by the relay. Every signed header goes along,
  // `accept` included: the signature covers it, so a relay request missing it
  // carries an invalid signature — and a read without it gets the HTML page
  // instead of the document.
  async _signedRequest(url, init = {}) {
    const body = typeof init.body === 'string' ? init.body : (init.body ? new TextDecoder().decode(init.body) : '');
    const s = await sign({ url, method: init.method || 'GET', headers: init.headers || {}, body }, this.rsaPrivate, this.keyId);
    return {
      url: s.url, method: s.method, body,
      headers: {
        date: s.headers.date, digest: s.headers.digest, accept: s.headers.accept,
        'content-type': s.headers['content-type'], signature: s.headers.signature,
      },
    };
  }

  // One relay call for a list of requests; the results in the same order.
  // The relay's OWN answer, apart from the recipients': unreachable and a
  // refusal are hiccups the queue retries. Its 404 is not — it says this
  // account has no row here, and no retry changes that. It used to be read as
  // a hiccup too, and a tab whose account the site did not know retried its
  // deliveries every minute for three days.
  async _relay(requests) {
    let res;
    try {
      res = await this.sessionFetch(this.relayUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: this.handle, requests }),
      });
    } catch (e) { const err = new Error(`relay unreachable: ${e.message}`); err.status = 0; throw err; }
    if (res.status === 404) { const err = new Error('relay: no such account here'); err.status = 404; throw err; }
    if (res.status >= 400) { const err = new Error(`relay ${res.status}`); err.status = 502; throw err; }
    const out = await res.json().catch(() => ({}));
    return Array.isArray(out.results) ? out.results : [];
  }

  // What the far server answered, as the Node deliverer would have seen it:
  // a Response for a read, a thrown error carrying the status for a refusal.
  _outcome(r0, url, method) {
    const status = r0.status || 0;
    if (status === 0) { const err = new Error(r0.error || 'relay could not send'); err.status = 502; throw err; }
    if (status >= 400) {
      const err = new Error(`${method} ${url} → ${status}`); err.status = status;
      // The receiving server's own answer to "when should I try again", carried
      // through the relay (lib/front-core.mjs). Spelled `retryAfterMs`, which is
      // what the delivery queue reads (lib/deliver.mjs) — the queue's ladder is
      // the fallback for when there is none, not a replacement for being told.
      if (r0.retryAfter) {
        const secs = Number(r0.retryAfter);
        const ms = Number.isFinite(secs) ? Math.max(secs, 1) * 1000
          : Math.max(Date.parse(r0.retryAfter) - Date.now(), 1000);
        if (Number.isFinite(ms)) err.retryAfterMs = Math.min(ms, 24 * 60 * 60_000);
      }
      throw err;
    }
    // A read (GET) comes back with the fetched body; a delivery (POST) has none.
    // Hand back a real Response either way so the caller can read a remote
    // object — the topical (tag) feed dereferences every note it mirrors, and
    // intake.fetchAP reads that body off this Response.
    const headers = new Headers();
    if (r0.contentType) headers.set('content-type', r0.contentType);
    return new Response(typeof r0.body === 'string' ? r0.body : null, { status, headers });
  }
}
