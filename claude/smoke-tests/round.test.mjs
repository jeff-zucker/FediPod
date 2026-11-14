// round.test.mjs — two things the Gateway holds to. Every person's account has
// a day its owner was last here, so its mail is held and it pauses and closes
// like any other. And the fifteen-minute round finishes: work that is due
// starts first, an account's mail goes one batch a round, a pod has ten
// seconds to take a batch, and no account is always the one left out. Only
// one round runs at a time, and a pod that refused an account's copy can be
// left alone for a while.
//   node --test claude/smoke-tests/round.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withOpened, FIRST_OPENED, closedState } from '../../lib/gateway/quiet.mjs';
import { flushAll, flushHeld, holdsMail, mayBeAway, BATCH_MAX, ROUND_POD_MS } from '../../lib/gateway/held-mail.mjs';
import { appendWithToken } from '../../lib/pod/inbox.mjs';
import { memoryKv, lockKey, refusedAt, afterTry, copyMeta, COPY_RETRY_MS } from '../../lib/gateway/copy.mjs';

const POD = 'https://pod.example/';
const person = (h, more = {}) => ({ handle: h, kind: 'person', podHome: `${POD}${h}/fedipod/`, actorUrl: `${POD}${h}/fedipod/ap/actor`, ...more });

// ---- every person's account has a day its owner was last here ---------------

test('an account with no date counts from the day sign-ins began to be recorded; one with the day it was attached, from that day', () => {
  assert.equal(FIRST_OPENED, '2026-09-23T00:00:00.000Z');
  assert.equal(withOpened(person('heron')).openedAt, FIRST_OPENED, 'neither date: 23 September 2026');
  assert.equal(withOpened(person('siskin', { attachedAt: '2026-10-02T08:00:00.000Z' })).openedAt, '2026-10-02T08:00:00.000Z', 'attached since: that day');
  const opened = person('wren', { openedAt: '2026-11-01T09:00:00.000Z', attachedAt: '2026-10-02T08:00:00.000Z' });
  assert.equal(withOpened(opened), opened, 'an account that has its own date keeps it, untouched');
  assert.equal(withOpened({ handle: 'heron' }).openedAt, FIRST_OPENED, 'a row that names no kind is a person\'s');
});

test('a forum, a group and a forum\'s category are nobody\'s to open, and get no date', () => {
  for (const row of [{ handle: 'forum', kind: 'application' }, { handle: 'allotment', kind: 'group' },
    { handle: 'gardening', kind: 'group', forum: 'forum' }, { handle: 'odd', kind: 'person', forum: 'forum' }]) {
    assert.equal(withOpened(row), row, `${row.handle} is left as it is`);
    assert.equal('openedAt' in withOpened(row), false);
  }
  assert.equal(withOpened(null), null);
});

test('with its date, an old account\'s mail is held, and it closes when the window has passed', async () => {
  const ctx = { holdMail: async () => {}, hold: true };
  const bare = person('heron');
  assert.equal(holdsMail(ctx, bare), false, 'as the row is stored, nothing would be held');
  assert.equal(holdsMail(ctx, withOpened(bare)), true, 'with its date, its mail is held');
  assert.equal(mayBeAway(ctx, withOpened(bare)), true);
  const days = Math.floor((Date.now() - Date.parse(FIRST_OPENED)) / 86400_000);
  assert.equal((await closedState({ closeDays: days + 30 }, 'heron', withOpened(bare))).closed, false, 'inside the window: open');
  const shut = await closedState({ closeDays: Math.max(1, days - 1) }, 'heron', withOpened(bare));
  assert.equal(shut.closed, true, 'past the window: closed');
  assert.equal(shut.closedBy, 'quiet');
});

// ---- the round: held mail -----------------------------------------------------

