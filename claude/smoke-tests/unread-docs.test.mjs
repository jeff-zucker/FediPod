// unread-docs.test.mjs — a document the pod refused to hand over is read
// again, and nothing is saved over it in the meantime: an account whose pod
// was busy for one read must not lose its timeline or its followers.
import test from 'node:test';
import assert from 'node:assert/strict';
const { PodStore } = await import('../../lib/core/store.mjs');

// A pod's state container: answers 304 to a listing ETag it still has, and
// refuses a read of each name for as many times as `refuse` says.
function fakePod(docs, refuse = {}) {
  const pod = { docs: { ...docs }, refuse: { ...refuse }, puts: [], tag: 1 };
  pod.storage = {
    kind: 'pod', base: 'https://pod.example/fedipod/ap-state/',
    async list(_sub, { etag } = {}) {
      const now = `"L${pod.tag}"`;
      if (etag === now) return { notModified: true, names: null, etag };
      return { notModified: false, names: Object.keys(pod.docs), etag: now };
    },
    async read(name) {
      if (pod.refuse[name] > 0) { pod.refuse[name]--; return { ok: false, notModified: false, status: 429, body: null, etag: null }; }
      if (!(name in pod.docs)) return { ok: false, notModified: false, status: 404, body: null, etag: null };
      return { ok: true, notModified: false, status: 200, body: pod.docs[name], etag: `"${name}-${pod.docs[name].length}"` };
    },
    async write(name, body) { pod.puts.push(name); pod.docs[name] = body; return { ok: true, retry: false, why: '' }; },
    async remove(name) { delete pod.docs[name]; return true; },
  };
  return pod;
}
const rows = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ noteId: `old${i}`, kind: 'timeline' })));
const config = JSON.stringify({ handle: 'jeff' });

test('a document the pod refused is read again at the next load', async () => {
  const pod = fakePod({ 'config.json': config, 'statuses.json': rows(3) }, { 'statuses.json': 1 });
  const store = new PodStore({ storage: pod.storage, log: () => {} });
  await store.load();
  assert.deepEqual(store.getStatuses(), [], 'the refused read leaves nothing to show');
  assert.equal(store.lastSkipped.length, 1);
  await store.load();
  assert.equal(store.getStatuses().length, 3, 'the next load read it, though the container had not changed');
  assert.equal(store.lastSkipped.length, 0);
});

test('nothing is saved over a document that could not be read', async () => {
  const pod = fakePod({ 'config.json': config, 'statuses.json': rows(3) }, { 'statuses.json': 1 });
  const store = new PodStore({ storage: pod.storage, log: () => {} });
  await store.load();
  store.addStatus({ noteId: 'new1', kind: 'timeline' });
  assert.equal(await store.commit(), false, 'the new post is reported as not written down');
  assert.deepEqual(pod.puts, [], 'the pod was not written to');
  assert.equal(store.getStatuses().length, 3, 'the commit read the real timeline in its place');
  store.addStatus({ noteId: 'new1', kind: 'timeline' });
  assert.equal(await store.commit(), true);
  assert.deepEqual(JSON.parse(pod.docs['statuses.json']).map((s) => s.noteId), ['new1', 'old0', 'old1', 'old2']);
});

test('while the pod goes on refusing, the document is left as it is', async () => {
  const pod = fakePod({ 'config.json': config, 'contacts.json': JSON.stringify({ followers: [{ actor: 'a' }, { actor: 'b' }], following: [] }) },
    { 'contacts.json': 5 });
  const store = new PodStore({ storage: pod.storage, log: () => {} });
  await store.load();
  const c = store.getContacts();
  c.followers.push({ actor: 'c' });
  store.setContacts(c);
  assert.equal(await store.commit(), false);
  assert.equal(await store.commit(), true, 'a refusal is reported once, to the commit that can act on it');
  assert.deepEqual(pod.puts, []);
  assert.equal(JSON.parse(pod.docs['contacts.json']).followers.length, 2, 'both followers are still on the pod');
});

test('a document that is gone from the pod may be written again', async () => {
  const pod = fakePod({ 'config.json': config, 'statuses.json': rows(1) }, { 'statuses.json': 1 });
  const store = new PodStore({ storage: pod.storage, log: () => {} });
  await store.load();
  delete pod.docs['statuses.json']; pod.tag++;
  await store.load();
  store.addStatus({ noteId: 'new1', kind: 'timeline' });
  assert.equal(await store.commit(), true);
  assert.deepEqual(pod.puts, ['statuses.json']);
});
