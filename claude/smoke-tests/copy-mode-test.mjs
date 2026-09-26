// copy-mode-test.mjs — the browser asking the gateway for its account's copy
// (web/app/copy-mode.mjs openCopy): after the gateway could not find or make
// it, a restarted worker does not ask again for fifteen minutes; a sign-in
// does, and so does turning keeping on. IndexedDB is stood in for by a map.
// Run from the project root: node claude/smoke-tests/copy-mode-test.mjs

// Just enough IndexedDB for web/app/idb-kv.mjs: open, get, put, delete.
const data = new Map();
const db = {
  objectStoreNames: { contains: () => true },
  createObjectStore() {},
  transaction() {
    const tx = {};
    const done = () => queueMicrotask(() => tx.oncomplete?.());
    tx.objectStore = () => ({
      get(k) { const rq = {}; queueMicrotask(() => { rq.result = data.get(k); rq.onsuccess?.(); }); return rq; },
      put(v, k) { data.set(k, v); done(); },
      delete(k) { data.delete(k); done(); },
    });
    return tx;
  },
};
globalThis.indexedDB = { open() { const r = {}; queueMicrotask(() => { r.result = db; r.onsuccess?.(); }); return r; } };

const { openCopy, forgetFailedOpen } = await import('../../web/app/copy-mode.mjs');

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const GW = 'https://gw.example';

// An agent whose gateway answers `status` (or throws, for a network failure).
function agentAnswering(webId, answer) {
  const agent = { webId, log: () => {}, asks: 0, answer };
  agent.sessionFetch = async () => {
    agent.asks++;
    const a = agent.answer;
    if (a === 'network') throw new Error('offline');
    if (a === 200) return new Response(JSON.stringify({ handle: 'mei', base: `${GW}/api/state/mei/`, token: 't', expiresAt: Date.now() + 86_400_000 }));
    return new Response(JSON.stringify({ error: 'the pod could not be read (HTTP 403)' }), { status: a });
  };
  return agent;
}

try {
  const mei = agentAnswering('https://mei.example/#me', 502);
  check(await openCopy(mei, GW) === null && mei.asks === 1, 'a copy the gateway could not make is not had');
  check(await openCopy(mei, GW) === null && mei.asks === 1, 'and a restarted worker does not ask again');
  check(await openCopy(mei, GW, { askAnyway: true }) === null && mei.asks === 2, 'a sign-in asks anyway');
  await forgetFailedOpen(mei, GW);
  mei.answer = 200;
  const copy = await openCopy(mei, GW);
  check(copy?.base && mei.asks === 3, 'turning keeping on forgets the failure, and the next ask is answered');
  mei.answer = 502;
  await openCopy(mei, GW, { askAnyway: true });
  mei.answer = 200;
  await openCopy(mei, GW, { askAnyway: true });
  const asks = mei.asks;
  await openCopy(mei, GW);
  check(mei.asks === asks + 1, 'a copy had again forgets the failure before it');

  const kit = agentAnswering('https://kit.example/#me', 'network');
  await openCopy(kit, GW); await openCopy(kit, GW);
  check(kit.asks === 2, 'a network failure is not remembered: it is this browser\'s to put right');
  const ana = agentAnswering('https://ana.example/#me', 401);
  await openCopy(ana, GW); await openCopy(ana, GW);
  check(ana.asks === 2, 'nor a refused sign-in');
  const bo = agentAnswering('https://bo.example/#me', 404);
  await openCopy(bo, GW); await openCopy(bo, GW);
  check(bo.asks === 1, 'an account the gateway does not keep is not asked about again at every restart');
  const lu = agentAnswering('https://lu.example/#me', 409);   // the pod's lease still this browser's own
  await openCopy(lu, GW);
  lu.answer = 200;
  check(await openCopy(lu, GW) === null && lu.asks === 1, 'a restart does not ask again after "held by another device"');
  check((await openCopy(lu, GW, { letGo: true }))?.base && lu.asks === 2,
    'but having let go of the pod, the browser asks: the lease held may have been its own');
  const mo = agentAnswering('https://mo.example/#me', 502);
  await openCopy(mo, GW); await openCopy(mo, GW, { letGo: true });
  check(mo.asks === 1, 'letting go of the pod changes nothing for any other failure');
  check(await openCopy(agentAnswering('https://kit.example/#me', 502), GW) === null && (await openCopy(ana, GW), ana.asks === 3),
    'one account\'s failure does not hold back another\'s');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
