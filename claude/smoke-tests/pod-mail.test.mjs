// pod-mail.test.mjs — fedipod.net working for a personal account without
// writing its pod (lib/gateway/pod-mail.mjs): what it changes is read from
// and written to the copy, recorded, and handed to the pod inbox as one
// stamped item; nothing is written to the pod itself.
// Run from the project root: node --test claude/smoke-tests/pod-mail.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryKv, CopyStorage, copyLease, GATEWAY_HOLDER } from '../../lib/gateway/copy.mjs';
import { MailStorage, mailSession, flushMail, inCopyFor, pendingPublicResponse, appliedUpTo } from '../../lib/gateway/pod-mail.mjs';
import { PUBLIC_CONFIG } from '../../lib/core/pod-only.mjs';
import { PodStore } from '../../lib/core/store.mjs';
import { PodTransport } from '../../lib/pod/transport.mjs';
import { verifyReceipt } from '../../lib/gateway/httpsig.mjs';
import { applyDelta } from '../../lib/core/doc-delta.mjs';

const POD = 'https://nia.pod.example/';
const HOME = POD + 'fedipod/';
const SECRET = 'door-secret-for-the-test';
const rec = { handle: 'nia', webId: POD + 'profile/card#me', podHome: HOME, actorUrl: 'https://gw.example/u/nia/ap/actor',
  hmacSecret: SECRET, gatewayWebId: 'https://gw.example/gateway#me' };

async function setup({ full = false } = {}) {
  const kv = memoryKv();
  const put = (name, obj) => kv.set(`nia/d/${name}`, JSON.stringify(obj));
  await put('contacts.json', { followers: [{ actor: 'https://a.example/u/ama' }], following: [] });
  await put('queue.json', []);
  await put(PUBLIC_CONFIG, { handle: 'nia', name: 'Nia', root: 'fedipod/', remotePod: POD, kind: 'person' });
  if (full) await put('statuses.json', [{ noteId: HOME + 'ap/notes/old', kind: 'post' }]);
  await kv.set('nia/meta', JSON.stringify({ filledAt: Date.now(), full }));
  const lease = copyLease(kv, 'nia', { id: GATEWAY_HOLDER });
  assert.ok(await lease.acquire());
  const copy = new CopyStorage(kv, 'nia', { holder: GATEWAY_HOLDER });
  const storage = new MailStorage(copy, { inCopy: inCopyFor({ full }) });
  const store = new PodStore({ storage, log: () => {} });
  await store.load();
  const appended = [];
  const pending = new Map();
  const ctx = {
    copyKv: kv,
    podPut: async (handle, url, body, ct) => { appended.push({ handle, url, body, ct }); return true; },
    pendingPublic: {
      get: async (h, u) => pending.get(u) || null, set: async (h, u, v) => pending.set(u, { ...v, handle: h }), delete: async (h, u) => pending.delete(u),
      list: async (h) => [...pending].filter(([, v]) => v.handle === h).map(([url, value]) => ({ url, value })),
    },
  };
  return { kv, store, storage, ctx, appended, pending };
}

test('the settings are read from their public part in the copy', async () => {
  const { store } = await setup();
  assert.equal(store.getConfig()?.name, 'Nia');
  assert.equal(store.getConfig()?.handle, 'nia');
});

test('a change to a document in the slim copy is written there and recorded', async () => {
  const { store, storage, kv } = await setup();
  const c = store.read('contacts.json');
  c.followers.push({ actor: 'https://b.example/u/bo' });
  store.write('contacts.json', c);
  await store.commit();
  assert.equal(JSON.parse((await kv.get('nia/d/contacts.json')).text).followers.length, 2, 'written to the copy');
  const d = storage.deltas()['contacts.json'];
  assert.ok(d, 'and recorded');
});

test('a document outside the slim copy reads as absent, and a change to it is only recorded', async () => {
  const { store, storage, kv } = await setup();
  assert.deepEqual(store.getNotifications(), []);
  store.addNotification({ type: 'follow', actor: 'https://b.example/u/bo' });
  await store.commit();
  assert.equal(await kv.get('nia/d/notifications.json'), null, 'nothing kept at the gateway');
  const d = storage.deltas()['notifications.json'];
  const onPod = applyDelta([{ id: 'x', type: 'favourite' }], d);
  assert.equal(onPod.length, 2, 'the pod keeps its own and gains the new one');
  assert.equal(onPod[0].type, 'follow');
});

test('with an outside app signed in, the timeline is in the copy', async () => {
  const { store, kv } = await setup({ full: true });
  assert.equal(store.getStatuses().length, 1);
  store.addStatus({ noteId: HOME + 'ap/notes/new', kind: 'post' });
  await store.commit();
  assert.equal(JSON.parse((await kv.get('nia/d/statuses.json')).text).length, 2);
});

