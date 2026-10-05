// load-fixes.test.mjs — work an account does that it does not need to: the
// scheduled-post check copying the timeline twice a minute, every account
// fetching the same hashtags, followers' servers sent one after another, a
// fallback inbox check every ten minutes where the store's own events already
// wake the account, and an edited post with no size limit.
import test from 'node:test';
import assert from 'node:assert/strict';
const { nextToPublish } = await import('../../lib/core/scheduled.mjs');
const { PodStore } = await import('../../lib/core/store.mjs');
const { Deliverer } = await import('../../lib/core/deliver.mjs');
const { Intake } = await import('../../lib/core/intake/index.mjs');
const { timelineOnce } = await import('../../lib/connections/tagfeed.mjs');

test('asking when the next scheduled post or poll falls due reads the timeline without copying it', () => {
  const store = new PodStore({ log: () => {} });
  const soon = Date.now() + 60_000;
  store.cache.set('statuses.json', [
    { kind: 'post', noteId: 'n1', poll: { expiresAt: new Date(soon).toISOString() } },
    { kind: 'post', noteId: 'n2', poll: { expiresAt: new Date(soon - 10).toISOString(), closed: '2026-10-05T00:00:00Z' } },
  ]);
  store.cache.set('scheduled.json', [{ id: 's1', scheduledAt: new Date(soon + 5000).toISOString() }]);
  let copies = 0;
  const read = store.read.bind(store);
  store.read = (name, fallback) => { if (name === 'statuses.json') copies++; return read(name, fallback); };
  assert.equal(nextToPublish(store), soon, 'the open poll, not the closed one, not the later post');
  assert.equal(copies, 0, 'the timeline was not copied');
  store.cache.set('statuses.json', []); store.cache.set('scheduled.json', []);
  assert.equal(nextToPublish(store), null, 'nothing waiting');
});

test('an edited post is held to the size a new post is', () => {
  const store = new PodStore({ log: () => {} });
  store.cache.set('statuses.json', [{ kind: 'post', noteId: 'n1', content: 'hi' }]);
  const huge = 'x'.repeat(5_000_000);
  const row = store.updateStatus('n1', { content: huge });
  assert.ok(row.content.length <= 100_001 && row.truncated === true);
});

test("followers' servers are sent side by side, a few at a time", async () => {
  const d = new Deliverer({ store: new PodStore({ log: () => {} }), keyId: 'k', rsaPrivate: null, passive: true, parallel: 3, log: () => {} });
  let now = 0; let most = 0;
  d.deliverNow = async () => { now++; most = Math.max(most, now); await new Promise((r) => setTimeout(r, 20)); now--; };
  const out = await d.deliverManyNow(Array.from({ length: 3 }, (_, i) => ({ inbox: `https://h${i}.example/inbox`, activity: {} })));
  assert.equal(most, 3); assert.ok(out.every((r) => r.ok));
  assert.equal(d.batchSize, 3, 'and a fan-out hands it that many at a time');
});

test('inside the pod server the inbox backstop is hourly; with a socket it stays at ten minutes', () => {
  const intake = Object.create(Intake.prototype);
  intake.pollSeconds = null;
  intake.wsState = 'in-process';
  assert.equal(intake._pollMs(), 60 * 60_000);
  intake.wsState = 'open';
  assert.equal(intake._pollMs(), 10 * 60_000);
  intake.pollSeconds = 600; intake.wsState = 'in-process';
  assert.equal(intake._pollMs(), 600_000, 'a configured interval still wins');
});

test('every account sweeping a hashtag shares one fetch of it', async () => {
  let loads = 0;
  const load = async () => { loads++; return { status: 200, list: [] }; };
  const key = `https://instance.example|tag-${Date.now()}`;
  await Promise.all([timelineOnce(key, load), timelineOnce(key, load), timelineOnce(key, load)]);
  await timelineOnce(key, load);
  assert.equal(loads, 1);
});
