// adapt.mjs — the one glue layer between CSS and the gateway core.
//
// CSS hands a handler Node's own request/response (thin Guarded<> wrappers over
// IncomingMessage/ServerResponse). The FediPod core (routeFront/handleDelivery)
// speaks WHATWG Request/Response. These two functions convert both ways, and
// they are the only CSS-shaped code that needs unit coverage — everything
// downstream is the same core the standalone gateway runs.

// Buffer a Node readable into a Buffer (empty for GET/HEAD).
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') { resolve(null); return; }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

// A Node request → a WHATWG Request. `origin` is the public origin CSS serves on
// (e.g. https://fedipod.net), so the core sees the same absolute URL a remote
// used — its routing and any signed-URL check depend on that.
export async function nodeToWhatwg(req, origin) {
  const url = new URL(req.url, origin).href;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  const body = await readBody(req);
  return new Request(url, {
    method: req.method,
    headers,
    ...(body ? { body, duplex: 'half' } : {}),
  });
}

// Apply a core result onto the Node response. The core returns either a WHATWG
// Response or a plain { status, headers, body } (front-core uses the latter),
// so accept both.
export async function applyToNode(res, out) {
  if (out && typeof out.status === 'number' && !(out instanceof Response)) {
    res.writeHead(out.status, out.headers || {});
    res.end(out.body ?? null);
    return;
  }
  const r = out;   // a WHATWG Response
  const headers = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  const text = await r.text();
  res.end(text || null);
}
