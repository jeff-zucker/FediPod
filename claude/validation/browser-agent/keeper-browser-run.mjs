// keeper-browser-run.mjs — the owner's side of letting the gateway act while
// the app is closed: on its first full start the app names the gateway's pod
// identity in the rules on its account's folders and tells the gateway; the
// manage page turns it off and on again.
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

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const CSS_BIN = path.join(root, 'packages/fedipod-server/node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { signUpThroughPage } = await import(new URL('./page-signup.mjs', import.meta.url));
const { watchWorkerLog } = await import(new URL('./worker-log.mjs', import.meta.url));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3368; const APP_PORT = 8996; const CDP_PORT = 9368;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-sw-'));

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
css.stderr.on('data', (d) => process.env.SW_DEBUG && process.stderr.write(d));
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s`); process.exit(1); }

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

const KEEPER = 'https://keeper.example/profile/card#me';
const keeperCalls = [];
const hereCalls = [];
let kept = false;
const server = http.createServer((q, s) => {
  const u = q.url.split('?')[0];
  if (u === '/api/attach') return attachStub(q, s, `http://localhost:${APP_PORT}`);
  if (u === '/api/relay') return relayStub(q, s);
  // A stand-in gateway that can act for accounts: it names its keeper when the
  // app says it is here, and records what the owner says about keeping.
  if (['/api/open', '/api/keeper', '/api/here'].includes(u) && q.method === 'POST') {
    let raw = ''; q.on('data', (d) => { raw += d; });
    q.on('end', () => {
      const body = JSON.parse(raw || '{}');
      if (u === '/api/keeper') { keeperCalls.push({ on: body.on, auth: !!q.headers.authorization }); kept = body.on === true; }
      if (u === '/api/here') hereCalls.push(body);
      const out = u === '/api/open' ? { ok: true, handle: body.handle, paused: false, closed: false, keeper: KEEPER, kept }
        : u === '/api/keeper' ? { ok: true, handle: body.handle, kept, keeper: KEEPER } : { ok: true, handle: body.handle, flushed: 0 };
      s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify(out));
    });
    return;
  }
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
  await send('Page.enable'); await send('Runtime.enable');
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
  for (let i = 0; i < 60 && !keeperCalls.some((c) => c.on === true); i++) await sleep(1000);
  check(keeperCalls.some((c) => c.on === true && c.auth), `on its first full start the app tells the gateway it may act, with the pod sign-in as proof (${JSON.stringify(keeperCalls)})`);

  const pod = `http://${handle}.localhost:${CSS_PORT}/`;
  const { mintCredential, createGrantSession } = require(path.join(root, 'vendor/idp-grant.cjs'));
  const cred = await mintCredential({ origin: ISSUER, email: `${handle}@example.org`, password, name: 'keeper-browser-run' });
  const owner = createGrantSession(cred);
  const rule = async (url) => (await owner.fetch(url + '.acl', { headers: { accept: 'text/turtle' } })).text();
  const names = async (url) => /keeper\.example/.test(await rule(url));
  check(await names(pod + 'fedipod/ap-state/') && await names(pod + 'fedipod/'),
    'its folder and its state now name the keeper');
  check(await names(pod + 'fedipod/ap/actor'), 'and so does the rule on its public actor');
  check((await fetch(pod + 'fedipod/ap/actor', { headers: { accept: 'application/activity+json' } })).status === 200,
    'which is still public');
  const page = (p, init = {}) => evaluate(`(async () => { const r = await fetch(${JSON.stringify(p)}, { ...${JSON.stringify(init)}, headers: { 'x-fedipod-page': '1', 'content-type': 'application/json' } }); return { status: r.status, json: await r.json().catch(() => null) }; })()`);
  const g1 = await page('/gateway');
  check(g1.status === 200 && g1.json?.keeper?.on === true, `the manage page shows the account kept running (${JSON.stringify(g1.json?.keeper)})`);

  const off = await page('/gateway/keep', { method: 'POST', body: JSON.stringify({ on: false }) });
  check(off.status === 200 && keeperCalls.at(-1)?.on === false, `turning it off tells the gateway first (${off.status})`);
  check(!(await names(pod + 'fedipod/ap-state/')) && !(await names(pod + 'fedipod/ap/actor')), 'and takes the keeper out of the rules');
  check((await page('/gateway')).json?.keeper?.on === false, 'and the manage page says so');
  // Turning it back on, from the manage page.
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/admin/` });
  const $ = (id) => `document.getElementById(${JSON.stringify(id)})`;
  let offered = false;
  for (let i = 0; i < 60 && !offered; i++) { await sleep(500); offered = await evaluate(`!!${$('gateway-keep-on')} && !${$('gateway-keep-on')}.hidden && ${$('gateway-keep-on')}.offsetParent !== null`).catch(() => false); }
  check(offered, 'the manage page offers to keep the account running');
  const callsBefore = keeperCalls.length;
  await evaluate(`${$('gateway-keep-on')}.click()`);
  for (let i = 0; i < 40 && keeperCalls.length === callsBefore; i++) await sleep(500);
  check(keeperCalls.at(-1)?.on === true && await names(pod + 'fedipod/ap-state/'), 'one click turns it back on and names the gateway again');
  // Scheduling, now that something runs when the time comes.
  const at = new Date(Date.now() + 5 * 60_000).toISOString();
  const scheduled = await evaluate(`(async () => {
    const j = async (m, p, opt = {}) => (await fetch(p, { method: m, ...opt })).json();
    const app = await j('POST', '/api/v1/apps', { headers:{'content-type':'application/json'}, body: JSON.stringify({ client_name:'t', redirect_uris:'urn:ietf:wg:oauth:2.0:oob', scopes:'read write' }) });
    const authz = await j('GET', '/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri:'urn:ietf:wg:oauth:2.0:oob', response_type:'code', scope:'read write' }));
    const t = await j('POST', '/oauth/token', { headers:{'content-type':'application/json'}, body: JSON.stringify({ grant_type:'authorization_code', code: authz.code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri:'urn:ietf:wg:oauth:2.0:oob' }) });
    const r = await fetch('/api/v1/statuses', { method: 'POST', headers: { authorization: 'Bearer ' + t.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'later on', scheduled_at: ${JSON.stringify(at)} }) });
    return { status: r.status, body: await r.json() };
  })()`);
  check(scheduled.status === 200 && scheduled.body?.scheduled_at, `a client can schedule a post (${scheduled.status})`);
  for (let i = 0; i < 20 && !hereCalls.some((h) => h.nextAt && Date.parse(h.nextAt) === Date.parse(at)); i++) await sleep(500);
  check(hereCalls.some((h) => h.nextAt && Date.parse(h.nextAt) === Date.parse(at)), 'and the gateway is told when it falls due');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  if (fails && workerLog?.lines?.length) console.log('\n--- the agent said ---\n  ' + workerLog.lines.slice(-40).join('\n  '));
  workerLog?.close?.();
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