// Held mail and pods in memory. `refuse` names accounts whose pod says no.
function world(rows, { refuse = [] } = {}) {
  const held = new Map(); const reads = []; const puts = []; const marks = []; const said = [];
  let mark = null;
  const ctx = {
    hold: true,
    holdMail: async (h, name, body) => { held.set(`${h}/${name}`, body); },
    listHeld: async (h, { limit = Infinity } = {}) => [...held.keys()].filter((k) => k.startsWith(`${h}/`)).sort().slice(0, limit).map((k) => k.slice(h.length + 1)),
    readHeld: async (h, name) => { reads.push(`${h}/${name}`); return held.get(`${h}/${name}`) ?? null; },
    dropHeld: async (h, name) => { held.delete(`${h}/${name}`); },
    heldAccounts: async () => [...new Set([...held.keys()].map((k) => k.split('/')[0]))],
    roundMark: async () => mark,
    setRoundMark: async (h) => { mark = h; marks.push(h); },
    lookup: async (h) => rows[h] || null,
    podPut: async (h, url, body, ct, opts) => { puts.push({ h, url, n: JSON.parse(body).batch.length, names: JSON.parse(body).batch.map((e) => e.name), opts });
      return !refuse.includes(h); },
  };
  const fill = async (h, n) => {
    for (let i = 0; i < n; i++) {
      const name = `item-${String(i).padStart(5, '0')}`;
      await ctx.holdMail(h, name, JSON.stringify({ type: 'Create', id: `${POD}${h}/${i}` }));
      await ctx.holdMail(h, `${name}.receipt.json`, JSON.stringify({ v: 1, verified: false }));
    }
  };
  const left = (h) => [...held.keys()].filter((k) => k.startsWith(`${h}/`) && !k.endsWith('.receipt.json')).length;
  return { ctx, held, reads, puts, marks, said, fill, left, log: (m) => said.push(m), setMark: (h) => { mark = h; } };
}

test('the round writes one batch of a hundred for an account, and the rest waits for the next rounds', async () => {
  const w = world({ heron: person('heron') });
  await w.fill('heron', 250);
  await flushAll(w.ctx, { log: w.log });
  assert.equal(BATCH_MAX, 100);
  assert.deepEqual(w.puts.map((p) => p.n), [100], 'one write of a hundred');
  assert.equal(w.left('heron'), 150, 'a hundred and fifty wait');
  assert.ok(w.said.includes('held mail @heron: 100 delivered to the pod'), w.said.join(' | '));
  await flushAll(w.ctx, { log: w.log });
  await flushAll(w.ctx, { log: w.log });
  assert.deepEqual(w.puts.map((p) => p.n), [100, 100, 50], 'two more rounds take the rest');
  assert.equal(w.held.size, 0, 'and nothing is held any more, receipts included');
  assert.equal(new Set(w.puts.flatMap((p) => p.names)).size, 250, 'every item written once');
});

test('a pile of three thousand costs the round one batch, not the whole pile, and the others still get theirs', async () => {
  const w = world({ heron: person('heron'), siskin: person('siskin'), wren: person('wren') });
  await w.fill('heron', 3000); await w.fill('siskin', 4); await w.fill('wren', 7);
  await flushAll(w.ctx, { log: w.log });
  const read = (h) => w.reads.filter((k) => k.startsWith(`${h}/`)).length;
  assert.ok(read('heron') <= 2 * BATCH_MAX, `a hundred items and their receipts are read, not six thousand documents (${read('heron')} read)`);
  assert.deepEqual(w.puts.map((p) => `${p.h}:${p.n}`).sort(), ['heron:100', 'siskin:4', 'wren:7']);
  assert.equal(w.left('heron'), 2900);
  assert.equal(w.left('siskin') + w.left('wren'), 0);
});

test('a pod that refuses keeps its mail for another round, the others are served, and every pod is given ten seconds', async () => {
  const w = world({ heron: person('heron'), siskin: person('siskin'), wren: person('wren') }, { refuse: ['siskin'] });
  await w.fill('heron', 3); await w.fill('siskin', 5); await w.fill('wren', 2);
  await flushAll(w.ctx, { log: w.log });
  assert.equal(w.left('siskin'), 5, 'the refused batch is still held');
  assert.equal(w.left('heron') + w.left('wren'), 0, 'the others reached their pods');
  assert.equal(ROUND_POD_MS, 10_000);
  assert.ok(w.puts.length === 3 && w.puts.every((p) => p.opts?.timeoutMs === 10_000), `each write carries the limit (${JSON.stringify(w.puts.map((p) => p.opts))})`);
});

