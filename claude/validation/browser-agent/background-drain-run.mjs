// background-drain-run.mjs — mail waiting in the pod inbox is all taken in
// after one request from a page that then goes quiet, as a background tab does.
//
// Chrome stops an idle service worker about thirty seconds after its last
// event. This signs up, puts 300 follows from slow-answering people in the pod
// inbox, stops the worker, makes ONE request from a page that makes no others,
// and counts the follows the pod sees taken out of the inbox. All 300 must go,
// which takes longer than thirty seconds here. Then the "wait for approval"
// switch, flipped through the worker, must show in the actor on the pod.
//
// No DevTools session is attached to the worker while it works: one keeps a
// worker running, and would hide exactly what this checks.
//
//   node claude/validation/browser-agent/background-drain-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
import { dependentDir } from '../../../scripts/dependents.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const CSS_BIN = path.join(dependentDir('fedipod-server'), 'node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { signUpThroughPage } = await import(new URL('./page-signup.mjs', import.meta.url));
const { watchWorkerLog } = await import(new URL('./worker-log.mjs', import.meta.url));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3386; const APP_PORT = 9006; const CDP_PORT = 9386;
const ISSUER = `http://localhost:${CSS_PORT}`;
const FOLLOWS = 300;
const PEER_DELAY_MS = 120;               // each remote person answers this slowly
const DEADLINE_MS = 4.5 * 60_000;        // one request may keep the worker up four minutes
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-bgdrain-'));

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'info'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
const podLog = [];
let cssErr = '';
const onCss = (d) => { cssErr = (cssErr + d).slice(-3000); for (const line of String(d).split('\n')) { const m = /Received (\w+) request for (\S+)/.exec(line); if (m) podLog.push(`${m[1]} ${m[2]}`); } if (process.env.SW_DEBUG) process.stderr.write(d); };
css.stderr.on('data', onCss); css.stdout.on('data', onCss);
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }

const file = (p, ct) => (q, s) => { s.writeHead(200, { 'content-type': ct, ...(p.endsWith('sw.js') ? { 'service-worker-allowed': '/' } : {}) }); s.end(fs.readFileSync(path.join(root, p))); };
const page = '<!doctype html><meta charset=utf-8><title>boot</title><script type=module src="/dist/boot.js"></script>';
// A page under the worker that asks it for nothing: the background tab.
const quiet = '<!doctype html><meta charset=utf-8><title>quiet</title>';
// The front's mail door and relay, stubbed as in restart-run.mjs.
const attachStub = (req, res, frontOrigin) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const { handle } = JSON.parse(raw || '{}');
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, handle,
      doorInbox: `${frontOrigin}/u/${handle}/ap/inbox/`,
      hmacSecret: Buffer.from(`door-secret-for-${handle}`).toString('base64') }));
  });
};
const relayStub = (req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    let out = [];
    try {
      const { requests = [] } = JSON.parse(raw || '{}');
      out = await Promise.all(requests.map(async (r) => {
        const method = r.method || 'POST';
        try {
          const sent = await fetch(r.url, { method, headers: r.headers,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: r.body }) });
          const one = { url: r.url, status: sent.status };
          if (method === 'GET') { one.contentType = sent.headers.get('content-type'); one.body = await sent.text(); }
          return one;
        } catch (e) { return { url: r.url, status: 0, error: String(e.message || e) }; }
      }));
    } catch (e) { out = [{ status: 0, error: String(e.message || e) }]; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: out }));
  });
};

