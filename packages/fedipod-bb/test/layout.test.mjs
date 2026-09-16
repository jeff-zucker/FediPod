// layout.test.mjs — the forum's pod layout and writers, against a pod that
// records what is written. No network.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { forumUrls, categoryUrls, cacheKey, ROOT } from '../src/urls.mjs';
import * as fwire from '../src/wire.mjs';
import * as topics from '../src/topics.mjs';
import * as publish from '../src/publish.mjs';
import { provisionForum, provisionCategory } from '../src/provision.mjs';
import { PodStore } from '../../../lib/core/store.mjs';
import { apUrls } from '../../../lib/pod/urls.mjs';
import { readLenient } from '../../../lib/core/as2.mjs';

const POD = 'https://forum.example/';

// A pod that keeps what it is given and counts the requests.
function fakePod() {
  const docs = new Map();
  const acls = [];
  const log = [];
  return {
    docs, acls, log,
    putJson: async (u, o) => { docs.set(u, o); log.push(['put', u]); return { ok: true }; },
    put: async (u, body) => { docs.set(u, body); log.push(['put', u]); return { ok: true }; },
    getJson: async (u) => docs.get(u) ?? null,
    setAcl: async (u, modes) => { acls.push([u, modes]); log.push(['acl', u]); },
    delete: async (u) => { docs.delete(u); log.push(['delete', u]); return true; },
    fetch: async () => ({ status: 404 }),
  };
}

function memStore() {
  const st = new PodStore({ log: () => {} });
  st.attach({ base: 'mem://', list: async () => ({ names: [], etag: null }), read: async () => ({ ok: false }),
    remove: async () => true, write: async () => ({ ok: true }) });
  return st;
}

const post = (n, { inReplyTo = null } = {}) => ({
  id: `https://mei.pod.example/fedipod/ap/notes/p${n}`, author: 'https://mei.pod.example/fedipod/ap/actor',
  published: `2026-09-${String(1 + Math.floor(n / 30)).padStart(2, '0')}T${String(n % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}:00Z`,
  inReplyTo,
});

test('the layout: a category is a group root, with the topic documents beside it', () => {
  const site = forumUrls(POD);
  assert.equal(site.home, POD + ROOT);
  assert.equal(site.actor, POD + 'fedipod-bb/ap/actor');
  assert.equal(site.inbox, POD + 'fedipod-bb/ap/inbox/');
  assert.equal(site.categories, POD + 'fedipod-bb/ap/categories');
  assert.equal(site.administrators, POD + 'fedipod-bb/ap/administrators');
  const cat = site.category('gardening');
  const plain = apUrls(POD, 'fedipod-bb/c/gardening/');
  for (const k of ['home', 'actor', 'outbox', 'followers', 'following', 'notes', 'featured', 'moderators', 'state']) {
    assert.equal(cat[k], plain[k], `a category's ${k} is a group's`);
  }
  assert.equal(cat.forumInbox, site.inbox, 'a category is delivered to through the forum inbox');
  assert.equal(cat.topics, POD + 'fedipod-bb/c/gardening/ap/topics');
  assert.equal(cat.topicsPage(3), cat.topics + '-3');
  assert.equal(cat.topic('2026-09-tomato-blight'), POD + 'fedipod-bb/c/gardening/ap/topic/2026-09-tomato-blight');
  assert.equal(cat.topicPage('2026-09-tomato-blight', 2), cat.topic('2026-09-tomato-blight') + '-2');
  assert.equal(cat.cached('https://a.example/n/1'), cat.cache + cacheKey('https://a.example/n/1'));
  assert.throws(() => site.category('Bad Slug'), /not a category slug/u);
  assert.throws(() => cat.topic('nope'), /not a topic id/u);
});

test('a fronted forum advertises the front and writes to the pod', () => {
  const site = forumUrls(POD, ROOT, { publicBase: 'https://front.example/u/forum/' });
  const cat = site.category('gardening');
  assert.equal(cat.actor, 'https://front.example/u/forum/c/gardening/ap/actor');
  assert.equal(cat.toPod(cat.topics), POD + 'fedipod-bb/c/gardening/ap/topics');
  assert.equal(cat.state, POD + 'fedipod-bb/c/gardening/ap-state/', 'state stays on the pod');
});