test('a write to a pod that does not answer in the time given is counted as not landed', async () => {
  let aborted = false;
  // A connection waiting on a pod keeps the process running, and so does this:
  // the limit's own timer does not, on every Node this is tested with.
  const never = (url, init) => new Promise((resolve, reject) => {
    const open = setTimeout(resolve, 5000, new Response(null, { status: 201 }));
    init.signal?.addEventListener('abort', () => { clearTimeout(open); aborted = true; reject(new Error('aborted')); });
  });
  const statuses = [];
  const started = Date.now();
  const ok = await appendWithToken(`${POD}heron/fedipod/ap/inbox/x`, '{}', 'application/json', { fetchImpl: never, timeoutMs: 60, report: (s) => statuses.push(s) });
  assert.equal(ok, false);
  assert.equal(aborted, true, 'the write is given up');
  assert.deepEqual(statuses, [0], 'and reported as no answer');
  assert.ok(Date.now() - started < 2000, 'without waiting on the pod');
  // With no limit asked for, none is set: the door waits as it always has.
  let signal = 'unset';
  await appendWithToken(`${POD}x`, '{}', 'application/json', { fetchImpl: async (u, init) => { signal = init.signal; return new Response(null, { status: 201 }); } });
  assert.equal(signal, undefined);
});

test('each round starts after the account the last one finished with, so a round cut short leaves nobody out twice', async () => {
  const names = ['avocet', 'bittern', 'curlew', 'dunlin', 'egret', 'fulmar', 'godwit', 'heron', 'ibis'];
  const w = world(Object.fromEntries(names.map((n) => [n, person(n)])));
  for (const n of names) await w.fill(n, 1);
  await flushAll(w.ctx, { log: w.log });
  assert.deepEqual(w.puts.map((p) => p.h).sort(), [...names], 'a round that is not cut short serves everyone');
  assert.equal(w.marks.at(-1), 'ibis', 'and notes the last account it finished');
  assert.ok(w.marks.length >= 2 && w.marks.every((m, i) => i === 0 || m > w.marks[i - 1]), `noted as it goes, not only at the end (${w.marks.join(',')})`);
  // The last round got as far as dunlin and was cut off there.
  for (const n of names) await w.fill(n, 1);
  w.puts.length = 0; w.setMark('dunlin');
  await flushAll(w.ctx, { log: w.log });
  const order = w.puts.map((p) => p.h);
  assert.deepEqual(order.slice(0, 4).sort(), ['egret', 'fulmar', 'godwit', 'heron'], `the accounts after dunlin go first (${order.join(',')})`);
  assert.ok(order.indexOf('ibis') < order.indexOf('avocet') && order.indexOf('avocet') > 3, 'then round to the start of the list');
  assert.equal(order.length, names.length);
});

test('mail held for an account that is gone is let go, a batch a round', async () => {
  const w = world({ heron: person('heron') });
  await w.fill('ghost', 250); await w.fill('heron', 2);
  await flushAll(w.ctx, { log: w.log });
  assert.equal(w.left('ghost'), 150, 'a hundred let go this round');
  assert.equal(w.left('heron'), 0);
  assert.ok(w.said.includes('held mail @ghost: let go (no account to deliver to)'), w.said.join(' | '));
  assert.ok(!w.puts.some((p) => p.h === 'ghost'), 'and nothing of it is written anywhere');
});

test('an account the round is told to leave is left; its mail stays held', async () => {
  const w = world({ heron: person('heron'), siskin: person('siskin') });
  await w.fill('heron', 2); await w.fill('siskin', 2);
  await flushAll(w.ctx, { log: w.log, keep: async (h) => h === 'siskin' });
  assert.deepEqual(w.puts.map((p) => p.h), ['heron']);
  assert.equal(w.left('siskin'), 2);
});

test('away from the round, an account\'s held mail is still written whole: every batch, in one go', async () => {
  const w = world({ heron: person('heron') });
  await w.fill('heron', 250);
  const n = await flushHeld(w.ctx, 'heron', person('heron'));
  assert.equal(n, 250);
  assert.deepEqual(w.puts.map((p) => p.n), [100, 100, 50]);
  assert.ok(w.puts.every((p) => !p.opts?.timeoutMs), 'and with no limit on the pod');
  assert.equal(w.held.size, 0);
});

// ---- one round at a time --------------------------------------------------------

