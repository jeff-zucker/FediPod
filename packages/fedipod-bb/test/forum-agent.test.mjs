// forum-agent.test.mjs — the host, against a pod kept in memory: two
// categories, a member joining and posting, replies placed in topics, a
// non-member refused, and two devices sharing the forum through the lease.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForumAgent } from '../src/forum-agent.mjs';
import * as topics from '../src/topics.mjs';

const POD = 'https://forum.example/';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const MEI = 'https://mei.pod.example/fedipod/ap/actor';
const KWAME = 'https://kwame.example/users/kwame';

// One pod, shared by every agent in a test: documents, ACLs, the inbox as a
// listing, the lease with its ETag, and owner-only state containers.
function fakePod() {
  const docs = new Map();
  const acls = [];
  const inbox = [];
  const state = new Map();                         // base → Map(name → body)
  let leaseEtag = 0;
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
  const pod = {
    docs, acls, inbox, state, webId: 'https://forum.example/profile/card#me',
    putJson: async (u, o) => { docs.set(u, o); return { ok: true }; },
    put: async (u, body) => { docs.set(u, body); return { ok: true }; },
    getJson: async (u) => docs.get(u) ?? null,
    setAcl: async (u, modes, opts) => { acls.push([u, modes, opts || null]); },
    delete: async (u) => {
      const i = inbox.findIndex(x => x.url === u);
      if (i >= 0) inbox.splice(i, 1);
      docs.delete(u);
      return true;
    },
    listContainer: async (u) => (u.endsWith('ap/inbox/') && u.startsWith(POD + 'fedipod-bb/ap/') ? inbox.map(x => ({ ...x })) : []),
    linkAccountInProfile: async () => false,
    stats: () => ({}),
    fetch: async (u, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      if (u.endsWith('lease.json')) {
        const cur = docs.get(u);
        if (method === 'GET') return cur ? json(cur, 200, { etag: `"${leaseEtag}"` }) : new Response('', { status: 404 });
        if (method === 'PUT') {
          const im = init.headers?.['if-match'] ?? init.headers?.['If-Match'];
          if (im && im !== `"${leaseEtag}"`) return new Response('', { status: 412 });
          docs.set(u, JSON.parse(init.body));
          leaseEtag++;
          return new Response(null, { status: 204, headers: { etag: `"${leaseEtag}"` } });
        }
      }
      const item = inbox.find(x => x.url === u);
      if (item && method === 'GET') return new Response(item.body, { status: 200, headers: { 'content-type': 'application/activity+json' } });
      return new Response('', { status: 404 });
    },
  };
  // Owner-only state, per container: what PodStore reads and writes.
  pod.storageFor = (base) => {
    const m = state.get(base) || new Map();
    state.set(base, m);
    return {
      base, kind: 'mem',
      list: async () => ({ notModified: false, names: [...m.keys()], etag: null }),
      read: async (name) => (m.has(name) ? { ok: true, notModified: false, status: 200, body: m.get(name), etag: null }
        : { ok: false, notModified: false, status: 404, body: null, etag: null }),
      write: async (name, body) => { m.set(name, body); return { ok: true, retry: false, why: '' }; },
      remove: async (name) => { m.delete(name); return true; },
    };
  };
  pod.deliver = (url, activity) => {
    const body = JSON.stringify(activity);
    inbox.push({ url: POD + 'fedipod-bb/ap/inbox/' + url, size: body.length, modified: new Date().toISOString(), body });
  };
  return pod;
}

function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-bb-'));
  fs.writeFileSync(path.join(dir, 'credential.json'), JSON.stringify({ remotePod: POD, webId: 'https://forum.example/profile/card#me' }));
  return dir;
}

// A stranger's pod, as fetched at its origin.
const remoteDocs = {
  [MEI]: { id: MEI, type: 'Person', preferredUsername: 'mei', inbox: MEI.replace('actor', 'inbox/'), endpoints: { sharedInbox: 'https://mei.pod.example/fedipod/ap/inbox/' } },
  [KWAME]: { id: KWAME, type: 'Person', preferredUsername: 'kwame', inbox: KWAME + '/inbox' },
};
const note = (id, { by = MEI, type = 'Note', name = null, content = '<p>hello</p>', inReplyTo = null, context = null, audience = null, to = null, published = '2026-09-15T10:00:00Z' } = {}) => ({
  '@context': 'https://www.w3.org/ns/activitystreams', id, type, attributedTo: by, content, published,
  ...(name ? { name } : {}), ...(inReplyTo ? { inReplyTo } : {}), ...(context ? { context } : {}), ...(audience ? { audience } : {}),
  to: to || [PUBLIC, ...(audience ? [audience] : [])], cc: [],
});

