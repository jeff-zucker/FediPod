// keys-browser.mjs — turn the keys record (from keystore/the pod) into what the
// agent's deliverer and publisher expect. The Node agent's resolveKeys returns
// { rsaPrivate (a WebCrypto key), rsaPublicPem, edPrivate, edPublicMultibase };
// this returns the same, RSA only. FEP-8b32 Ed25519 proofs are optional — the
// deliverer treats a null edPrivate as "no proof", and an unproved activity
// still federates — so the browser MVP omits them.
//
// The private key is imported NON-extractable, and the copy this browser keeps
// in IndexedDB is that CryptoKey, not the PEM: it can sign and cannot be read
// out, so a script that reaches this origin's storage gets nothing it can carry
// away. The PEM record exists only in memory, between unwrap and import.
import { kvGet, kvPut } from './idb-kv.mjs';
import * as podState from '../../lib/pod/state.mjs';
import { isKeyEnvelope, KeyPasswordNeeded } from './keystore.mjs';

const pemToDer = (pem) => Uint8Array.from(
  atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));

export async function importSigningKey(keysRecord) {
  const rsaPrivate = await crypto.subtle.importKey('pkcs8', pemToDer(keysRecord.rsa.privatePem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return { rsaPrivate, rsaPublicPem: keysRecord.rsa.publicPem, edPrivate: null, edPublicMultibase: null };
}

/** What the cache holds: the non-extractable key and the public half. */
const fromCache = (c) => ({ rsaPrivate: c.rsaPrivate, rsaPublicPem: c.rsaPublicPem, edPrivate: null, edPublicMultibase: null });
const isOpenedKey = (c) => c?.rsaPrivate?.type === 'private' && typeof c.rsaPublicPem === 'string';

/**
 * Keep this browser's opened copy: import the record and store the CryptoKey.
 * Best effort on the store — a browser that refuses IndexedDB (private mode)
 * reads the pod's copy again on the way back in. Returns the imported keys.
 */
export async function cacheOpenedKeys(actorUrl, keysRecord) {
  const keys = await importSigningKey(keysRecord);
  await kvPut(keyCacheKey(actorUrl), { rsaPrivate: keys.rsaPrivate, rsaPublicPem: keys.rsaPublicPem })
    .catch(() => {});
  return keys;
}

// Where this browser keeps its own opened copy of the signing key: a
// non-extractable CryptoKey that never leaves the origin — the same protection
// the OIDC session in the next IDB row already relies on. It is what lets the
// worker boot itself after an idle kill without a network read.
export const keyCacheKey = (actorUrl) => `signing-keys:${actorUrl}`;
// The cache is keyed by the POD actor, whatever the identity advertises: a
// fronted identity's advertised actor is the gateway's, and keying by that
// would hide the opened copy sign-up stored and read the pod again.
export const podActorOf = (urls) => (urls.toPod ? urls.toPod(urls.actor) : urls.actor);

// Read the signing key for this actor and import it for signing.
//
// Two places hold one: this browser (opened, in IndexedDB) and the pod. The
// browser's is tried first — no network read. Falling through to the pod covers
// the browser that has just signed in and has no copy yet: the record is read
// with the pod session and used as it stands. An envelope from before 1.28.0
// needs the password and so has to go back to the page.
export async function loadKeysFromPod(remote, urls) {
  const podActor = podActorOf(urls);
  const cached = await kvGet(keyCacheKey(podActor)).catch(() => null);
  if (isOpenedKey(cached)) return fromCache(cached);
  // A copy stored as PEM by an earlier build: import it and store the key form
  // in its place, so the PEM is gone from storage after one boot.
  if (cached?.rsa?.privatePem) return cacheOpenedKeys(podActor, cached);

  const doc = await podState.readKeys(remote, urls);
  if (isKeyEnvelope(doc)) throw new KeyPasswordNeeded();
  if (!doc || !doc.rsa) throw new Error('no signing key on the pod — sign up did not finish');
  // Cache it so the next boot is no read at all.
  return cacheOpenedKeys(podActor, doc);
}
