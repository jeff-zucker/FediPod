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
import * as inbox from '../pod/inbox.mjs';
import { senderKeys } from './caches.mjs';

const DEFAULT_MAX_BYTES = 512 * 1024;   // mirror intake.mjs MAX_ITEM_BYTES

// Control activities are the message itself and must always pass — you want
// Follows from strangers. Only CONTENT is subject to the concerns-us drop,
// and to a pause: an account nobody is reading still takes its follows.
export const CONTROL = new Set(['Follow', 'Undo', 'Accept', 'Reject', 'Delete', 'Move',
  'Add', 'Remove', 'Block']);
export const isControl = (type) => CONTROL.has(type);

const idOf = (v) => (typeof v === 'string' ? v : v?.id) || null;
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function httpUrl(u) {
  try { const p = new URL(u).protocol; return p === 'http:' || p === 'https:'; } catch { return false; }
}

// Mirror of intake.isBlocked over the policy doc's public blocklist mirror.
function isBlocked(actor, blocklist = {}) {
  if (!actor) return true;
  if ((blocklist.actors || []).includes(actor)) return true;
  // hostname, not host: the agent's own isBlocked strips the port, and a door
  // that keeps it lets a blocked domain back in on a non-default port.
  let host; try { host = new URL(actor).hostname; } catch { return false; }
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
// `paused` says nobody is reading this inbox: content is accepted and
// discarded (the same quiet 202 a blocked sender gets, so nothing retries
// and nothing counts a failure against this host), control still lands.
// Returns { status, reason } — the adapter turns it into an HTTP response —
// and, for a delivery that reached the pod, `content` (whether it was
// content rather than control) and `bytes`, so the caller can keep count.
export async function handleDelivery(request, ident, { podPut, fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES, paused = false } = {}) {
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
  const content = !CONTROL.has(activity.type);
  if (content && paused) return { status: 202, reason: 'paused' };
  if (content && !concernsUsAtEdge(activity, ident)) {
    return { status: 202, reason: 'does not concern us' };
  }

  // The sender's key, kept between deliveries: a server pushing a hundred
  // items is asked for its key once (caches.mjs).
  const v = await verifyHttpSignature(request, {
    documentLoader: makeSafeLoader({ fetchImpl }), keyCache: senderKeys,
  });
  // A present-but-invalid signature is a forgery — dropped here, so it never
  // reaches the pod (today it would, drain, and die unapplied). An absent or
  // unfetchable-key signature is NOT dropped: it forwards unverified and the
  // drain's verify-by-dereference still stands behind it.
  if (v.verified === false && v.reason === 'bad-signature') {
    return { status: 202, reason: 'forged signature' };
  }

  // No per-user secret on record = no receipt: the delivery still filters and
  // forwards, it just reads as unverified at the drain — never a failure.
  const receipt = ident.hmacSecret
    ? signReceipt(makeReceipt(v, { gateway: ident.gatewayWebId }), ident.hmacSecret)
    : null;
  const hash = sha256hex(raw);
  const okA = await inbox.appendVerifiedDelivery(podPut, ident.inboxUrl, hash, raw);
  // A pod-write failure returns 5xx so the ORIGIN retries over its own ladder —
  // that is what preserves the pod's buffer property without the gateway
  // holding any state.
  if (!okA) return { status: 502, reason: 'pod inbox write failed' };
  if (receipt) await inbox.writeReceiptBeside(podPut, ident.inboxUrl, hash, receipt);
  return { status: 202, reason: v.verified ? 'verified' : 'buffered-unverified', content, bytes: Buffer.byteLength(raw) };
}

// The outbox door: the owner's own post, taken on their behalf.
//
// A client such as dokieli POSTs an activity — or a bare object — to the
// outbox address the actor advertises. The door holds no key and mints nothing:
// it checks that the token proves the account's owner (the caller has already
// done that and hands in `owner`), writes the bytes into the pod inbox exactly
// as verified mail is written, and stamps them with a receipt whose method is
// `c2s` and whose actor is this account. The drain hands such an item to the
// client-to-server dispatcher, which publishes and delivers it — so the post
// goes out when the agent next runs, the same way inbound mail is read.
//
// `slug` is the name the client asked for its new document. It rides in the
// receipt so the dispatcher can use it, and it is what lets the door answer a
// Location before anything exists: the object will live at notesPrefix+slug
// unless that name is taken, in which case the agent mints another.
export const SLUG_OK = /^[A-Za-z0-9._-]{1,64}$/u;
export const safeSlug = (s) => (typeof s === 'string' && SLUG_OK.test(s) && !/^\.+$/u.test(s) ? s : null);

export async function handleOwnerPost(request, ident, { podPut, ownerWebId, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!ident.hmacSecret) return { status: 409, reason: 'this account has no door secret — attach it again' };
  let raw;
  try { raw = await request.text(); } catch { return { status: 400, reason: 'unreadable body' }; }
  if (Buffer.byteLength(raw) > maxBytes) return { status: 413, reason: 'too large' };
  let doc;
  try { doc = JSON.parse(raw); } catch { return { status: 400, reason: 'unparsable JSON' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !doc.type) {
    return { status: 400, reason: 'a typed ActivityStreams object is required' };
  }
  const slug = safeSlug(request.headers.get('slug'));
  const receipt = signReceipt({
    v: 1, verified: true, method: 'c2s', keyId: ownerWebId || null, actor: ident.actorUrl,
    checks: ['owner-token'], reason: 'owner', gateway: ident.gatewayWebId, ...(slug ? { slug } : {}),
  }, ident.hmacSecret);
  const hash = sha256hex(raw);
  const okA = await inbox.appendVerifiedDelivery(podPut, ident.inboxUrl, hash, raw);
  if (!okA) return { status: 502, reason: 'pod inbox write failed' };
  await inbox.writeReceiptBeside(podPut, ident.inboxUrl, hash, receipt);
  return { status: 202, reason: 'accepted', location: slug && ident.notesPrefix ? ident.notesPrefix + slug : null };
}

export const _internal = { isBlocked, concernsUsAtEdge, httpUrl, sha256hex };