async function boot(pod, dir, { push = false } = {}) {
  const log = [];
  const agent = new ForumAgent({ home: dir, log: (...a) => log.push(a.join(' ')), remote: pod, storageFor: pod.storageFor, push, pollSeconds: 3600 });
  // What a stranger sees: the private trees refuse, everything else answers.
  agent.probeFetch = async (u) => ({ status: /ap-state\/|ap\/private\/|inbox-archive\/|\/fedipod-bb\/(c\/[^/]+\/)?\.keep$/u.test(u) ? 401 : 200 });
  return { agent, log };
}

function wire(agent, delivered) {
  const record = (who) => ({
    deliver: async (inbox, a) => { delivered.push({ who, inbox, a }); },
    deliverToAll: async (inboxes, a) => { delivered.push({ who, inboxes, a }); },
  });
  for (const cat of agent.categories) {
    Object.assign(cat.deliverer, record(cat.slug));
    cat.intake.fetchAP = async (u) => remoteDocs[u] ?? null;
  }
  Object.assign(agent.siteAgent.deliverer, record('site'));
  agent.intake.fetchAP = async (u) => remoteDocs[u] ?? null;
}

test('a forum hosts its categories as groups and drains one inbox to all of them', async () => {
  const pod = fakePod();
  const dir = home();
  const { agent, log } = await boot(pod, dir);
  const cfg = await agent.init({ handle: 'forum', name: 'The Forum', categories: [{ slug: 'gardening', name: 'Gardening' }, 'compost'],
    moderators: ['https://priya.pod.example/fedipod/ap/actor'] });
  assert.equal(cfg.categories.length, 2);
  assert.ok(await agent.connect(), 'the forum connects');
  assert.equal(agent.viewer, false, 'the first device hosts');
  const site = agent.site;
  const g = agent.categories[0];
  // Published on first start: every actor, the forum's lists, one WebFinger.
  const gActor = pod.docs.get(g.urls.actor);
  assert.equal(gActor.type, 'Group');
  assert.equal(gActor.inbox, site.inbox, 'a category is delivered to through the forum inbox');
  assert.equal(gActor.endpoints.sharedInbox, site.inbox);
  assert.equal(gActor.attributedTo, g.urls.moderators, 'the moderators are the roster (FEP-1b12)');
  assert.equal(pod.docs.get(site.actor).type, 'Application');
  assert.equal(pod.docs.get(site.webfinger)?.subject, 'acct:forum@forum.example', 'the pod answers WebFinger for the forum');
  assert.ok(!pod.docs.has(POD + 'fedipod-bb/c/gardening/.well-known/webfinger'), 'a category writes no discovery of its own');
  assert.deepEqual(pod.docs.get(site.categories).orderedItems, agent.categories.map(c => c.urls.actor));
  assert.ok(pod.acls.some(([u, m]) => u === g.urls.inbox && m.length === 0), 'the category\'s own inbox is shut');
  assert.ok(pod.acls.some(([u, m]) => u === site.inbox && m.includes('Append')), 'the forum inbox takes mail');
  assert.ok(pod.docs.get(site.home + 'ap/heartbeat')?.at, 'a heartbeat says the forum is hosted');

  const delivered = [];
  wire(agent, delivered);
  // Mei joins gardening.
  pod.deliver('f1', { '@context': 'https://www.w3.org/ns/activitystreams', id: 'https://mei.pod.example/fedipod/ap/actor#follow-1', type: 'Follow', actor: MEI, object: g.urls.actor });
  await agent.intake.drain();
  assert.ok(g.store.getContacts().followers.some(f => f.actor === MEI), 'the Follow reached the gardening group');
  assert.ok(delivered.some(d => d.who === 'gardening' && d.a.type === 'Accept'), 'and was accepted by that category');
  assert.equal(pod.inbox.length, 0, 'the item left the inbox');
  assert.ok(!agent.categories[1].store.getContacts().followers.length, 'compost saw nothing');

  // Mei opens a topic: an Article with a title, addressed to the category.
  const A1 = 'https://mei.pod.example/fedipod/ap/notes/blight';
  remoteDocs[A1] = note(A1, { type: 'Article', name: 'Tomato blight after the wet August', content: '<p>Three beds gone.</p>', audience: g.urls.actor });
  pod.deliver('c1', { '@context': 'https://www.w3.org/ns/activitystreams', id: A1 + '-create', type: 'Create', actor: MEI, object: remoteDocs[A1], to: remoteDocs[A1].to, cc: [] });
  await agent.intake.drain();
  const carried = delivered.find(d => d.who === 'gardening' && d.a.type === 'Announce');
  assert.ok(carried, 'the category carried the post (FEP-1b12)');
  assert.equal(carried.a.audience, g.urls.actor);
  const list = topics.list(g.store);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Tomato blight after the wet August');
  const tid = list[0].tid;
  const head = pod.docs.get(g.urls.topic(tid));
  assert.equal(head?.type, 'OrderedCollection', 'the topic is published as a context collection');
  assert.deepEqual(pod.docs.get(g.urls.topicPage(tid, 1)).orderedItems, [A1]);
  assert.equal(pod.docs.get(g.urls.cached(A1))?.content, '<p>Three beds gone.</p>', 'a readable copy is kept for the website');
  assert.equal(pod.docs.get(g.urls.cached(MEI))?.preferredUsername, 'mei', 'and the author\'s card beside it');
  assert.equal(pod.docs.get(g.urls.topics)?.totalItems, 1);

  // A reply with no context, from Mei, lands in the same topic by its parent.
  const R1 = 'https://mei.pod.example/fedipod/ap/notes/blight-r1';
  remoteDocs[R1] = note(R1, { inReplyTo: A1, audience: g.urls.actor, published: '2026-09-15T11:00:00Z' });
  pod.deliver('c2', { type: 'Create', actor: MEI, object: remoteDocs[R1], to: remoteDocs[R1].to, cc: [] });
  await agent.intake.drain();
  assert.deepEqual(pod.docs.get(g.urls.topicPage(tid, 1)).orderedItems, [A1, R1], 'the reply follows the opening post');
  // A reply that names the topic as its context, addressed to nobody in particular, still routes.
  const R2 = 'https://mei.pod.example/fedipod/ap/notes/blight-r2';
  remoteDocs[R2] = note(R2, { inReplyTo: R1, context: g.urls.topic(tid), to: [PUBLIC], published: '2026-09-15T12:00:00Z' });
  pod.deliver('c3', { type: 'Create', actor: MEI, object: remoteDocs[R2], to: [PUBLIC], cc: [] });
  await agent.intake.drain();
  assert.deepEqual(pod.docs.get(g.urls.topicPage(tid, 1)).orderedItems, [A1, R1, R2], 'context places a reply (FEP-7888)');
  assert.equal(pod.docs.get(g.urls.topic(tid)).totalItems, 3);

  // A non-member's post is not carried and opens nothing.
  const K1 = 'https://kwame.example/notes/1';
  remoteDocs[K1] = note(K1, { by: KWAME, audience: g.urls.actor, content: '<p>drive-by</p>' });
  pod.deliver('c4', { type: 'Create', actor: KWAME, object: remoteDocs[K1], to: remoteDocs[K1].to, cc: [] });
  await agent.intake.drain();
  assert.equal(topics.list(g.store).length, 1, 'a non-member opens no topic');
  assert.ok(!delivered.some(d => d.a.type === 'Announce' && d.a.object?.id === K1 + '-create'), 'and is not carried');
  assert.ok(log.some(l => /not a member/u.test(l)));

  // A listed moderator's Remove of the topic is held for the operator, not run; applied, the topic goes.
  const PRIYA = 'https://priya.pod.example/fedipod/ap/actor';
  pod.deliver('m1', { type: 'Remove', actor: PRIYA, object: g.urls.topic(tid), target: g.urls.actor });
  await agent.intake.drain();
  const q = g.store.read('modqueue.json', []);
  assert.equal(q.length, 1, 'a moderator\'s Remove is queued');
  assert.equal(q[0].type, 'Remove');
  assert.equal(topics.list(g.store).length, 1, 'and nothing happened yet');
  const applied = await agent.applyModeration('gardening', q[0].id);
  assert.equal(applied.removed, 3);
  assert.equal(topics.list(g.store).length, 0, 'applied, the topic is gone');
  assert.ok(delivered.some(d => d.who === 'gardening' && d.a.type === 'Announce' && d.a.object?.type === 'Remove'), 'and members were told');
  assert.equal(g.store.read('modqueue.json', []).length, 0);
  // A locked topic takes no reply: the post is not placed and its carry is unsaid.
  const L1 = 'https://mei.pod.example/fedipod/ap/notes/locked-op';
  remoteDocs[L1] = note(L1, { type: 'Article', name: 'Locked thread', audience: g.urls.actor, published: '2026-09-15T13:00:00Z' });
  pod.deliver('c5', { type: 'Create', actor: MEI, object: remoteDocs[L1], to: remoteDocs[L1].to, cc: [] });
  await agent.intake.drain();
  const ltid = topics.list(g.store)[0].tid;
  const { moderation } = await import('../src/index.mjs');
  moderation.lockTopic(g, ltid, true);
  const L2 = 'https://mei.pod.example/fedipod/ap/notes/locked-r1';
  remoteDocs[L2] = note(L2, { inReplyTo: L1, audience: g.urls.actor, published: '2026-09-15T13:30:00Z' });
  pod.deliver('c6', { type: 'Create', actor: MEI, object: remoteDocs[L2], to: remoteDocs[L2].to, cc: [] });
  await agent.intake.drain();
  assert.equal(topics.get(g.store, ltid).posts.length, 1, 'the reply did not join the locked topic');
  assert.ok(delivered.some(d => d.who === 'gardening' && d.a.type === 'Undo' && d.a.object?.type === 'Announce'), 'and its carry was unsaid');

  // Mail for nobody here is a dead letter, and leaves the inbox.
  pod.deliver('x1', { type: 'Create', actor: KWAME, object: note('https://kwame.example/notes/2', { by: KWAME, to: [PUBLIC] }), to: [PUBLIC] });
  await agent.intake.drain();
  assert.ok(agent.store.getDeadLetters().some(d => /names no category/u.test(d.reason)));
  assert.equal(pod.inbox.length, 0);
  assert.equal(agent.status().categories[0].topics, 1);
  await agent.stop();
});

