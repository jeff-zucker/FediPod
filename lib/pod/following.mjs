// following.mjs — ap/following: who this actor follows.
//
// Flat, not paged: it is bounded by what one person chose to do, where the
// followers list is bounded by what everyone else chose.

import * as collection from './collection.mjs';

// ---- the owner's agent ----

export const write = (pod, urls, doc, opts) => collection.writeFlat(pod, urls.following, doc, opts);
