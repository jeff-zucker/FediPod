// moderation.test.mjs — what a moderator does to topics and what members'
// servers are told: remove a post, delete a topic, move one, pin one; and
// which arriving activities are held as a moderator's ask.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { forumUrls } from '../src/urls.mjs';
import * as topics from '../src/topics.mjs';
import * as publish from '../src/publish.mjs';
import * as moderation from '../src/moderation.mjs';
import { PodStore } from '../../../lib/core/store.mjs';

const POD = 'https://forum.example/';
const MEI = 'https://mei.pod.example/fedipod/ap/actor';
const PRIYA = 'https://priya.pod.example/fedipod/ap/actor';

function fakePod() {
  const docs = new Map();
  return {
    docs,
    putJson: async (u, o) => { docs.set(u, o); return { ok: true }; },
    put: async (u, body) => { docs.set(u, body); return { ok: true }; },
    getJson: async (u) => docs.get(u) ?? null,
    setAcl: async () => {}, delete: async (u) => docs.delete(u),
  };
}
function memStore(config) {
  const st = new PodStore({ log: () => {} });
  st.attach({ base: 'mem://', list: async () => ({ names: [], etag: null }), read: async () => ({ ok: false }),
    remove: async () => true, write: async () => ({ ok: true }) });
  st.setConfig(config);
  return st;
}
// A category as the host builds it, with recording delivery and retract.
function category(pod, site, slug, delivered, retracted) {
  const urls = site.category(slug);
  const store = memStore({ kind: 'group', handle: slug, moderators: [PRIYA] });
  store.setContacts({ followers: [{ actor: MEI, inbox: 'https://mei.pod.example/fedipod/ap/inbox/' }], following: [] });
  const outbox = [];
  return {
    slug, urls, store, remote: pod, log: () => {},
    publisher: { urls, recordOutbox: async (i) => { outbox.push(i); } },
    deliverer: { deliverToAll: async (inboxes, a) => { delivered.push({ who: slug, inboxes, a }); }, deliver: async (inbox, a) => { delivered.push({ who: slug, inbox, a }); } },
    intake: { retract: async (id) => { retracted.push(id); } },
    outbox,
  };
}
const post = (n) => ({ id: `https://mei.pod.example/fedipod/ap/notes/p${n}`, author: MEI, published: `2026-09-15T10:${String(n).padStart(2, '0')}:00Z`, inReplyTo: n ? 'https://mei.pod.example/fedipod/ap/notes/p0' : null });

async function seed(cat, { posts = 3, title = 'Tomato blight' } = {}) {
  const tid = topics.open(cat.store, { title, post: post(0) });
  for (let n = 1; n < posts; n++) topics.append(cat.store, tid, post(n));
  for (let n = 0; n < posts; n++) {
    await publish.cachePost(cat, { id: post(n).id, type: n ? 'Note' : 'Article', attributedTo: MEI, content: `<p>${n}</p>`, published: post(n).published });
    cat.store.addStatus({ noteId: post(n).id, actor: MEI, content: `<p>${n}</p>`, published: post(n).published, kind: 'timeline', announcedAt: 'x', announceActivity: { id: 'a' + n } });
  }
  await publish.cacheAuthor(cat, { id: MEI, type: 'Person', preferredUsername: 'mei' });
  await publish.publishTopic(cat, tid);
  await publish.publishTopicIndex(cat);
  return tid;
}

test('removing a post: the copy becomes a tombstone, the page goes short, the carry is unsaid, members are told', async () => {
  const pod = fakePod(); const delivered = []; const retracted = [];
  const g = category(pod, forumUrls(POD), 'gardening', delivered, retracted);
  const tid = await seed(g);
  const r = await moderation.removePost(g, post(1).id);
  assert.equal(r.tid, tid);
  assert.deepEqual(pod.docs.get(g.urls.topicPage(tid, 1)).orderedItems, [post(0).id, post(2).id]);
  assert.equal(pod.docs.get(g.urls.cached(post(1).id)).type, 'Tombstone');
  assert.equal(pod.docs.get(g.urls.cached(post(1).id)).formerType, 'Note');
  assert.deepEqual(retracted, [post(1).id], 'the carry of that post is unsaid');
  const told = delivered.find(d => d.a.type === 'Announce' && d.a.object?.type === 'Delete');
  assert.ok(told, 'an announced Delete goes to the members');
  assert.equal(told.a.object.object, post(1).id);
  assert.equal(told.a.object.origin, g.urls.topic(tid), 'naming the topic as its origin (FEP-7888)');
  assert.equal(told.a.audience, g.urls.actor);
});

test('deleting a topic: a Remove from the category, every post a tombstone, the topic a tombstone', async () => {
  const pod = fakePod(); const delivered = []; const retracted = [];
  const g = category(pod, forumUrls(POD), 'gardening', delivered, retracted);
  const tid = await seed(g, { posts: 2 });
  const r = await moderation.deleteTopic(g, tid);
  assert.equal(r.removed, 2);
  const told = delivered.find(d => d.a.type === 'Announce' && d.a.object?.type === 'Remove');
  assert.equal(told.a.object.object, g.urls.topic(tid));
  assert.equal(told.a.object.target, g.urls.actor, 'removed from the category (FEP-f15d)');
  assert.equal(pod.docs.get(g.urls.topic(tid)).type, 'Tombstone');
  assert.equal(pod.docs.get(g.urls.topic(tid)).formerType, 'OrderedCollection');
  assert.equal(pod.docs.has(g.urls.topicPage(tid, 1)), false, 'its pages are gone');
  assert.equal(topics.list(g.store).length, 0);
  assert.equal(pod.docs.get(g.urls.topics).totalItems, 0);
  assert.equal(retracted.length, 2);
});

