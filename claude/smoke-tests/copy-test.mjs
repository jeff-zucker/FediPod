// copy-test.mjs — the account's working copy at the gateway (lib/gateway/copy.mjs):
// made from the pod, worked on by whoever holds its lease, written back.
// Run from the project root: node claude/smoke-tests/copy-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryKv, kvDocFetch, CopyStorage, copyLease, holds, lockCopy, fillCopy, flushCopy, dropCopy, copyMeta, podOnly, GATEWAY_HOLDER,
  renewPodLease, safeName } from '../../lib/gateway/copy.mjs';
import { FileStorage } from '../../lib/core/storage.mjs';
import { PodStore } from '../../lib/core/store.mjs';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-test-'));
const pod = new FileStorage(dir);
const write = (name, obj) => fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2) + '\n');
write('config.json', { handle: 'mei', root: 'fedipod/' });
write('statuses.json', [{ noteId: 'n1' }]);
write('keys.json', { rsa: { privatePem: 'secret' } });
write('conn-bsky.json', { password: 'app-password' });
write('lease.json', { holder: 'old-browser', expiresAt: 0 });

const kv = memoryKv();
const podKv = memoryKv();                     // the pod's lease document, as the pod would answer it
const podFetch = kvDocFetch(podKv, 'lease');
await podKv.set('lease', JSON.stringify({ holder: 'old-browser', expiresAt: 0 }));
const stateUrl = 'https://pod.example/fedipod/ap-state/';
const H = 'mei';

