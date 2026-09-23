// caches.mjs — what one warm gateway process keeps between requests: the
// pod-token verifier, and the public keys of the servers that deliver here.
// Built per request, each costs round trips to somebody else's server for
// every call; built once, a process pays them once.

// The Solid-OIDC verifier remembers the issuers' key sets it has seen. A
// fresh one per call re-read the caller's WebID document, the issuer's
// discovery document and its keys on every signed-in call.
let verifier = null;
export async function podTokenVerifier() {
  if (!verifier) verifier = (await import('@solid/access-token-verifier')).createSolidTokenVerifier();
  return verifier;
}

// The keys deliveries are signed with, by key id, in the shape Fedify's
// verifier asks for. A key is held an hour; a key that could not be fetched
// is held five minutes, so a server that was down is asked again soon.
// Fedify re-fetches on its own when a held key no longer verifies, so a
// rotated key costs one failed check, not an hour of refused mail.
const KEY_TTL_MS = 60 * 60_000;
const MISS_TTL_MS = 5 * 60_000;
const KEY_CACHE_MAX = 500;
const keys = new Map();   // key id → { key, until }
export const senderKeys = {
  async get(keyId) {
    const hit = keys.get(keyId.href);
    if (!hit) return undefined;
    if (hit.until < Date.now()) { keys.delete(keyId.href); return undefined; }
    return hit.key;
  },
  async set(keyId, key) {
    if (keys.size >= KEY_CACHE_MAX) keys.delete(keys.keys().next().value);
    keys.set(keyId.href, { key, until: Date.now() + (key ? KEY_TTL_MS : MISS_TTL_MS) });
  },
  size: () => keys.size,
};