test('the round\'s lock: a second taker is told no at once, the next one after it is let go gets it, and a holder that died loses it', async () => {
  const kv = memoryKv();
  const first = await lockKey(kv, '_round/lock', { waitMs: 0 });
  assert.equal(typeof first, 'function', 'the first round holds the lock');
  const started = Date.now();
  assert.equal(await lockKey(kv, '_round/lock', { waitMs: 0 }), null, 'a second is told no');
  assert.ok(Date.now() - started < 1000, 'without waiting for the first');
  await first();
  const next = await lockKey(kv, '_round/lock', { waitMs: 0 });
  assert.equal(typeof next, 'function', 'let go, the lock is there for the next round');
  await next();
  // A round that was cut off never lets go: its lock runs out by itself.
  await kv.set('_round/lock', JSON.stringify({ by: 'a round that was cut off', until: Date.now() - 1 }));
  const after = await lockKey(kv, '_round/lock', { waitMs: 0 });
  assert.equal(typeof after, 'function', 'a lock whose time is up is taken over');
  await after();
});

// ---- a pod that refuses an account's copy ----------------------------------------

test('a pod that refused a copy is left alone for an hour, then tried again; with no wait, it is asked every round', async () => {
  const kv = memoryKv();
  assert.equal(COPY_RETRY_MS, 3_600_000, 'the wait is one hour');
  await afterTry(kv, 'heron', false, { waitMs: 0 });
  assert.equal(await refusedAt(kv, 'heron', { waitMs: 0 }), 0, 'with no wait, a refusal is not noted and the account is tried every round');
  assert.equal(kv.map.size, 0);
  const HOUR = COPY_RETRY_MS; const t0 = Date.parse('2026-11-14T08:00:00Z');
  const w = (now) => ({ now });
  assert.equal(await refusedAt(kv, 'heron', w(t0)), 0, 'an account whose pod has refused nothing is tried');
  await afterTry(kv, 'heron', false, w(t0));
  assert.equal(await refusedAt(kv, 'heron', w(t0 + 15 * 60_000)), t0, 'the next round leaves it alone');
  assert.equal(await refusedAt(kv, 'heron', w(t0 + 59 * 60_000)), t0, 'and the ones after');
  assert.equal(await refusedAt(kv, 'heron', w(t0 + 61 * 60_000)), 0, 'once the wait has passed it is tried again');
  await afterTry(kv, 'heron', false, w(t0 + 61 * 60_000));
  assert.equal(await refusedAt(kv, 'heron', w(t0 + 75 * 60_000)), t0 + 61 * 60_000, 'refused again, the wait starts again');
  await afterTry(kv, 'heron', true, w(t0 + 125 * 60_000));
  assert.equal(kv.map.size, 0, 'a try that worked leaves no note');
  assert.equal(await refusedAt(kv, 'siskin', w(t0)), 0, 'and one account\'s refusal says nothing about another');
});