test('provisioning writes a canary and a rule for every container', async () => {
  const pod = fakePod();
  const site = forumUrls(POD);
  await provisionForum(pod, site);
  await provisionCategory(pod, site.category('gardening'));
  const rule = (u) => pod.acls.find(([a]) => a === u)?.[1];
  assert.deepEqual(rule(site.home), [], 'the forum home is owner-only');
  assert.deepEqual(rule(site.state), []);
  assert.deepEqual(rule(site.category('gardening').topicContainer), ['Read'], 'the topic container is public');
  assert.deepEqual(rule(site.category('gardening').cache), ['Read']);
  assert.deepEqual(rule(site.category('gardening').state), []);
  assert.ok(pod.docs.has(site.category('gardening').topicContainer + '.keep'));
});

test('a topic is a context collection: head, pages oldest first, sealed pages never rewritten', async () => {
  const pod = fakePod();
  const store = memStore();
  const cat = forumUrls(POD).category('gardening');
  const ctx = { remote: pod, store, urls: cat };
  const tid = topics.open(store, { title: 'Tomato blight after the wet August', post: post(0) });
  assert.equal(tid, '2026-09-tomato-blight-after-the-wet-august');
  for (let n = 1; n < 45; n++) topics.append(store, tid, post(n, { inReplyTo: post(0).id }));
  const wrote = await publish.publishTopic(ctx, tid);
  assert.equal(wrote, 4, 'three pages and a head');
  const head = pod.docs.get(cat.topic(tid));
  assert.equal(head.type, 'OrderedCollection');
  assert.equal(head.name, 'Tomato blight after the wet August');
  assert.equal(head.attributedTo, cat.actor, 'the category owns the topic (FEP-7888)');
  assert.equal(head.audience, cat.actor);
  assert.equal(head.totalItems, 45);
  assert.equal(head.first, cat.topicPage(tid, 1));
  assert.equal(head.last, cat.topicPage(tid, 3));
  assert.ok(head.published && head.updated);
  const p1 = pod.docs.get(cat.topicPage(tid, 1));
  const p2 = pod.docs.get(cat.topicPage(tid, 2));
  const p3 = pod.docs.get(cat.topicPage(tid, 3));
  assert.equal(p1.orderedItems[0], post(0).id, 'the opening post is first');
  assert.equal(p1.next, p2.id); assert.equal(p2.prev, p1.id); assert.equal(p2.next, p3.id); assert.equal(p3.prev, p2.id);
  assert.equal(p1.prev, undefined); assert.equal(p3.next, undefined);
  assert.equal(p3.orderedItems.length, 5);
  // Nothing changed: nothing written.
  pod.log.length = 0;
  assert.equal(await publish.publishTopic(ctx, tid), 0);
  assert.equal(pod.log.length, 0, 'a republish of an unchanged topic touches the pod not at all');
  // One reply: the newest page and the head move, the sealed pages do not.
  topics.append(store, tid, post(45, { inReplyTo: post(0).id }));
  assert.equal(await publish.publishTopic(ctx, tid), 2);
  assert.deepEqual(pod.log.map(([, u]) => u), [cat.topicPage(tid, 3), cat.topic(tid)]);
  // A removed post leaves its page one short; the others stay sealed.
  pod.log.length = 0;
  topics.remove(store, tid, post(7).id);
  assert.equal(await publish.publishTopic(ctx, tid), 2);
  assert.deepEqual(pod.log.map(([, u]) => u), [cat.topicPage(tid, 1), cat.topic(tid)]);
  assert.equal(pod.docs.get(cat.topicPage(tid, 1)).orderedItems.length, 19);
  assert.equal(pod.docs.get(cat.topic(tid)).totalItems, 45);
  assert.equal(pod.docs.get(cat.topicPage(tid, 2)).orderedItems.length, 20, 'no re-slicing');
  // What other servers read: the head and a page read back as JSON-LD with the terms that matter.
  const view = (await readLenient(pod.docs.get(cat.topic(tid)))).view;
  assert.equal(view.type, 'OrderedCollection');
  assert.equal(view.name, 'Tomato blight after the wet August');
  assert.deepEqual(view.attributedTo, [cat.actor]);
  assert.equal(view.audience?.[0] ?? view.audience, cat.actor);
  const pv = (await readLenient(pod.docs.get(cat.topicPage(tid, 2)))).view;
  assert.equal(pv.type, 'OrderedCollectionPage');
  assert.equal(pv.partOf, cat.topic(tid));
  assert.equal(pv.orderedItems.length, 20, 'order survives the round trip');
  assert.equal(pv.orderedItems[0], post(20).id);
});

