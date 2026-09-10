// deliver-relay.mjs — delivery for the in-browser agent.
//
// The Node deliverer opens a signed connection straight to the remote inbox. A
// browser cannot: it may not set Date or Host, and it is blocked from posting
// cross-origin to a fediverse server anyway. So it signs with the agent's key
// and hands the signed request to the relay (POST /api/relay on the front),
// which sends it verbatim. Everything else — the retry queue, the cooling
// hosts, the dead-letter, FEP-8b32 proofs — is the Node Deliverer, reused by
// overriding only the one network step.
import { Deliverer } from '../../lib/deliver.mjs';
import { sign } from './shims/fedify-sig.mjs';

export class RelayDeliverer extends Deliverer {
  constructor(opts) {
    super(opts);
    this.relayUrl = opts.relayUrl;       // <front>/api/relay
    this.handle = opts.handle;
    this.sessionFetch = opts.sessionFetch;   // the DPoP session's fetch, to authenticate to the relay
  }

  // Same contract as Deliverer.signedFetch, DEFAULT INCLUDED: an init with no
  // method is a read. The Node one builds a `Request`, whose default is GET, and
  // every caller that means POST says so (deliver.mjs deliverNow). Defaulting to
  // POST here sent every dereference — an actor, a note, a reply — to the relay
  // as a delivery, and the relay returns a body only for a GET. So the agent
  // never saw the document it asked for: a Follow from anyone new was rejected
  // with "actor fetch failed", and nothing needing a lookup could be ingested.
  async signedFetch(url, init = {}) {
    const body = typeof init.body === 'string' ? init.body : (init.body ? new TextDecoder().decode(init.body) : '');
    const s = await sign({ url, method: init.method || 'GET', headers: init.headers || {}, body }, this.rsaPrivate, this.keyId);
    const relayReq = {
      url: s.url, method: s.method, body,
      headers: {
        date: s.headers.date, digest: s.headers.digest,
        'content-type': s.headers['content-type'], signature: s.headers.signature,
      },
    };
    let res;
    try {
      res = await this.sessionFetch(this.relayUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: this.handle, requests: [relayReq] }),
      });
    } catch (e) { const err = new Error(`relay unreachable: ${e.message}`); err.status = 0; throw err; }
    if (res.status >= 400) { const err = new Error(`relay ${res.status}`); err.status = 502; throw err; }
    const out = await res.json().catch(() => ({}));
    const r0 = (out.results && out.results[0]) || {};
    const status = r0.status || 0;
    if (status === 0) { const err = new Error(r0.error || 'relay could not send'); err.status = 502; throw err; }
    if (status >= 400) {
      const err = new Error(`${init.method || 'POST'} ${url} → ${status}`); err.status = status;
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