test('in the round: a copy its pod refuses is tried, then left alone, then tried again, and handed back when the pod takes it', async () => {
  const KEEPER = 'https://keeper.example/profile/card#me';
  const STATE = `${POD}heron/fedipod/ap-state/`;
  const kv = memoryKv();
  await kv.set('_copies/heron', '1');
  await kv.set('heron/meta', JSON.stringify({ stateUrl: STATE }));
  await kv.set('heron/d/statuses.json', '["a post"]');
  await kv.set('heron/d/liked.json', '[]');
  let refuse = true; const asked = [];
  const podFetch = async (input, init = {}) => {
    const url = String(input?.url || input); const method = (init.method || input?.method || 'GET').toUpperCase();
    asked.push(`${method} ${url.slice(STATE.length)}`);
    if (method === 'PUT' && refuse && url.endsWith('statuses.json')) return new Response('no', { status: 500 });
    return new Response(method === 'GET' ? '{}' : null, { status: method === 'GET' ? 404 : 201 });
  };
  const rec = person('heron', { keeper: { webId: KEEPER }, openedAt: new Date().toISOString() });
  const ctx = { hold: true, keeperWebId: KEEPER, frontOrigin: 'https://fedipod.example', copyKv: kv, lookup: async (h) => (h === 'heron' ? rec : null),
    keeperDue: async () => [], heldAccounts: async () => [], keeperFetch: async () => podFetch };
  const said = []; const log = console.log; console.log = (m) => said.push(String(m));
  try {
    const { round } = await import('../../netlify/functions/flush-mail.mjs');
    const HOUR = COPY_RETRY_MS;
    await round(ctx);
    const first = asked.filter((a) => a === 'PUT statuses.json').length;
    assert.ok(first >= 1, `the round tries the copy (${asked.join(', ')})`);
    assert.ok(asked.includes('PUT liked.json'), 'and what the pod takes is written');
    assert.ok(said.some((m) => /^copy @heron: not deleted: 1 document/u.test(m)), said.join(' | '));
    assert.ok(await copyMeta(kv, 'heron'), 'the copy stays at the Gateway');
    asked.length = 0;
    await round(ctx);
    await round(ctx);
    assert.deepEqual(asked, [], 'the next rounds ask that pod for nothing');
    // Fifty-nine minutes on, still nothing; the hour passed, it is tried again.
    await kv.set('heron/refused', JSON.stringify({ at: Date.now() - HOUR + 60_000 }));
    await round(ctx);
    assert.deepEqual(asked, [], 'nor a minute short of the hour');
    await kv.set('heron/refused', JSON.stringify({ at: Date.now() - HOUR - 1000 }));
    await round(ctx);
    assert.ok(asked.includes('PUT statuses.json'), 'after the hour it is tried again');
    asked.length = 0;
    await kv.set('heron/refused', JSON.stringify({ at: Date.now() - HOUR - 1000 }));
    refuse = false;
    await round(ctx);
    assert.ok(said.includes('copy @heron: written to the pod and deleted (the hold)'), said.join(' | '));
    assert.equal(await copyMeta(kv, 'heron'), null, 'the pod took it: the copy is handed back');
    assert.equal(await kv.get('heron/refused'), null, 'and nothing is noted against the account');
    // With no wait, every round tries.
    await kv.set('_copies/heron', '1'); await kv.set('heron/meta', JSON.stringify({ stateUrl: STATE })); await kv.set('heron/d/statuses.json', '["another"]');
    refuse = true; asked.length = 0;
    await round(ctx, { copyRetryMs: 0 }); await round(ctx, { copyRetryMs: 0 });
    assert.ok(asked.filter((a) => a === 'PUT statuses.json').length >= 2 * first, `with no wait, each round asks again (${asked.length} requests)`);
    assert.equal(await kv.get('heron/refused'), null, 'and nothing is noted');
  } finally { console.log = log; }
});

// ---- as fedipod.net runs it: Netlify's stores, stood in for -------------------

