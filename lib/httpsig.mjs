// httpsig.mjs — inbound HTTP-Signature verification, and the verification
// receipt that carries the outcome from wherever the verify happened (an
// always-on gateway, or the agent's own endpoint when it is publicly reachable)
// into the drain, which cannot see the delivery's headers.
//
// We SIGN outbound with Fedify draft-cavage (lib/deliver.mjs); we VERIFY with
// the same library, so the signing-string reconstruction can never drift out
// of step with what we produce. The one thing Fedify must be prevented from
// doing on its own is fetching an attacker-named key over an unguarded socket
// — so the key deref is injected as a loader that goes through safefetch.

import crypto from 'node:crypto';
import { verifyRequestDetailed } from '@fedify/fedify/sig';
import { assertPublicUrl, safeFetch, readCapped } from './safefetch.mjs';

// An SSRF-safe JSON-LD document loader for Fedify's key fetch. The keyId in a
// delivery is chosen by the sender, so every deref it triggers is untrusted
// input and must pass the same address policy as the rest of our outbound
// path. `skipActor` forces a network read past any cache, for the one refetch
// a rotated key needs.
export function makeSafeLoader({ getActors = null, fetchImpl = fetch } = {}) {
  return async (url) => {
    // A cached actor document short-circuits the network entirely — and it was
    // only cached after its own origin vouched for its id (intake.fetchAP).
    if (getActors) {
      const hit = getActors()[url];
      if (hit) return { document: hit, documentUrl: url, contextUrl: null };
    }
    await assertPublicUrl(url);
    const res = await safeFetch(url, {
      headers: { accept: 'application/activity+json, application/ld+json' },
    }, fetchImpl);
    if (res.status >= 400) throw new Error(`key fetch ${url} → ${res.status}`);
    const document = JSON.parse(await readCapped(res));
    return { document, documentUrl: url, contextUrl: null };
  };
}

// Verify a delivery's signature. `request` is a WHATWG Request (the gateway
// has one natively; an agent-side endpoint builds one from its req). Returns a
// normalized result both the gateway and the drain understand — never throws
// on a bad signature, because "unverified" is a routine outcome, not an error.
//
// Three outcomes, kept apart because the door acts on them differently. Only a
// signature we could CHECK and found wrong is a forgery. A key we could not
// fetch proves nothing: a sender in secure mode — Threads, Mastodon with
// AUTHORIZED_FETCH — answers this keyless loader 404 or 401, so its deliveries
// have to degrade to unverified rather than be read as forged.
export async function verifyHttpSignature(request, { documentLoader, keyCache, timeWindow } = {}) {
  const hadSig = request.headers.get('signature') != null;
  let result = null;
  try {
    result = await verifyRequestDetailed(request, {
      documentLoader,
      ...(keyCache ? { keyCache } : {}),
      timeWindow: timeWindow ?? { hours: 1 },
    });
  } catch {
    result = null;   // the library itself failed — no more informative than a bad signature
  }
  if (result?.verified) {
    const key = result.key;
    return {
      verified: true, method: 'draft-cavage',
      keyId: key.id?.href ?? null, actor: key.ownerId?.href ?? null, reason: null,
      checks: { signature: true, digest: true, dateSkew: true, keyFetched: true },
    };
  }
  const kind = result?.reason?.type;
  if (!hadSig || kind === 'noSignature') {
    return {
      verified: false, method: 'none', keyId: null, actor: null,
      reason: 'no-signature', checks: { signature: false },
    };
  }
  if (kind === 'keyFetchError') {
    return {
      verified: false, method: 'draft-cavage', keyId: null, actor: null,
      reason: 'key-unfetchable', checks: { signature: false, keyFetched: false },
    };
  }
  return {
    verified: false, method: 'draft-cavage', keyId: null, actor: null,
    reason: 'bad-signature', checks: { signature: false },
  };
}

// The receipt: what the door concluded, HMAC-stamped so the drain can trust it
// even while the inbox is still public-Append (a forger without the secret
// cannot mint `verified: true`). The HMAC is over the receipt minus the hmac
// field itself, with sorted keys so gateway and drain canonicalize alike.
function canonical(obj) {
  return JSON.stringify(obj, Object.keys(obj).filter(k => k !== 'hmac').sort());
}

export function makeReceipt(result, { gateway = null } = {}) {
  return {
    v: 1,
    verified: !!result.verified,
    method: result.method,
    keyId: result.keyId,
    actor: result.actor,
    checks: result.checks,
    reason: result.reason,
    gateway,
  };
}

export function signReceipt(receipt, secret) {
  const hmac = crypto.createHmac('sha256', secret).update(canonical(receipt)).digest('base64');
  return { ...receipt, hmac };
}

// True only when the receipt carries a valid HMAC for `secret`. A missing
// secret, a missing hmac, or a mismatch all read as "not ours" → the drain
// treats the receipt as absent (today's unverified behavior). timingSafeEqual
// over equal-length buffers; unequal lengths are a straight mismatch.
export function verifyReceipt(receipt, secret) {
  if (!receipt || typeof receipt !== 'object' || !receipt.hmac || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(canonical(receipt)).digest();
  let given;
  try { given = Buffer.from(receipt.hmac, 'base64'); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