test('the topic list reads newest first and is paged from the oldest end', async () => {
  const pod = fakePod();
  const store = memStore();
  const cat = forumUrls(POD).category('gardening');
  const ctx = { remote: pod, store, urls: cat };
  const tids = [];
  for (let i = 0; i < 23; i++) tids.push(topics.open(store, { title: `Topic ${i}`, post: post(100 + i) }));
  assert.equal(new Set(tids).size, 23, 'every topic id is distinct');
  assert.equal(await publish.publishTopicIndex(ctx), 3, 'two pages and a head');
  const head = pod.docs.get(cat.topics);
  assert.equal(head.totalItems, 23);
  assert.equal(head.first, cat.topicsPage(2), 'first is the newest page');
  assert.equal(head.last, cat.topicsPage(1));
  const newest = pod.docs.get(cat.topicsPage(2));
  assert.equal(newest.orderedItems[0], cat.topic(tids[22]), 'newest topic first');
  assert.equal(newest.next, cat.topicsPage(1));
  assert.ok(pod.acls.some(([u, m]) => u === cat.topics && m[0] === 'Read'), 'the head under ap/ gets its own public rule');
  assert.equal(await publish.publishTopicIndex(ctx), 0);
  topics.open(store, { title: 'Topic 23', post: post(200) });
  pod.log.length = 0;
  assert.equal(await publish.publishTopicIndex(ctx), 2);
  assert.deepEqual(pod.log.map(([, u]) => u), [cat.topicsPage(2), cat.topics]);
  // The same title twice gets a distinct id.
  const a = topics.open(store, { title: 'Same title', post: post(300) });
  const b = topics.open(store, { title: 'Same title', post: post(301) });
  assert.notEqual(a, b);
  assert.equal(topics.topicOf(store, post(301).id), b);
});

test('the forum lists its categories and administrators, and speaks as an Application', async () => {
  const pod = fakePod();
  const store = memStore();
  const site = forumUrls(POD);
  const ctx = { remote: pod, store, urls: site };
  const cats = [site.category('gardening').actor, site.category('compost').actor];
  assert.equal(await publish.publishCategories(ctx, cats), 1);
  assert.equal(await publish.publishCategories(ctx, cats), 0);
  assert.deepEqual(pod.docs.get(site.categories).orderedItems, cats);
  assert.equal(await publish.publishAdministrators(ctx, ['https://priya.pod.example/fedipod/ap/actor']), 1);
  assert.equal(pod.docs.get(site.administrators).type, 'OrderedCollection');
  const actor = fwire.siteActorDoc({ urls: site, handle: 'forum', name: 'The Forum', publicKeyPem: 'x' });
  assert.equal(actor.type, 'Application');
  assert.equal(actor.inbox, site.inbox);
  const view = (await readLenient(actor)).view;
  assert.equal(view.type, 'Application');
});

test('a cached copy keeps the author\'s words under the author\'s id, and a tombstone replaces it', async () => {
  const pod = fakePod();
  const cat = forumUrls(POD).category('gardening');
  const note = { '@context': 'https://www.w3.org/ns/activitystreams', id: post(0).id, type: 'Article',
    attributedTo: post(0).author, name: 'Blight', content: '<p>hello<script>x()</script></p>', published: post(0).published,
    context: cat.topic('2026-09-blight'), audience: cat.actor };
  const url = await publish.cachePost({ remote: pod, urls: cat }, note);
  assert.equal(url, cat.cached(note.id));
  const copy = pod.docs.get(url);
  assert.equal(copy.id, note.id, 'the copy carries the original id');
  assert.equal(copy.content, '<p>hello</p>', 'hostile markup does not reach a reader');
  assert.equal(copy.context, note.context);
  assert.equal((await readLenient(copy)).view.context, note.context, 'context reads back by name');
  await publish.tombstoneCached({ remote: pod, urls: cat }, note.id, { formerType: 'Article' });
  const gone = pod.docs.get(url);
  assert.equal(gone.type, 'Tombstone');
  assert.equal(gone.formerType, 'Article');
});
