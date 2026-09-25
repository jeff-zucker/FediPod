// relay-extras.mjs — the relay's single request, and what the relay notices
// about the requests it carries.
//
// relayOne(): sends one request a browser-run agent has already signed, with
// exactly the headers that were signed. It forwards a signature and cannot
// make one: a POST must carry one, by this account's own key, over the body
// its Digest names.
//
// announced(): a relayed delivery of the account's own activity — a post, an
// edit, a pin, an Accept, a Delete, an Undo — means its documents have just
// changed, so the copies the edge holds of them are out of date; the front
// purges them rather than serving the old ones for the rest of their hold.
//
// overLimit(): how many requests one account may have the relay carry. Counted
// per running instance, which bounds a runaway agent or a stolen token without
// any shared state; a real account sends nowhere near it.

import crypto from 'node:crypto';
import { readCapped, safeFetch } from '../shared/safefetch.mjs';

const RELAY_MAX_BODY = 1024 * 1024;
const RELAY_TIMEOUT_MS = 8_000;
// The only headers a relayed request may carry to the remote server. Host
// comes from the URL; the user agent from safeFetch.
const RELAY_HEADERS = new Set(['date', 'digest', 'signature', 'content-type', 'accept']);
const keyIdOf = (signature) => (/keyId="([^"]+)"/.exec(signature || '') || [])[1] || null;

export async function relayOne(item, rec, fetchImpl) {
  const url = String(item?.url || '');
  const method = String(item?.method || 'POST').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { url, status: 0, error: 'method must be GET or POST' };
  let u;
  try { u = new URL(url); } catch { return { url, status: 0, error: 'not a URL' }; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && process.env.AP_ALLOW_PRIVATE_TARGETS === '1')) {
    return { url, status: 0, error: 'https only' };
  }
  const headers = {};
  for (const [k, v] of Object.entries(item?.headers || {})) {
    const name = k.toLowerCase();
    if (RELAY_HEADERS.has(name) && typeof v === 'string') headers[name] = v;
  }
  const body = method === 'POST' ? String(item?.body ?? '') : undefined;
  if (body !== undefined && Buffer.byteLength(body) > RELAY_MAX_BODY) return { url, status: 0, error: 'body too large' };
  const keyId = keyIdOf(headers.signature);
  if (method === 'POST' && !keyId) return { url, status: 0, error: 'a delivery must be signed' };
  if (keyId && !keyId.startsWith(rec.actorUrl + '#')) return { url, status: 0, error: "signed with a key that is not this account's" };
  if (headers.digest) {
    const want = 'SHA-256=' + crypto.createHash('sha256').update(body || '').digest('base64');
    if (headers.digest !== want) return { url, status: 0, error: 'digest does not match the body' };
  }
  try {
    const res = await safeFetch(url, { method, headers, body, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) }, fetchImpl);
    const out = { url, method, status: res.status };
    // The far server asking to be left alone has to reach the agent that will
    // do the asking again. Without this the browser build could not honour a
    // Retry-After at all — every delivery it makes goes through here — and fell
    // back to its own ladder against a server that had already said how long.
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) out.retryAfter = retryAfter;
    if (method === 'GET') {
      out.contentType = res.headers.get('content-type') || null;
      out.body = await readCapped(res, RELAY_MAX_BODY);
    }
    return out;
  } catch (e) { return { url, method, status: 0, error: e.message }; }
}

const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 600;
const counts = new Map();   // handle → { since, n }

export function announced(items, actorUrl) {
  return items.some((it) => {
    if (String(it?.method || 'POST').toUpperCase() !== 'POST') return false;
    try {
      const a = JSON.parse(String(it?.body ?? ''));
      return a?.actor === actorUrl && typeof a.type === 'string';
    } catch { return false; }
  });
}

export function overLimit(handle, n, now = Date.now()) {
  const c = counts.get(handle);
  const fresh = !c || now - c.since > WINDOW_MS ? { since: now, n: 0 } : c;
  fresh.n += n;
  counts.set(handle, fresh);
  if (counts.size > 10_000) counts.clear();
  return fresh.n > PER_WINDOW;
}
