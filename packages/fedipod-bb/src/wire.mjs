// wire.mjs — the forum's documents as other servers read them: a topic as a
// context collection (FEP-7888), a category's topic list, the forum's
// category and administrator lists, and the site actor. Every term is
// ActivityStreams; the group actor a category publishes is FediPod's own.

import { AS_CTX, pageItems, orderedCollection, actorDoc } from '../../../lib/core/wire.mjs';

export const TOPIC_PAGE_SIZE = 20;
export const TOPICS_PAGE_SIZE = 20;

// ── a topic ────────────────────────────────────────────────────────────
// The head is what a post's `context` names: the collection's owner is the
// category (`attributedTo`), the audience is the category, and the pages
// hold the posts in the order they were said. Oldest first: a thread is
// read forwards, so `first` is page 1.
export function topicHead({ id, name, category, total, pageCount, published, updated = null, closed = null }) {
  const pages = Math.max(1, pageCount);
  return {
    '@context': AS_CTX,
    id, type: 'OrderedCollection',
    name,
    attributedTo: category,
    audience: category,
    totalItems: total,
    first: `${id}-1`,
    last: `${id}-${pages}`,
    published,
    ...(updated ? { updated } : {}),
    // Closed: this topic takes no more replies (AS2 `closed`).
    ...(closed ? { closed } : {}),
  };
}

// A page carries `prev` and `next` both ways. Writing page n+1 rewrites page
// n once, to give it a `next`; nothing else on a sealed page ever changes.
export function topicPage({ id, n, items, pageCount }) {
  return {
    '@context': AS_CTX,
    id: `${id}-${n}`,
    type: 'OrderedCollectionPage',
    partOf: id,
    ...(n > 1 ? { prev: `${id}-${n - 1}` } : {}),
    ...(n < pageCount ? { next: `${id}-${n + 1}` } : {}),
    orderedItems: items,
  };
}

// Posts in the order they were said; the assignment is kept so a removed
// post leaves its page one short rather than re-slicing every page after it.
export function topicPaging(postIds, index = []) {
  const byId = new Map();
  for (const id of postIds) if (typeof id === 'string' && !byId.has(id)) byId.set(id, id);
  return pageItems({ order: postIds, byId, index, pageSize: TOPIC_PAGE_SIZE });
}

// ── a category's topics ────────────────────────────────────────────────
// Newest first, the way an outbox is read: `first` is the newest page and
// `next` walks back in time. Pages are numbered from the oldest end so
// opening a topic moves only the newest page.
export function topicsHead({ id, category, total, pageCount }) {
  const pages = Math.max(1, pageCount);
  return {
    '@context': AS_CTX,
    id, type: 'OrderedCollection',
    attributedTo: category,
    totalItems: total,
    first: `${id}-${pages}`,
    last: `${id}-1`,
  };
}

export function topicsPage({ id, n, items }) {
  return {
    '@context': AS_CTX,
    id: `${id}-${n}`,
    type: 'OrderedCollectionPage',
    partOf: id,
    orderedItems: [...items].reverse(),          // newest first within the page
    ...(n > 1 ? { next: `${id}-${n - 1}` } : {}),
  };
}

// `topicIds` oldest first, as the record keeps them.
export function topicsPaging(topicIds, index = []) {
  const byId = new Map();
  for (const id of topicIds) if (typeof id === 'string' && !byId.has(id)) byId.set(id, id);
  return pageItems({ order: topicIds, byId, index, pageSize: TOPICS_PAGE_SIZE });
}

// ── the forum ──────────────────────────────────────────────────────────
export const categoriesCollection = (id, actorIds) => orderedCollection(id, actorIds);
export const administratorsCollection = (id, actorIds) => orderedCollection(id, actorIds);
// The latest posts: the forum's own copies of them, newest first. Its items
// are the copies rather than the authors' ids, because one fetch of a copy
// tells a reader everything — who wrote it, when, and which topic it is in.
export const latestCollection = (id, copyUrls) => orderedCollection(id, copyUrls);

// The forum's own actor: an Application, the service that speaks for the
// site. Everything else is what any FediPod actor carries.
export function siteActorDoc(opts) {
  return actorDoc({ ...opts, kind: 'application' });
}

// ── a cached copy ──────────────────────────────────────────────────────
// What a removed copy becomes: a Tombstone that says what it was, so a
// reader landing on it knows a post stood here (FEP-4f05).
export function cachedTombstone({ id, formerType = 'Note', deleted = new Date().toISOString() }) {
  return { '@context': AS_CTX, id, type: 'Tombstone', formerType, deleted };
}
