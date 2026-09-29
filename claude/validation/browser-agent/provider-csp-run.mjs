// provider-csp-run.mjs — the shipped sign-up page, in a real browser, reaching
// a pod provider that is not the one it used to name.
//
// The page's own policy is what decides this, and it is enforced by the browser
// rather than by anything we can unit-test: a blocked request looks exactly like
// a server being down. So this loads the page EXACTLY as it ships — no rewriting
// — and watches for the browser's own policy-violation report while the page
// tries to reach several providers.
//
//   node claude/validation/browser-agent/provider-csp-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const APP_PORT = 8982; const CDP_PORT = 9342;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-csp-'));

// The page as it ships, and the two files it pulls in. Nothing else is served:
// a request that gets a 404 still tells us whether the policy allowed it.
const appDir = path.join(root, 'web/app');
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const file = p === '/' ? path.join(appDir, 'index.html') : path.join(appDir, p);
  if (!file.startsWith(appDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('no'); }
  const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
  res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(file));
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

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/` });
  await sleep(1500);

  // The browser reports every refusal here, so an empty report is the page
  // being allowed to ask — which is the whole question.
  await evaluate(`(() => { window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.blockedURI + ' | ' + e.violatedDirective));
    return true; })()`);

  // Providers people actually use, none of them the one the page used to name.
  // The requests fail — these hosts do not answer a probe like this — and that
  // is fine: a REFUSAL is reported, a failure is not.
  const providers = ['https://inrupt.net', 'https://teamid.live', 'https://pod.example.org'];
  const tried = await evaluate(`(async () => {
    const out = [];
    for (const p of ${JSON.stringify(providers)}) {
      try { await fetch(p + '/.well-known/openid-configuration', { mode: 'cors' }); out.push([p, 'asked']); }
      catch (e) { out.push([p, String(e.message || e)]); }
    }
    await new Promise((r) => setTimeout(r, 300));
    return { out, violations: window.__violations };
  })()`);
  check(Array.isArray(tried?.violations) && tried.violations.length === 0,
    `the page may ask any https provider (${(tried?.violations || []).join('; ') || 'no refusals'})`);

  // The listener really does catch a refusal — otherwise the check above passes
  // on a page that reports nothing at all. `http:` is outside the policy, and a
  // page served over https could not reach it in any case.
  const control = await evaluate(`(async () => {
    window.__violations = [];
    try { await fetch('http://blocked.example/x'); } catch { /* expected */ }
    await new Promise((r) => setTimeout(r, 300));
    return window.__violations;
  })()`);
  check(Array.isArray(control) && control.some((v) => /connect-src/.test(v)),
    `and a provider outside the policy IS refused, so the check above means something (${(control || []).join('; ') || 'nothing reported'})`);

  // The lock that makes the one above safe to have: the page that reads the
  // password is the page we shipped, and no other script runs on it.
  const script = await evaluate(`(async () => {
    window.__violations = [];
    const s = document.createElement('script');
    s.src = 'https://evil.example/x.js';
    document.head.appendChild(s);
    await new Promise((r) => setTimeout(r, 400));
    return window.__violations;
  })()`);
  check(Array.isArray(script) && script.some((v) => /script-src/.test(v)),
    `a script from anywhere else is still refused (${(script || []).join('; ') || 'nothing reported'})`);
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  ws.close(); chrome.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
