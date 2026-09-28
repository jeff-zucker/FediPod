// gateway.test.mjs — the forum as fedipod.net runs it: a delivery placed at
// the door lands in its topic at once with its carry left on the queue; the
// run carries it, writes the heartbeat and says when it is next due.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { memoryKv, copyMeta } from 'fedipod/gateway/copy.mjs';
import { ForumAgent } from '../src/forum-agent.mjs';
import { isForumRow, placeAtDoor, keepOnce } from '../src/gateway.mjs';
import * as topics from '../src/topics.mjs';
import { POD, MEI, KWAME, fakePod, home, remoteDocs, note } from './fake-pod.mjs';

const KEEPER = 'https://fedipod.net/keeper/profile/card#me';
const WEBID = 'https://forum.example/profile/card#me';
const HOME = POD + 'fedipod-bb/';

// A forum set up the ordinary way, then handed to the gateway: its state
// copied from the pod into the gateway's copies, its rows kept, and the pod
// answering the keys the copies leave there.
async function keptForum() {
  const pod = fakePod();
  const dir = home();
  const setup = new ForumAgent({ home: dir, log: () => {}, remote: pod, storageFor: pod.storageFor, pollSeconds: 3600 });
  setup.probeFetch = async () => ({ status: 200 });
  await setup.init({ handle: 'forum', name: 'The Forum', categories: ['gardening'], replyPolicy: 'open' });
  assert.ok(await setup.connect());
  const g = setup.categories[0];
  g.store.setContacts({ followers: [
    { actor: MEI, inbox: remoteDocs[MEI].inbox, sharedInbox: remoteDocs[MEI].endpoints.sharedInbox, accepted: true },
    { actor: KWAME, inbox: remoteDocs[KWAME].inbox, accepted: true },
  ], following: [] });
  await setup.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  // The copies, as the gateway would have filled them from the pod.
  const kv = memoryKv();
  const bases = { forum: HOME + 'ap-state/', gardening: HOME + 'c/gardening/ap-state/' };
  for (const [h, base] of Object.entries(bases)) {
    const m = pod.state.get(base) || new Map();
    for (const [name, body] of m) if (name !== 'keys.json' && name !== 'lease.json') await kv.set(`${h}/d/${name}`, body);
    await kv.set(`${h}/meta`, JSON.stringify({ filledAt: Date.now(), webId: WEBID, stateUrl: base, podOnly: ['keys.json'] }));
    await kv.set(`_copies/${h}`, String(Date.now()));
  }
  // What stays on the pod is read there: the keys.
  const fetchWas = pod.fetch;
  pod.fetch = async (u, init) => {
    for (const base of Object.values(bases)) {
      if (u === base + 'keys.json' && (!init?.method || init.method === 'GET')) {
        const body = pod.state.get(base)?.get('keys.json');
        if (body) return new Response(body, { status: 200, headers: { 'content-type': 'application/json', etag: '"k"' } });
      }
    }
    return fetchWas(u, init);
  };
  const rows = {
    forum: { handle: 'forum', kind: 'application', podHome: HOME, inboxUrl: HOME + 'ap/inbox/', webId: WEBID, keeper: { webId: KEEPER } },
    gardening: { handle: 'gardening', kind: 'group', podHome: HOME + 'c/gardening/', inboxUrl: HOME + 'ap/inbox/', webId: WEBID, keeper: { webId: KEEPER }, forum: 'forum' },
  };
  const started = [];
  const said = [];
  const ctx = { copyKv: kv, keeperWebId: KEEPER, lookup: async (h) => rows[h] || null, keeperFetch: async () => pod.fetch,
    startKeeper: async (h) => { started.push(h); } };
  // What the door and the run have to say the origins say: Mei's post and
  // the members' actors, in place of the network.
  const prepare = (forum) => {
    for (const cat of forum.categories) cat.intake.fetchAP = async (u) => remoteDocs[u] ?? null;
    forum.intake.fetchAP = async (u) => remoteDocs[u] ?? null;
  };
  return { pod, kv, rows, ctx, started, said, prepare, log: (m) => said.push(m) };
}