try {
  // ---- made from the pod ----
  check(podOnly('keys.json') && podOnly('lease.json') && podOnly('conn-bsky.json') && !podOnly('statuses.json'),
    'the key, the pod lease and connected-account passwords stay on the pod');
  const busyKv = memoryKv();
  const busyPod = memoryKv();
  await busyPod.set('lease', JSON.stringify({ holder: 'a-browser', expiresAt: Date.now() + 600_000 }));
  const busy = await fillCopy(busyKv, H, { pod, podFetch: kvDocFetch(busyPod, 'lease'), stateUrl });
  check(!busy.ok && /active on another device/.test(busy.why) && !(await copyMeta(busyKv, H)),
    'no copy is made while a device is acting on the pod directly');
  const podRefused = await fillCopy(memoryKv(), H, { pod, podFetch: async () => new Response('', { status: 403 }), stateUrl });
  check(!podRefused.ok && /could not be read \(HTTP 403\)/.test(podRefused.why) && !/another device/.test(podRefused.why),
    'a pod that refuses the gateway is named as the reason, not another device');
  const noToken = await fillCopy(memoryKv(), H, { pod, podFetch: async () => { throw new Error('token request failed (HTTP 401)'); }, stateUrl });
  check(!noToken.ok && /could not be read \(token request failed \(HTTP 401\)\)/.test(noToken.why),
    'and so is the gateway\'s own sign-in failing');
  const filled = await fillCopy(kv, H, { pod, podFetch, stateUrl, webId: 'https://pod.example/profile/card#me' });
  check(filled.ok && (await kv.get('mei/d/statuses.json')) && !(await kv.get('mei/d/keys.json')) && !(await kv.get('mei/d/conn-bsky.json')),
    'the copy holds the state documents, and not the key or the passwords');
  const podLease = JSON.parse((await podKv.get('lease')).text);
  check(podLease.holder === 'gateway-copy' && podLease.expiresAt > Date.now() + 23 * 3600_000 && podLease.expiresAt < Date.now() + 25 * 3600_000,
    'the pod lease is held a day at a time while the copy lives');
  check(!(await renewPodLease(kv, H, { podFetch })), 'and is not renewed while it has hours left');
  const meta0 = JSON.parse((await kv.get('mei/meta')).text);
  await kv.set('mei/meta', JSON.stringify({ ...meta0, podLeaseUntil: Date.now() + 3600_000 }));
  check(await renewPodLease(kv, H, { podFetch }) && JSON.parse((await podKv.get('lease')).text).expiresAt > Date.now() + 23 * 3600_000,
    'the round holds it another day when it is running out');

  // ---- names that are not plain are refused everywhere ----
  const sneaky = new CopyStorage(kv, H, { holder: GATEWAY_HOLDER, pod });
  check(!safeName('../../site:masto/token/x.json') && !safeName('a/b.json') && !safeName('..json') && safeName('statuses.json'),
    'a document name with a path in it is not a state document');
  check((await sneaky.write('..%2F..%2Fx.json'.replace(/%2F/g, '/'), '{}')).ok === false && (await sneaky.read('../meta')).ok === false,
    'and the copy neither writes nor reads one');
  let threw = false; try { new CopyStorage(kv, '../other', { holder: 'x' }); } catch { threw = true; }
  check(threw, 'nor works for an account key with a path in it');

  // ---- a copy half made is taken away again ----
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-broken-'));
  fs.writeFileSync(path.join(brokenDir, 'config.json'), '{}');
  const brokenPod = { list: async () => ({ names: ['config.json', 'statuses.json'], etag: null }),
    read: async (n) => (n === 'config.json' ? { ok: true, body: '{}', etag: '"1"' } : { ok: false, status: 500 }) };
  const brokenKv = memoryKv(); const brokenLease = memoryKv();
  await brokenKv.set('zed/d/orphan.json', '{}');           // what an interrupted give-up could leave
  const half = await fillCopy(brokenKv, 'zed', { pod: brokenPod, podFetch: kvDocFetch(brokenLease, 'lease'), stateUrl });
  check(!half.ok && !(await brokenKv.list('zed/')).length && JSON.parse((await brokenLease.get('lease')).text).expiresAt === 0,
    `a copy that could not be made is taken away and the pod's lease given back (${half.why})`);
  fs.rmSync(brokenDir, { recursive: true, force: true });
  check((await fillCopy(kv, H, { pod, podFetch, stateUrl })).already, 'making it again changes nothing');

  // ---- worked on through a PodStore ----
  let refused = 0;
  const browser = new CopyStorage(kv, H, { holder: 'browser-1', pod, onRefused: () => { refused++; } });
  const store = new PodStore({ storage: browser, log: () => {} });
  await store.load();
  check(store.getConfig()?.handle === 'mei' && store.read('keys.json', null)?.rsa?.privatePem === 'secret',
    'a store over the copy reads the state from the copy and the key from the pod');
  const lease = copyLease(kv, H, { id: 'browser-1' });
  check(await lease.acquire(), 'the browser takes the copy\'s lease');
  store.addStatus({ noteId: 'n2', kind: 'post', published: new Date().toISOString() });
  check(await store.commit() && JSON.parse((await kv.get('mei/d/statuses.json')).text).some((s) => s.noteId === 'n2'),
    'the lease holder\'s writes land in the copy');
  check(!fs.readFileSync(path.join(dir, 'statuses.json'), 'utf8').includes('n2'), 'and not yet on the pod');
  const listing1 = await browser.list('');
  check((await browser.list('', { etag: listing1.etag })).notModified, 'an unchanged copy answers "not modified"');

  // ---- the gateway acts: the browser is refused ----
  const gwLease = copyLease(kv, H, { id: GATEWAY_HOLDER });
  check(await gwLease.takeover(), 'the gateway takes the lease when an app acts');
  check(await holds(kv, H, GATEWAY_HOLDER) && !(await holds(kv, H, 'browser-1')), 'and holds it now');
  store.write('lists.json', [{ id: 'l1' }]);
  const landed = await store.commit();
  check(!landed && refused === 1 && !(await kv.get('mei/d/lists.json')),
    'a write from the browser that lost the lease is refused, and it is told');
  const gw = new PodStore({ storage: new CopyStorage(kv, H, { holder: GATEWAY_HOLDER, pod }), log: () => {} });
  await gw.load();
  gw.addStatus({ noteId: 'n3', kind: 'post', published: new Date().toISOString() });
  check(await gw.commit() && gw.getStatuses().some((s) => s.noteId === 'n2'), 'the gateway writes, over what the browser wrote');
  check((await browser.list('', { etag: listing1.etag })).notModified === false, 'and a reader sees the copy changed');

  // ---- the gateway's identity changes ----
  const { keptNow, keptBefore } = await import('../../lib/gateway/copy.mjs');
  const gwCtx = { keeperWebId: 'https://keeper-one.example/#me' };
  const row = { keeper: { webId: 'https://keeper-one.example/#me' } };
  check(keptNow(gwCtx, row) && !keptBefore(gwCtx, row), 'an account kept under the gateway\'s identity is kept now');
  gwCtx.keeperWebId = 'https://keeper-two.example/#me';
  check(!keptNow(gwCtx, row) && keptBefore(gwCtx, row), 'and, once the identity changes, kept under a former one until its owner moves it');

  // ---- writes dropped after another agent acted are not a save ----
  const sweep = new PodStore({ storage: new CopyStorage(kv, H, { holder: GATEWAY_HOLDER, pod }), log: () => {} });
  await sweep.load();
  const began = sweep.generation;                         // a drain in the middle of its sweep
  sweep.hold();
  sweep.write('muted.json', { actors: ['https://x.example/u/1'] });
  const dropping = sweep.discardPending();
  sweep.release();
  const racing = sweep.commit({ since: began });           // its commit, already under way as the drop begins
  await dropping;
  check(await racing === false, 'a sweep whose results were dropped is told they were not written, so it deletes nothing');
  const after = sweep.generation;
  sweep.write('muted.json', { actors: [] });
  check(await sweep.commit({ since: after }) === true, 'while work begun after the drop saves as usual');

  // ---- the gateway's writers take turns ----
  const release = await lockCopy(kv, H);
  const second = await lockCopy(kv, H, { waitMs: 300 });
  check(!!release && second === null, 'a second writer at the gateway waits for the first');
  await release();
  const third = await lockCopy(kv, H, { waitMs: 300 });
  check(!!third, 'and gets its turn once the first is done');
  await third();
  const held = await lockCopy(kv, H, { ms: 1200 });
  await new Promise((r) => setTimeout(r, 1800));
  check(!(await lockCopy(kv, H, { waitMs: 200 })), 'a lock is kept while its holder runs, past its first time');
  await held();
  await kv.set('mei/lock', JSON.stringify({ by: 'dead', until: Date.now() - 1 }));
  const afterDeath = await lockCopy(kv, H, { waitMs: 300 });
  check(!!afterDeath, 'a lock whose holder died is taken over once its time is up');
  await afterDeath();

  // ---- written back ----
  const n = await flushCopy(kv, H, { pod, log: () => {} });
  const onPod = JSON.parse(fs.readFileSync(path.join(dir, 'statuses.json'), 'utf8'));
  check(n >= 1 && onPod.some((s) => s.noteId === 'n3'), `what changed is written to the pod (${n} document(s))`);
  check((await flushCopy(kv, H, { pod })) === 0, 'and nothing is written twice');
  const same = (await kv.get('mei/d/statuses.json')).text;
  await new CopyStorage(kv, H, { holder: GATEWAY_HOLDER, pod }).write('statuses.json', same);
  const podBefore = fs.statSync(path.join(dir, 'statuses.json')).mtimeMs;
  check((await flushCopy(kv, H, { pod })) === 0 && fs.statSync(path.join(dir, 'statuses.json')).mtimeMs === podBefore,
    'a document written again with the same content is not sent again');
  const gwDel = new CopyStorage(kv, H, { holder: GATEWAY_HOLDER, pod });
  await gwDel.write('muted.json', '{"actors":[]}\n');
  await flushCopy(kv, H, { pod });
  await gwDel.remove('muted.json');
  await flushCopy(kv, H, { pod });
  check(!fs.existsSync(path.join(dir, 'muted.json')), 'a document removed from the copy is removed from the pod');

  // ---- given up ----
  await gw.hold?.();
  gw.addStatus({ noteId: 'n4', kind: 'post', published: new Date().toISOString() });
  gw.release?.();
  await gw.commit();
  const dropped = await dropCopy(kv, H, { pod, podFetch, stateUrl });
  check(dropped.ok && JSON.parse(fs.readFileSync(path.join(dir, 'statuses.json'), 'utf8')).some((s) => s.noteId === 'n4'),
    'giving the copy up writes everything to the pod first');
  check(!(await kv.list('mei/')).length && JSON.parse((await podKv.get('lease')).text).expiresAt === 0,
    'then frees the pod lease and deletes the copy');
  check(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8').includes('secret'), 'the key never left the pod');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }

fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
