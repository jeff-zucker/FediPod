// safefetch.mjs — browser stand-in for lib/safefetch.mjs.
//
// The Node version pins connections to a validated IP to stop DNS-rebinding and
// refuses private targets, using undici and node:dns. A browser cannot open raw
// sockets and is bound by the same-origin policy and CORS, so the rebinding
// attack this defends against is not reachable from here; the browser agent's
// only cross-origin writes go through the relay, which runs the Node checks.
// This keeps the same surface with plain fetch and no top-level await.
export const HTTP_TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

export function retryAfterMs(res, max = 30 * 60_000) {
  const h = res?.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = /^\d+$/.test(h.trim()) ? Number(h) * 1000 : (Date.parse(h) - Date.now());
  return Number.isFinite(secs) ? Math.max(0, Math.min(secs, max)) : null;
}
export function isPrivateAddress() { return false; }
export function isLoopbackHost(host) { return /^(localhost|127\.|\[?::1)/.test(String(host)); }
export function insecureUrlReason(url, what = 'address') {
  try { const u = new URL(url); if (u.protocol === 'https:' || isLoopbackHost(u.hostname)) return null;
    if (u.protocol !== 'http:') return `the ${what} must be http(s)`; return null; } catch { return `"${url}" is not a ${what}`; }
}
export async function assertPublicUrl() { return null; }     // no socket pinning in a browser
export async function pinnedFor() { return undefined; }
export async function readCapped(res, max = MAX_BYTES) {
  const len = Number(res.headers?.get?.('content-length') || 0);
  if (len > max) throw new Error(`response too large (${len} bytes)`);
  return res.text();
}
export async function safeFetch(url, init = {}, fetchImpl = fetch) {
  return fetchImpl(url, { ...init, signal: init.signal || AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}