test('moving a topic: the same posts and copies under the other category, a Move from both, a tombstone behind', async () => {
  const pod = fakePod(); const delivered = []; const retracted = [];
  const site = forumUrls(POD);
  const g = category(pod, site, 'gardening', delivered, retracted);
  const c = category(pod, site, 'compost', delivered, retracted);
  const tid = await seed(g);
  moderation.lockTopic(g, tid, true);
  const r = await moderation.moveTopic(g, c, tid);
  assert.equal(r.tid, tid, 'the id is kept where it is free');
  assert.deepEqual(pod.docs.get(c.urls.topicPage(tid, 1)).orderedItems, [post(0).id, post(1).id, post(2).id]);
  assert.equal(pod.docs.get(c.urls.topic(tid)).attributedTo, c.urls.actor, 'the new category owns it now');
  assert.equal(pod.docs.get(c.urls.cached(post(2).id))?.content, '<p>2</p>', 'the copies moved with it');
  assert.equal(pod.docs.get(c.urls.cached(MEI))?.preferredUsername, 'mei', 'and the author cards');
  assert.equal(topics.list(c.store)[0].locked, true, 'a lock travels');
  const moves = delivered.filter(d => d.a.type === 'Announce' && d.a.object?.type === 'Move');
  assert.deepEqual(moves.map(m => m.who).sort(), ['compost', 'gardening'], 'both categories announce the move');
  assert.equal(moves[0].a.object.origin, g.urls.actor); assert.equal(moves[0].a.object.target, c.urls.actor);
  assert.equal(pod.docs.get(g.urls.topic(tid)).type, 'Tombstone');
  assert.equal(topics.list(g.store).length, 0);
  assert.equal(pod.docs.get(c.urls.topics).totalItems, 1);
});

test('pinning a topic: the featured collection names it and members are told the category changed', async () => {
  const pod = fakePod(); const delivered = []; const retracted = [];
  const g = category(pod, forumUrls(POD), 'gardening', delivered, retracted);
  pod.docs.set(g.urls.actor, { id: g.urls.actor, type: 'Group', preferredUsername: 'gardening' });
  const tid = await seed(g, { posts: 1 });
  const r = await moderation.pinTopic(g, tid, true);
  assert.deepEqual(r.pinned, [g.urls.topic(tid)]);
  assert.deepEqual(pod.docs.get(g.urls.featured).orderedItems, [g.urls.topic(tid)]);
  assert.ok(delivered.some(d => d.a.type === 'Update' && d.a.object?.id === g.urls.actor), 'an Update of the Group goes out');
  await moderation.pinTopic(g, tid, false);
  assert.deepEqual(pod.docs.get(g.urls.featured).orderedItems, []);
});

test('which arriving activities are a moderator\'s ask, and how one is applied', async () => {
  const pod = fakePod(); const delivered = []; const retracted = [];
  const site = forumUrls(POD);
  const g = category(pod, site, 'gardening', delivered, retracted);
  const c = category(pod, site, 'compost', delivered, retracted);
  const tid = await seed(g, { posts: 2 });
  const topic = g.urls.topic(tid);
  assert.equal(moderation.isForumAsk(g, { type: 'Remove', object: topic, target: g.urls.actor }), true);
  assert.equal(moderation.isForumAsk(g, { type: 'Move', object: topic, origin: g.urls.actor, target: c.urls.actor }), true);
  assert.equal(moderation.isForumAsk(g, { type: 'Delete', object: post(1).id, origin: topic }), true);
  assert.equal(moderation.isForumAsk(g, { type: 'Flag', object: [post(1).id, MEI] }), true);
  assert.equal(moderation.isForumAsk(g, { type: 'Remove', object: 'https://elsewhere.example/topic/1', target: g.urls.actor }), false, 'not our topic');
  assert.equal(moderation.isForumAsk(g, { type: 'Create', object: { id: 'x' } }), false);
  const forum = { categories: [g, c] };
  const moved = await moderation.applyForumModeration(forum, g, { type: 'Move', moderator: PRIYA, activity: { type: 'Move', object: topic, target: c.urls.actor } });
  assert.equal(moved.topic, c.urls.topic(tid));
  assert.equal(topics.list(c.store).length, 1);
  const flagged = await moderation.applyForumModeration(forum, c, { type: 'Flag', moderator: PRIYA, activity: { type: 'Flag', object: post(1).id } });
  assert.equal(flagged.flagged, post(1).id);
  assert.ok(c.store.getNotifications().some(n => n.type === 'flag' && n.actor === PRIYA));
  const removed = await moderation.applyForumModeration(forum, c, { type: 'Delete', moderator: PRIYA, activity: { type: 'Delete', object: post(1).id } });
  assert.equal(removed.tid, tid);
  assert.deepEqual(pod.docs.get(c.urls.topicPage(tid, 1)).orderedItems, [post(0).id]);
  const gone = await moderation.applyForumModeration(forum, c, { type: 'Remove', moderator: PRIYA, activity: { type: 'Remove', object: c.urls.topic(tid), target: c.urls.actor } });
  assert.equal(gone.removed, 1);
  assert.equal(topics.list(c.store).length, 0);
});