const accepted = new Set();               // people who were sent an Accept
const server = http.createServer(async (q, s) => {
  const u = q.url.split('?')[0];
  if (u === '/api/attach') return attachStub(q, s, `http://localhost:${APP_PORT}`);
  if (u === '/api/relay') return relayStub(q, s);
  const peer = /^\/peer\/(\d+)$/.exec(u);
  if (peer) {
    await sleep(PEER_DELAY_MS);
    const id = `http://localhost:${APP_PORT}/peer/${peer[1]}`;
    s.writeHead(200, { 'content-type': 'application/activity+json' });
    return s.end(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams',
      id, type: 'Person', preferredUsername: `peer${peer[1]}`, name: `Peer ${peer[1]}`,
      inbox: `${id}/inbox`, outbox: `${id}/outbox` }));
  }
  const peerInbox = /^\/peer\/(\d+)\/inbox$/.exec(u);
  if (peerInbox) {
    let raw = ''; for await (const d of q) raw += d;
    await sleep(PEER_DELAY_MS);
    try { if (JSON.parse(raw).type === 'Accept') accepted.add(peerInbox[1]); } catch {}
    s.writeHead(202); return s.end();
  }
  if (u === '/quiet.html') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(quiet); }
  if (u === '/' || u === '/index.html') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(page); }
  if (u === '/dist/boot.js') return file('web/app/dist/boot.js', 'text/javascript')(q, s);
  if (u === '/sw.js') return file('web/app/dist/sw.js', 'text/javascript')(q, s);
  if (u.startsWith('/admin/')) {
    const rel = u.endsWith('/') ? u + 'index.html' : u;
    const f = path.join(root, 'web', rel);
    if (f.startsWith(path.join(root, 'web/admin')) && fs.existsSync(f)) {
      const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css'
        : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      s.writeHead(200, { 'content-type': type }); return s.end(fs.readFileSync(f));
    }
  }
  s.writeHead(404); s.end();
});
await new Promise((r) => server.listen(APP_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu',
  `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let tab;
for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tab = l.find((t) => t.type === 'page'); if (tab) break; } catch {} await sleep(500); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('cdp'))); });
let seq = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const status = () => evaluate('(async () => { const r = await fetch("/status", { headers: { "x-fedipod-page": "1" } }); return r.ok ? r.json() : { __status: r.status }; })()');
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('ServiceWorker.enable');
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
  for (let i = 0; i < 40; i++) { if (await evaluate('typeof window.fedipodSignup === "function"')) break; await sleep(250); }
  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  await signUpThroughPage(evaluate, sleep, { issuer: ISSUER, appOrigin: `http://localhost:${APP_PORT}`, handle, email: `${handle}@example.org`, password: 'correct horse battery staple' });
  let ready = null;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()');
    if (!ready) await sleep(500);
  }
  check(!!ready, `signed up and the agent booted in the worker: ${ready}`);

  // From here the tab shows a page that asks the worker for nothing.
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/quiet.html` });
  await sleep(1500);
  let st = null;
  for (let i = 0; i < 40 && !(st?.mode === 'active'); i++) { st = await status(); if (st?.mode !== 'active') await sleep(500); }
  check(st?.mode === 'active' && /\/ap\/actor$/.test(st.actor || ''), `the agent acts for ${st?.actor}`);
  await sleep(15000);                     // the full start's background work settles
  const actorUrl = st.actor;
  const inboxUrl = actorUrl.replace(/actor$/u, 'inbox/');

  // The browser stops the worker, and the mail arrives while it is stopped:
  // 300 follows, as the door puts them in the pod inbox. The next start is a
  // restart moments later, due an inbox round.
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1500);
  let seeded = 0;
  for (let i = 1; i <= FOLLOWS; i++) {
    const peer = `http://localhost:${APP_PORT}/peer/${i}`;
    const r = await fetch(inboxUrl, { method: 'POST', headers: { 'content-type': 'application/ld+json' },
      body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${peer}#follow`, type: 'Follow', actor: peer, object: actorUrl }) });
    if (r.status === 201) seeded++;
  }
  check(seeded === FOLLOWS, `${seeded} follows waiting in the pod inbox`);

  await evaluate(`new Promise((res) => { const o = indexedDB.open('fedipod-warm'); o.onerror = () => res(false);
    o.onsuccess = () => { const db = o.result; const t = db.transaction('meta', 'readwrite'); const s = t.objectStore('meta');
      const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { cur.update({ ...cur.value, drainedAt: 0 }); cur.continue(); } };
      t.oncomplete = () => { db.close(); res(true); }; t.onerror = () => { db.close(); res(false); }; }; })`);
  const from = podLog.length;
  // The pod logs a path, or a whole address; either names the inbox.
  const inboxPath = new URL(inboxUrl).pathname;
  const isTaken = (l) => /^DELETE /u.test(l) && l.includes(inboxPath) && !l.endsWith(inboxPath) && !l.endsWith('.receipt.json');
  const t0 = Date.now();
  const woke = await evaluate('(async () => (await fetch("/api/v1/instance")).status)()');
  check(woke === 200, 'one request from the page wakes the worker');
  let taken = 0; let at40 = null;
  while (Date.now() - t0 < DEADLINE_MS) {
    taken = podLog.slice(from).filter(isTaken).length;
    if (at40 === null && Date.now() - t0 >= 40_000) at40 = taken;
    if (taken >= FOLLOWS) break;
    await sleep(2000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`  taken out of the inbox: ${at40 ?? taken} after 40 s, ${taken} after ${secs} s`);
  check(taken >= FOLLOWS, `all ${FOLLOWS} follows taken in after one request, with no other (${taken} in ${secs} s)`);
  check(secs > 35, `and that took longer than a worker lives unasked (${secs} s), so the test means something`);
  check(accepted.size >= FOLLOWS, `every follower was sent an Accept (${accepted.size})`);
  st = await status();
  check(st?.followers === FOLLOWS, `the account lists ${st?.followers} followers`);

  // Mail fedipod.net held while the app was closed reaches the pod as one
  // batch document (lib/gateway/held-mail.mjs); the browser reads it the same.
  const BATCHED = 20;
  const batch = [];
  for (let i = FOLLOWS + 1; i <= FOLLOWS + BATCHED; i++) {
    const peer = `http://localhost:${APP_PORT}/peer/${i}`;
    batch.push({ name: `held-${i}.json`, receipt: null,
      body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${peer}#follow`, type: 'Follow', actor: peer, object: actorUrl }) });
  }
  const deadBefore = st?.deadLetters ?? 0;
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1500);
  const put = await fetch(inboxUrl, { method: 'POST', headers: { 'content-type': 'application/json', slug: `batch-${Date.now()}-0-rig.json` },
    body: JSON.stringify({ batch }) });
  check(put.status === 201 && /\/batch-[^/]*\.json$/u.test(put.headers.get('location') || ''), `a batch of ${BATCHED} held follows in the pod inbox (${put.headers.get('location')})`);
  await evaluate(`new Promise((res) => { const o = indexedDB.open('fedipod-warm'); o.onerror = () => res(false);
    o.onsuccess = () => { const db = o.result; const t = db.transaction('meta', 'readwrite'); const s = t.objectStore('meta');
      const c = s.openCursor(); c.onsuccess = () => { const cur = c.result; if (cur) { cur.update({ ...cur.value, drainedAt: 0 }); cur.continue(); } };
      t.oncomplete = () => { db.close(); res(true); }; t.onerror = () => { db.close(); res(false); }; }; })`);
  const t1 = Date.now();
  await evaluate('(async () => (await fetch("/api/v1/instance")).status)()');
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    if (podLog.slice(from).some((l) => /^DELETE /u.test(l) && /\/batch-[^/]*\.json$/u.test(l))) break;
  }
  st = await status();
  check(st?.followers === FOLLOWS + BATCHED, `the batch's follows are followers too (${st?.followers}, ${Math.round((Date.now() - t1) / 1000)} s)`);
  check((st?.deadLetters ?? 0) === deadBefore, `and none of them became a dead letter (${(st?.deadLetters ?? 0) - deadBefore})`);

  // The "wait for approval" switch, through the worker, reaches the actor.
  const setApproval = (on) => evaluate(`(async () => { const r = await fetch('/config', { method: 'POST',
    headers: { 'x-fedipod-page': '1', 'content-type': 'application/json' }, body: JSON.stringify({ autoAcceptFollows: ${on} }) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) }; })()`);
  const actorNow = async () => (await fetch(actorUrl, { headers: { accept: 'application/activity+json' } })).json();
  const off = await setApproval(false);
  const locked = await actorNow();
  check(off.status === 200 && off.published === true && locked.manuallyApprovesFollowers === true,
    `"wait for approval" on: the actor says it approves followers by hand (${locked.manuallyApprovesFollowers})`);
  const onAgain = await setApproval(true);
  const open = await actorNow();
  check(onAgain.status === 200 && onAgain.published === true && open.manuallyApprovesFollowers === undefined,
    `"wait for approval" off: the actor no longer says so (${open.manuallyApprovesFollowers})`);
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  if (fails) {
    const log = await watchWorkerLog(WebSocket, CDP_PORT).catch(() => null);
    await sleep(500);
    if (log?.lines?.length) console.log('\n--- the agent said (after the fact) ---\n  ' + log.lines.slice(-30).join('\n  '));
    log?.close?.();
  }
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
