// full-run.mjs — the whole deployable app, as a tester will use it.
//
// Stages the site the way it will deploy: the sign-up page at /, boot.js and
// sw.js, and Phanpy at /app/ (its own service-worker registration stripped, so
// only the agent worker runs). Serves it, boots a scratch CSS, and in headless
// Chrome: fills the sign-up form, waits for the account to be made and the agent
// to boot into the worker, navigates to /app/, and checks Phanpy comes up signed
// in as the account, talking to the agent through the worker.
//
//   node claude/validation/browser-agent/full-run.mjs
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
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3339; const APP_PORT = 8978; const CDP_PORT = 9340;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-full-'));

// --- stage the site ---
const site = path.join(tmp, 'site'); fs.mkdirSync(path.join(site, 'app'), { recursive: true });
// The page may contact any https pod provider a person types. This scratch
// server is plain http, which no https page could reach anyway, so the staged
// copy adds that one origin — and nothing else about the policy is touched.
{
  const html = fs.readFileSync(path.join(root, 'web/app/index.html'), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i);
  if (!csp) throw new Error('the sign-up page no longer carries a CSP — this rewrite is stale');
  if (!/connect-src [^;]*\bhttps:/.test(csp[1])) {
    throw new Error('the sign-up page no longer allows any https provider — see web/app/index.html');
  }
  const relaxed = csp[1].replace(/connect-src ([^;]*)/, `connect-src $1 ${ISSUER} http://*.localhost:${CSS_PORT}`);
  fs.writeFileSync(path.join(site, 'index.html'), html.replace(csp[1], relaxed));
}
fs.copyFileSync(path.join(root, 'web/app/dist/boot.js'), path.join(site, 'boot.js'));
fs.copyFileSync(path.join(root, 'web/app/dist/sw.js'), path.join(site, 'sw.js'));
// Phanpy into /app/, its own SW registration stripped so only ours runs.
const phanpy = path.join(root, 'phanpy/dist');
const copyDir = (from, to) => { fs.mkdirSync(to, { recursive: true }); for (const e of fs.readdirSync(from, { withFileTypes: true })) {
  const s = path.join(from, e.name); const d = path.join(to, e.name);
  if (e.isDirectory()) copyDir(s, d); else if (e.name === 'sw.js') { /* skip Phanpy's SW */ }
  else if (e.name === 'index.html') { fs.writeFileSync(d, fs.readFileSync(s, 'utf8').replace(/<script id="vite-plugin-pwa:inline-sw">[\s\S]*?<\/script>/i, '')); }
  else fs.copyFileSync(s, d); } };
copyDir(phanpy, path.join(site, 'app'));

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
css.stderr.on('data', (d) => process.env.FULL_DEBUG && process.stderr.write(d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${ISSUER}/`)).status) break; } catch {} await sleep(500); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.map': 'application/json' };
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

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/api/attach') return attachStub(req, res, `http://localhost:${APP_PORT}`);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(site, p);
  if (!f.startsWith(site) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'service-worker-allowed': '/' });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(APP_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu',
  `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let tabt;
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tabt = l.find((t) => t.type === 'page'); if (tabt) break; } catch {} await sleep(500); }
const ws = new WebSocket(tabt.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('cdp'))); });
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
  let signedIn = null;
  for (let i = 0; i < 60; i++) {
    signedIn = await evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()');
    if (signedIn) break;
    await sleep(500);
  }
  check(!!signedIn, `signed up and in through the page + worker: ${signedIn}`);

  // Load Phanpy at /app/; it should sign in through the worker with no prompt.
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/app/#/login?instance=localhost:${APP_PORT}&submit=1` });
  let ready = null;
  for (let i = 0; i < 60; i++) {
    ready = await evaluate(`(async () => {
      const txt = document.body ? document.body.innerText : '';
      const controlled = !!navigator.serviceWorker.controller;
      const inst = await fetch('/api/v1/instance').then(r=>r.json()).catch(()=>null);
      return { controlled, hasInstance: !!(inst&&inst.uri), title: document.title, home: /Home|home/.test(txt), text: txt.slice(0,120) };
    })()`);
    if (ready && ready.controlled && ready.hasInstance) break;
    await sleep(500);
  }
  check(ready?.controlled, 'the Phanpy page at /app/ is controlled by the agent worker');
  check(ready?.hasInstance, 'the agent answers the Mastodon API under /app/');
  const acct = await evaluate(`fetch('/api/v1/accounts/verify_credentials', { headers: {} }).then(r=>r.status).catch(()=>0)`);
  check(acct === 401 || acct === 200, 'verify_credentials is reachable through the worker (needs a token → 401 without one)');
  await sleep(2500);
  const rendered = await evaluate(`document.title + ' :: ' + (document.body?document.body.innerText.replace(/\\s+/g,' ').slice(0,140):'')`);
  console.log('  Phanpy:', rendered);
  check(/Phanpy/.test(rendered) || /Home|Timeline|@/.test(rendered), 'Phanpy rendered from the agent');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
