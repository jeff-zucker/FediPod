// restart-run.mjs — what a worker restart asks of the pod.
//
// Chrome stops an idle service worker and a client's next request starts it
// again. This signs up, stops the worker the way the browser does, and counts
// the requests the pod receives on the restart: once with the copy the last
// start kept (warm-start.mjs), once with that copy deleted.
//
// Boots a scratch CSS, serves the boot page + the built boot.js and sw.js, and
// in headless Chrome: signs up, registers the worker, boots the agent into it,
// then makes ordinary fetch() calls to /api and /oauth on the origin — which the
// worker intercepts and the agent answers. If a full sign-in and a post work
// through the worker with no server behind it, the client story holds. (Phanpy
// itself rendering from such a worker is proven separately in sw-facade-spike/.)
//
//   node claude/validation/browser-agent/sw-run.mjs
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

const CSS_PORT = 3348; const APP_PORT = 8986; const CDP_PORT = 9348;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-sw-'));

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
// The front's mail door, stubbed. Sign-up attaches to it and the actor then
// advertises it as its inbox; the real one lives on fedipod.net (front-core.mjs)
// and there is no front in this test. Everything after this cares only that the
// attach returned a door address and a shared secret.
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

// The front's relay, stubbed. A browser may not set Date or Host, so the agent
// signs a request and hands it to the relay to send verbatim; the real one is on
// fedipod.net (front-core.mjs) and there is no front here. This sends it onward
// for real and answers in the same shape, which matters for reads: the agent
// dereferences whoever writes to it through this same path.
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
          // A read comes back with its body; a delivery has none. The agent
          // reads a fetched actor or note straight off this (deliver-relay.mjs).
          if (method === 'GET') { one.contentType = sent.headers.get('content-type'); one.body = await sent.text(); }
          const retryAfter = sent.headers.get('retry-after');
          if (retryAfter) one.retryAfter = retryAfter;
          return one;
        } catch (e) { return { url: r.url, status: 0, error: String(e.message || e) }; }
      }));
    } catch (e) { out = [{ status: 0, error: String(e.message || e) }]; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ results: out }));
  });
};

