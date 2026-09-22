// keystore.mjs — the signing keys, made in the browser and stored on the pod.
//
// The Node agent keeps keys.json (RSA + Ed25519 PEMs) on disk, 0600. A browser
// has no disk it can carry to the next machine, so the durable copy lives on
// the pod, in an owner-only container: the same access rule every private
// document on the pod lives under, reachable through the pod's own login and
// by nobody else. The shape is exactly the agent's keys.json, so it is used
// unchanged. A new browser reads it with its pod session and asks for nothing.
//
// Until 2026-09-22 the pod's copy was encrypted under the pod password, so a
// new browser had to ask for the password once. That sealed the key against
// the pod's host, which the access rule cannot do, at the price of fedipod.net
// asking for a pod password. Jeff decided the host is trusted the way it is
// for every other document, and the password went. `unwrapKeys`,
// `isKeyEnvelope` and `KeyPasswordNeeded` remain for accounts made before
// then: their key is opened once with the password and stored as it is.

const PEM = (der, label) => {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
};

/** RSA (what Mastodon verifies) and, where the browser supports it, Ed25519
 *  (FEP-8b32 proofs). A missing Ed25519 half is not fatal — the agent mints one
 *  the same way it does for a pre-proofs keys.json, since nothing has published it. */
export async function generateKeys() {
  const rsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const rec = {
    rsa: {
      publicPem: PEM(await crypto.subtle.exportKey('spki', rsa.publicKey), 'PUBLIC KEY'),
      privatePem: PEM(await crypto.subtle.exportKey('pkcs8', rsa.privateKey), 'PRIVATE KEY'),
    },
  };
  try {
    const ed = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    rec.ed25519 = {
      publicPem: PEM(await crypto.subtle.exportKey('spki', ed.publicKey), 'PUBLIC KEY'),
      privatePem: PEM(await crypto.subtle.exportKey('pkcs8', ed.privateKey), 'PRIVATE KEY'),
    };
  } catch { /* no Ed25519 in this browser — the agent mints it on first run */ }
  return rec;
}

const PBKDF2_ITERATIONS = 310_000;   // OWASP 2023 floor for PBKDF2-HMAC-SHA256

async function deriveAesKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Whether a document read off the pod is an envelope from before 1.28.0
 *  rather than the keys record. The shape is what tells them apart. */
export function isKeyEnvelope(doc) {
  return !!doc && doc.v === 1 && typeof doc.ct === 'string' && typeof doc.salt === 'string';
}

/** Thrown when the pod holds a key from before 1.28.0, under a password, and
 *  nothing in this browser can open it. The page catches it by `code` and asks
 *  for the password once; the worker cannot ask anyone anything. */
export class KeyPasswordNeeded extends Error {
  constructor() { super('this browser needs your account password to unlock the signing key'); }
  code = 'key-password-needed';
}

/** Open an envelope from before 1.28.0. Throws on a wrong password (AES-GCM
 *  auth failure) — which is how the page tells a typo from a real problem. */
export async function unwrapKeys(envelope, password) {
  if (!envelope || envelope.v !== 1) throw new Error('not a key envelope');
  const aes = await deriveAesKey(password, fromB64(envelope.salt), envelope.iterations);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, aes, fromB64(envelope.ct));
  } catch { throw new Error('wrong password'); }
  return JSON.parse(new TextDecoder().decode(plaintext));
}
