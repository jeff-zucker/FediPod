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

// Throws when the URL must not be requested.
export async function assertPublicUrl(url) {
  if (process.env.AP_ALLOW_PRIVATE_TARGETS === '1') return;
  let u;
  try { u = new URL(url); } catch { throw new Error(`unparsable URL: ${url}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`blocked scheme: ${u.protocol}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`blocked private address: ${host}`);
    return;
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
}

/**
 * fetch() with the address policy applied to the initial URL and to every
 * redirect hop, plus a response size cap.
 * @param {string} url
 * @param {object} [init]         passed through to fetch
 * @param {function} [fetchImpl]  the actual fetch (e.g. a signing fetch)
 */
export async function safeFetch(url, init = {}, fetchImpl = fetch) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetchImpl(current, { ...init, redirect: 'manual' });
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
