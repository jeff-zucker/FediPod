// safefetch.mjs — SSRF guard for every outbound request. The pod inbox is
// public-Append, so ANY fediverse user can hand this agent URLs that it will
// dereference (verify-by-deref) or deliver to. Without a filter those URLs
// can name the machine's own services, the LAN, or cloud metadata.
//
// Policy: http/https only; the host must resolve exclusively to public
// addresses; redirects are followed by hand so every hop is re-checked;
// responses are size-capped. AP_ALLOW_PRIVATE_TARGETS=1 disables the address
// check for local federation testing.

import { USER_AGENT } from './ua.mjs';
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;

// ONE default, read from ONE place. It was 15s in publisher, 20s in intake and
// other values again in the vendor grant, so "the timeout" meant four things
// and AP_HTTP_TIMEOUT_MS moved some of them and not others.
export const HTTP_TIMEOUT_MS = Number(process.env.AP_HTTP_TIMEOUT_MS) || 20_000;

// A server answering 429 or 503 is asking to be left alone, and Retry-After
// says for how long. Here rather than in remote.mjs because BOTH directions
// need it: the pod has honoured it since the incident, and the outbound path
// — the one that talks to other people's servers — did not.
const COOLDOWN_DEFAULT_MS = 60_000;
const COOLDOWN_MAX_MS = 30 * 60_000;

// null when the server sent NO Retry-After. The caller decides what absence
// means: the pod path falls back to its own 60s cooldown, and the delivery
// queue keeps its exponential ladder — which is why this cannot just return a
// default. Doing so collapsed the ladder to a flat 60s for every 503 without
// the header, which is most of them.
export function retryAfterMs(res, max = COOLDOWN_MAX_MS) {
  const raw = res?.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 1) * 1000, max);
  const when = Date.parse(raw);                       // HTTP-date form
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), max);
  return null;
}

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
  if (/^fe[89ab]/.test(a)) return true;              // fe80::/10 link-local, all four nibbles
  if (a.startsWith('fc') || a.startsWith('fd')) return true;                           // ULA
  if (a.startsWith('fec0')) return true;             // deprecated site-local, still routed by some
  if (a.startsWith('ff')) return true;               // multicast
  // A v4-mapped address, in EITHER spelling. The dotted form was the only one
  // matched, and it is the one that never arrives: the WHATWG URL parser
  // normalises an IPv6 literal to compressed hex, so `[::ffff:127.0.0.1]` is
  // handed to us as `::ffff:7f00:1` and walked straight past this filter — and
  // with it every one of 127/8, 10/8, 172.16/12, 192.168/16 and 169.254/16.
  // Canonicalise to the quad first, then classify once.
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateV4(dotted[1]);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

export function isPrivateAddress(ip) {
  return net.isIPv4(ip) ? isPrivateV4(ip) : net.isIPv6(ip) ? isPrivateV6(ip) : true;
}

// Is this host the machine we are running on? Not a security check — the
// operator typed this URL — but the one distinction that decides whether
// plaintext is harmless. Loopback traffic never reaches a network interface,
// so `http://localhost:8000/` crosses nothing and TLS would add nothing to it.
// A LAN address is a different matter entirely: 192.168.1.50 is a real wire,
// shared with every other device on it.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(h) || h === '[::1]') return true;
  if (h.endsWith('.localhost')) return true;           // RFC 6761 reserves the whole label
  return /^127\./.test(h);
}

/**
 * Refuse a pod, issuer or private-root address that would carry secrets in
 * clear over a real network. Returns a reason string, or null when acceptable.
 *
 * The pod URL is where the account password is exchanged for a credential and
 * where that credential is used from then on; the issuer is where the password
 * itself is posted. Nothing checked the scheme, so a typed `http://` sent both
 * in plaintext with no warning. Loopback is exempt because it cannot leak, and
 * because a pod on this machine is a documented, ordinary way to run this.
 */
export function insecureUrlReason(url, what = 'address') {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return `"${url}" is not a ${what}`; }
  if (u.protocol === 'https:') return null;
  if (u.protocol !== 'http:') return `the ${what} must be http(s), not ${u.protocol}`;
  if (isLoopbackHost(u.hostname)) return null;         // never crosses a wire
  return `refusing an unencrypted ${what}: ${u.origin} would send your password, `
    + 'your credential and everything after it in clear over the network. '
    + 'Use https:// — or a loopback address if the pod is on this machine.';
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
// Declared in package.json since 2026-08-03. It had been arriving as a
// four-level transitive dependency of rdflib's, which meant the rebinding
// protection below rested on a package nothing had asked for — and the catch
// swallowed its absence, so losing it would have been silent. Say so instead:
// the address check still runs, but the connection is no longer pinned to the
// address that passed it.
let Agent = null;
try { ({ Agent } = await import('undici')); }
catch {
  console.warn('safefetch: undici is not available — addresses are still checked, '
    + 'but connections are NOT pinned to the checked address, so a name that '
    + 'resolves differently on the second lookup is not caught');
}

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
  const len = Number(res.headers?.get?.('content-length') || 0);
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
  const withUa = { ...init, headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) } };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const dispatcher = await pinnedFor(current);
    const res = await fetchImpl(current, {
      ...withUa,
      signal: init.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      current = new URL(loc, current).href;
      continue;
    }
    const len = Number(res.headers?.get?.('content-length') || 0);
    if (len > MAX_BYTES) throw new Error(`response too large (${len} bytes) from ${current}`);
    return res;
  }
  throw new Error(`too many redirects from ${url}`);
}
