// urls.mjs — where a forum's documents live on its pod.
//
// A forum is one root holding a site actor and, under `c/`, one FediPod group
// root per category. The group roots are `apUrls` verbatim, so every module
// that publishes or drains a group works on a category unchanged; the forum
// adds the topic documents beside them and one inbox above them.
//
// The root is this application's answer, stated here: the pod library refuses
// to guess one, and a forum is one application.

import crypto from 'node:crypto';
import { apUrls } from '../../../lib/pod/urls.mjs';

export const ROOT = 'fedipod-bb/';

// A category's slug is its handle's local part and a container name: lower
// case letters, digits and hyphens, starting with a letter or digit.
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
export const isSlug = (s) => typeof s === 'string' && SLUG.test(s);

// A topic's id on the pod: the month it opened and a slug of its title, which
// keeps a category's topic container readable to a person listing it.
export const TID = /^[0-9]{4}-[0-9]{2}-[a-z0-9][a-z0-9-]{0,78}$/u;
export const isTid = (s) => typeof s === 'string' && TID.test(s);

// The name a cached copy is filed under: a post's id is a URL and a URL is
// not a file name, so the copy takes a digest of it.
export const cacheKey = (postId) => crypto.createHash('sha256').update(String(postId)).digest('hex').slice(0, 16);

// `front` and `handle`: a forum reachable through a Gateway. Its own actor
// answers at `<front>/u/<handle>/`, each category at `<front>/u/<slug>/`,
// and every advertised id is rewritten onto the pod at the transport's one
// choke point (`toPod`). Without a front the ids are the pod's own.
export function forumUrls(remotePod, root = ROOT, { publicBase = null, front = null, handle = null } = {}) {
  const origin = front ? String(front).replace(/\/$/u, '') : null;
  if (origin && !handle) throw new Error('forumUrls: a fronted forum needs its handle');
  const site = apUrls(remotePod, root, { publicBase: publicBase || (origin ? `${origin}/u/${handle}/` : null) });
  const face = site.actor.slice(0, -'ap/actor'.length);
  site.front = origin;
  site.categories = face + 'ap/categories';
  site.administrators = face + 'ap/administrators';
  // Everything the forum holds, newest first, across every category: what a
  // reader arriving at the forum sees before they know its categories.
  site.latest = face + 'ap/latest';
  // The moderators' own container: the queue of reports and held posts,
  // readable by the moderators' WebIDs and nobody else. Under the pod's own
  // root, not the advertised face — nothing here is published.
  site.mod = (remotePod.endsWith('/') ? remotePod : remotePod + '/') + (root.endsWith('/') ? root : root + '/') + 'mod/';
  site.siteHtml = face + 'ap/site.html';
  site.root = root.endsWith('/') ? root : root + '/';
  site.category = (slug) => {
    if (!isSlug(slug)) throw new Error(`forumUrls: not a category slug (${slug})`);
    return categoryUrls(remotePod, site.root + 'c/' + slug + '/', {
      publicBase: origin ? `${origin}/u/${slug}/` : (publicBase ? face + 'c/' + slug + '/' : null),
      forumInbox: site.inbox,
    });
  };
  return site;
}

// A category: a group root plus the topic documents. `forumInbox` is what
// the category advertises as its inbox — deliveries to any category land in
// the forum's one inbox, and the host routes them.
export function categoryUrls(remotePod, root, { publicBase = null, forumInbox = null } = {}) {
  const urls = apUrls(remotePod, root, { publicBase });
  const face = urls.actor.slice(0, -'ap/actor'.length);
  urls.forumInbox = forumInbox || urls.inbox;
  // The category's topics, newest first, paged like an outbox: a head under
  // ap/ and page documents beside it.
  urls.topics = face + 'ap/topics';
  urls.topicsPage = (n) => `${urls.topics}-${n}`;
  // One topic: its head and its pages live in a public container, so a new
  // page inherits the container's rule and needs none of its own.
  urls.topicContainer = face + 'ap/topic/';
  urls.topic = (tid) => {
    if (!isTid(tid)) throw new Error(`categoryUrls: not a topic id (${tid})`);
    return urls.topicContainer + tid;
  };
  urls.topicPage = (tid, n) => `${urls.topic(tid)}-${n}`;
  // Readable copies of members' posts, for the website.
  urls.cache = face + 'ap/cache/';
  urls.cached = (postId) => urls.cache + cacheKey(postId);
  urls.categoryHtml = face + 'ap/index.html';
  urls.topicHtml = (tid) => face + 'ap/t/' + tid + '.html';
  return urls;
}
