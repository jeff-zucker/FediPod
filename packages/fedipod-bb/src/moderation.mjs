// moderation.mjs — what a moderator does to a topic, and what it says on the
// wire: a post removed (Delete with the topic as its origin), a topic deleted
// (Remove from the category, FEP-f15d), a topic moved (Move between
// categories), a topic pinned (the category's featured collection) or locked
// (local). Every activity is announced to the category's members the way a
// group's bans are (FEP-1b12). And the other direction: which arriving
// activities are a moderator's ask, held for the operator, and how one is
// applied.
//
// A category here is the object the host builds: { urls, store, remote,
// publisher, deliverer, intake, log }.

import { AS_CTX, PUBLIC, orderedCollection, updateActorActivity } from '../../../lib/core/wire.mjs';
import { announceModeration, applyModeration } from '../../../lib/core/social.mjs';
import * as collection from '../../../lib/pod/collection.mjs';
import * as podNotes from '../../../lib/pod/notes.mjs';
import * as topics from './topics.mjs';
import * as publish from './publish.mjs';
import { applySettings } from './settings.mjs';

const idOf = (v) => (typeof v === 'string' ? v : v?.id);

// ── on the wire ────────────────────────────────────────────────────────
export function removeTopicActivity({ urls, topic, serial }) {
  return { '@context': AS_CTX, id: `${urls.actor}#remove-${serial}`, type: 'Remove', actor: urls.actor,
    object: topic, target: urls.actor, to: [PUBLIC], cc: [urls.followers] };
}

export function moveTopicActivity({ urls, topic, origin, target, serial }) {
  return { '@context': AS_CTX, id: `${urls.actor}#move-${serial}`, type: 'Move', actor: urls.actor,
    object: topic, origin, target, to: [PUBLIC], cc: [urls.followers] };
}

// The category is not the post's author; what it deletes is the post's place
// in the topic, which `origin` names.
export function deletePostActivity({ urls, post, origin, serial }) {
  return { '@context': AS_CTX, id: `${urls.actor}#delete-${serial}`, type: 'Delete', actor: urls.actor,
    object: post, origin, to: [PUBLIC], cc: [urls.followers] };
}

export function flagActivity({ urls, objects, content, serial }) {
  return { '@context': AS_CTX, id: `${urls.actor}#flag-${serial}`, type: 'Flag', actor: urls.actor,
    object: [].concat(objects), ...(content ? { content: String(content).slice(0, 2000) } : {}) };
}

const tidOf = (cat, id) => {
  if (typeof id !== 'string' || !id.startsWith(cat.urls.topicContainer)) return null;
  const tail = id.slice(cat.urls.topicContainer.length);
  return topics.get(cat.store, tail) ? tail : (topics.get(cat.store, tail.replace(/-\d+$/u, '')) ? tail.replace(/-\d+$/u, '') : null);
};

// ── the moderator's acts ───────────────────────────────────────────────
// A post out of its topic: the copy becomes a tombstone, the page it was on
// goes one short, the carry is unsaid, and members are told.
export async function removePost(cat, postId, { announce = true } = {}) {
  const tid = topics.topicOf(cat.store, postId);
  if (!tid) throw new Error(`no topic holds ${postId}`);
  const copy = await cat.remote.getJson(cat.urls.cached(postId)).catch(() => null);
  topics.remove(cat.store, tid, postId);
  await publish.tombstoneCached(cat, postId, { formerType: copy?.type && copy.type !== 'Tombstone' ? copy.type : 'Note' });
  await publish.publishTopic(cat, tid);
  await publish.publishTopicIndex(cat);
  const s = cat.store.getStatuses().find(x => x.noteId === postId);
  if (s?.announceActivity) await cat.intake.retract(postId).catch(e => cat.log?.(`retract ${postId}: ${e.message}`));
  if (announce) {
    await announceModeration(cat, deletePostActivity({ urls: cat.urls, post: postId, origin: cat.urls.topic(tid), serial: Date.now() }));
  }
  return { tid };
}

// A whole topic: announced first as a Remove of the topic from the category,
// then each post as above, then the topic's documents become a tombstone.
export async function deleteTopic(cat, tid) {
  const doc = topics.get(cat.store, tid);
  if (!doc) throw new Error(`no such topic: ${tid}`);
  await announceModeration(cat, removeTopicActivity({ urls: cat.urls, topic: cat.urls.topic(tid), serial: Date.now() }));
  for (const p of [...doc.posts]) {
    await publish.tombstoneCached(cat, p.id);
    const s = cat.store.getStatuses().find(x => x.noteId === p.id);
    if (s?.announceActivity) await cat.intake.retract(p.id).catch(e => cat.log?.(`retract ${p.id}: ${e.message}`));
  }
  await dropTopicDocuments(cat, tid, doc);
  topics.drop(cat.store, tid);
  await publish.publishTopicIndex(cat);
  return { removed: doc.posts.length };
}