test('a forum row and a category row are the forum\'s; a person\'s is not', () => {
  assert.equal(isForumRow({ kind: 'application', inboxUrl: 'https://p/fedipod-bb/ap/inbox/' }), true);
  assert.equal(isForumRow({ kind: 'group', inboxUrl: 'https://p/fedipod-bb/ap/inbox/' }), true);
  assert.equal(isForumRow({ kind: 'person', podHome: 'https://p/fedipod/' }), false);
  assert.equal(isForumRow({ kind: 'group', podHome: 'https://p/fedipod/' }), false, 'a plain group has no shared inbox');
});

test('placed at the door: the post is in its topic and its copy written, the item leaves the inbox, and the carry waits for the run', async () => {
  const { pod, kv, rows, ctx, prepare, log } = await keptForum();
  const N = 'https://mei.pod.example/fedipod/ap/notes/door-1';
  remoteDocs[N] = note(N, { type: 'Article', name: 'Through the door', audience: HOME + 'c/gardening/ap/actor', published: '2026-09-28T12:00:00Z' });
  const create = { '@context': 'https://www.w3.org/ns/activitystreams', id: N + '#create', type: 'Create', actor: MEI, object: remoteDocs[N], to: remoteDocs[N].to, cc: [] };
  pod.deliver('door-1', create);
  const r = await placeAtDoor(ctx, 'gardening', rows.gardening, { name: 'door-1', raw: JSON.stringify(create), remote: pod, prepare, log });
  assert.equal(r.placed, true, `placed (${r.why || 'ok'})`);
  assert.equal(r.forum, 'forum', 'and names the forum for the run');
  const topicsDoc = JSON.parse((await kv.get('gardening/d/topics.json')).text);
  assert.equal(topicsDoc.length, 1, 'the topic is in the category\'s copy');
  const topic = JSON.parse((await kv.get(`gardening/d/${topics.topicDoc(topicsDoc[0].tid)}`)).text);
  assert.ok(topic.posts.some((p) => p.id === N), 'with the post in it');
  assert.ok([...pod.docs.keys()].some((u) => u.startsWith(HOME + 'c/gardening/ap/cache/')), 'the copy readers see is on the pod');
  assert.ok(pod.docs.get(HOME + 'ap/latest'), 'and the forum\'s latest index');
  assert.equal(pod.inbox.length, 0, 'the item left the inbox');
  const queue = JSON.parse((await kv.get('gardening/d/queue.json')).text);
  assert.ok(queue.some((i) => i.activity?.type === 'Announce' && i.attempts === 0), 'the carry waits on the queue, untried');
  assert.ok(!(await kv.get('forum/lease'))?.text || JSON.parse((await kv.get('forum/lease')).text).expiresAt <= Date.now() + 1000
    || JSON.parse((await kv.get('forum/lease')).text).expiresAt === 0, 'the forum\'s lease is given back');
});

test('the run: carries what the door placed, writes the heartbeat, and says when it is next due', async () => {
  const { pod, kv, rows, ctx, prepare, log } = await keptForum();
  const N = 'https://mei.pod.example/fedipod/ap/notes/door-2';
  remoteDocs[N] = note(N, { type: 'Article', name: 'Carried by the run', audience: HOME + 'c/gardening/ap/actor', published: '2026-09-28T12:30:00Z' });
  const create = { '@context': 'https://www.w3.org/ns/activitystreams', id: N + '#create', type: 'Create', actor: MEI, object: remoteDocs[N], to: remoteDocs[N].to, cc: [] };
  pod.deliver('door-2', create);
  assert.equal((await placeAtDoor(ctx, 'gardening', rows.gardening, { name: 'door-2', raw: JSON.stringify(create), remote: pod, prepare, log })).placed, true);
  const out = await keepOnce(ctx, 'forum', rows.forum, { remote: pod, prepare, log });
  assert.equal(out.skipped, undefined, `the run ran (${out.skipped || ''})`);
  assert.equal(out.drained, true);
  const queue = JSON.parse((await kv.get('gardening/d/queue.json')).text);
  // Kwame's server is nowhere to be found from a test, so the carry was tried
  // and waits for another try — which is what the run reports as its next time.
  assert.ok(queue.every((i) => i.attempts >= 1), 'every queued delivery was tried by the run');
  assert.ok(out.nextAt > Date.now(), 'and the run says when to come back for the retry');
  assert.ok(pod.docs.get(HOME + 'ap/heartbeat')?.at, 'the heartbeat says the forum was just hosted');
  assert.ok(await copyMeta(kv, 'forum') && await copyMeta(kv, 'gardening'), 'the copies are still the gateway\'s');
});
