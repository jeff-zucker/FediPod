// setup.test.mjs — a forum brought into being from wherever its owner is: the
// config and containers on the pod, its rows at a Gateway, the Gateway named
// as keeper, in the order that starts the first run last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { forumConfig, writeForumConfig, attachRows, keepRows, nameKeeperInRules, setUpForumAtGateway } from '../src/setup.mjs';
import { POD, fakePod } from './fake-pod.mjs';

const FRONT = 'https://fedipod.example';
const KEEPER = 'https://fedipod.example/keeper/profile/card#me';

// A Gateway that attaches and keeps, remembering what it was asked, in order.
function fakeFront() {
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, body });
    if (url.endsWith('/api/attach')) return { status: 201, json: async () => ({ hmacSecret: 'secret-' + body.handle }) };
    if (url.endsWith('/api/keeper')) return { ok: true, status: 200, json: async () => ({ ok: true, keeper: KEEPER }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { calls, fetch };
}

test('the config: a first write, then a rename that asks to be published again', () => {
  const first = forumConfig({}, { remotePod: POD, handle: 'forum', name: 'The Forum', categories: ['gardening', { slug: 'compost', name: 'Compost' }] });
  assert.equal(first.kind, 'application');
  assert.deepEqual(first.categories, [{ slug: 'gardening', name: 'gardening' }, { slug: 'compost', name: 'Compost' }]);
  assert.equal(first.republish, undefined);
  const renamed = forumConfig(first, { remotePod: POD, handle: 'forum', name: 'The Forum, renamed', categories: first.categories });
  assert.equal(renamed.republish, true);
  assert.throws(() => forumConfig({}, { remotePod: POD, handle: 'forum', categories: ['Not A Slug'] }), /not a category slug/u);
  assert.throws(() => forumConfig({}, { remotePod: POD, handle: 'No Handle' }), /not a forum handle/u);
});

test('written on the pod: the containers with their rules, and the config in the forum\'s state', async () => {
  const pod = fakePod();
  const { config, plain } = await writeForumConfig(pod, pod.storageFor, { remotePod: POD, handle: 'forum', name: 'The Forum', categories: ['gardening'] });
  assert.equal(plain.home, POD + 'fedipod-bb/');
  assert.ok(pod.acls.some(([u]) => u.startsWith(POD + 'fedipod-bb/')), 'rules were written under the forum\'s home');
  const state = pod.state.get(plain.state);
  assert.ok(state, 'the forum\'s state container was written');
  const stored = JSON.parse(state.get('config.json'));
  assert.equal(stored.handle, 'forum');
  assert.equal(stored.categories[0].slug, config.categories[0].slug);
});

test('attached at a Gateway: the forum\'s row and one per category, fronted, all writing into the one inbox', async () => {
  const pod = fakePod();
  const { config, plain } = await writeForumConfig(pod, pod.storageFor, { remotePod: POD, handle: 'forum', categories: ['gardening', 'compost'] });
  const front = fakeFront();
  const { gateway, handles } = await attachRows({ fetch: front.fetch, front: FRONT + '/', config, plain });
  assert.deepEqual(handles, ['forum', 'gardening', 'compost']);
  assert.equal(gateway.front, FRONT, 'the origin is kept without its slash');
  assert.deepEqual(front.calls.map((c) => c.body.handle), ['forum', 'gardening', 'compost']);
  assert.ok(front.calls.every((c) => c.body.fronted === true && c.body.inboxUrl === plain.inbox), 'every row is fronted and names the forum\'s inbox');
  assert.equal(front.calls[0].body.kind, 'application');
  assert.equal(front.calls[1].body.kind, 'group');
  assert.equal(front.calls[1].body.podHome, plain.category('gardening').home);
  assert.deepEqual(gateway.secrets, { forum: 'secret-forum', gardening: 'secret-gardening', compost: 'secret-compost' });
});

test('kept: the categories are switched on first and the forum\'s own row last, each category naming its forum', async () => {
  const config = forumConfig({}, { remotePod: POD, handle: 'forum', categories: ['gardening', 'compost'] });
  const front = fakeFront();
  const { keeper, handles } = await keepRows({ fetch: front.fetch, front: FRONT, config,
    between: async (k) => { front.calls.push({ path: 'rules', body: { keeper: k } }); } });
  assert.equal(keeper, KEEPER);
  assert.deepEqual(handles, ['gardening', 'compost', 'forum']);
  assert.deepEqual(front.calls.map((c) => c.body), [
    { handle: 'gardening', on: true, forum: 'forum' }, { handle: 'compost', on: true, forum: 'forum' }, { keeper: KEEPER }, { handle: 'forum', on: true },
  ], 'the rules are stated, with the keeper known, before the forum\'s own switch');
  const off = await keepRows({ fetch: front.fetch, front: FRONT, config, on: false });
  assert.equal(off.keeper, null);
});

test('the keeper named in every rule: the transport carries the name, and the containers are stated again', async () => {
  const pod = fakePod();
  const { config, plain } = await writeForumConfig(pod, pod.storageFor, { remotePod: POD, handle: 'forum', categories: ['gardening'] });
  const before = pod.acls.length;
  await nameKeeperInRules(pod, { config, plain, keeper: KEEPER, ownerWebId: pod.webId });
  assert.deepEqual(pod.keepers, [KEEPER]);
  assert.equal(pod.aclOwner, pod.webId);
  assert.ok(pod.acls.length > before, 'the rules were written again with the keeper named');
  assert.ok(pod.acls.some(([u]) => u.startsWith(plain.category('gardening').home)), 'the category\'s rules among them');
});

test('from a sign-up page, start to finish: config, rows, keeper, and the gateway recorded in the config', async () => {
  const pod = fakePod();
  const front = fakeFront();
  const steps = [];
  const out = await setUpForumAtGateway({ remote: pod, storageFor: pod.storageFor, fetch: front.fetch, front: FRONT, ownerWebId: pod.webId,
    remotePod: POD, handle: 'forum', name: 'The Forum', categories: [{ slug: 'gardening', name: 'Gardening' }], moderatorWebIds: [pod.webId] },
  { onStep: (k, st) => steps.push(k + ':' + st) });
  assert.deepEqual(out, { handle: 'forum', front: FRONT, handles: ['forum', 'gardening'], keeper: KEEPER });
  assert.deepEqual(steps, ['write:running', 'write:ok', 'attach:running', 'attach:ok', 'keep:running', 'keep:ok']);
  const paths = front.calls.map((c) => c.path + ':' + c.body.handle);
  assert.deepEqual(paths, ['/api/attach:forum', '/api/attach:gardening', '/api/keeper:gardening', '/api/keeper:forum'],
    'attached first, then kept with the forum\'s own row last');
  const state = [...pod.state.values()].find((m) => m.has('config.json'));
  const stored = JSON.parse(state.get('config.json'));
  assert.equal(stored.gateway.front, FRONT);
  assert.equal(stored.gateway.secrets.gardening, 'secret-gardening');
  assert.equal(stored.republish, true, 'the first run publishes everything');
  assert.deepEqual(pod.keepers, [KEEPER]);
});
