// adapt.ts — the one glue layer between CSS and the gateway core.
//
// CSS hands a handler Node's own request/response. The FediPod core
// (routeFront/handleDelivery) speaks WHATWG Request/Response. These convert
// both ways; they are the only CSS-shaped code that needs unit coverage.

type NodeReq = { method?: string; url?: string; headers: Record<string, unknown>;
  on(event: string, cb: (arg?: unknown) => void): void };
type NodeRes = { writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | null): void };
type CoreResult = Response | { status: number; headers?: Record<string, string>; body?: string | null };

// The same ceiling the agent surface's own readBody has. Everything the front
// accepts is far smaller; without this a stranger's POST buffers unbounded.
const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: NodeReq): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') { resolve(null); return; }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (err: Error & { statusCode?: number }): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (c) => {
      if (done) return;
      total += (c as Buffer).length;
      if (total > MAX_BODY_BYTES) {
        const err = new Error('request body too large') as Error & { statusCode?: number };
        err.statusCode = 413;
        fail(err);
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on('end', () => { if (!done) resolve(chunks.length ? Buffer.concat(chunks) : null); });
    req.on('error', (e) => fail(e as Error));
  });
}

// A Node request → a WHATWG Request. `origin` is the public origin CSS serves
// on, so the core sees the same absolute URL a remote used.
export async function nodeToWhatwg(req: NodeReq, origin: string): Promise<Request> {
  const url = new URL(req.url ?? '/', origin).href;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, String(one));
    else if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  const body = await readBody(req);
  return new Request(url, {
    method: req.method,
    headers,
    ...(body ? { body: body as unknown as BodyInit, duplex: 'half' } as RequestInit : {}),
  });
}

// Apply a core result onto the Node response. The core returns either a WHATWG
// Response or a plain { status, headers, body } (front-core uses the latter).
export async function applyToNode(res: NodeRes, out: CoreResult): Promise<void> {
  if (out && typeof (out as { status?: number }).status === 'number' && !(out instanceof Response)) {
    const o = out as { status: number; headers?: Record<string, string>; body?: string | null };
    res.writeHead(o.status, o.headers || {});
    res.end(o.body ?? null);
    return;
  }
  const r = out as Response;
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  const text = await r.text();
  res.end(text || null);
}
