// gateway-core.mjs — the runtime-agnostic logic of an inbox gateway: verify a
// delivery at the door (where the HTTP-Signature headers still exist), drop
// spam and forgeries at the edge, and forward what remains — with a signed
// verification receipt — into the pod inbox for the ordinary drain.
//
// This holds NO signing key. It verifies with remotes' PUBLIC keys, writes to
// the pod inbox with an Append-only credential the adapter supplies, and stamps
// the receipt with a shared HMAC secret. A compromise here can inject inbox
// items (which still meet verify-by-dereference in the drain) but cannot
// impersonate the actor, read the private tree, or post as it.
//
// `netlify/functions/inbox.mjs` is a thin adapter over this; an agent-side
// endpoint could be another. The core is what the smoke suite exercises.

import crypto from 'node:crypto';
import { verifyHttpSignature, makeSafeLoader, makeReceipt, signReceipt } from './httpsig.mjs';

const DEFAULT_MAX_BYTES = 512 * 1024;   // mirror intake.mjs MAX_ITEM_BYTES

// Control activities are the message itself and must always pass — you want
// Follows from strangers. Only CONTENT is subject to the concerns-us drop.
const CONTROL = new Set(['Follow', 'Undo', 'Accept', 'Reject', 'Delete', 'Move',
  'Add', 'Remove', 'Block']);

const idOf = (v) => (typeof v === 'string' ? v : v?.id) || null;
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function httpUrl(u) {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

// Mirror of intake.isBlocked over the policy doc's public blocklist mirror.
function isBlocked(actor, blocklist = {}) {
  if (!actor) return true;
  if ((blocklist.actors || []).includes(actor)) return true;
  let host; try { host = new URL(actor).host; } catch { return false; }
  return (blocklist.domains || []).some(d => host === d || host.endsWith('.' + d));
}

// The edge form of intake.concernsUs — pure addressing, no I/O. Conservative:
// only DROPS content it is confident does not concern the identity. A GROUP
// owns conversations under anything it has carried, which the keyless edge
// cannot see, so a group defers the whole check to the drain (returns true).
function concernsUsAtEdge(activity, ident) {
  if (ident.kind === 'group') return true;
  const actor = idOf(activity.actor);
  if ((ident.following || []).includes(actor)) return true;
  const obj = typeof activity.object === 'object' ? activity.object : null;
  const audience = []
    .concat(activity.to || [], activity.cc || [], activity.bto || [], activity.bcc || [], activity.audience || [],
      obj?.to || [], obj?.cc || [], obj?.audience || [])
    .map(idOf).filter(Boolean);
  if (audience.includes(ident.actorUrl) || audience.includes(ident.followersUrl)) return true;
  const tag = [].concat(obj?.tag || activity.tag || []);
  if (tag.some(t => t?.type === 'Mention' && (t.href === ident.actorUrl || t.name?.includes(ident.actorUrl)))) return true;
  const inReplyTo = idOf(obj?.inReplyTo ?? activity.inReplyTo);
  return !!inReplyTo && ident.notesPrefix && String(inReplyTo).startsWith(ident.notesPrefix);
}

// Handle one inbound delivery. `request` is a WHATWG Request. `ident` is the
// resolved identity policy: { inboxUrl, actorUrl, followersUrl, notesPrefix,
// following, blocklist, kind, gatewayWebId, hmacSecret }. `podPut(url, body,
// contentType) → boolean` appends to the pod with the gateway's credential.
// Returns { status, reason } — the adapter turns it into an HTTP response.
export async function handleDelivery(request, ident, { podPut, fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  // Read the body once from a clone; the original, unconsumed, goes to the
  // verifier (which needs the body for the Digest check).
  let raw;
  try { raw = await request.clone().text(); } catch { return { status: 400, reason: 'unreadable body' }; }
  if (Buffer.byteLength(raw) > maxBytes) return { status: 413, reason: 'too large' };

  let activity;
  try { activity = JSON.parse(raw); } catch { return { status: 400, reason: 'unparsable JSON' }; }
  const actor = idOf(activity.actor);
  if (!httpUrl(actor)) return { status: 400, reason: 'actor is not an http(s) URL' };

  // Edge drops — silent 202 so a rejected sender does not retry a delivery we
  // will never accept. None of these becomes a pod write.
  if (isBlocked(actor, ident.blocklist)) return { status: 202, reason: 'blocked' };
  if (!CONTROL.has(activity.type) && !concernsUsAtEdge(activity, ident)) {
    return { status: 202, reason: 'does not concern us' };
  }

  const v = await verifyHttpSignature(request, {
    documentLoader: makeSafeLoader({ fetchImpl }),
  });
  // A present-but-invalid signature is a forgery — dropped here, so it never
  // reaches the pod (today it would, drain, and die unapplied). An absent or
  // unfetchable-key signature is NOT dropped: it forwards unverified and the
  // drain's verify-by-dereference still stands behind it.
  if (v.verified === false && v.reason === 'bad-signature-or-key-unfetchable') {
    return { status: 202, reason: 'forged signature' };
  }

  const receipt = signReceipt(makeReceipt(v, { gateway: ident.gatewayWebId }), ident.hmacSecret);
  const hash = sha256hex(raw);
  const okA = await podPut(ident.inboxUrl + hash, raw, 'application/activity+json');
  // A pod-write failure returns 5xx so the ORIGIN retries over its own ladder —
  // that is what preserves the pod's buffer property without the gateway
  // holding any state.
  if (!okA) return { status: 502, reason: 'pod inbox write failed' };
  // The receipt is best-effort, like _archive: a delivery that landed but whose
  // receipt did not is simply unverified, never lost.
  await podPut(ident.inboxUrl + hash + '.receipt.json', JSON.stringify(receipt), 'application/json')
    .catch(() => {});
  return { status: 202, reason: v.verified ? 'verified' : 'buffered-unverified' };
}

export const _internal = { isBlocked, concernsUsAtEdge, httpUrl, sha256hex };