test('two devices share the forum: the second watches, and hosts when the first stops', async () => {
  const pod = fakePod();
  const dir1 = home();
  const dir2 = home();
  const { agent: one } = await boot(pod, dir1);
  await one.init({ handle: 'forum', name: 'The Forum', categories: ['gardening'] });
  assert.ok(await one.connect());
  assert.equal(one.viewer, false);
  const { agent: two } = await boot(pod, dir2);
  assert.ok(await two.connect());
  assert.equal(two.viewer, true, 'a second device is a viewer while the first hosts');
  assert.equal(await two.tryPromote(), false, 'and stays one while the lease is held');
  await one.stop();                                   // releases the lease
  assert.equal(await two.tryPromote(), true, 'the lease freed: the second device hosts');
  assert.equal(two.viewer, false);
  assert.ok(pod.docs.get(two.site.home + 'ap/heartbeat'));
  await two.stop();
});

test('a fronted forum: one Gateway row per category, one inbox behind them, front ids on every document', async () => {
  const pod = fakePod();
  // The pod applies the url map a transport would: an advertised id lands
  // where its pod tree is.
  let map = null;
  pod.setUrlMap = (fn) => { map = fn; };
  const at = (u) => (map ? map(u) : u);
  for (const k of ['putJson', 'put', 'getJson', 'setAcl', 'delete', 'listContainer']) {
    const orig = pod[k];
    pod[k] = (u, ...rest) => orig(at(u), ...rest);
  }
  const origFetch = pod.fetch;
  pod.fetch = (u, init) => origFetch(at(u), init);
  const FRONT = 'https://front.example';
  const dir = home();
  const { agent } = await boot(pod, dir);
  await agent.init({ handle: 'forum', name: 'The Forum', categories: ['gardening'] });
  assert.ok(await agent.connect({ act: false }));
  const asked = [];
  const r = await agent.attach({ front: FRONT, attachOne: async (body) => { asked.push(body); return { hmacSecret: 's-' + body.handle }; } });
  assert.deepEqual(r.handles, ['forum', 'gardening']);
  assert.equal(asked[1].podHome, POD + 'fedipod-bb/c/gardening/', 'a category row names its own tree');
  assert.equal(asked[1].inboxUrl, POD + 'fedipod-bb/ap/inbox/', 'and the forum\'s inbox as where its mail goes');
  assert.equal(asked[1].kind, 'group'); assert.equal(asked[0].kind, 'application');
  assert.equal(asked[1].fronted, true);
  // A new start reads the config, takes the front shape, and republishes.
  const { agent: two } = await boot(pod, dir);
  assert.ok(await two.connect());
  assert.equal(two.viewer, false);
  const g = two.categories[0];
  assert.equal(g.urls.actor, FRONT + '/u/gardening/ap/actor', 'the category answers at the front');
  assert.equal(two.site.actor, FRONT + '/u/forum/ap/actor');
  const stored = pod.docs.get(POD + 'fedipod-bb/c/gardening/ap/actor');
  assert.ok(stored, 'the category actor is written to the pod tree');
  assert.equal(stored.id, FRONT + '/u/gardening/ap/actor', 'under its front id');
  assert.equal(stored.inbox, FRONT + '/u/gardening/ap/inbox/', 'and names its door at the front');
  assert.equal(g.config.gateway.hmacSecret, 's-gardening', 'each row keeps the secret it was given');
  assert.equal(two.siteAgent.config.gateway.hmacSecret, 's-forum');
  assert.equal(two.gatewaySecret?.() ?? two.intake.gatewaySecret(), 's-forum');
  // Mail still drains from the pod's inbox container, whatever id it is listed under.
  const delivered = [];
  wire(two, delivered);
  pod.deliver('f1', { type: 'Follow', actor: MEI, object: g.urls.actor });
  await two.intake.drain();
  assert.ok(g.store.getContacts().followers.some(f => f.actor === MEI), 'a Follow of the front id reaches the category');
  assert.equal(pod.inbox.length, 0);
  await two.stop();
});

