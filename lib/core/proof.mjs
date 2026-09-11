// proof.mjs — FEP-8b32 object integrity proofs (Data Integrity, eddsa-jcs-2022).
//
// An HTTP signature covers one delivery and says nothing about who wrote what
// was inside it. A proof travels with the activity, so a server that receives
// one of ours second-hand — carried by a group, or forwarded by a follower's
// server — can tell it is ours without asking us.
//
// The RSA `#main-key` and its HTTP signatures are untouched; this is a second
// key alongside, which is what the Data Integrity suites require.

import crypto from 'node:crypto';
import serialize from 'json-canon';

// multicodec: an Ed25519 public key is its 32 raw bytes behind 0xed 0x01.
const ED25519_PREFIX = Buffer.from([0xed, 0x01]);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58btc(bytes) {
  const b = Buffer.from(bytes);
  let n = 0n;
  for (const byte of b) n = (n << 8n) + BigInt(byte);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const byte of b) { if (byte !== 0) break; out = B58[0] + out; }
  return out;
}

/** The `publicKeyMultibase` form of an Ed25519 public key in PEM. */
export function multibaseEd25519(publicPem) {
  const raw = Buffer.from(crypto.createPublicKey(publicPem).export({ format: 'jwk' }).x, 'base64url');
  return 'z' + base58btc(Buffer.concat([ED25519_PREFIX, raw]));
}

/** The signing key, as WebCrypto wants it. */
export function edPrivateKey(privatePem) {
  const jwk = crypto.createPrivateKey(privatePem).export({ format: 'jwk' });
  return crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'Ed25519' }, true, ['sign']);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

// The proof's own terms have to be declared in the document that carries it,
// or a receiver that processes JSON-LD expands the proof away before it ever
// looks at it. Declared BEFORE signing, because the proof covers the document
// exactly as sent, `@context` included.
export const DI_CTX = 'https://w3id.org/security/data-integrity/v1';

function withProofContext(doc) {
  const ctx = doc['@context'];
  const list = Array.isArray(ctx) ? ctx : ctx ? [ctx] : [];
  if (list.includes(DI_CTX)) return doc;
  return { ...doc, '@context': [...list, DI_CTX] };
}

/**
 * Return the activity with a `proof` attached. The proof covers the activity
 * exactly as it goes on the wire, minus the proof itself — so it must be the
 * last thing added, and nothing may edit the activity afterwards.
 *
 * Whole seconds on `created`: a verifier re-serializes the timestamp it was
 * given, and a fractional one has more than one spelling.
 */
export async function attachProof(activity, { privateKey, verificationMethod, created = new Date() } = {}) {
  if (!privateKey || !verificationMethod || !activity || typeof activity !== 'object') return activity;
  const { proof: _existing, ...bare } = activity;
  const doc = withProofContext(bare);
  const config = {
    '@context': doc['@context'],
    type: 'DataIntegrityProof',
    cryptosuite: 'eddsa-jcs-2022',
    verificationMethod,
    proofPurpose: 'assertionMethod',
    created: new Date(created).toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  const digest = Buffer.concat([sha256(serialize(config)), sha256(serialize(doc))]);
  const sig = await crypto.subtle.sign('Ed25519', privateKey, digest);
  const { '@context': _ctx, ...emitted } = config;
  return { ...doc, proof: { ...emitted, proofValue: 'z' + base58btc(Buffer.from(sig)) } };
}
