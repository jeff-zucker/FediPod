// publish.mjs — writing the forum's documents to the pod, and only the ones
// that changed. Every paged collection keeps the digest of each page it last
// wrote, as FediPod's outbox does, so a sealed page is never re-PUT and a
// republish of an unchanged forum writes nothing.
//
// A call takes `{ remote, store, urls }`: the pod transport, the owner-only
// state (a PodStore), and the category's or forum's urls.

import crypto from 'node:crypto';
import * as collection from '../../../lib/pod/collection.mjs';
import * as podNotes from '../../../lib/pod/notes.mjs';
import { sanitizeHtml } from '../../../lib/core/wire.mjs';
import * as fwire from './wire.mjs';
import * as topics from './topics.mjs';

const digestOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);

// One topic: its pages and its head. Returns how many documents were written.
export async function publishTopic({ remote, store, urls }, tid, { force = false } = {}) {
  const doc = topics.get(store, tid);
  if (!doc) throw new Error(`publishTopic: no such topic ${tid}`);
  const id = urls.topic(tid);
  const { index, pages } = fwire.topicPaging(doc.posts.map(p => p.id), doc.index);
  const before = force ? {} : (doc.pages || {});
  const after = {};
  let wrote = 0;
  for (let i = 0; i < pages.length; i++) {
    const n = i + 1;
    const page = fwire.topicPage({ id, n, items: pages[i], pageCount: pages.length });
    const digest = digestOf(page);
    after[n] = digest;
    if (before[n] === digest) continue;
    // The topic container is public-Read; a page inherits it.
    await collection.writePage(remote, urls.topicPage(tid, n), page);
    wrote++;
  }
  for (const n of Object.keys(doc.pages || {}).map(Number).filter(n => n > pages.length)) {
    await collection.dropPage(remote, urls.topicPage(tid, n));
  }
  const entry = topics.list(store).find(t => t.tid === tid);
  const head = fwire.topicHead({
    id, name: doc.title, category: urls.actor, total: doc.posts.length, pageCount: pages.length,
    closed: store.read('topics.json', []).find(t => t.tid === tid)?.locked ? (doc.closedAt || new Date().toISOString()) : null,
    published: entry?.created || doc.posts[0]?.published || null,
    updated: doc.posts.length > 1 ? (entry?.last || null) : null,
  });
  const headDigest = digestOf(head);
  if (force || headDigest !== doc.headDigest) {
    await collection.writeHead(remote, id, head);
    wrote++;
  }
  store.write(topics.topicDoc(tid), { ...doc, index, pages: after, headDigest });
  return wrote;
}

// The category's topic list. Oldest first in the record; the pages read
// newest first. Kept in `published.json` beside the group's own digests.
export async function publishTopicIndex({ remote, store, urls }, { force = false } = {}) {
  const seen = store.read('published.json', {});
  const order = topics.list(store).map(t => urls.topic(t.tid));
  const { index, pages } = fwire.topicsPaging(order, seen.topicsIndex || []);
  const before = force ? {} : (seen.topicsPages || {});
  const after = {};
  let wrote = 0;
  for (let i = 0; i < pages.length; i++) {
    const n = i + 1;
    const page = fwire.topicsPage({ id: urls.topics, n, items: pages[i] });
    const digest = digestOf(page);
    after[n] = digest;
    if (before[n] === digest) continue;
    // Under ap/ directly, whose container is owner-only: the rule is set when
    // a page is first created, as the outbox does.
    await collection.writePage(remote, urls.topicsPage(n), page, { publicRead: !before[n] || force });
    wrote++;
  }
  for (const n of Object.keys(seen.topicsPages || {}).map(Number).filter(n => n > pages.length)) {
    await collection.dropPage(remote, urls.topicsPage(n));
  }
  const head = fwire.topicsHead({ id: urls.topics, category: urls.actor, total: order.length, pageCount: pages.length });
  const headDigest = digestOf(head);
  if (force || headDigest !== seen.topicsHead) {
    await collection.writeHead(remote, urls.topics, head, { publicRead: !seen.topicsHead || force });
    wrote++;
  }
  store.write('published.json', { ...store.read('published.json', {}), topicsPages: after, topicsIndex: index, topicsHead: headDigest });
  return wrote;
}

