// push-signout.test.mjs — an app signed out stops hearing about the account.
// Where the sign-ins are kept beside the subscriptions (the Server), a
// subscription whose sign-in is gone is forgotten at the next notification;
// where they are not (fedipod.net keeps its sign-ins elsewhere), nothing is
// forgotten for that reason.
import test from 'node:test';
import assert from 'node:assert/strict';
const { Push } = await import('../../lib/client/webpush.mjs');

const memoryStore = () => {
  const docs = {};
  return { read: (n, f) => structuredClone(docs[n] ?? f), write: (n, v) => { docs[n] = structuredClone(v); } };
};
// Keys no push service would take: each send fails at once, before any network.
const sub = (n) => ({ endpoint: `https://127.0.0.1:9/${n}`, keys: { p256dh: 'not-a-key', auth: 'not-a-secret' } });

test('a subscription whose app is signed out is forgotten, and the signed-in one kept', async () => {
  const push = new Push({ store: memoryStore(), subject: () => 'https://kofi.pod.example/fedipod/ap/actor',
    liveKeys: () => new Set([push.keyOf('signed-in')]) });
  push.set('signed-in', sub('a')); push.set('signed-out', sub('b'));
  await push.notify({ type: 'mention' }, { title: 'Nia mentioned you', body: 'see you at six' });
  assert.ok(push.get('signed-in'));
  assert.equal(push.get('signed-out'), null);
});

test('without the list of sign-ins, no subscription is forgotten for its sign-in', async () => {
  const push = new Push({ store: memoryStore(), subject: () => 'https://fedipod.example/' });
  push.set('one', sub('a')); push.set('two', sub('b'));
  await push.notify({ type: 'mention' }, { title: 't', body: '' });
  assert.ok(push.get('one') && push.get('two'));
});
