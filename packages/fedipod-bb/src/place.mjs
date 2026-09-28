// place.mjs — placing a post in its topic, keeping the copy readers see, and
// what an edit or a deletion does to that place. Called by a category's
// intake before it carries a post, and by the door that takes one as it
// lands.

import * as topics from './topics.mjs';
import * as publish from './publish.mjs';
import * as moderation from './moderation.mjs';

const idOf = (v) => (typeof v === 'string' ? v : v?.id);

// Before a category carries a post: place it in its topic, keep a copy for
// readers, and publish what changed. A locked topic takes no more: the post
// is not placed and, answered with false, not carried either.
export async function placePost(forum, cat, { noteId, sent }) {
  let note = cat.intake.recentNotes.get(noteId) || null;
  cat.intake.recentNotes.delete(noteId);
  if (!note) note = await cat.intake.fetchAP(noteId);
  if (!note) throw new Error(`${noteId} could not be read for its topic`);
  const tid = await topics.assign({ store: cat.store, urls: cat.urls, fetchAP: (u) => cat.intake.fetchAP(u) }, note, sent);
  if (moderation.isLocked(cat, tid) && !topics.list(cat.store).find(t => t.tid === tid && t.op === noteId)) {
    topics.remove(cat.store, tid, noteId);
    forum.log(`${cat.slug}: ${noteId} not placed — topic ${tid} is locked`);
    return false;
  }
  await publish.cachePost(cat, note, { topic: cat.urls.topic(tid), replies: 0 });
  noteLatest(forum, cat, note);
  const answered = idOf(note.inReplyTo);
  if (answered) await countReplies(forum, cat, tid, answered).catch(e => forum.log(`replies of ${answered}: ${e.message}`));
  // The author's card, from the actor the intake already holds; fetched
  // once when it does not, so the website can name them.
  const author = idOf([].concat(note.attributedTo || [])[0]);
  if (author) {
    const held = cat.store.getActors?.()[author];
    const doc = held ? { id: author, ...held } : await cat.intake.fetchAP(author).catch(() => null);
    if (doc) await publish.cacheAuthor(cat, doc).catch(e => forum.log(`author card for ${author}: ${e.message}`));
  }
  await publish.publishTopic(cat, tid);
  await publish.publishTopicIndex(cat);
  await publish.publishLatest(forum.siteAgent);
  forum.log(`${cat.slug}: ${noteId} in topic ${tid}`);
  return true;
}

// An author edited a post of theirs that we hold: the copy the website
// reads is rewritten from the note as verified at its origin, and a changed
// title is the topic's title when that post opened it.
export async function editPlaced(forum, cat, { noteId, note }) {
  // The copy is rewritten from the note as verified at its origin; the
  // counts the forum keeps on it are put back from what the forum knows.
  const v = cat.store.read('votes.json', {})[noteId];
  const held = topics.topicOf(cat.store, noteId);
  const replies = held ? (topics.get(cat.store, held)?.posts || []).filter(p => p.inReplyTo === noteId).length : null;
  await publish.cachePost(cat, note, { topic: held ? cat.urls.topic(held) : null, replies,
    likes: (Array.isArray(v) ? v : v?.up || []).length, dislikes: (Array.isArray(v) ? [] : v?.down || []).length });
  await publish.publishLatest(forum.siteAgent);
  const tid = topics.topicOf(cat.store, noteId);
  if (!tid) return;
  await publish.publishTopic(cat, tid, { force: true });
}

// An author deleted one: it leaves the topic, its copy becomes a tombstone
// (FEP-4f05), and a topic with nothing left in it goes too. The carry has
// already been taken back by the group itself.
export async function dropPlaced(forum, cat, { noteId }) {
  const tid = topics.topicOf(cat.store, noteId);
  // Whatever it answered has one fewer answer now.
  const answered = tid ? idOf(topics.get(cat.store, tid)?.posts?.find(p => p.id === noteId)?.inReplyTo) : null;
  dropLatest(forum, cat, noteId);
  await publish.tombstoneCached(cat, noteId);
  await publish.publishLatest(forum.siteAgent);
  if (!tid) return;
  topics.remove(cat.store, tid, noteId);
  const left = topics.get(cat.store, tid);
  if (!left?.posts?.length) {
    await moderation.deleteTopic(cat, tid).catch(e => forum.log(`empty topic ${tid}: ${e.message}`));
    return;
  }
  await publish.publishTopic(cat, tid, { force: true });
  await publish.publishTopicIndex(cat, { force: true });
  if (answered) await countReplies(forum, cat, tid, answered).catch(e => forum.log(`replies of ${answered}: ${e.message}`));
}

// Answers to one post, counted in the topic that holds it, and written
// into the copy the website reads.
export async function countReplies(forum, cat, tid, postId) {
  const doc = topics.get(cat.store, tid);
  if (!doc) return;
  const n = (doc.posts || []).filter(p => p.inReplyTo === postId).length;
  const copy = await forum.remote.getJson(cat.urls.cached(postId)).catch(() => null);
  if (!copy || copy.type === 'Tombstone') return;
  if (Number(copy.replies?.totalItems) === n) return;
  await publish.cachePost(cat, copy, { replies: n });
}

// The forum's own index of its newest posts, across every category.
export function noteLatest(forum, cat, note) {
  const copy = cat.urls.cached(note.id);
  const at = note.published || new Date().toISOString();
  const rows = forum.store.read('latest.json', []).filter(e => e.copy !== copy);
  rows.push({ copy, at });
  rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  forum.store.write('latest.json', rows.slice(0, publish.LATEST_MAX));
}

export function dropLatest(forum, cat, noteId) {
  const copy = cat.urls.cached(noteId);
  forum.store.write('latest.json', forum.store.read('latest.json', []).filter(e => e.copy !== copy));
}

