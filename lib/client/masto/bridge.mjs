// bridge.mjs — a fetch Request handed to code written for Node's request and
// response: the Mastodon facade and the admin surface. The browser worker
// answers its own client through it (web/app/sw-src.mjs), and the gateway
// answers Mastodon apps through it (lib/gateway/masto-gateway.mjs).
//
// Returns { req, res, bodyBytes, bodyText, response() }: `response()` is what
// the handler wrote, as a fetch Response.
export async function bridge(request, url, { sameOrigin = false } = {}) {
  // Bytes, not text. A multipart upload is binary — read as text it comes back
  // through a UTF-8 round trip that replaces every byte that is not valid UTF-8,
  // which is most of a JPEG, so the boundary search found nothing and every
  // media and avatar upload answered "422 file required". readBody() does
  // `data += chunk`, which decodes a Buffer the same way it always did, so the
  // JSON and form paths are unchanged.
  const bodyBytes = (request.method === 'GET' || request.method === 'HEAD')
    ? null : Buffer.from(new Uint8Array(await request.arrayBuffer()));
  const bodyText = bodyBytes ? new TextDecoder().decode(bodyBytes) : '';
  const reqHeaders = {}; for (const [k, v] of request.headers) reqHeaders[k.toLowerCase()] = v;
  // `host` is a forbidden header name, so a fetch Request never carries one and
  // the loop above cannot produce it — but it is a header every real request
  // arrives with, and the agent reads it to say where it lives. Without it the
  // notifications `Link` header named `https://undefined/`, so a client that
  // paged by following it (which is how a client is meant to page) walked off
  // the origin and saw nothing past the first screen.
  reqHeaders.host = url.host;
  const listeners = {};
  // The body's events fire on the next microtask. A route that reads the body
  // may only register for them after an await or two — the facade dispatches
  // through its area modules first — so a listener that arrives after the
  // events have fired is given them at once, in the order it asks.
  let fired = false;
  const req = { method: request.method, url: url.pathname + url.search, headers: reqHeaders,
    // Whether the caller is a page on the agent's own origin. The browser
    // worker has established that before anything reaches the facade, and
    // MastoApi asks (through its authorities) whether a request is the owner's
    // own; a request at the gateway never is.
    sameOrigin,
    socket: { encrypted: url.protocol === 'https:' },
    on(ev, cb) {
      (listeners[ev] ||= []).push(cb);
      if (fired) { if (ev === 'data' && bodyBytes?.length) cb(bodyBytes); else if (ev === 'end') cb(); }
      return req;
    },
    destroy() {} };
  queueMicrotask(() => {
    fired = true;
    if (bodyBytes?.length) (listeners.data || []).forEach((cb) => cb(bodyBytes));
    (listeners.end || []).forEach((cb) => cb());
  });
  let status = 200; const outHeaders = {}; const chunks = [];
  const res = {
    writeHead(s, h) { status = s; if (h) Object.assign(outHeaders, h); return res; },
    setHeader(k, v) { outHeaders[k] = v; }, getHeader(k) { return outHeaders[k]; },
    write(c) { chunks.push(c); }, end(c) { if (c) chunks.push(c); },
  };
  return {
    req, res, bodyBytes, bodyText,
    get status() { return status; },
    response: () => new Response(chunks.join(''), { status, headers: { 'content-type': 'application/json', ...outHeaders } }),
  };
}
