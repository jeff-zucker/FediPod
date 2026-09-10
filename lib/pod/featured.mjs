// featured.mjs — ap/featured and ap/moderators: the two small public rosters.
//
// Together because both are short, flat, public lists that say "these are the
// ones that matter", and neither is big enough to page. `featured` is the
// pinned posts; `moderators` is FEP-1b12's roster, which a recipient validates
// a group's announced moderation against — published only when a group
// actually has moderators, since an empty roster and no roster mean different
// things.

import * as collection from './collection.mjs';

// ---- the owner's agent ----

export const write = (pod, urls, doc) =>
  collection.writeFlat(pod, urls.featured, doc, { publicRead: true });

export const writeModerators = (pod, urls, doc) =>
  collection.writeFlat(pod, urls.moderators, doc, { publicRead: true });
