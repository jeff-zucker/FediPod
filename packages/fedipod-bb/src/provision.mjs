// provision.mjs — bringing a forum's containers into being with their access
// rules, the way FediPod provisions an identity: a canary document and the
// rule as one operation, idempotent, so running it on every start is safe.

import * as containers from '../../../lib/pod/containers.mjs';

// The forum level: the site actor's home and state, owner-only; its notes
// and media, public.
export async function provisionForum(remote, site) {
  await containers.provisionPrivate(remote, site);
  await containers.provisionPublic(remote, site.notes);
  await containers.provisionPublic(remote, site.media);
}

// A category: a group's home and state, owner-only; its public trees, plus
// the topic container and the cache, public. The topic container's rule is
// what every topic head and page inherits.
export async function provisionCategory(remote, cat) {
  await containers.provisionPrivate(remote, cat);
  for (const base of [cat.notes, cat.media, cat.topicContainer, cat.cache]) {
    await containers.provisionPublic(remote, base);
  }
}
