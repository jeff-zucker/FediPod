// fedify-sig.mjs — a browser stand-in for @fedify/fedify/sig.
//
// Fedify itself will not run in a browser: it reaches for node:dns, node:net
// and node:process to resolve and fetch actors. Only two of its functions are
// on the agent's path:
//
//   signRequest       — outbound HTTP Signatures (draft-cavage), what a remote
//                       server verifies. Implemented here with WebCrypto and
//                       proven byte-identical to Fedify's own output for the
//                       same request and key (claude/validation/signing-shim/).
//   verifyRequestDetailed — inbound verification. The browser agent never runs
//                       it: it trusts the gateway's receipt, exactly as the
//                       agent does in the gateway's `trust` mode. Stubbed so a
//                       bundled import resolves.
//
// A browser cannot set Date or Host on a request (both are forbidden header
// names) and does not add them itself, so a signature that covers them can only
// travel through the relay, which sends the signed headers verbatim. That is why
// the real work is `sign()`, which returns the signed headers as data. The
// browser deliverer hands that to the relay; `signRequest` wraps it into a
// Request for the Fedify-shaped callers and the byte-equality proof.

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

/**
 * Sign a request and return the parts to send: the covered header names, the
 * header values (Date/Host/Digest filled in), the body, and the target. Host is
 * always signed from the URL; the relay's own fetch sends the matching Host.
 */
export async function sign({ url, method = 'POST', headers = {}, body }, privateKey, keyId) {
  const u = new URL(url);
  const m = method.toUpperCase();
  const signed = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (name !== 'signature' && name !== 'host') signed[name] = v;
  }

  let bodyBytes;
  if (m !== 'GET' && m !== 'HEAD' && body != null) {
    bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    if (!('digest' in signed)) signed.digest = `SHA-256=${b64(await crypto.subtle.digest('SHA-256', bodyBytes))}`;
  }
  if (!('date' in signed)) signed.date = new Date().toUTCString();
  signed.host = u.host;

  const names = ['(request-target)', ...Object.keys(signed).sort()];
  const signingString = names.map((n) => (n === '(request-target)'
    ? `(request-target): ${m.toLowerCase()} ${u.pathname}${u.search}`
    : `${n}: ${signed[n]}`)).join('\n');
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingString));
  signed.signature = `keyId="${keyId.href || keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${b64(sig)}"`;

  return { url: u.href, method: m, headers: signed, body: bodyBytes ?? null, covered: names };
}

/** Fedify's signRequest shape: sign, then return a Request. Forbidden headers
 *  (Host, Date) survive here only where the runtime allows them (Node); the
 *  browser delivery path uses sign() and the relay instead. */
export async function signRequest(request, privateKey, keyId) {
  const headers = {};
  for (const [k, v] of request.headers) headers[k] = v;
  const body = (request.method === 'GET' || request.method === 'HEAD')
    ? undefined : new Uint8Array(await request.clone().arrayBuffer());
  const s = await sign({ url: request.url, method: request.method, headers, body }, privateKey, keyId);
  const out = new Headers();
  for (const [k, v] of Object.entries(s.headers)) out.set(k, v);
  const init = { method: s.method, headers: out, signal: request.signal };
  if (s.body) init.body = s.body;
  return new Request(request.url, init);
}

// The browser agent verifies nothing itself — the gateway already did, and its
// receipt is what the drain trusts. Present so the import resolves.
export async function verifyRequestDetailed() {
  return { success: false, reason: 'the browser agent does not verify; it trusts the gateway receipt' };
}
