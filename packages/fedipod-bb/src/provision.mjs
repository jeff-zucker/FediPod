// provision.mjs — bringing a forum's containers into being with their access
// rules, the way FediPod provisions an identity: a canary document and the
// rule as one operation, idempotent, so running it on every start is safe.

import * as containers from '../../../lib/pod/containers.mjs';

// The forum level: the site actor's home and state, owner-only; its notes
// and media, public.
export async function provisionForum(remote, site, { moderatorWebIds = [] } = {}) {
  await containers.provisionPrivate(remote, site);
  await containers.provisionPublic(remote, site.notes);
  await containers.provisionPublic(remote, site.media);
  // What only the moderators may see: reports name people, and held posts
  // are somebody's words that the forum has not carried. Not public, not
  // owner-only either — each moderator's WebID may read it.
  await remote.putJson(site.mod + '.keep', { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Object' }, 'application/activity+json');
  await remote.setAcl(site.mod, [], { readAgents: moderatorWebIds });
}

// A category: a group's home and state, owner-only; its public trees, plus
// the topic container and the cache, public. The topic container's rule is
// what every topic head and page inherits.
export async function provisionCategory(remote, cat, { memberWebIds = null } = {}) {
  await containers.provisionPrivate(remote, cat);
  for (const base of [cat.notes, cat.media, cat.topicContainer, cat.cache]) {
    // A members-only category: the same containers, readable by the people
    // named rather than by the world. The actor itself stays public — a
    // server that cannot read the actor cannot deliver to the category at
    // all, and members join from outside.
    if (memberWebIds) {
      await remote.putJson(base + '.keep', { '@context': 'https://www.w3.org/ns/activitystreams', type: 'Object' }, 'application/activity+json');
      await remote.setAcl(base, [], { readAgents: memberWebIds });
    } else {
      await containers.provisionPublic(remote, base);
    }
  }
}
