// http.mjs — the two HTTP manners this library needs, and nothing else.
//
// FediPod has lib/safefetch.mjs, which does far more: DNS pinning, private
// address refusal, redirect re-checking. None of that can come here, because
// it imports node:dns and node:net and this library must run unmodified inside
// a service worker. What IS needed on both sides is a byte budget and a reading
// of Retry-After, so they live here in a form with no runtime of their own.
//
// Deliberately NOT a fetch wrapper. The library never opens a connection by
// itself; every request goes through a transport or a fetcher the caller
// supplies, which is what lets the same code serve an authenticated agent, a
// keyless gateway, and a test with no network at all.

// Five megabytes is what the wider project uses as a body budget, and a
// document this library reads is a pod resource, not a stranger's timeline.
const MAX_BYTES = 5 * 1024 * 1024;

// Thirty minutes is a ceiling, not a policy: a hostile or confused header must
// not be able to park a caller for a day. Callers that want a tighter ceiling
// pass their own — the browser transport does.
const COOLDOWN_MAX_MS = 30 * 60_000;

/**
 * How long a server asked to be left alone, or **null** when it did not say.
 *
 * The null matters and must not become a default. The caller decides what
 * absence means: a pod falls back to a flat cooldown, while a delivery queue
 * keeps its exponential ladder — and returning a default here once collapsed
 * that ladder to a flat 60s for every 503 without the header, which is most
 * of them.
 */
export function retryAfterMs(res, max = COOLDOWN_MAX_MS) {
  const raw = res?.headers?.get?.('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  // A floor of one second: a server answering `Retry-After: 0` is still asking
  // for a pause, and honouring it as "none" is how a throttle becomes a spin.
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 1) * 1000, max);
  const when = Date.parse(raw);                       // the HTTP-date spelling
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), max);
  return null;
}

/**
 * Read a response body with a hard byte budget.
 *
 * Checking `content-length` and then handing back `res.text()` is not a cap: a
 * chunked response carries no `content-length` at all, and an inbox listing is
 * public-Append, so its size is in other people's hands. Stream it and stop at
 * the budget.
 *
 * TextDecoder rather than Buffer — it exists in both runtimes — and
 * `stream: true` so a UTF-8 sequence split across two chunks still decodes.
 */
export async function readCapped(res, max = MAX_BYTES) {
  const len = Number(res.headers?.get?.('content-length') || 0);
  if (len > max) throw new Error(`response too large (${len} bytes)`);
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new Error(`response exceeded ${max} bytes`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
