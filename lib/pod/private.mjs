// private.mjs — ap/private/: the collections that are nobody else's business.
//
// pending-followers and pending-following are FEP-4ccd's follows in limbo;
// blocked is FEP-c648's block list. All three live in the private container so
// the owner-only rule is INHERITED rather than re-stated per document — which
// is why none of these writes sets an ACL of its own, and why writing one into
// the wrong container would silently publish it.

import * as collection from './collection.mjs';

// ---- the owner's agent ----

export async function writePending(pod, urls, { followers, following }) {
  await collection.writeFlat(pod, urls.pendingFollowers, followers);
  await collection.writeFlat(pod, urls.pendingFollowing, following);
}

export const writeBlocked = (pod, urls, doc) =>
  collection.writeFlat(pod, urls.blocked, doc);
