// check-letter.test.mjs — the gateway's test letter: one every six hours to
// the admin's own account, answered by its FediPod, and its owner told when
// FediPod has been open an hour without taking it in.
import test from 'node:test';
import assert from 'node:assert/strict';
const { roundChecks, answerLetter, missingLetter, routeCheckActor, checkActor, LETTER_EVERY_MS } = await import('../../lib/gateway/check-letter.mjs');
const { memoryKv } = await import('../../lib/gateway/copy.mjs');

const ORIGIN = 'https://gateway.example';
const ADMIN = 'https://pod.example/profile/card#me';
const HOUR = 3600_000;
const rows = {
  owner: { openedAt: '2026-10-01T00:00:00Z', webId: ADMIN, actorUrl: `${ORIGIN}/u/owner/ap/actor`, podHome: 'https://pod.example/fedipod/' },
  stranger: { openedAt: '2026-10-01T00:00:00Z', webId: 'https://other.example/profile/card#me', actorUrl: `${ORIGIN}/u/stranger/ap/actor` },
  device: { webId: ADMIN, actorUrl: `${ORIGIN}/u/device/ap/actor` },
};

function rig() {
  const kv = memoryKv();
  const present = new Map();
  const sent = [];
  const alerts = [];
  const ctx = { frontOrigin: ORIGIN, adminWebId: ADMIN, mastoKv: kv,
    listDirectory: async () => rows, presentAt: async (h) => present.get(h) || 0 };
  const round = (now) => roundChecks(ctx, { now, log: () => {},
    send: async (h, rec, doc) => { sent.push({ h, doc }); return 202; },
    alert: async (h, text) => { alerts.push({ h, text }); } });
  return { kv, present, sent, alerts, ctx, round };
}

test('a letter goes to the admin\'s own browser account only, as a direct note from the gateway', async () => {
  const r = rig();
  await r.round(1000);
  assert.deepEqual(r.sent.map((s) => s.h), ['owner']);
  const { doc } = r.sent[0];
  assert.equal(doc.type, 'Create');
  assert.equal(doc.actor, checkActor(ORIGIN));
  assert.deepEqual(doc.to, [rows.owner.actorUrl]);
  assert.match(doc.id, /^https:\/\/gateway\.example\/check\/letters\/[0-9a-f]{24}$/u);
});

test('an answered letter is followed by the next one six hours after it, not before', async () => {
  const r = rig();
  await r.round(0);
  assert.equal(await answerLetter(r.kv, 'owner', r.sent[0].doc.id, { now: 60_000 }), true);
  await r.round(LETTER_EVERY_MS - 1);
  assert.equal(r.sent.length, 1);
  await r.round(LETTER_EVERY_MS);
  assert.equal(r.sent.length, 2);
  assert.notEqual(r.sent[1].doc.id, r.sent[0].doc.id);
  assert.equal(r.alerts.length, 0);
});

test('only the letter waiting is answered', async () => {
  const r = rig();
  await r.round(0);
  assert.equal(await answerLetter(r.kv, 'owner', `${ORIGIN}/check/letters/${'0'.repeat(24)}`), false);
  assert.equal(await answerLetter(r.kv, 'owner', 'not a letter'), false);
  assert.equal(await answerLetter(r.kv, 'stranger', r.sent[0].doc.id), false);
});

test('a letter unanswered while FediPod is closed raises nothing, however long', async () => {
  const r = rig();
  await r.round(0);
  for (let t = HOUR; t <= 20 * HOUR; t += HOUR / 4) await r.round(t);
  assert.equal(r.alerts.length, 0);
  assert.equal(r.sent.length, 1, 'and no second letter goes while one waits');
});

test('unanswered after an hour with FediPod open, the owner is told once', async () => {
  const r = rig();
  await r.round(0);
  // FediPod opens at 5 h and stays open, saying so every five minutes.
  const opened = 5 * HOUR;
  let t = opened;
  for (; t < opened + HOUR; t += HOUR / 4) { r.present.set('owner', t); await r.round(t); }
  assert.equal(r.alerts.length, 0, 'not within the first hour open');
  r.present.set('owner', t); await r.round(t);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].h, 'owner');
  assert.match(r.alerts[0].text, /test letter has not reached your FediPod/u);
  assert.ok(await missingLetter(r.kv, 'owner'), 'and FediPod hears it is missing');
  r.present.set('owner', t + HOUR); await r.round(t + HOUR);
  assert.equal(r.alerts.length, 1, 'once');
});

test('FediPod closing in the hour starts the hour again', async () => {
  const r = rig();
  await r.round(0);
  r.present.set('owner', HOUR); await r.round(HOUR);
  r.present.set('owner', HOUR + 40 * 60_000); await r.round(HOUR + 45 * 60_000);
  await r.round(HOUR + 75 * 60_000);                         // closed: its last word was 35 minutes ago
  r.present.set('owner', HOUR + 90 * 60_000); await r.round(HOUR + 90 * 60_000);
  assert.equal(r.alerts.length, 0);
  r.present.set('owner', HOUR + 150 * 60_000); await r.round(HOUR + 150 * 60_000);
  assert.equal(r.alerts.length, 1);
});

test('the letter\'s sender is an application the door can look up', () => {
  const j = (status, obj, ct = 'application/json') => ({ status, headers: { 'content-type': ct }, body: JSON.stringify(obj) });
  const got = routeCheckActor(new Request(`${ORIGIN}/check/actor`), '/check/actor', { frontOrigin: ORIGIN, host: 'gateway.example' }, { j });
  const doc = JSON.parse(got.body);
  assert.equal(got.headers['content-type'], 'application/activity+json');
  assert.equal(doc.id, checkActor(ORIGIN));
  assert.equal(doc.type, 'Application');
  assert.equal(routeCheckActor(new Request(`${ORIGIN}/check/inbox`, { method: 'POST', body: '{}' }), '/check/inbox', {}, { j }).status, 202);
  assert.equal(routeCheckActor(new Request(`${ORIGIN}/elsewhere`), '/elsewhere', {}, { j }), null);
});
