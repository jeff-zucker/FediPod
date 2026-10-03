// sw-run.mjs — the agent, hosted in a service worker, answering the Mastodon
// API the way it will in production.
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

const CSS_PORT = 3338; const APP_PORT = 8976; const CDP_PORT = 9338;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-sw-'));

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'],
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
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
  for (let i = 0; i < 40; i++) { if (await evaluate('typeof window.fedipodSignup === "function"')) break; await sleep(250); }

  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  const password = 'correct horse battery staple';
  // The pod is made first, the page sends the browser to the pod's login,
  // and the identity screen on the way back sets the account up and boots.
  await signUpThroughPage(evaluate, sleep, { issuer: ISSUER, appOrigin: `http://localhost:${APP_PORT}`, handle, email: `${handle}@example.org`, password });
  let ready = null;
  for (let i = 0; i < 60; i++) {
    ready = await evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()');
    if (ready) break;
    await sleep(500);
  }
  check(!!ready, `sign-up, sign-in, worker registered, agent booted into it: ${ready}`);

  // A way in from this side, for putting mail in the pod's inbox the way a
  // gateway does. Its own credential.
  workerLog = await watchWorkerLog(WebSocket, CDP_PORT);
  const pod = `http://${handle}.localhost:${CSS_PORT}/`;
  const { mintCredential, createGrantSession } = require(path.join(root, 'vendor/idp-grant.cjs'));
  const cred = await mintCredential({ origin: ISSUER, email: `${handle}@example.org`, password, name: 'sw-run-post' });
  const podSession = createGrantSession(cred);
  const podFetch = (u, i) => podSession.fetch(u, i);

  // Every call below is an ordinary fetch() to this origin — the worker
  // intercepts it and the agent answers. Nothing else is serving these paths.
  const flow = await evaluate(`(async () => {
    const j = async (m, p, opt = {}) => { const r = await fetch(p, { method: m, ...opt }); return { status: r.status, body: await r.text() }; };
    const inst = JSON.parse((await j('GET', '/api/v1/instance')).body);
    const app = JSON.parse((await j('POST', '/api/v1/apps', { headers:{'content-type':'application/json'}, body: JSON.stringify({ client_name:'test', redirect_uris:'urn:ietf:wg:oauth:2.0:oob', scopes:'read write' }) })).body);
    const authz = JSON.parse((await j('GET', '/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri:'urn:ietf:wg:oauth:2.0:oob', response_type:'code', scope:'read write' }))).body);
    const tok = JSON.parse((await j('POST', '/oauth/token', { headers:{'content-type':'application/json'}, body: JSON.stringify({ grant_type:'authorization_code', code: authz.code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri:'urn:ietf:wg:oauth:2.0:oob' }) })).body);
    const me = JSON.parse((await j('GET', '/api/v1/accounts/verify_credentials', { headers:{ authorization:'Bearer '+tok.access_token } })).body);
    const posted = JSON.parse((await j('POST', '/api/v1/statuses', { headers:{ authorization:'Bearer '+tok.access_token, 'content-type':'application/json' }, body: JSON.stringify({ status:'posted through the service worker' }) })).body);
    const home = JSON.parse((await j('GET', '/api/v1/timelines/home?limit=20', { headers:{ authorization:'Bearer '+tok.access_token } })).body);
    window.__token = tok.access_token;
    return { instanceUri: inst.uri, controlled: !!navigator.serviceWorker.controller, gotToken: !!tok.access_token, meAcct: me.username, postId: posted.id, postContent: posted.content, homeCount: Array.isArray(home) ? home.length : -1 };
  })()`);
  if (flow?.__error) throw new Error('facade via worker: ' + flow.__error);
  check(flow.controlled, 'the page is controlled by the agent service worker');
  check(!!flow.instanceUri, `instance answered through the worker (${flow.instanceUri})`);
  check(flow.gotToken && flow.meAcct === handle, `a full sign-in through the worker returns the account: @${flow.meAcct}`);
  check(!!flow.postId && /through the service worker/.test(flow.postContent || ''), 'a status posts through the worker');
  check(flow.homeCount >= 1, `the home timeline through the worker carries the post (${flow.homeCount})`);

  // --- a picture, all the way to the pod and back -------------------------
  //
  // The multipart parse has a unit proof; the pod PUT that follows it does not,
  // and neither does the browser's own FormData reaching the worker intact. So
  // this posts real PNG bytes and then fetches the stored file back from the
  // pod as a stranger would — the media container is world-readable, which is
  // the point of it.
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da636460000002000005fe02fea9b5cf7a0000000049454e44ae426082', 'hex');
  const media = await evaluate(`(async () => {
    const bytes = new Uint8Array(${JSON.stringify([...PNG])});
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'image/png' }), 'dot.png');
    fd.append('description', 'a single pixel');
    const up = await fetch('/api/v2/media', { method: 'POST', headers: { authorization: 'Bearer ' + ${JSON.stringify('')} + window.__token }, body: fd });
    const m = await up.json();
    const st = await fetch('/api/v1/statuses', { method: 'POST',
      headers: { authorization: 'Bearer ' + window.__token, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'with a picture', media_ids: [m.id] }) });
    const posted = await st.json();
    return { status: up.status, id: m.id, url: m.url, description: m.description,
      attached: (posted.media_attachments || []).map((a) => a.url) };
  })()`);
  if (media?.__error) throw new Error('media: ' + media.__error);
  check(media.status === 200 && /\/ap\/media\//.test(media.url || ''),
    `an upload through the worker lands in the pod's media container (${media.url})`);
  const served = media.url ? await fetch(media.url) : { status: 0 };
  const back = served.status === 200 ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0);
  check(served.status === 200 && back.equals(PNG) && served.headers.get('content-type') === 'image/png',
    `and the pod serves those exact bytes to anyone (${served.status}, ${back.length} of ${PNG.length} bytes)`);
  check(media.attached.length === 1 && media.attached[0] === media.url,
    'and a status posted with it carries it as an attachment');

  // --- notifications, paged the way a client pages them -------------------
  //
  // Five people follow this account, delivered into the pod's inbox the way
  // real mail lands. Then the client walks them two at a time by following the
  // `Link` header rather than guessing ids — which is the part that only works
  // if the header names an address this origin actually answers on.
  for (let n = 1; n <= 5; n++) {
    const activity = { '@context': 'https://www.w3.org/ns/activitystreams',
      id: `http://localhost:${APP_PORT}/peer/${n}/follows/1`, type: 'Follow',
      actor: `http://localhost:${APP_PORT}/peer/${n}`, object: `${pod}fedipod/ap/actor` };
    const r = await podFetch(`${pod}fedipod/ap/inbox/follow-${n}.json`, {
      method: 'PUT', headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify(activity) });
    if (r.status >= 400) throw new Error(`could not post mail to the pod inbox: HTTP ${r.status}`);
  }
  // With the pod's push channel open this is seconds, not the two-minute
  // fallback poll — which is the difference the socket makes, and the reason the
  // wait is timed below rather than just waited out.
  const mailedAt = Date.now();
  let notes = [];
  for (let i = 0; i < 200; i++) {
    const got = await evaluate(`(async () => { const r = await fetch('/api/v1/notifications?limit=30', { headers: { authorization: 'Bearer ' + window.__token } }); return r.ok ? (await r.json()).length : -1; })()`);
    if (got >= 5) break;
    await sleep(1000);
  }
  const waited = Math.round((Date.now() - mailedAt) / 1000);
  check(waited < 30, `mail arrives over the pod's socket, not the two-minute poll (${waited}s)`);
  const paged = await evaluate(`(async () => {
    const pages = []; const seen = []; const hosts = [];
    let next = '/api/v1/notifications?limit=2';
    for (let i = 0; i < 5 && next; i++) {
      const r = await fetch(next, { headers: { authorization: 'Bearer ' + window.__token } });
      const batch = await r.json();
      if (!batch.length) break;
      pages.push(batch.length); seen.push(...batch.map((n) => n.id));
      const link = r.headers.get('link') || '';
      const m = /<([^>]+)>; rel="next"/.exec(link);
      if (!m) { next = null; continue; }
      const u = new URL(m[1]);
      // The agent names itself https, because the deployed site is. This one is
      // served over plain http, so the host is checked and only the scheme is
      // put back — the part being tested is that a client can follow the link
      // it was handed and land on the next page.
      hosts.push(u.host);
      next = u.pathname + u.search;
    }
    return { pages, seen, unique: new Set(seen).size, hosts, origin: location.host };
  })()`);
  if (paged?.__error) throw new Error('notifications: ' + paged.__error);
  notes = paged.seen || [];
  check(notes.length >= 5 && paged.unique === notes.length,
    `following the Link header walks every notification once (${paged.pages?.join('+')} = ${notes.length}, ${paged.unique} distinct)`);
  check((paged.pages || []).slice(0, 2).every((n) => n === 2),
    `and honours the page size it was asked for (${(paged.pages || []).join(', ')})`);
  check((paged.hosts || []).length > 0 && paged.hosts.every((h) => h === paged.origin),
    `and every link it hands out names this origin (${[...new Set(paged.hosts || [])].join(', ')})`);
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  // The agent lives in the worker, so its console is the only account of what it
  // did. Shown when something went wrong, where it is the first thing wanted.
  if (fails && workerLog?.lines?.length) console.log('\n--- the agent said ---\n  ' + workerLog.lines.slice(-40).join('\n  '));
  workerLog?.close?.();
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
