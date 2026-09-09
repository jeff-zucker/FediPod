// keys-browser.mjs — turn the keys record (from keystore/the pod) into what the
// agent's deliverer and publisher expect. The Node agent's resolveKeys returns
// { rsaPrivate (a WebCrypto key), rsaPublicPem, edPrivate, edPublicMultibase };
// this returns the same, RSA only. FEP-8b32 Ed25519 proofs are optional — the
// deliverer treats a null edPrivate as "no proof", and an unproved activity
// still federates — so the browser MVP omits them.
import { kvGet, kvPut } from './idb-kv.mjs';
import { isKeyEnvelope, KeyPasswordNeeded } from './keystore.mjs';

const pemToDer = (pem) => Uint8Array.from(
  atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));

export async function importSigningKey(keysRecord) {
  const rsaPrivate = await crypto.subtle.importKey('pkcs8', pemToDer(keysRecord.rsa.privatePem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  return { rsaPrivate, rsaPublicPem: keysRecord.rsa.publicPem, edPrivate: null, edPublicMultibase: null };
}

// Where this browser keeps its own opened copy of the signing key. The pod's
// copy is wrapped under the account password; this one is not, because it never
// leaves the origin — the same protection the OIDC session in the next IDB row
// already relies on. It is what lets the worker boot itself after an idle kill
// without a soul around to type anything.
export const keyCacheKey = (actorUrl) => `signing-keys:${actorUrl}`;

// Read the signing key for this actor and import it for signing.
//
// Two places hold one: this browser (opened, in IndexedDB) and the pod (wrapped).
// The browser's is tried first — it is the only one that can be read with no
// password, and a service worker has nobody to ask. Falling through to the pod
// covers the browser that has just signed in and has no copy yet: a bare record
// there is from before wrapping and is used as it stands, while an envelope
// needs the password and so has to go back to the page.
export async function loadKeysFromPod(remote, urls) {
  const cached = await kvGet(keyCacheKey(urls.actor)).catch(() => null);
  if (cached?.rsa) return importSigningKey(cached);

  const doc = await remote.getJson(urls.state + 'keys.json');
  if (isKeyEnvelope(doc)) throw new KeyPasswordNeeded();
  if (!doc || !doc.rsa) throw new Error('no signing key on the pod — sign up did not finish');
  // A pre-wrapping install. Cache it so the next boot is one read, and leave
  // the pod's copy alone: re-wrapping it would need the password we do not have.
  await kvPut(keyCacheKey(urls.actor), doc).catch(() => {});
  return importSigningKey(doc);
}
