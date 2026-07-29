// keys.mjs — actor signing keys. RSA (Mastodon's draft-cavage HTTP Signatures
// require RSA-SHA256) + Ed25519 (stored for future FEP-8b32 use, not yet in
// the actor doc). PEM at rest (0600 via Store), CryptoKey in memory for
// Fedify's signRequest.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RSA_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

// localDir (setup --keys local) keeps the private key on this machine
// instead of in pod state: the pod host can no longer read it, at the cost
// of portability — the key file must travel with the credential.
export async function ensureKeys(store, { localDir = null } = {}) {
  const keyFile = localDir ? path.join(localDir, 'keys.json') : null;
  const readRec = () => {
    if (!keyFile) return store.read('keys.json', null);
    try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { return null; }
  };
  const writeRec = (r) => {
    if (!keyFile) return store.write('keys.json', r);
    fs.writeFileSync(keyFile, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  };
  let rec = readRec();
  if (!rec) {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ed = crypto.generateKeyPairSync('ed25519');
    rec = {
      rsa: {
        publicPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }),
        privatePem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
      ed25519: {
        publicPem: ed.publicKey.export({ type: 'spki', format: 'pem' }),
        privatePem: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      },
    };
    writeRec(rec);
  }
  const der = crypto.createPrivateKey(rec.rsa.privatePem).export({ type: 'pkcs8', format: 'der' });
  const rsaPrivate = await crypto.subtle.importKey('pkcs8', der, RSA_ALG, true, ['sign']);
  return { rsaPrivate, rsaPublicPem: rec.rsa.publicPem };
}
