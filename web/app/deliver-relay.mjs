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

  // Same contract as Deliverer.signedFetch: resolve with { status, headers }, or
  // throw with .status/.retryAfterMs so the queue can back off.
  async signedFetch(url, init = {}) {
    const body = typeof init.body === 'string' ? init.body : (init.body ? new TextDecoder().decode(init.body) : '');
    const s = await sign({ url, method: init.method || 'POST', headers: init.headers || {}, body }, this.rsaPrivate, this.keyId);
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
      // the relay does not forward Retry-After yet; the queue's own ladder applies
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
