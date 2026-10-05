// private-read.mjs — a followers-only or direct post, read at its address by
// a server it was sent to (ActivityPub §3.2). The read is signed the way a
// delivery is; the signer is resolved; and the post is served only to an
// actor in its audience: a follower for a post sent to followers, a named
// recipient for a direct one. That is the rule Mastodon applies to its own
// posts (StatusPolicy#show?). Anyone else learns nothing — 404, as for a
// document that is not there, which §3.2 allows for a private target.
//
// At fedipod.net this works for an account it keeps: the post is read from
// the pod with the keeper's credential, and the followers list from the
// account's copy, or from the pod when there is no copy just then (the hold,
// copy.mjs). Nothing read is kept. An account it does not keep gives it
// nothing to read with,
// so that read is sent on to the pod, as every private read was.

import { verifyHttpSignature, makeSafeLoader } from './httpsig.mjs';
import { asSigned } from './gateway-core.mjs';
import { senderKeys } from './caches.mjs';
import { keptNow } from './copy.mjs';
import { sameOrigin } from '../core/intake/activity.mjs';

const AP_CT = 'application/activity+json';
const PUBLIC_NAMES = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public']);
const list = (v) => (v == null ? [] : Array.isArray(v) ? v : [v])
  .map((x) => (typeof x === 'string' ? x : x?.id)).filter((x) => typeof x === 'string');

/** Who a document was sent to: the actors named, and whether followers were. */
export function audienceOf(doc, followersUrls = []) {
  const o = doc?.type === 'Create' && doc.object && typeof doc.object === 'object' ? doc.object : doc;
  const named = new Set(['to', 'cc', 'audience'].flatMap((k) => [...list(doc?.[k]), ...list(o?.[k])]));
  return {
    named,
    isPublic: [...named].some((a) => PUBLIC_NAMES.has(a)),
    toFollowers: followersUrls.some((f) => named.has(f)),
  };
}

/** Whether `actor` may read `doc`: named in its audience, or a follower when it went to followers. */
export function mayRead(doc, actor, { followersUrls = [], followers = [] } = {}) {
  if (typeof actor !== 'string' || !actor) return false;
  const a = audienceOf(doc, followersUrls);
  if (a.isPublic || a.named.has(actor)) return true;
  return a.toFollowers && followers.includes(actor);
}

/**
 * The actor behind a signed read, or null with why. `origin` is the door's
 * own (see asSigned in gateway-core.mjs); a GET has no body to digest.
 */
export async function signedReader(request, { fetchImpl = fetch, origin = null } = {}) {
  if (!request.headers.get('signature')) return { actor: null, reason: 'no-signature' };
  const v = await verifyHttpSignature(asSigned(request, new Uint8Array(0), origin), {
    documentLoader: makeSafeLoader({ fetchImpl }), keyCache: senderKeys,
  });
  if (!v.verified || typeof v.actor !== 'string') return { actor: null, reason: v.reason };
  // A key document names its owner, and anyone can publish one naming anyone.
  // Only a key on the owner's own server speaks for them — the drain's rule too
  // (receiptVouchesFor in lib/core/intake/verify.mjs).
  if (!sameOrigin(v.keyId, v.actor)) return { actor: null, reason: 'key-not-on-signer-origin' };
  return { actor: v.actor, reason: null };
}

// Refused reads are told nothing, and never held at the edge.
const nothing = (open) => ({ status: 404, headers: { ...open, 'cache-control': 'no-store', vary: 'Signature' }, body: '' });

/**
 * A read under `ap/private/` at the front. Unsigned: sent on to the pod, which
 * decides (the owner reads there with their own credential). Signed: answered
 * here for a kept account, to a reader the post was sent to.
 */
export async function answerPrivateRead(ctx, rec, { request, handle, podTarget, base, open, swap }) {
  if (!request.headers.get('signature')) {
    return { status: 303, headers: { ...open, location: podTarget, 'cache-control': 'no-store' }, body: '' };
  }
  const say = (what) => console.log(`private read @${handle}: ${what}`);
  if (!keptNow(ctx, rec) || typeof ctx.keeperFetch !== 'function' || !ctx.copyKv) { say('refused — account not kept here'); return nothing(open); }
  const { actor, reason } = await signedReader(request, { fetchImpl: ctx.fetchImpl || fetch, origin: ctx.frontOrigin || null });
  if (!actor) { say(`refused — ${reason}`); return nothing(open); }
  const podFetch = await ctx.keeperFetch();
  if (!podFetch) { say('refused — no keeper credential'); return nothing(open); }
  let text = null;
  try {
    const res = await podFetch(podTarget, { headers: { accept: AP_CT } });
    if (res.status === 200) text = await res.text();
  } catch { /* unreachable: nothing to serve */ }
  let doc = null;
  try { doc = text ? JSON.parse(text) : null; } catch { doc = null; }
  if (!doc) { say(`refused — the pod did not give it (${actor})`); return nothing(open); }
  // Who follows: from the account's copy while there is one, else from the pod.
  let followers = [];
  try {
    let contacts = (await ctx.copyKv.get(`${handle}/d/contacts.json`))?.text || null;
    if (!contacts) {
      const res = await podFetch(`${rec.podHome.replace(/\/?$/u, '/')}ap-state/contacts.json`, { headers: { accept: 'application/json' } });
      if (res.status === 200) contacts = await res.text();
    }
    followers = (JSON.parse(contacts || '{}').followers || []).map((f) => f?.actor).filter(Boolean);
  } catch { followers = []; }
  const followersUrls = [rec.podHome + 'ap/followers', base + 'ap/followers'];
  if (!mayRead(doc, actor, { followersUrls, followers })) { say(`refused — ${actor} is not in its audience`); return nothing(open); }
  say(`served to ${actor}`);
  return { status: 200, headers: { ...open, 'content-type': AP_CT, 'cache-control': 'no-store', vary: 'Signature' },
    body: request.method === 'HEAD' ? '' : swap(text, rec.podHome, base) };
}
