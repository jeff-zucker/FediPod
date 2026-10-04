// copy-browser-run.mjs — a kept browser account working from its copy at the
// gateway (lib/gateway/copy.mjs, state-api.mjs, web/app/copy-mode.mjs).
//
// A scratch CSS with a keeper account; the gateway's real owner routes
// (front-core: open, keeper, here) and state API over in-memory stores, with
// the real pod-token verifier; the built app in headless Chrome. Signs up, and
// then: the account moves onto its copy; a post lands in the copy and not on
// the pod; the round writes it to the pod; the hold: the round writes the copy
// to the pod and deletes it, and the browser's next write makes it again; a
// restart comes back onto the copy; the gateway taking the lease stops the
// browser writing, and the browser acting takes it back; the admin turning the
// hold off: the copy goes to the pod, the browser and an app work on the pod
// taking turns, a mention reaches the phone from the pod inbox, and nothing of
// the account is kept at the gateway; turning the keeper off puts everything
// back on the pod.
//
//   node claude/validation/browser-agent/copy-browser-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process'; import crypto from 'node:crypto';
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

const CSS_PORT = 3378; const APP_PORT = 8998; const CDP_PORT = 9378;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-copy-'));
const seed = path.join(tmp, 'seed.json');
fs.writeFileSync(seed, JSON.stringify([{ email: 'keeper@example.org', password: 'keeper-password-2026', pods: [{ name: 'keeper' }] },
  { email: 'keeper2@example.org', password: 'keeper2-password-2026', pods: [{ name: 'keeper2' }] }]));

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '--seedConfig', seed, '-l', 'warn'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.SW_DEBUG) process.stderr.write(d); });
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
    const { handle, podHome, actorUrl } = JSON.parse(raw || '{}');
    rows[handle] = { handle, podHome, actorUrl, kind: 'person', webId: `${new URL(podHome).origin}/profile/card#me` };
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


process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
const lib = (p) => import(path.join(root, p));
const { routeFront, verifyPodToken } = await lib('lib/gateway/front-core.mjs');
const { routeStateApi, endHold } = await lib('lib/gateway/state-api.mjs');
const { routeMastoGateway, pushHeld, pushMade } = await lib('lib/gateway/masto-gateway.mjs');
const ece = require(path.join(root, 'node_modules/http_ece/ece.js'));
const https = await import('node:https');
const { logInAtIdp } = await import(new URL('./idp-login.mjs', import.meta.url));
const { memoryKv, copyMeta, copyLease, flushCopy, GATEWAY_HOLDER } = await lib('lib/gateway/copy.mjs');
const { HttpStorage } = await lib('lib/core/storage.mjs');
const { mintCredential, createGrantSession } = require(path.join(root, 'vendor/idp-grant.cjs'));
const ORIGIN = `http://localhost:${APP_PORT}`;