// The forum's two flat lists, each written only when it changed.
export async function publishCategories({ remote, store, urls }, actorIds, { force = false } = {}) {
  return flat({ remote, store }, 'categories', urls.categories, fwire.categoriesCollection(urls.categories, actorIds), force);
}

// How many of the newest posts the forum keeps an index of.
// How many of the newest posts the forum keeps an index of. A page shows
// thirty at a time and asks for more; this is the whole of what it can ask
// for, and the topics themselves hold everything older.
export const LATEST_MAX = 500;

export async function publishLatest({ remote, store, urls }, { force = false } = {}) {
  const items = store.read('latest.json', []).slice(0, LATEST_MAX).map(e => e.copy);
  return flat({ remote, store }, 'latest', urls.latest, fwire.latestCollection(urls.latest, items), force);
}

export async function publishAdministrators({ remote, store, urls }, actorIds, { force = false } = {}) {
  return flat({ remote, store }, 'administrators', urls.administrators, fwire.administratorsCollection(urls.administrators, actorIds), force);
}

async function flat({ remote, store }, key, url, doc, force) {
  const seen = store.read('published.json', {});
  const digest = digestOf(doc);
  if (!force && seen[key] === digest) return 0;
  await collection.writeFlat(remote, url, doc, { publicRead: !seen[key] || force });
  store.write('published.json', { ...store.read('published.json', {}), [key]: digest });
  return 1;
}

// A member's post, as verified at its origin, made readable for the website.
// Content is sanitised again on the way in; nothing else is changed, so the
// copy says what the author said, under the author's own id. Returns the
// copy's url.
export async function cachePost({ remote, urls }, note, { topic = null, replies = null } = {}) {
  const copy = { ...note };
  if (topic) copy.context = topic;
  if (!copy.audience) copy.audience = urls.actor;
  // How many answered THIS post, as the forum counts them (FEP-7458 shape).
  // The author's own replies collection is theirs and says something else:
  // this is what the forum holds, in the topic it placed the post in.
  if (Number.isFinite(replies)) copy.replies = { type: 'Collection', totalItems: replies };
  if (typeof copy.content === 'string') copy.content = sanitizeHtml(copy.content);
  if (!copy['@context']) copy['@context'] = 'https://www.w3.org/ns/activitystreams';
  const url = urls.cached(note.id);
  await podNotes.write(remote, url, copy);
  return url;
}

// Who wrote a post, for the website: the author's actor as the host fetched
// it, cut down to what a reader shows — name, handle, picture — filed beside
// the posts under the digest of the actor's id. A FediPod actor's id does
// not carry its handle; this is where a browser learns it.
export async function cacheAuthor({ remote, urls }, actor) {
  if (!actor?.id) return null;
  const icon = typeof actor.icon === 'string' ? actor.icon : actor.icon?.url;
  const card = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: actor.id, type: actor.type || 'Person',
    ...(actor.preferredUsername ? { preferredUsername: String(actor.preferredUsername).slice(0, 100) } : {}),
    ...(actor.name ? { name: String(actor.name).slice(0, 200) } : {}),
    ...(icon && /^https?:\/\//u.test(icon) ? { icon: { type: 'Image', url: String(icon).slice(0, 2048) } } : {}),
    ...(actor.url && typeof actor.url === 'string' ? { url: actor.url } : {}),
  };
  const url = urls.cached(actor.id);
  await podNotes.write(remote, url, card);
  return url;
}

// The copy of a post that is gone: a Tombstone in its place.
export async function tombstoneCached({ remote, urls }, postId, { formerType = 'Note' } = {}) {
  const url = urls.cached(postId);
  await podNotes.write(remote, url, fwire.cachedTombstone({ id: url, formerType }));
  return url;
}

// A public sign of life: when the forum was last hosted, and by which
// version. The website reads it to say how current the forum is, since the
// lease that really says so is owner-only.
export async function publishHeartbeat({ remote, urls }, { version = null, at = new Date().toISOString() } = {}) {
  // Under the advertised face, like every read document, so a fronted forum's
  // reader finds it at the front and the transport lands it on the pod.
  // Typed and named like the actor: a pod refuses to hand a plain-JSON
  // document to a reader asking for ActivityPub, and the front asks that way.
  const url = urls.actor.replace(/ap\/actor$/u, '') + 'ap/heartbeat';
  await remote.putJson(url, { at, ...(version ? { version } : {}) }, 'application/activity+json');
  await remote.setAcl(url, ['Read']);
  return url;
}