test('pod writes are recorded, not sent, and read back within the run', async () => {
  const sent = [];
  const session = mailSession({
    keyUrl: HOME + 'ap-state/keys.json',
    keyFetch: async () => new Response('{"rsa":{}}', { status: 200 }),
    publicFetch: async (u, i) => { sent.push([i?.method || 'GET', u]); return new Response('', { status: 404 }); },
  });
  const t = new PodTransport(session, { webId: 'https://gw.example/keyreader#me', log: () => {} });
  await t.put(HOME + 'ap/notes/n1', '{"type":"Note"}', 'application/activity+json');
  const back = await t.getJson(HOME + 'ap/notes/n1');
  assert.equal(back.type, 'Note', 'read back from the run');
  assert.equal((await t.fetch(HOME + 'ap-state/keys.json')).status, 200, 'the key comes from the key reader');
  await t.fetch(HOME + 'ap/media/pic.png', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3]) });
  await t.delete(HOME + 'ap/notes/gone');
  assert.ok(sent.every(([m]) => m === 'GET' || m === 'HEAD'), 'nothing but reads ever reached the pod');
  assert.deepEqual(session.writes.map((w) => w.method), ['PUT', 'PUT', 'DELETE']);
  assert.equal(session.writes[1].base64, Buffer.from([1, 2, 3]).toString('base64'), 'a picture travels as base64');
});

test('one run is one stamped item in the pod inbox, numbered', async () => {
  const { store, storage, ctx, appended, pending } = await setup();
  store.addNotification({ type: 'follow', actor: 'https://b.example/u/bo' });
  await store.commit();
  const session = mailSession({ keyUrl: 'k', keyFetch: async () => null, publicFetch: async () => new Response('', { status: 404 }) });
  await session.fetch(HOME + 'ap/notes/n1', { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: '{"type":"Note"}' });
  await session.fetch(HOME + 'ap/private/d1', { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: '{"type":"Note"}' });
  const first = await flushMail(ctx, 'nia', rec, { storage, session });
  assert.equal(first.seq, 1);
  const [item, receiptDoc] = appended;
  assert.ok(/ap\/inbox\/gw-0000000001-[0-9a-f]{32}\.json$/.test(item.url) && receiptDoc.url === item.url + '.receipt.json', item.url);
  const body = JSON.parse(item.body);
  const receipt = JSON.parse(receiptDoc.body);
  assert.equal(body.seq, 1);
  assert.ok(verifyReceipt(receipt, SECRET), 'stamped with the door secret');
  assert.equal(receipt.method, 'gateway-writes');
  assert.ok(!verifyReceipt(receipt, 'someone-else'), 'and nobody else could have stamped it');
  assert.ok(body.deltas['notifications.json'] && body.writes.length === 2);
  assert.ok(pending.has(HOME + 'ap/notes/n1'), 'a public post is kept to be shown before FediPod runs');
  assert.ok(!pending.has(HOME + 'ap/private/d1'), 'a private one is not');
  const res = await pendingPublicResponse(ctx, 'nia', HOME + 'ap/notes/n1');
  assert.equal((await res.json()).type, 'Note');
  const second = await flushMail(ctx, 'nia', rec, { storage: null, session: { writes: [{ method: 'PUT', url: HOME + 'ap/outbox', text: '{}' }] } });
  assert.equal(second.seq, 2, 'the next item has the next number');
  assert.equal(await appliedUpTo(ctx, 'nia', 1), 1, 'what FediPod has applied is dropped');
  assert.ok(!pending.has(HOME + 'ap/notes/n1') && pending.has(HOME + 'ap/outbox'));
});

test('a run that changed nothing hands nothing over', async () => {
  const { storage, ctx, appended } = await setup();
  const r = await flushMail(ctx, 'nia', rec, { storage, session: mailSession({ keyUrl: 'k', keyFetch: async () => null }) });
  assert.ok(r.none && appended.length === 0);
});

test('small changes are set aside, and the round hands them over together, in order', async () => {
  const { store, storage, ctx, appended } = await setup();
  store.addNotification({ type: 'follow', actor: 'https://b.example/u/bo' });
  await store.commit();
  const first = await flushMail(ctx, 'nia', rec, { storage, defer: true });
  assert.ok(first.deferred && appended.length === 0, 'nothing goes to the pod for a change with no pod write in it');
  store.addNotification({ type: 'favourite', actor: 'https://c.example/u/cy' });
  await store.commit();
  await flushMail(ctx, 'nia', rec, { storage, defer: true });
  const { flushPending } = await import('../../lib/gateway/pod-mail.mjs');
  const out = await flushPending(ctx, 'nia', rec);
  assert.equal(out.items, 1);
  const item = JSON.parse(appended[0].body);
  const list = item.deltas['notifications.json'];
  assert.ok(Array.isArray(list) && list.length === 2, 'both changes, in one item');
  const onPod = (Array.isArray(list) ? list : [list]).reduce((d, one) => applyDelta(d, one), [{ id: 'x', type: 'mention' }]);
  assert.deepEqual(onPod.map((n) => n.type), ['favourite', 'follow', 'mention'], 'applied in order, newest first as the store keeps them');
  const again = await flushPending(ctx, 'nia', rec);
  assert.ok(again.none, 'and nothing is handed over twice');
});
