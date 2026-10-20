// gone-through-relay.test.mjs — a deleted account's "gone" is read as gone,
// whether the deliverer hands the origin's answer back (the Node agent) or
// throws it (FediPod in the browser, through fedipod.net's relay).
import test from 'node:test';
import assert from 'node:assert/strict';
const { isGone } = await import('../../lib/core/intake/verify.mjs');

const through = (signedFetch) => ({ deliverer: { signedFetch } });
const refused = (status, { answered = true } = {}) => async () => {
  const err = new Error(`GET → ${status}`); err.status = status; if (answered) err.answered = true; throw err;
};

test('gone at the origin, through the browser\'s relay, is gone', async () => {
  assert.equal(await isGone(through(refused(410)), 'https://m.example/users/left'), true);
  assert.equal(await isGone(through(refused(404)), 'https://m.example/users/left'), true);
});

test('a refusal from the origin is no answer, not gone', async () => {
  assert.equal(await isGone(through(refused(403)), 'https://m.example/users/locked'), null);
  assert.equal(await isGone(through(refused(500)), 'https://m.example/users/busy'), null);
});

test('the relay itself not knowing the account is no answer about the origin', async () => {
  assert.equal(await isGone(through(refused(404, { answered: false })), 'https://m.example/users/x'), null);
  assert.equal(await isGone(through(async () => { throw new Error('relay unreachable'); }), 'https://m.example/users/x'), null);
});

test('the Node agent\'s answer, handed back, reads the same', async () => {
  assert.equal(await isGone(through(async () => new Response('', { status: 410 })), 'https://m.example/users/left'), true);
  const tomb = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: 'https://m.example/users/left', type: 'Tombstone' });
  assert.equal(await isGone(through(async () => new Response(tomb, { status: 200, headers: { 'content-type': 'application/activity+json' } })), 'https://m.example/users/left'), true);
});