test('at the Gateway: an old account shows its date, a new row is stored with one, and the round starts due work before the mail', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-test-'));
  const { BlobsServer } = await import(path.join(root, 'node_modules/@netlify/blobs/dist/server.js'));
  const blobs = new BlobsServer({ directory: dir, token: 'check', logger: () => {} });
  const { port } = await blobs.start();
  const KEEPER = 'https://keeper.example/profile/card#me';
  const env = {
    NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({ edgeURL: `http://127.0.0.1:${port}`, uncachedEdgeURL: `http://127.0.0.1:${port}`, siteID: 'check', token: 'check' })).toString('base64'),
    FEDIPOD_FRONT_HOST: 'fedipod.example', FEDIPOD_FRONT_ORIGIN: 'https://fedipod.example', URL: 'https://fedipod.example',
    FEDIPOD_KEEPER_WEBID: KEEPER, FEDIPOD_KEEPER_CLIENT_SECRET: 'check-secret', FEDIPOD_CLOSE_DAYS: '100000',
  };
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    if (url.startsWith(`http://127.0.0.1:${port}`)) return realFetch(input, init);
    calls.push({ url, method: (init.method || input?.method || 'GET').toUpperCase(), limited: !!init.signal });
    return new Response(null, { status: url.includes('/.netlify/functions/') ? 202 : 201 });
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await blobs.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { getStore } = await import(path.join(root, 'node_modules/@netlify/blobs/dist/main.js'));
  const { gatewayCtx } = await import('../../netlify/functions/front.mjs');
  const directory = getStore('directory');
  // An old account as it is stored today: no date of either kind. And a forum.
  await directory.setJSON('heron', person('heron', { hmacSecret: 's' }));
  await directory.setJSON('forum', { handle: 'forum', kind: 'application', podHome: `${POD}forum/fedipod-bb/`, inboxUrl: `${POD}forum/fedipod-bb/ap/inbox/`,
    webId: `${POD}forum/profile/card#me`, keeper: { webId: KEEPER } });
  const ctx = gatewayCtx();
  assert.equal((await ctx.lookup('heron')).openedAt, FIRST_OPENED, 'read: the old account shows 23 September 2026');
  assert.equal((await ctx.lookupFresh('heron')).openedAt, FIRST_OPENED, 'read fresh: the same');
  const roster = await ctx.listDirectory();
  assert.equal(roster.heron.openedAt, FIRST_OPENED, 'on the roster: the same');
  assert.equal('openedAt' in roster.forum, false, 'the forum has none');
  // A new account, written as attach writes it.
  await ctx.putDirectory('siskin', person('siskin', { attachedAt: '2026-11-13T20:00:00.000Z' }));
  assert.equal((await directory.get('siskin', { type: 'json' })).openedAt, '2026-11-13T20:00:00.000Z', 'a new person\'s row is stored with its date');
  await ctx.putDirectory('allotment', { handle: 'allotment', kind: 'group', podHome: `${POD}allotment/` });
  assert.equal('openedAt' in (await directory.get('allotment', { type: 'json' })), false, 'a group\'s is not');
  // Held mail for the old account, a pile for another, and the forum due.
  const mail = getStore('mail');
  await mail.set('heron/aaa', '{"type":"Create"}'); await mail.set('heron/aaa.receipt.json', '{"v":1}');
  for (let i = 0; i < 130; i++) await mail.set(`siskin/item-${String(i).padStart(4, '0')}`, '{"type":"Create"}');
  assert.deepEqual((await ctx.heldAccounts()).sort(), ['heron', 'siskin'], 'the accounts with mail held, without listing every item');
  assert.equal((await ctx.listHeld('siskin', { limit: 50 })).length, 50, 'and an account\'s pile is listed only as far as asked');
  assert.equal((await ctx.listHeld('siskin')).length, 130);
  await getStore('keeper').setJSON('forum', { nextAt: new Date(Date.now() - 1000).toISOString() });
  calls.length = 0;
  const round = (await import('../../netlify/functions/flush-mail.mjs')).default;
  const res = await round();
  assert.equal(res.status, 204);
  const what = calls.map((c) => (c.url.includes('keeper-background') ? 'forum run started' : `${c.method} ${c.url.split('/').slice(3, 4)[0]}${c.limited ? ' (limited)' : ''}`));
  assert.equal(what[0], 'forum run started', `work that is due starts before any mail is written (${what.join(' | ')})`);
  assert.deepEqual(what.slice(1).sort(), ['PUT heron (limited)', 'PUT siskin (limited)'], 'then one batch for each account, each with its time limit');
  assert.equal((await mail.list({ prefix: 'heron/' })).blobs.length, 0, 'the old account\'s held mail reached its pod');
  assert.equal((await mail.list({ prefix: 'siskin/' })).blobs.length, 30, 'a hundred of the pile went; thirty wait');
  assert.equal(await ctx.roundMark(), 'siskin', 'and the round noted where it finished');
  // Netlify sends a round again while the first is still running: the second
  // stops at once and writes nothing; the round after the first has ended runs.
  for (let i = 0; i < 3; i++) await mail.set(`heron/later-${i}`, '{"type":"Create"}');
  let release; const gate = new Promise((r) => { release = r; });
  const quick = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    if (!url.startsWith(`http://127.0.0.1:${port}`) && (init.method || '').toUpperCase() === 'PUT') await gate;
    return quick(input, init);
  };
  const said = []; const log = console.log; console.log = (m) => said.push(String(m));
  try {
    calls.length = 0;
    const first = round();
    await new Promise((r) => setTimeout(r, 400));
    const second = await round();
    assert.equal(second.status, 204);
    assert.ok(said.includes('round: another round is running; this one stops'), said.join(' | '));
    const puts = () => calls.filter((c) => c.method === 'PUT').map((c) => c.url.split('/').slice(3, 4)[0]).sort();
    release(); await first;
    assert.deepEqual(puts(), ['heron', 'siskin'], 'each account got one batch, from the first round alone');
    assert.equal((await mail.list({ prefix: 'heron/' })).blobs.length, 0);
    calls.length = 0;
    await round();
    assert.equal(said.filter((m) => m.startsWith('round:')).length, 1, 'the round after it is not turned away');
    assert.equal((await mail.list({ prefix: 'siskin/' })).blobs.length, 0, 'and takes what was left');
  } finally { console.log = log; globalThis.fetch = quick; }
});