test('a topic survives a restart: its record is where the state can read it', async () => {
  // The state is loaded by listing ONE container and reading the .json files
  // in it. A topic filed in a folder below it was written and never read back,
  // so a forum that restarted lost every topic it had.
  const { PodStore } = await import('../../../lib/core/store.mjs');
  const st = new PodStore({ log: () => {} });
  const written = new Map();
  st.attach({ base: 'mem://', kind: 'pod',
    list: async () => ({ names: [...written.keys()].filter(n => n.endsWith('.json')), etag: null }),
    read: async (n) => (written.has(n) ? { ok: true, body: written.get(n) } : { ok: false }),
    write: async (n, body) => { written.set(n, body); return { ok: true }; },
    remove: async (n) => { written.delete(n); return true; } });
  const tid = topics.open(st, { title: 'Kept', post: { id: 'https://a.example/1', author: 'https://a.example/actor', published: '2026-09-16T00:00:00Z' } });
  await st.flush();
  assert.ok([...written.keys()].some(n => n === topics.topicDoc(tid)), 'the record is a document of the state container');
  assert.ok([...written.keys()].every(n => !n.includes('/')), 'nothing is filed in a folder below it');
  const again = new PodStore({ log: () => {} });
  again.attach({ base: 'mem://', kind: 'pod',
    list: async () => ({ names: [...written.keys()].filter(n => n.endsWith('.json')), etag: null }),
    read: async (n) => (written.has(n) ? { ok: true, body: written.get(n) } : { ok: false }),
    write: async () => ({ ok: true }), remove: async () => true });
  await again.load();
  assert.equal(topics.list(again).length, 1);
  assert.equal(topics.get(again, tid)?.posts.length, 1, 'the posts come back with it');
});