async function dropTopicDocuments(cat, tid, doc) {
  for (const n of Object.keys(doc.pages || {})) await collection.dropPage(cat.remote, cat.urls.topicPage(tid, Number(n)));
  await podNotes.writeTombstone(cat.remote, cat.urls.topic(tid),
    { '@context': AS_CTX, id: cat.urls.topic(tid), type: 'Tombstone', formerType: 'OrderedCollection', deleted: new Date().toISOString() });
}

// A topic from one category to another: opened afresh there with the same
// posts and copies, announced as a Move by both, and left as a tombstone here.
export async function moveTopic(from, to, tid) {
  const doc = topics.get(from.store, tid);
  const entry = topics.list(from.store).find(t => t.tid === tid);
  if (!doc || !entry) throw new Error(`no such topic: ${tid}`);
  const [first, ...rest] = doc.posts;
  const newTid = topics.open(to.store, { title: doc.title, post: first, tid: topics.get(to.store, tid) ? null : tid });
  for (const p of rest) topics.append(to.store, newTid, { ...p, cached: to.urls.cached(p.id) });
  topics.setFlags(to.store, newTid, { pinned: entry.pinned, locked: entry.locked });
  const authors = new Set();
  for (const p of doc.posts) {
    const copy = await from.remote.getJson(from.urls.cached(p.id)).catch(() => null);
    if (copy) await podNotes.write(to.remote, to.urls.cached(p.id), copy);
    if (p.author) authors.add(p.author);
  }
  for (const a of authors) {
    const card = await from.remote.getJson(from.urls.cached(a)).catch(() => null);
    if (card) await podNotes.write(to.remote, to.urls.cached(a), card);
  }
  await publish.publishTopic(to, newTid);
  await publish.publishTopicIndex(to);
  const move = { topic: from.urls.topic(tid), origin: from.urls.actor, target: to.urls.actor, serial: Date.now() };
  await announceModeration(from, moveTopicActivity({ urls: from.urls, ...move }));
  await announceModeration(to, moveTopicActivity({ urls: to.urls, ...move }));
  await dropTopicDocuments(from, tid, doc);
  topics.drop(from.store, tid);
  await publish.publishTopicIndex(from);
  return { tid: newTid, topic: to.urls.topic(newTid) };
}

// Pinned topics are the category's featured collection; members' servers
// learn of the change through an Update of the category.
export async function pinTopic(cat, tid, pinned) {
  if (!topics.get(cat.store, tid)) throw new Error(`no such topic: ${tid}`);
  topics.setFlags(cat.store, tid, { pinned });
  const ids = topics.list(cat.store).filter(t => t.pinned).map(t => cat.urls.topic(t.tid));
  await collection.writeFlat(cat.remote, cat.urls.featured, orderedCollection(cat.urls.featured, ids), { publicRead: true });
  const actor = await cat.remote.getJson(cat.urls.actor).catch(() => null);
  const inboxes = [...new Set(cat.store.getContacts().followers.map(f => f.sharedInbox || f.inbox).filter(Boolean))];
  if (actor && inboxes.length) {
    await cat.deliverer.deliverToAll(inboxes, updateActorActivity({ urls: cat.urls, actor, serial: Date.now() }));
  }
  return { pinned: ids };
}

// A topic's name, changed: the record and the published head follow, and
// nothing about the posts inside it moves.
export async function renameTopic(cat, tid, name) {
  if (!topics.get(cat.store, tid)) throw new Error(`no such topic: ${tid}`);
  const title = String(name).trim().slice(0, 200);
  if (!title) throw new Error('a topic needs a name');
  topics.setTitle(cat.store, tid, title);
  await publish.publishTopic(cat, tid, { force: true });
  await publish.publishTopicIndex(cat, { force: true });
  return { tid, name: title };
}

// Locked: the record says so, and the host places nothing more in it.
export async function lockTopic(cat, tid, locked) {
  if (!topics.get(cat.store, tid)) throw new Error(`no such topic: ${tid}`);
  topics.setFlags(cat.store, tid, { locked });
  // The topic says so itself, so a reader and any other server can see it:
  // `closed` is what AS2 gives for a collection that takes no more.
  await publish.publishTopic(cat, tid, { force: true });
  return { locked: !!locked };
}

