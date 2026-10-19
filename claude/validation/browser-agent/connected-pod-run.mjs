// connected-pod-run.mjs — an account connected on another server is kept on
// the pod. Logins an earlier build kept in this browser move to the pod the
// next time the agent acts, leave the browser, and the account page offers no
// other place to keep them.
//
// Signs up, puts a Mastodon login and a Bluesky login where the earlier build
// kept them (this origin's IndexedDB), restarts the worker the way the browser
// does, then reads the account page's report, the browser's store and the pod's
// log. SHOT=<file> also saves the account page as a picture.
//
//   node claude/validation/browser-agent/connected-pod-run.mjs
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

const CSS_PORT = 3391; const APP_PORT = 9011; const CDP_PORT = 9391;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-connpod-'));

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
    const id = `http://localhost:${APP_PORT}/peer/${peer[1]}`;
    s.writeHead(200, { 'content-type': 'application/activity+json' });
    return s.end(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams',
      id, type: 'Person', preferredUsername: `peer${peer[1]}`, name: `Peer ${peer[1]}`,
      inbox: `${id}/inbox`, outbox: `${id}/outbox` }));
  }
  const peerInbox = /^\/peer\/(\d+)\/inbox$/.exec(u);
  if (peerInbox) {
    let raw = ''; for await (const d of q) raw += d;
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
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/quiet.html` });
  await sleep(1500);
  let st = null;
  for (let i = 0; i < 40 && !(st?.mode === 'active'); i++) { st = await status(); if (st?.mode !== 'active') await sleep(500); }
  check(st?.mode === 'active', 'the agent acts');
  await sleep(8000);                      // the full start's background work settles

  // Where the earlier build kept them: this origin's IndexedDB. Both paused,
  // so no mirror reaches for servers that are not there.
  const mastodon = { id: 'me@mastodon.example', handle: '@me@mastodon.example', host: 'mastodon.example',
    token: 'full-access-mastodon', addedAt: '2026-10-01T00:00:00Z', enabled: false };
  const bluesky = { did: 'did:plc:fixture', handle: 'me.bsky.example', service: `http://localhost:${APP_PORT}/bsky`,
    accessJwt: 'a', refreshJwt: 'full-access-bluesky', feedPaused: true };
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1500);
  const seeded = await evaluate(`new Promise((res) => { const o = indexedDB.open('fedipod-accounts', 1);
    o.onupgradeneeded = () => { if (!o.result.objectStoreNames.contains('kv')) o.result.createObjectStore('kv'); };
    o.onerror = () => res(false);
    o.onsuccess = () => { const db = o.result; const t = db.transaction('kv', 'readwrite'); const s = t.objectStore('kv');
      s.put(${JSON.stringify(mastodon)}, 'rec:me@mastodon.example'); s.put(${JSON.stringify(bluesky)}, 'atproto');
      t.oncomplete = () => { db.close(); res(true); }; t.onerror = () => { db.close(); res(false); }; }; })`);
  check(seeded === true, 'a Mastodon login and a Bluesky login kept in this browser, as an earlier build kept them');
  const from = podLog.length;

  // The next request starts the worker again; the agent acts and moves them.
  let moved = null;
  for (let i = 0; i < 40; i++) {
    const c = await evaluate(`(async () => { const r = await fetch('/config', { headers: { 'x-fedipod-page': '1' } }); return r.ok ? r.json() : null; })()`);
    moved = c;
    if (c?.fediAccounts?.[0]?.storage === 'pod' && c?.atproto?.storage === 'pod') break;
    await sleep(500);
  }
  check(moved?.fediAccounts?.[0]?.id === 'me@mastodon.example' && moved.fediAccounts[0].storage === 'pod',
    `the Mastodon account is kept on the pod (${moved?.fediAccounts?.[0]?.storage})`);
  check(moved?.atproto?.connected && moved.atproto.storage === 'pod', `the Bluesky account is kept on the pod (${moved?.atproto?.storage})`);
  const left = await evaluate(`new Promise((res) => { const o = indexedDB.open('fedipod-accounts', 1);
    o.onsuccess = () => { const db = o.result; const all = []; const c = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { all.push(cur.key); cur.continue(); } else { db.close(); res(all); } }; }; })`);
  check(Array.isArray(left) && !left.includes('rec:me@mastodon.example') && !left.includes('atproto'),
    `and neither is left in this browser (${JSON.stringify(left)})`);
  const wrote = podLog.slice(from).filter((l) => /^(PUT|PATCH) /u.test(l));
  check(wrote.some((l) => l.endsWith('/fediaccts.json')) && wrote.some((l) => l.endsWith('/atproto.json')),
    `both were written to the pod (${wrote.filter((l) => /fediaccts|atproto/u.test(l)).length} writes)`);

  // A request to keep one in the browser is refused.
  const refused = await evaluate(`(async () => (await fetch('/fediacct', { method: 'POST',
    headers: { 'x-fedipod-page': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'me@mastodon.example', storage: 'browser' }) })).status)()`);
  check(refused === 400, `no other place to keep it is accepted (${refused})`);

  // The account page: the connections show, with no choice of where to keep them.
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/admin/` });
  let page = null;
  for (let i = 0; i < 40; i++) {
    page = await evaluate(`(() => { const t = document.body?.innerText || ''; return { shown: t.includes('@me@mastodon.example') && t.includes('me.bsky.example'),
      storeKey: /Store key/u.test(t) || [...document.querySelectorAll('option')].some((o) => /Store key/u.test(o.textContent)) }; })()`);
    if (page?.shown) break;
    await sleep(500);
  }
  check(page?.shown === true, 'the account page lists both connected accounts');
  check(page?.storeKey === false, 'and offers no "Store key" choice');
  if (process.env.SHOT) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 760, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('dt.under')?.scrollIntoView({ block: 'center' })`);
    await sleep(500);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) fs.writeFileSync(process.env.SHOT, Buffer.from(shot.result.data, 'base64'));
  }
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
