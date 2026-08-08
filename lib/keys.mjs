// keys.mjs — actor signing keys. RSA (Mastodon's draft-cavage HTTP Signatures
// require RSA-SHA256) + Ed25519 (stored for future FEP-8b32 use, not yet in
// the actor doc). PEM at rest (0600), CryptoKey in memory for Fedify's
// signRequest.
//
// The key lives on THIS MACHINE by default (AP_HOME/keys.json): the pod host
// then never holds it. `setup --keys pod` puts it in pod state instead,
// which is what lets several devices sign as the same actor without copying
// anything — see resolveKeys() for the guard that keeps the two modes from
// silently breaking each other.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './home.mjs';

const RSA_ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };

const localPath = (dir) => path.join(dir, 'keys.json');
const readLocal = (dir) => {
  try { return JSON.parse(fs.readFileSync(localPath(dir), 'utf8')); } catch { return null; }
};
// Atomic: this is the private key remote servers have cached, and a truncated
// one cannot be recovered from anywhere — the pod does not hold it.
const writeLocal = (dir, rec) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJsonAtomic(localPath(dir), rec);
};

function generate() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed = crypto.generateKeyPairSync('ed25519');
  return {
    rsa: {
      publicPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }),
      privatePem: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
    ed25519: {
      publicPem: ed.publicKey.export({ type: 'spki', format: 'pem' }),
      privatePem: ed.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    },
  };
}

/**
 * Find or create the key record.
 *
 * The dangerous case is minting a NEW key when the actor already advertises
 * one: remote servers cache the public key, so a fresh keypair silently
 * invalidates every signature until the actor document is republished — and
 * then breaks whichever other device holds the old key. So when key material
 * is missing but the actor doc already has a key, we refuse and explain,
 * unless the caller passes rotate:true deliberately.
 *
 * @param {object} store            pod-backed state store
 * @param {object} o
 * @param {string|null} o.localDir  AP_HOME when keys are local (the default)
 * @param {boolean} o.rotate        mint a replacement on purpose
 * @param {function} [o.actorHasKey] async () => boolean, consulted only when
 *                                  no key material exists anywhere
 * @param {function} [o.log]
 */
export async function resolveKeys(store, { localDir = null, rotate = false, actorHasKey = null, actorId = null, log = () => {} } = {}) {
  let rec = localDir ? readLocal(localDir) : null;

  // A key belongs to ONE actor. Adopting whatever keys.json happens to be in
  // the directory is right within an identity and wrong across two: it is how
  // a second setup in the same AP_HOME ended up signing as a different actor
  // with the first one's key, which links the two publicly for anyone who
  // compares the actor documents. A stamped key that names another actor is
  // treated as absent, so the mint path (and its actorHasKey guard) applies.
  if (rec && actorId && rec.mintedFor && rec.mintedFor !== actorId) {
    log(`local keys.json belongs to ${rec.mintedFor} — not reusing it for ${actorId}`);
    rec = null;
  } else if (rec && actorId && !rec.mintedFor) {
    // Written before keys were stamped: keep working, but say so, because it
    // may be another actor's key.
    log('keys.json predates per-identity stamping — if this actor was set up in a '
      + 'home that already held a key, `setup --rotate-key` mints one of its own');
  }

  if (!rec) {
    const podRec = store.read('keys.json', null);
    if (podRec && localDir) {
      // Migrating an existing actor to local keys: adopt the pod's key so
      // the identity is preserved, then remove the pod's copy — leaving it
      // would defeat the point of going local.
      writeLocal(localDir, podRec);
      rec = podRec;
      const gone = await store.remove('keys.json');
      log(gone
        ? `signing key moved to ${localPath(localDir)} and deleted from pod state`
        : `signing key copied to ${localPath(localDir)} — could NOT delete the pod copy, remove it by hand`);
    } else {
      rec = podRec;
    }
  }

  if (!rec && !rotate && actorHasKey && await actorHasKey()) {
    throw new Error(
      'this actor already publishes a signing key, but no key material is present here.\n'
      + `  Copy keys.json from your other device into ${localDir || 'pod state'}, or\n`
      + '  re-run setup with --keys pod to share the key through the pod, or\n'
      // --force, because rotate-key connects before it rotates and would meet
      // this same refusal: advice has to name a command that can actually run.
      + '  run `fedipod rotate-key --force` to replace the published key (breaks other devices).');
  }

  if (!rec || rotate) {
    rec = { ...generate(), ...(actorId ? { mintedFor: actorId } : {}) };
    if (localDir) writeLocal(localDir, rec); else store.write('keys.json', rec);
    log(rotate ? 'minted a REPLACEMENT signing key — republish the profile' : 'minted a signing key');
  }

  const der = crypto.createPrivateKey(rec.rsa.privatePem).export({ type: 'pkcs8', format: 'der' });
  const rsaPrivate = await crypto.subtle.importKey('pkcs8', der, RSA_ALG, true, ['sign']);
  return { rsaPrivate, rsaPublicPem: rec.rsa.publicPem };
}

// Back-compat alias for callers that just want "the keys, wherever they are".
export const ensureKeys = (store, opts) => resolveKeys(store, opts);
