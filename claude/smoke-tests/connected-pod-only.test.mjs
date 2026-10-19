// connected-pod-only.test.mjs — the login of an account connected on another
// server stays on the owner's pod: never in the gateway's working copy, and
// one put there before is handed to the pod and leaves the copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const { memoryKv, kvDocFetch, CopyStorage, fillCopy, flushCopy, copyMeta, podOnly } = await import('../../lib/gateway/copy.mjs');
const { FileStorage, StateApiStorage } = await import('../../lib/core/storage.mjs');

const stateUrl = 'https://pod.example/fedipod/ap-state/';
const LOGINS = { 'me@mastodon.example': { id: 'me@mastodon.example', host: 'mastodon.example', token: 'full-access', storage: 'pod' } };

function podDir(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connected-pod-only-'));
  for (const [name, doc] of Object.entries(docs)) fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  return { dir, pod: new FileStorage(dir), read: (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) };
}
// The copy's record of what it last wrote to the pod, as copy.mjs keeps it.
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('base64url').slice(0, 22);
async function leftInCopy(kv, name, text, { podHad = text } = {}) {
  const set = await kv.set(`mei/d/${name}`, text);
  const flushed = JSON.parse((await kv.get('mei/flushed'))?.text || '{}');
  if (podHad !== null) flushed[name] = { etag: set.etag, hash: hashOf(podHad) };
  await kv.set('mei/flushed', JSON.stringify(flushed));
}
const filled = async (docs) => {
  const p = podDir({ 'config.json': { handle: 'mei' }, 'lease.json': { holder: 'x', expiresAt: 0 }, ...docs });
  const kv = memoryKv();
  const podKv = memoryKv();
  await podKv.set('lease', JSON.stringify({ holder: 'x', expiresAt: 0 }));
  const made = await fillCopy(kv, 'mei', { pod: p.pod, podFetch: kvDocFetch(podKv, 'lease'), stateUrl });
  assert.ok(made.ok, `copy made: ${made.why || ''}`);
  return { ...p, kv };
};

test('the two documents holding connected-account logins are pod-only', () => {
  assert.ok(podOnly('fediaccts.json') && podOnly('atproto.json'));
  assert.ok(!podOnly('statuses.json'));
});

test('a copy made from the pod holds no connected-account login', async () => {
  const { kv } = await filled({ 'fediaccts.json': LOGINS, 'atproto.json': { did: 'did:plc:x', refreshJwt: 'r1' }, 'statuses.json': [] });
  assert.equal(await kv.get('mei/d/fediaccts.json'), null);
  assert.equal(await kv.get('mei/d/atproto.json'), null);
  assert.ok(await kv.get('mei/d/statuses.json'));
  assert.deepEqual((await copyMeta(kv, 'mei')).podOnly.sort(), ['atproto.json', 'fediaccts.json', 'lease.json']);
});

test('the gateway reads and writes them on the pod, not in the copy', async () => {
  const { kv, pod, read } = await filled({ 'fediaccts.json': LOGINS });
  const copy = new CopyStorage(kv, 'mei', { pod, holder: 'browser', fence: null });
  const got = await copy.read('fediaccts.json');
  assert.equal(JSON.parse(got.body)['me@mastodon.example'].token, 'full-access');
  await copy.write('atproto.json', JSON.stringify({ did: 'did:plc:y' }));
  assert.equal(await kv.get('mei/d/atproto.json'), null);
  assert.equal(read('atproto.json').did, 'did:plc:y');
});

test('the browser working from a copy sends them to the pod, never to the gateway', async () => {
  const toGateway = [];
  const fetchImpl = async (u) => { toGateway.push(String(u)); return new Response('{}', { status: 200 }); };
  const p = podDir({});
  const s = new StateApiStorage('https://gateway.example/api/state/mei/', { fetchImpl, token: 't', holder: 'browser', pod: p.pod });
  await s.write('fediaccts.json', JSON.stringify(LOGINS), 'application/json');
  await s.read('atproto.json');
  assert.deepEqual(toGateway, []);
  assert.equal(p.read('fediaccts.json')['me@mastodon.example'].token, 'full-access');
});

// A copy made before these were pod-only holds them, with its record of what
// the pod had when it last wrote them.
test('a login renewed in an older copy goes to the pod, then leaves the copy', async () => {
  const before = JSON.stringify(LOGINS);
  const { kv, pod, read } = await filled({ 'fediaccts.json': LOGINS });
  const renewed = JSON.stringify({ 'me@mastodon.example': { ...LOGINS['me@mastodon.example'], token: 'renewed' } });
  await leftInCopy(kv, 'fediaccts.json', renewed, { podHad: before });
  await flushCopy(kv, 'mei', { pod });
  assert.equal(read('fediaccts.json')['me@mastodon.example'].token, 'renewed');
  assert.equal(await kv.get('mei/d/fediaccts.json'), null);
  assert.equal(JSON.parse((await kv.get('mei/flushed')).text)['fediaccts.json'], undefined);
  await flushCopy(kv, 'mei', { pod });
  assert.equal(read('fediaccts.json')['me@mastodon.example'].token, 'renewed', 'and a later write-back leaves the pod\'s alone');
});

test('a login the pod has changed since is not written over by the one left in the copy', async () => {
  const old = JSON.stringify({ did: 'did:plc:x', refreshJwt: 'old' });
  const { kv, pod, read, dir } = await filled({ 'atproto.json': JSON.parse(old) });
  await leftInCopy(kv, 'atproto.json', old);
  fs.writeFileSync(path.join(dir, 'atproto.json'), JSON.stringify({ did: 'did:plc:x', refreshJwt: 'newer-on-the-pod' }));
  await flushCopy(kv, 'mei', { pod });
  assert.equal(read('atproto.json').refreshJwt, 'newer-on-the-pod');
  assert.equal(await kv.get('mei/d/atproto.json'), null);
});

test('a login the pod made after the copy was is not written over either', async () => {
  const { kv, pod, read, dir } = await filled({});
  await leftInCopy(kv, 'atproto.json', JSON.stringify({ did: 'did:plc:x', refreshJwt: 'in-the-copy' }), { podHad: null });
  fs.writeFileSync(path.join(dir, 'atproto.json'), JSON.stringify({ did: 'did:plc:x', refreshJwt: 'made-on-the-pod' }));
  await flushCopy(kv, 'mei', { pod });
  assert.equal(read('atproto.json').refreshJwt, 'made-on-the-pod');
  assert.equal(await kv.get('mei/d/atproto.json'), null);
});

test('a login only the older copy holds reaches the pod', async () => {
  const { kv, pod, read } = await filled({});
  await leftInCopy(kv, 'fediaccts.json', JSON.stringify(LOGINS), { podHad: null });
  await flushCopy(kv, 'mei', { pod });
  assert.equal(read('fediaccts.json')['me@mastodon.example'].token, 'full-access');
  assert.equal(await kv.get('mei/d/fediaccts.json'), null);
});
