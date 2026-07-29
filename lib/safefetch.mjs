// safefetch.mjs — SSRF guard for every outbound request. The pod inbox is
// public-Append, so ANY fediverse user can hand this agent URLs that it will
// dereference (verify-by-deref) or deliver to. Without a filter those URLs
// can name the machine's own services, the LAN, or cloud metadata.
//
// Policy: http/https only; the host must resolve exclusively to public
// addresses; redirects are followed by hand so every hop is re-checked;
// responses are size-capped. AP_ALLOW_PRIVATE_TARGETS=1 disables the address
// check for local federation testing.

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)                 // link-local + cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)       // CGNAT
    || (a === 192 && b === 0)                   // 192.0.0.0/24 special-use
    || a >= 224;                                // multicast + reserved
}

function isPrivateV6(ip) {
  const a = ip.toLowerCase();
  if (a === '::' || a === '::1') return true;
  if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;  // link-local, ULA
  const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);                                  // v4-mapped
  return m ? isPrivateV4(m[1]) : false;
}

export function isPrivateAddress(ip) {
  return net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : true;
}

// Throws when the URL must not be requested; otherwise returns the
// validated address to pin the connection to ({address, family}), or null
// when the URL already names a literal IP.
export async function assertPublicUrl(url) {
  if (process.env.AP_ALLOW_PRIVATE_TARGETS === '1') return null;
  let u;
  try { u = new URL(url); } catch { throw new Error(`unparsable URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`blocked scheme: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`blocked private address: ${host}`);
    return null;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch (e) { throw new Error(`DNS lookup failed for ${host}: ${e.message}`); }
  if (!addrs.length) throw new Error(`no addresses for ${host}`);
  // ALL addresses must be public — a name resolving to both public and
  // private answers is a rebinding attempt.
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) throw new Error(`blocked private address: ${host} → ${a.address}`);
  }
  return { address: addrs[0].address, family: addrs[0].family };
}

// Validating a hostname and then handing that NAME to fetch leaves a
// rebinding window: the resolver can answer publicly for our check and
// privately for the connection. Pinning the dispatcher's lookup to the
// address we validated closes it, while TLS/SNI still see the real
// hostname (so certificates verify normally).
let Agent = null;
try { ({ Agent } = await import('undici')); } catch { /* fall back to plain fetch */ }

function pinnedDispatcher(address, family) {
  if (!Agent) return undefined;
  // The connect layer calls lookup either callback-style (err, address,
  // family) or, with options.all, expecting an array of records.
  const lookup = (_host, opts, cb) => (opts && opts.all
    ? cb(null, [{ address, family }])
    : cb(null, address, family));
  return new Agent({ connect: { lookup } });
}

/** Resolve + validate, returning a dispatcher pinned to the checked address. */
export async function pinnedFor(url) {
  if (process.env.AP_ALLOW_PRIVATE_TARGETS === '1') return undefined;
  const addr = await assertPublicUrl(url);
  return addr ? pinnedDispatcher(addr.address, addr.family) : undefined;
}

/** Read a response body with a hard byte budget (streams are unbounded). */
export async function readCapped(res, max = MAX_BYTES) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new Error(`response too large (${len} bytes)`);
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); throw new Error(`response exceeded ${max} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
}

/**
 * fetch() with the address policy applied to the initial URL and to every
 * redirect hop, the connection pinned to the validated address, and a
 * response size cap.
 * @param {string} url
 * @param {object} [init]         passed through to fetch
 * @param {function} [fetchImpl]  the actual fetch (e.g. a signing fetch);
 *                                receives (url, init) with the dispatcher set
 */
export async function safeFetch(url, init = {}, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const dispatcher = await pinnedFor(current);
    const res = await fetchImpl(current, { ...init, ...(dispatcher ? { dispatcher } : {}), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error(`response too large (${len} bytes) from ${current}`);
    return res;
  }
  throw new Error(`too many redirects from ${url}`);
}