export const isLocked = (cat, tid) => !!topics.list(cat.store).find(t => t.tid === tid)?.locked;

// ── the other direction: a moderator's ask, arriving ──────────────────
// Beyond what every group already holds (Block, Undo, Delete of a carried
// post, roster changes): a Remove or Move of one of our topics, a Delete
// naming one of our topics as its origin, and a Flag.
export function isForumAsk(cat, activity) {
  const t = activity?.type;
  if (t === 'Flag') return true;
  // A held post let through, or turned away: both name a post the forum is
  // holding rather than one it has carried.
  if (t === 'Accept' || t === 'Reject') return !!idOf(activity.object);
  // Somebody let into the category: named by their actor, which is what a
  // moderator has in front of them.
  if (t === 'Join') return !!idOf(activity.object);
  if (t === 'Add' || t === 'Remove' || t === 'Move') return !!tidOf(cat, idOf(activity.object));
  // A topic renamed, or closed to further replies: the name and the closing
  // are the topic's own, and only the forum can write them, so a moderator
  // asks for both the way they ask for anything else.
  if (t === 'Update') return !!tidOf(cat, idOf(activity.object));
  if (t === 'Delete') return !!tidOf(cat, idOf(activity.origin));
  return false;
}

// Apply one queued ask. `forum` resolves a Move's target to a category.
export async function applyForumModeration(forum, cat, entry) {
  const object = idOf(entry.activity?.object);
  switch (entry.type) {
    case 'Update': {
      const tid = tidOf(cat, object);
      const asked = typeof entry.activity?.object === 'object' ? entry.activity.object : null;
      if (!tid || !asked) break;
      // `closed` present and truthy: no more replies are placed in it.
      if ('closed' in asked) return lockTopic(cat, tid, !!asked.closed);
      if (asked.name) return renameTopic(cat, tid, asked.name);
      break;
    }
    // Somebody admitted to a category: their follow is accepted, and for a
    // private one their pod is granted the reading their membership means.
    case 'Join': {
      if (!object) break;
      // In a private category, membership means reading, and reading is
      // granted to a WebID. Somebody whose server has none cannot be admitted
      // at all — admitting them would carry them posts they may not read.
      const closed = (forum.config?.membersOnly || []).includes(cat.slug);
      if (closed) {
        const webid = await forum.webIdOf(object).catch(() => null);
        if (!webid) throw new Error(`${object} has no WebID this forum can grant reading to`);
        await applySettings(forum, { type: 'Add', object: webid, target: cat.urls.members });
      }
      const { admitRequest } = await import('../../../lib/core/social.mjs');
      await admitRequest(cat, object);
      return { admitted: object };
    }
    // A held post let through: the category carries it after all.
    case 'Accept': {
      if (!object) break;
      await cat.intake.amplify(object, { approved: true });
      return { approved: object };
    }
    // Turned away: nothing is carried and the holding ends.
    case 'Reject': {
      if (!object) break;
      cat.store.write('modqueue.json', cat.store.read('modqueue.json', [])
        .filter(e => (typeof e.activity?.object === 'string' ? e.activity.object : e.activity?.object?.id) !== object));
      return { refused: object };
    }
    case 'Add': {
      const tid = tidOf(cat, object);
      if (!tid) break;
      const target = idOf(entry.activity?.target);
      // The forum's own featured collection: pinned for the whole site.
      if (forum.site?.featured && target === forum.site.featured) return forum.sitePin(object, true);
      if (target !== cat.urls.featured) break;
      return pinTopic(cat, tid, true);
    }
    case 'Remove': {
      const tid = tidOf(cat, object);
      if (!tid) break;
      // From the featured collection: unpinned. From the category itself:
      // gone (FEP-f15d).
      const target = idOf(entry.activity?.target);
      if (forum.site?.featured && target === forum.site.featured) return forum.sitePin(object, false);
      if (target === cat.urls.featured) return pinTopic(cat, tid, false);
      return deleteTopic(cat, tid);
    }
    case 'Move': {
      const tid = tidOf(cat, object);
      const to = forum.categories.find(c => c.urls.actor === idOf(entry.activity?.target));
      if (!tid || !to) break;
      return moveTopic(cat, to, tid);
    }
    case 'Delete': {
      if (object && topics.topicOf(cat.store, object)) return removePost(cat, object);
      break;
    }
    case 'Flag': {
      cat.store.addNotification({ type: 'flag', actor: entry.moderator, noteId: object || null });
      return { flagged: object || null };
    }
    default:
  }
  return applyModeration(cat, entry);
}
