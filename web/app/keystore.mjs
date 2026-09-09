// keystore.mjs — the signing keys, made in the browser and locked under the
// account password so any browser can recover them.
//
// The Node agent keeps keys.json (RSA + Ed25519 PEMs) on disk, 0600. A browser
// has no disk it can trust across machines, so the durable copy lives on the
// pod, encrypted here first: the pod's owner-only ACL protects it from
// strangers, and the password protects it from the pod host. The shape inside
// is exactly the agent's keys.json, so once unwrapped it is used unchanged.

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

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Wrap the keys record under the password. The envelope names its own KDF and
 *  parameters, so unwrap needs only the password and this document. */
export async function wrapKeys(keysRecord, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(keysRecord));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plaintext);
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** Unwrap an envelope wrapKeys made. Throws on a wrong password (AES-GCM auth
 *  failure) — which is how a new browser tells a typo from a real key. */
export async function unwrapKeys(envelope, password) {
  if (!envelope || envelope.v !== 1) throw new Error('not a key envelope');
  const aes = await deriveAesKey(password, fromB64(envelope.salt), envelope.iterations);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, aes, fromB64(envelope.ct));
  } catch { throw new Error('wrong password'); }
  return JSON.parse(new TextDecoder().decode(plaintext));
}
