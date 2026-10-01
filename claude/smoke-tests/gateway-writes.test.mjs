// gateway-writes.test.mjs — FediPod applying what fedipod.net handed the pod
// through the inbox (lib/core/intake/gateway-writes.mjs): only with
// fedipod.net's stamp for this account, only inside the account, and each
// document change only once.
// Run from the project root: node --test claude/smoke-tests/gateway-writes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { applyGatewayWrites, isGatewayWrites, gatewayWritesName } from '../../lib/core/intake/gateway-writes.mjs';
import { signReceipt } from '../../lib/gateway/httpsig.mjs';
import { deltaOf } from '../../lib/core/doc-delta.mjs';
import { PodStore } from '../../lib/core/store.mjs';

const POD = 'https://nia.pod.example/';
const HOME = POD + 'fedipod/';
const ACTOR = 'https://gw.example/u/nia/ap/actor';
const SECRET = 'door-secret-for-the-test';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function intakeFor() {
  const pod = new Map();
  const asked = [];
  const remote = { fetch: async (url, init = {}) => {
    asked.push([init.method || 'GET', url]);
    if (init.method === 'DELETE') return new Response(null, { status: pod.delete(url) ? 205 : 404 });
    pod.set(url, typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('base64'));
    return new Response(null, { status: 201 });
  } };
  const store = new PodStore({ log: () => {} });
  store.write('notifications.json', [{ id: 'old', type: 'favourite' }]);
  return { pod, asked, intake: { urls: { home: HOME, base: POD, actor: ACTOR }, remote, store, log: () => {} } };
}
function itemOf(seq, { writes = [], deltas = null } = {}, secret = SECRET) {
  const raw = JSON.stringify({ type: 'fedipod:GatewayWrites', seq, at: new Date().toISOString(), writes, ...(deltas ? { deltas } : {}) });
  const receipt = signReceipt({ v: 1, verified: true, method: 'gateway-writes', actor: ACTOR, seq, hash: sha(raw) }, secret);
  return { raw, receipt };
}

test('an item is named so that sorting by name applies them in order', () => {
  const a = gatewayWritesName(9, 'ab'.repeat(16));
  const b = gatewayWritesName(10, 'cd'.repeat(16));
  assert.ok(isGatewayWrites(HOME + 'ap/inbox/' + a) && a < b);
  assert.ok(!isGatewayWrites(HOME + 'ap/inbox/' + 'batch-1.json'));
});

test('fedipod.net\'s writes are made on the pod, in order, pictures included', async () => {
  const { pod, intake } = intakeFor();
  const { raw, receipt } = itemOf(1, { writes: [
    { method: 'PUT', url: HOME + 'ap/notes/n1', contentType: 'application/activity+json', text: '{"type":"Note"}' },
    { method: 'PUT', url: HOME + 'ap/media/p.png', contentType: 'image/png', base64: Buffer.from([1, 2]).toString('base64') },
  ] });
  assert.equal(await applyGatewayWrites(intake, 'u', raw, receipt), null);
  assert.equal(pod.get(HOME + 'ap/notes/n1'), '{"type":"Note"}');
  assert.equal(pod.get(HOME + 'ap/media/p.png'), Buffer.from([1, 2]).toString('base64'));
});

test('nothing is written outside the account', async () => {
  const { pod, intake } = intakeFor();
  const { raw, receipt } = itemOf(1, { writes: [
    { method: 'PUT', url: POD + 'profile/card', text: 'x' },
    { method: 'PUT', url: HOME + '../elsewhere', text: 'x' },
    { method: 'PUT', url: 'https://other.example/x', text: 'x' },
  ] });
  assert.equal(await applyGatewayWrites(intake, 'u', raw, receipt), null);
  assert.equal(pod.size, 0);
});

test('an item without fedipod.net\'s stamp, or for another account, is refused', async () => {
  const { pod, intake } = intakeFor();
  const forged = itemOf(1, { writes: [{ method: 'PUT', url: HOME + 'ap/notes/x', text: 'x' }] }, 'not-the-secret');
  // readReceipt returns null for a stamp that does not verify; the drain hands that in.
  assert.match(await applyGatewayWrites(intake, 'u', forged.raw, null), /without fedipod.net's stamp/);
  const other = itemOf(1, {});
  assert.match(await applyGatewayWrites(intake, 'u', other.raw, { ...other.receipt, actor: 'https://gw.example/u/someone/ap/actor' }), /without/);
  const swapped = itemOf(2, { writes: [{ method: 'PUT', url: HOME + 'ap/notes/y', text: 'y' }] });
  assert.match(await applyGatewayWrites(intake, 'u', swapped.raw, itemOf(2, {}).receipt), /different item/);
  assert.equal(pod.size, 0);
});

test('document changes are applied once, and not to what the agent works from at the gateway', async () => {
  const { intake } = intakeFor();
  const deltas = { 'notifications.json': deltaOf(null, [{ id: 'n1', type: 'follow' }]), 'contacts.json': deltaOf(null, { followers: [] }) };
  const one = itemOf(1, { deltas });
  intake.inCopy = (name) => name === 'contacts.json';
  assert.equal(await applyGatewayWrites(intake, 'u', one.raw, one.receipt), null);
  assert.deepEqual(intake.store.read('notifications.json').map((n) => n.id), ['n1', 'old']);
  assert.equal(intake.store.read('contacts.json', 'absent'), 'absent', 'the copy has it already');
  assert.equal(intake.store.read('replica.json').seq, 1);
  intake.store.write('notifications.json', [{ id: 'old', type: 'favourite' }]);
  assert.equal(await applyGatewayWrites(intake, 'u', one.raw, one.receipt), null);
  assert.deepEqual(intake.store.read('notifications.json').map((n) => n.id), ['old'], 'the same item a second time changes nothing');
});