const server = http.createServer((q, s) => {
  const u = q.url.split('?')[0];
  if (u === '/api/attach') return attachStub(q, s, `http://localhost:${APP_PORT}`);
  if (u === '/api/relay') return relayStub(q, s);
  // Stand-in remote people. The drain dereferences whoever follows this account
  // and delivers an Accept back, so both have to answer for a Follow to become
  // a notification at all.
  const peer = /^\/peer\/(\d+)$/.exec(u);
  if (peer) {
    const id = `http://localhost:${APP_PORT}/peer/${peer[1]}`;
    s.writeHead(200, { 'content-type': 'application/activity+json' });
    return s.end(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams',
      id, type: 'Person', preferredUsername: `peer${peer[1]}`, name: `Peer ${peer[1]}`,
      inbox: `${id}/inbox`, outbox: `${id}/outbox` }));
  }
  if (/^\/peer\/\d+\/inbox$/.test(u)) { s.writeHead(202); return s.end(); }
  if (u === '/' || u === '/index.html') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(page); }
  if (u === '/dist/boot.js') return file('web/app/dist/boot.js', 'text/javascript')(q, s);
  if (u === '/sw.js') return file('web/app/dist/sw.js', 'text/javascript')(q, s);
  // The record/manage pages, under /admin/ as the deployed site stages them.
  // boot.js sends the browser to /admin/client/ once the agent is up, and a 404
  // there takes the page off this origin — where the worker no longer controls
  // it and nothing below can reach the agent.
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
let workerLog = null;                     // set once the worker exists; read in `finally`
let seq = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('ServiceWorker.enable');
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
  for (let i = 0; i < 40; i++) { if (await evaluate('typeof window.fedipodSignup === "function"')) break; await sleep(250); }
  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  const password = 'correct horse battery staple';
  await signUpThroughPage(evaluate, sleep, { issuer: ISSUER, appOrigin: `http://localhost:${APP_PORT}`, handle, email: `${handle}@example.org`, password });
  let ready = null;
  for (let i = 0; i < 60; i++) {
    ready = await evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()');
    if (ready) break;
    await sleep(500);
  }
  check(!!ready, `signed up and the agent booted in the worker: ${ready}`);
  workerLog = await watchWorkerLog(WebSocket, CDP_PORT);
  const tok = await evaluate(`(async () => {
    const j = async (m, p, opt = {}) => (await fetch(p, { method: m, ...opt })).json();
    const app = await j('POST', '/api/v1/apps', { headers:{'content-type':'application/json'}, body: JSON.stringify({ client_name:'test', redirect_uris:'urn:ietf:wg:oauth:2.0:oob', scopes:'read write' }) });
    const authz = await j('GET', '/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri:'urn:ietf:wg:oauth:2.0:oob', response_type:'code', scope:'read write' }));
    const t = await j('POST', '/oauth/token', { headers:{'content-type':'application/json'}, body: JSON.stringify({ grant_type:'authorization_code', code: authz.code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri:'urn:ietf:wg:oauth:2.0:oob' }) });
    window.__token = t.access_token; return !!t.access_token;
  })()`);
  check(tok === true, 'a client signed in through the worker');
  const post = (text) => evaluate(`(async () => (await (await fetch('/api/v1/statuses', { method: 'POST', headers: { authorization: 'Bearer ' + window.__token, 'content-type': 'application/json' }, body: JSON.stringify({ status: ${JSON.stringify(text)} }) })).json()).id)()`);
  const home = () => evaluate(`(async () => { const r = await fetch('/api/v1/timelines/home?limit=40', { headers: { authorization: 'Bearer ' + window.__token } }); return r.ok ? (await r.json()).map((s) => s.content) : null; })()`);
  check(!!(await post('before any restart')), 'a post before any restart');
  await sleep(12000);                        // the full start's background work settles
  // The hashtag feed's first sweep reads real servers and can outlast that; a
  // restart before it is recorded sweeps again, and writes, by design.
  for (let i = 0; i < 60 && !(workerLog?.lines || []).some((l) => /tagfeed: /.test(l)); i++) await sleep(1000);
  await sleep(2000);

  const podHost = `${handle}.localhost:${CSS_PORT}`;
  const restart = async (label) => {
    await send('ServiceWorker.stopAllWorkers');
    await sleep(1500);
    const from = podLog.length;
    const t0 = Date.now();
    const h = await home();                  // the client's next request starts the worker again
    await sleep(8000);                       // and its background start runs to the end
    const asked = podLog.slice(from).filter((l) => l.includes(podHost) || /^\w+ \//.test(l));
    console.log(`  ${label}: ${asked.length} pod requests (${Date.now() - t0} ms)`);
    const tally = {}; for (const l of asked) { const k = l.replace(/https?:\/\/[^/]+/, '').replace(/\/(notes|activities|cache)\/[^ ]+/, '/$1/…'); tally[k] = (tally[k] || 0) + 1; }
    for (const [k, n] of Object.entries(tally)) console.log(`    ${n} × ${k}`);
    return { home: h, asked };
  };

  const warm1 = await restart('restart with the kept copy');
  check(Array.isArray(warm1.home) && warm1.home.some((c) => /before any restart/.test(c)), 'after a restart the timeline still has the post');
  check(!warm1.asked.some((l) => /^PUT .*lease\.json/.test(l)), 'the restart writes no lease');
  check(!warm1.asked.some((l) => /^(PUT|PATCH) /.test(l)), `the restart writes nothing to the pod (${warm1.asked.filter((l) => /^(PUT|PATCH)/.test(l)).join(', ') || 'no writes'})`);

  check(!!(await post('between restarts')), 'a post between restarts');
  await sleep(3000);
  const warm2 = await restart('restart after a post');
  check(Array.isArray(warm2.home) && warm2.home.some((c) => /between restarts/.test(c)), 'after the next restart the timeline has the new post too');
  check(!warm2.asked.some((l) => /^(PUT|PATCH|POST) /.test(l)), `and that restart writes nothing either: no mirror sweeps on a wake (${warm2.asked.filter((l) => /^(PUT|PATCH|POST)/.test(l)).length} writes)`);

  await evaluate(`new Promise((res) => { const r = indexedDB.deleteDatabase('fedipod-warm'); r.onsuccess = r.onerror = r.onblocked = () => res(); })`);
  const cold = await restart('restart with the copy deleted (as before this fix)');
  check(cold.asked.length > warm1.asked.length * 3, `the kept copy saves most of the pod requests (${warm1.asked.length} against ${cold.asked.length})`);
  check(Array.isArray(cold.home) && cold.home.some((c) => /between restarts/.test(c)), 'and a cold restart shows the same timeline');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  if (fails && workerLog?.lines?.length) console.log('\n--- the agent said ---\n  ' + workerLog.lines.slice(-40).join('\n  '));
  workerLog?.close?.();
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