const rows = {};
// A phone's push service, standing in: an https endpoint that keeps what it is sent.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const PUSH_PORT = 8999;
const pushed = [];
const pushTls = (() => {
  const { execSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-tls-'));
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 1 -subj /CN=localhost 2>/dev/null`);
  return { key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) };
})();
const pushService = https.createServer(pushTls, (q, s) => {
  const chunks = []; q.on('data', (c) => chunks.push(c));
  q.on('end', () => { pushed.push({ headers: q.headers, body: Buffer.concat(chunks) }); s.writeHead(201); s.end(); });
});
await new Promise((r) => pushService.listen(PUSH_PORT, '127.0.0.1', r));
const pendingWork = [];
const callbacks = [];
const kv = memoryKv();
const received = new Map(); const present = new Map(); const held = new Map();
let keeperSession = null;
let keeperWebId = null;
let mentionTarget = null;
const ctx = {
  host: `localhost:${APP_PORT}`, frontOrigin: ORIGIN,
  lookup: async (h) => rows[h] || null,
  listDirectory: async () => ({ ...rows }),
  putDirectory: async (h, r) => { rows[h] = r; },
  readReceived: async (k) => received.get(k) || null, writeReceived: async (k, n) => { received.set(k, n); }, dropReceived: async (k) => { received.delete(k); },
  markPresent: async (h) => { present.set(h, Date.now()); }, presentAt: async (h) => present.get(h) || 0,
  holdMail: async (h, n, b) => { held.set(`${h}/${n}`, b); },
  listHeld: async (h) => [...held.keys()].filter((k) => k.startsWith(`${h}/`)).map((k) => k.slice(h.length + 1)),
  readHeld: async (h, n) => held.get(`${h}/${n}`) ?? null, dropHeld: async (h, n) => { held.delete(`${h}/${n}`); },
  heldAccounts: async () => [...new Set([...held.keys()].map((k) => k.split('/')[0]))],
  podPut: async (_h, url, b, ct) => (await fetch(url, { method: 'PUT', headers: { 'content-type': ct }, body: b }).catch(() => null))?.status < 400,
  noteNext: async () => {},
  get keeperWebId() { return keeperWebId; },
  copyKv: kv,
  mastoKv: memoryKv(),
  keeperCredential: null,
  waitUntil: (p) => { pendingWork.push(p); },
  stateSecret: Buffer.from('a-secret-only-this-test-knows'),
  keeperFetch: async () => (u, i) => keeperSession.fetch(u, i),
  // As push-background does for notifications FediPod named while open.
  pushWanted: async (h) => Number((await ctx.mastoKv.get(`push/${h}`))?.text || 0) > 0,
  startPush: async (h, o) => { if (o?.ids) pendingWork.push(pushMade(ctx, h, rows[h], o.ids, { log: () => {} })); },
};
const gatewayRoute = async (q, s, u) => {
  const chunks = []; for await (const c of q) chunks.push(c);
  const headers = {};
  for (const [k, v] of Object.entries(q.headers)) if (!['content-length', 'connection', 'transfer-encoding', 'host'].includes(k)) headers[k] = v;
  const request = new Request(ORIGIN + q.url, { method: q.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const out = u.startsWith('/api/state/')
    ? await routeStateApi(request, u, ctx, { verifyPodToken })
    : await routeMastoGateway(request, u, ctx, { verifyPodToken }) || await routeFront(request, ctx);
  s.writeHead(out?.status || 404, out?.headers || {}); s.end(out?.body ?? '');
};

const server = http.createServer((q, s) => {
  const u = q.url.split('?')[0];
  if (u === '/api/attach') return attachStub(q, s, ORIGIN);
  if (u === '/api/relay') return relayStub(q, s);
  // An app's own page, where the sign-in sends it back.
  if (u === '/app-callback') { callbacks.push(new URL(ORIGIN + q.url).searchParams); s.writeHead(200, { 'content-type': 'text/html' }); return s.end('<p>back at the app</p>'); }
  // A person on another server, whose post mentions the account.
  if (u === '/peer/1' || /^\/peer\/1\/notes\/\d+$/.test(u)) {
    const actor = `${ORIGIN}/peer/1`;
    const doc = u === '/peer/1'
      ? { '@context': 'https://www.w3.org/ns/activitystreams', id: actor, type: 'Person', preferredUsername: 'aisha', inbox: `${actor}/inbox`, outbox: `${actor}/outbox` }
      : { '@context': 'https://www.w3.org/ns/activitystreams', id: ORIGIN + u, type: 'Note', attributedTo: actor, content: '<p>hello from aisha</p>',
        to: [mentionTarget], tag: [{ type: 'Mention', href: mentionTarget }], published: new Date().toISOString() };
    s.writeHead(200, { 'content-type': 'application/activity+json' }); return s.end(JSON.stringify(doc));
  }
  // The app sign-in page, as the site stages it (scripts/stage-site.mjs).
  if (u === '/app-signin/') return file('web/app-signin/index.html', 'text/html')(q, s);
  if (u === '/app-signin/app-signin.mjs') return file('web/app-signin/app-signin.mjs', 'text/javascript')(q, s);
  if (u === '/app-signin/tokens.css') return file('web/admin/tokens.css', 'text/css')(q, s);
  if (/^\/app-signin\/(fedi-login|oidc-session)\.mjs$/.test(u)) return file(`node_modules/fediverse-session/${path.basename(u)}`, 'text/javascript')(q, s);
  if (u.startsWith('/api/state/') || u.startsWith('/api/v1/') || u.startsWith('/api/v2/') || u.startsWith('/oauth/')
    || u === '/api/authorize' || ['/api/open', '/api/keeper', '/api/here', '/api/push'].includes(u)) {
    return gatewayRoute(q, s, u).catch((e) => { s.writeHead(500); s.end(String(e.stack || e)); });
  }
  if (u === '/' || u === '/index.html') { s.writeHead(200, { 'content-type': 'text/html' }); return s.end(page); }
  if (u === '/dist/boot.js') return file('web/app/dist/boot.js', 'text/javascript')(q, s);
  if (u === '/sw.js') return file('web/app/dist/sw.js', 'text/javascript')(q, s);
  if (u.startsWith('/admin/')) {
    const rel = u.endsWith('/') ? u + 'index.html' : u;
    const f = path.join(root, 'web', rel);
    if (f.startsWith(path.join(root, 'web/admin')) && fs.existsSync(f)) {
      const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
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
let workerLog = null;
let seq = 0; const pend = new Map();
const pageLog = [];
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') pageLog.push('THREW ' + (d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text));
  if (d.method === 'Runtime.consoleAPICalled') pageLog.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const waitFor = async (fn, tries = 60, ms = 500) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await sleep(ms); } return false; };
try {
  cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered again at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }
  const keepCred = await mintCredential({ origin: ISSUER, email: 'keeper@example.org', password: 'keeper-password-2026', name: 'fedipod-keeper' });
  keeperSession = createGrantSession(keepCred);
  keeperWebId = keepCred.webId;
  ctx.keeperCredential = keepCred;

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `${ORIGIN}/` });
  for (let i = 0; i < 40; i++) { if (await evaluate('typeof window.fedipodSignup === "function"')) break; await sleep(250); }
  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  const password = 'correct horse battery staple';
  await signUpThroughPage(evaluate, sleep, { issuer: ISSUER, appOrigin: ORIGIN, handle, email: `${handle}@example.org`, password });
  const ready = await waitFor(async () => !!(await evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok; })()')));
  check(ready, 'signed up and the agent booted in the worker');
  workerLog = await watchWorkerLog(WebSocket, CDP_PORT);
  const pod = `http://${handle}.localhost:${CSS_PORT}/`;
  const state = `${pod}fedipod/ap-state/`;
  const said = (re) => (workerLog?.lines || []).some((l) => re.test(l));

  // ---- onto the copy ----
  check(await waitFor(async () => !!rows[handle]?.keeper && !!(await copyMeta(kv, handle)), 60, 1000),
    'once kept, the account\'s copy is made at the gateway');
  check(await waitFor(async () => said(/working from the account's copy at the gateway/), 30, 500), 'and the browser works from it');
  check(!(await kv.get(`${handle}/d/keys.json`)) && !!(await kv.get(`${handle}/d/config.json`)),
    'the copy holds the account\'s state and not its key');
  const cred = await mintCredential({ origin: ISSUER, email: `${handle}@example.org`, password, name: 'copy-browser-run' });
  const owner = createGrantSession(cred);
  const onPod = async (name) => { const r = await owner.fetch(state + name, { headers: { accept: 'application/json' } }); return r.ok ? r.text() : ''; };
  check(JSON.parse(await onPod('lease.json') || '{}').holder === 'gateway-copy', 'the pod\'s lease is held for the copy');

  // ---- a post lands in the copy ----
  const token = await evaluate(`(async () => {
    const j = async (m, p, opt = {}) => (await fetch(p, { method: m, ...opt })).json();
    const app = await j('POST', '/api/v1/apps', { headers:{'content-type':'application/json'}, body: JSON.stringify({ client_name:'t', redirect_uris:'urn:ietf:wg:oauth:2.0:oob', scopes:'read write' }) });
    const authz = await j('GET', '/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri:'urn:ietf:wg:oauth:2.0:oob', response_type:'code', scope:'read write' }));
    const t = await j('POST', '/oauth/token', { headers:{'content-type':'application/json'}, body: JSON.stringify({ grant_type:'authorization_code', code: authz.code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri:'urn:ietf:wg:oauth:2.0:oob' }) });
    return t.access_token; })()`);
  const post = (text) => evaluate(`(async () => { const r = await fetch('/api/v1/statuses', { method: 'POST', headers: { authorization: 'Bearer ${token}', 'content-type': 'application/json' }, body: JSON.stringify({ status: ${JSON.stringify(text)} }) }); return r.status; })()`);
  const home = () => evaluate(`(async () => { const r = await fetch('/api/v1/timelines/home?limit=40', { headers: { authorization: 'Bearer ${token}' } }); return r.ok ? (await r.json()).map((s) => s.content).join(' | ') : ''; })()`);
  check(await post('written into the copy') === 200, 'a post from the browser');
  check(await waitFor(async () => /written into the copy/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 20, 300),
    'lands in the copy');
  check(!/written into the copy/.test(await onPod('statuses.json')), 'and not yet on the pod');
  const n = await flushCopy(kv, handle, { pod: new HttpStorage(state, (u, i) => keeperSession.fetch(u, i)) });
  check(n > 0 && /written into the copy/.test(await onPod('statuses.json')), `the round writes it to the pod (${n} document(s))`);

  // ---- the hold: the round writes the copy to the pod and deletes it ----
  check(await post('just before the round') === 200
    && await waitFor(async () => /just before the round/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 20, 300),
    'another post lands in the copy');
  const ended = await endHold(ctx, handle, rows[handle], () => {});
  check(ended.ok && !(await copyMeta(kv, handle)) && !(await kv.list(`${handle}/d/`)).length,
    `the round writes the copy to the pod and deletes it, whatever is happening (${ended.why || 'ok'})`);
  check(/just before the round/.test(await onPod('statuses.json')) && JSON.parse(await onPod('lease.json') || '{}').expiresAt === 0,
    'the pod has everything, and its lease is let go');
  check(await post('after the copy was deleted') === 200
    && await waitFor(async () => /after the copy was deleted/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 30, 500)
    && /just before the round/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''),
    'the browser carries on: its next write makes the copy again from the pod, and lands in it');

  // ---- a restart comes back onto the copy ----
  await send('ServiceWorker.enable').catch(() => {});
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1500);
  check(/written into the copy/.test(await home()), 'after a restart the timeline has the post');
  check(await post('after the restart') === 200 && await waitFor(async () => /after the restart/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 20, 300)
    && !/after the restart/.test(await onPod('statuses.json')), 'and the restarted worker writes to the copy too');

  // ---- the gateway acts, then the browser does ----
  check(await copyLease(kv, handle, { id: GATEWAY_HOLDER }).takeover(), 'the gateway takes the lease, as an app acting there would');
  check(await post('taken back by acting here') === 200, 'a post from the browser after that');
  check(await waitFor(async () => /taken back by acting here/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 20, 300)
    && JSON.parse((await kv.get(`${handle}/lease`)).text).holder !== GATEWAY_HOLDER,
    'is not lost: acting here takes the lease back first, and the post lands in the copy');

  // ---- a Mastodon app signs in at the gateway ----
  const appReg = await (await fetch(`${ORIGIN}/api/v1/apps`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_name: 'Test App', redirect_uris: `${ORIGIN}/app-callback`, scopes: 'read write push' }) })).json();
  check(!!appReg.client_id, 'an app registers at the gateway');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = `${ORIGIN}/oauth/authorize?${new URLSearchParams({ client_id: appReg.client_id, redirect_uri: `${ORIGIN}/app-callback`,
    response_type: 'code', scope: 'read write push', state: 'st8', code_challenge: challenge, code_challenge_method: 'S256' })}`;
  await send('Page.navigate', { url: authorize });
  const named = await waitFor(async () => /Test App/.test(await evaluate(`document.getElementById('asking')?.textContent || ''`) || ''), 40, 250);
  if (!named) console.log('  status:', await evaluate(`document.getElementById('signin-status')?.textContent`), await evaluate('document.readyState'));
  check(named,
    'the app\'s sign-in reaches the gateway\'s page, past the worker, and names the app');
  await evaluate(`(() => { const f = document.getElementById('signin-form'); if (!f.hidden) { document.getElementById('address').value = ${JSON.stringify(handle)}; f.requestSubmit(); } })()`);
  await sleep(1500);
  if (!/^http:\/\/localhost:8998\/app-callback/.test(await evaluate('location.href'))) {
    await logInAtIdp(evaluate, sleep, { email: `${handle}@example.org`, password, appOrigin: ORIGIN }).catch((e) => console.log('  ' + e.message));
  }
  check(await waitFor(async () => callbacks.length > 0, 40, 500), `after signing in at the pod the app gets its code (${await evaluate('location.href')})`);
  const cb = callbacks.at(-1);
  check(cb?.get('state') === 'st8', 'with the state it sent');
  const tokRes = await (await fetch(`${ORIGIN}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: cb?.get('code'), client_id: appReg.client_id, redirect_uri: `${ORIGIN}/app-callback`, code_verifier: verifier }) })).json();
  check(!!tokRes.access_token, 'and trades it for a token');
  const appApi = (p, init = {}) => fetch(`${ORIGIN}${p}`, { ...init, headers: { authorization: `Bearer ${tokRes.access_token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const me = await (await appApi('/api/v1/accounts/verify_credentials')).json();
  check(me.username === handle, `the app knows whose account it is (@${me.acct})`);
  const appHome = async () => (await (await appApi('/api/v1/timelines/home')).json()).map((x) => x.content).join(' | ');
  check(/taken back by acting here/.test(await appHome()), 'and reads the timeline from the copy');
  const posted = await appApi('/api/v1/statuses', { method: 'POST', body: JSON.stringify({ status: 'posted from an app' }) });
  const postedJson = await posted.json();
  check(posted.status === 200 && /posted from an app/.test(postedJson.content), `the app posts (${posted.status})`);
  check(/posted from an app/.test((await kv.get(`${handle}/d/statuses.json`))?.text || '') && JSON.parse((await kv.get(`${handle}/lease`)).text).holder === GATEWAY_HOLDER,
    'the post lands in the copy, the gateway having taken the lease to make it');
  check((await fetch(postedJson.uri, { headers: { accept: 'application/activity+json' } })).status === 200, 'and the post itself is public on the pod');
  check(JSON.parse((await kv.get(`${handle}/lease`)).text).expiresAt === 0, 'the gateway lets the lease go once it has acted');
  // Mail held while nobody read it: the app's next check reads it in.
  mentionTarget = rows[handle].actorUrl;            // the account's own actor, as attach recorded it
  held.set(`${handle}/held-mention-1`, JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ORIGIN}/peer/1/creates/1`, type: 'Create',
    actor: `${ORIGIN}/peer/1`, to: [mentionTarget], object: `${ORIGIN}/peer/1/notes/1` }));
  await kv.delete(`${handle}/mail-read-at`);
  await appHome();
  await Promise.all(pendingWork.splice(0));
  check(!held.size, 'mail held for the account is read into the copy after the app\'s check');
  check(await waitFor(async () => /hello from aisha/.test(JSON.stringify(await (await appApi('/api/v1/notifications')).json())), 10, 500),
    'and the app sees it among its notifications on its next check');

  const againStatus = await post('from the browser after the app');
  const landedAgain = await waitFor(async () => /from the browser after the app/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 30, 300);
  const kept = /posted from an app/.test((await kv.get(`${handle}/d/statuses.json`))?.text || '');
  if (!landedAgain || !kept) console.log(`  post ${againStatus}; lease ${(await kv.get(`${handle}/lease`))?.text}; landed ${landedAgain}; app post kept ${kept}`);
  check(againStatus === 200 && landedAgain && kept, 'and the browser acts again straight after, keeping what the app wrote');
  // ---- phone notifications ----
  const phone = crypto.createECDH('prime256v1'); phone.generateKeys();
  const phoneAuth = crypto.randomBytes(16);
  const instance2 = await (await fetch(`${ORIGIN}/api/v2/instance`)).json();
  check(!!instance2.configuration?.vapid?.public_key, 'the instance names its push key, for any app to sign up with');
  const subRes = await appApi('/api/v1/push/subscription', { method: 'POST', body: JSON.stringify({
    subscription: { endpoint: `https://localhost:${PUSH_PORT}/push/1`, keys: { p256dh: phone.getPublicKey().toString('base64url'), auth: phoneAuth.toString('base64url') } },
    data: { alerts: { mention: true, follow: true, favourite: true, reblog: true } } }) });
  const sub = await subRes.json();
  check(subRes.status === 200 && sub.server_key === instance2.configuration.vapid.public_key, `the app signs up for notifications (${subRes.status} ${JSON.stringify(sub).slice(0, 120)})`);
  held.set(`${handle}/held-mention-2`, JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ORIGIN}/peer/1/creates/2`, type: 'Create',
    actor: `${ORIGIN}/peer/1`, to: [mentionTarget], object: `${ORIGIN}/peer/1/notes/2` }));
  const pushedBefore = pushed.length;
  const pushLog = [];
  const notesBefore = JSON.parse((await kv.get(`${handle}/d/notifications.json`))?.text || '[]').length;
  await pushHeld(ctx, handle, rows[handle], { log: (m) => pushLog.push(m) });
  const notesAfter = JSON.parse((await kv.get(`${handle}/d/notifications.json`))?.text || '[]').length;
  if (pushed.length === pushedBefore) console.log(`  notifications ${notesBefore} → ${notesAfter}\n  ` + pushLog.slice(-25).join('\n  '));
  check(!held.size && pushed.length > pushedBefore, `a mention held while every app is closed is read in and pushed to the phone (${pushed.length - pushedBefore} push)`);
  const got = pushed.at(-1);
  let payload = null;
  try { payload = JSON.parse(ece.decrypt(got.body, { version: 'aes128gcm', privateKey: phone, authSecret: phoneAuth.toString('base64url') }).toString()); } catch (e) { console.log('  ' + e.message); }
  check(payload?.notification_type === 'mention' && /aisha/i.test(payload.title || '') && !!payload.notification_id,
    `the phone can read it: ${payload?.title} — ${payload?.body}`);
  check(/^vapid t=/.test(got?.headers?.authorization || ''), 'and it is signed with the instance\'s push key');
  // A mention while FediPod is open: it reaches the pod inbox, FediPod reads it, and the phone hears.
  check(await post('acting again before a mention') === 200, 'FediPod acts again after the push run');
  const openPushed = pushed.length;
  const openMention = await owner.fetch(`${pod}fedipod/ap/inbox/open-mention-4`, { method: 'PUT', headers: { 'content-type': 'application/ld+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ORIGIN}/peer/1/creates/4`, type: 'Create',
      actor: `${ORIGIN}/peer/1`, to: [mentionTarget], object: `${ORIGIN}/peer/1/notes/4` }) });
  const heardOpen = await waitFor(async () => { await Promise.all(pendingWork.splice(0)); return pushed.length > openPushed; }, 60, 1000);
  let openPayload = null;
  try { openPayload = JSON.parse(ece.decrypt(pushed.at(-1).body, { version: 'aes128gcm', privateKey: phone, authSecret: phoneAuth.toString('base64url') }).toString()); } catch (e) { console.log('  ' + e.message); }
  check(openMention.status < 300 && heardOpen && openPayload?.notification_type === 'mention' && /aisha/i.test(openPayload.title || ''),
    `a mention while FediPod is open is read by FediPod and pushed to the phone (${pushed.length - openPushed} push: ${openPayload?.title})`);
  check(await pushMade(ctx, handle, rows[handle], [openPayload?.notification_id], { log: () => {} }) === 0 && pushed.length === openPushed + 1,
    'and named again, it is not pushed twice');

  // ---- the gateway changes its identity: the account moves over ----
  check(await post('written before the switch') === 200
    && await waitFor(async () => /written before the switch/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 20, 300)
    && !/written before the switch/.test(await onPod('statuses.json')), 'a post in the copy that the pod does not have yet');
  const keep2Cred = await mintCredential({ origin: ISSUER, email: 'keeper2@example.org', password: 'keeper2-password-2026', name: 'fedipod-keeper-2' });
  keeperSession = createGrantSession(keep2Cred);          // the operator sets new FEDIPOD_KEEPER_* values
  keeperWebId = keep2Cred.webId;
  ctx.keeperCredential = keep2Cred;
  const appWhileMoving = await appApi('/api/v1/timelines/home');
  check(appWhileMoving.status === 503 && /open FediPod/.test((await appWhileMoving.json()).error || ''),
    'until the owner opens FediPod, an app is told to open it once');
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1000);
  await send('Page.navigate', { url: `${ORIGIN}/` });       // the owner opens FediPod
  const moved = await waitFor(async () => (await copyMeta(kv, handle)) && rows[handle]?.keeper?.webId === keep2Cred.webId, 90, 1000);
  workerLog?.close?.();
  workerLog = await watchWorkerLog(WebSocket, CDP_PORT);
  check(/written before the switch/.test(await onPod('statuses.json')), 'the owner\'s browser wrote the old copy to the pod itself');
  check(moved, 'then the gateway keeps the account under its new identity, with a new copy');
  const stateAcl = await (await owner.fetch(`${state}.acl`, { headers: { accept: 'text/turtle' } })).text();
  check(/keeper2\.localhost/.test(stateAcl) && !/\/\/keeper\.localhost/.test(stateAcl), 'the pod\'s rules name the new identity and no longer the old');
  check(await waitFor(async () => (await appApi('/api/v1/timelines/home')).status === 200, 20, 500), 'and the app works again');
  check(await post('after the switch') === 200
    && await waitFor(async () => /after the switch/.test((await kv.get(`${handle}/d/statuses.json`))?.text || ''), 30, 500),
    'the browser works from the new copy');
  check(await flushCopy(kv, handle, { pod: new HttpStorage(state, (u, i) => keeperSession.fetch(u, i)) }) >= 1
    && /after the switch/.test(await onPod('statuses.json')), 'which the new identity writes to the pod');

  // ---- the admin turns the hold off ----
  ctx.hold = false;
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1000);
  await send('Page.navigate', { url: `${ORIGIN}/` });       // FediPod opened again
  workerLog?.close?.();
  workerLog = await watchWorkerLog(WebSocket, CDP_PORT);
  check(await waitFor(async () => !(await copyMeta(kv, handle)) && !(await kv.list(`${handle}/d/`)).length, 60, 1000)
    && /after the switch/.test(await onPod('statuses.json')),
    'with the hold off, FediPod opening has the copy written to the pod and deleted');
  const browserHolds = async () => { const l = JSON.parse(await onPod('lease.json') || '{}'); return !!l.holder && l.holder !== 'gateway-copy' && !/^keeper:/.test(l.holder) && l.expiresAt > Date.now(); };
  check(await waitFor(browserHolds, 60, 1000), 'and the browser holds the pod\'s lease, working on the pod');
  check(await post('on the pod, the hold off') === 200 && await waitFor(async () => /on the pod, the hold off/.test(await onPod('statuses.json')), 30, 500)
    && !(await kv.list(`${handle}/d/`)).length, 'a post from the browser lands on the pod, and no copy is made');
  const appOff = await appApi('/api/v1/statuses', { method: 'POST', body: JSON.stringify({ status: 'from an app, the hold off' }) });
  check(appOff.status === 200 && /from an app, the hold off/.test(await onPod('statuses.json')), `an app posts straight to the pod (${appOff.status})`);
  check(/^keeper:/.test(JSON.parse(await onPod('lease.json') || '{}').holder || '') && JSON.parse(await onPod('lease.json')).expiresAt === 0,
    'the gateway having taken the pod\'s lease to make it, and let it go');
  check(/from an app, the hold off/.test(await appHome()) && !(await copyMeta(kv, handle)) && !(await kv.list(`${handle}/d/`)).length,
    'the app reads its timeline from the pod, and nothing of the account is kept at the gateway');
  check(await post('from the browser after the app, the hold off') === 200
    && await waitFor(async () => /from the browser after the app, the hold off/.test(await onPod('statuses.json')), 30, 500)
    && /from an app, the hold off/.test(await onPod('statuses.json')),
    'the browser, acting after the app, takes the pod back and keeps what the app wrote');
  // And while FediPod is open, the hold off: FediPod reads it from the pod, and the phone hears.
  const offOpenPushed = pushed.length;
  const offOpenMention = await owner.fetch(`${pod}fedipod/ap/inbox/hold-off-open-mention-5`, { method: 'PUT', headers: { 'content-type': 'application/ld+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ORIGIN}/peer/1/creates/5`, type: 'Create',
      actor: `${ORIGIN}/peer/1`, to: [mentionTarget], object: `${ORIGIN}/peer/1/notes/5` }) });
  check(offOpenMention.status < 300 && await waitFor(async () => { await Promise.all(pendingWork.splice(0)); return pushed.length > offOpenPushed; }, 60, 1000)
    && !(await kv.list(`${handle}/d/`)).length,
    `with the hold off, a mention while FediPod is open is pushed to the phone, and nothing is copied at the gateway (${pushed.length - offOpenPushed} push)`);
  // A mention while FediPod is closed: in the pod inbox, not held; a push run drains it and tells the phone.
  await send('Page.navigate', { url: 'about:blank' });
  await send('ServiceWorker.stopAllWorkers');
  await sleep(1000);
  const inboxItem = `${pod}fedipod/ap/inbox/hold-off-mention-3`;
  const putMention = await owner.fetch(inboxItem, { method: 'PUT', headers: { 'content-type': 'application/ld+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ORIGIN}/peer/1/creates/3`, type: 'Create',
      actor: `${ORIGIN}/peer/1`, to: [mentionTarget], object: `${ORIGIN}/peer/1/notes/3` }) });
  const pushedOff = pushed.length;
  await pushHeld(ctx, handle, rows[handle], { log: () => {} });
  check(putMention.status < 300 && pushed.length > pushedOff && (await owner.fetch(inboxItem)).status === 404,
    `with the hold off, a mention in the pod inbox is drained from there and pushed to the phone (${pushed.length - pushedOff} push)`);
  check(!(await kv.list(`${handle}/d/`)).length && !held.size, 'with nothing held or copied at the gateway');
  await send('Page.navigate', { url: `${ORIGIN}/` });
  await waitFor(browserHolds, 60, 1000);

  // ---- back to the pod ----
  const pageCall = (p, init = {}) => evaluate(`(async () => { const r = await fetch(${JSON.stringify(p)}, { ...${JSON.stringify(init)}, headers: { 'x-fedipod-page': '1', 'content-type': 'application/json' } }); return { status: r.status, json: await r.json().catch(() => null) }; })()`);
  const off = await pageCall('/gateway/keep', { method: 'POST', body: JSON.stringify({ on: false }) });
  check(off.status === 200 && !rows[handle].keeper, `turning the keeper off (${off.status} ${JSON.stringify(off.json)})`);
  check(!(await copyMeta(kv, handle)) && /taken back by acting here/.test(await onPod('statuses.json')),
    'writes the copy to the pod and the gateway lets it go');
  check(JSON.parse(await onPod('lease.json') || '{}').holder !== 'gateway-copy', 'the browser holds the pod\'s lease again');
  check(await post('on the pod again') === 200 && await waitFor(async () => /on the pod again/.test(await onPod('statuses.json')), 20, 500),
    'and writes to the pod again');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }
finally {
  if (fails && workerLog?.lines?.length) console.log('\n--- the agent said ---\n  ' + workerLog.lines.slice(-50).join('\n  '));
  if (fails && pageLog.length) console.log('\n--- the page said ---\n  ' + pageLog.slice(-30).join('\n  '));
  workerLog?.close?.();
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); pushService.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
