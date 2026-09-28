// resume-run.mjs — a failed setup resumes from the first unfinished step.
//
// Same rig as gateway-run: a scratch CSS for pods, a local server playing the
// gateway. But the gateway's attach FAILS the first time it is called and
// succeeds the second. In headless Chrome we run signUp twice with the same
// answers: the first throws at the gateway step; the second must RESUME —
// reusing the account, credential and key it already made (their steps report
// 'ok' with no 'running') and only retrying the gateway. Proves setup continues
// mid-flow instead of restarting.
//
//   node claude/validation/browser-agent/resume-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url'; import { createRequire } from 'node:module';
import { buildApp } from '../../../scripts/build-app.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const { routeFront } = await import(pathToFileURL(path.join(root, 'lib/gateway/front-core.mjs')));
const CSS_BIN = path.join(root, 'packages/fedipod-server/node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3343; const FRONT_PORT = 8986; const CDP_PORT = 9348;
const ISSUER = `http://localhost:${CSS_PORT}`; const FRONT = `http://localhost:${FRONT_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-resume-'));
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
const bundle = path.join(tmp, 'test.js');
await buildApp({ entry: path.join(here, 'entry.mjs'), out: bundle });

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
css.stderr.on('data', (d) => process.env.RS_DEBUG && process.stderr.write(d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${ISSUER}/`)).status) break; } catch {} await sleep(500); }

const dir = {};
let attachN = 0;   // the gateway attach fails the first time, succeeds after
const loader = `<!doctype html><meta charset=utf-8><title>rs</title><script type=module>import * as t from '/test.js'; window.T=t; window.__ready=true;</script>`;
const ctx = { host: `localhost:${FRONT_PORT}`, frontOrigin: FRONT, offersPods: false, gatewayWebId: `${FRONT}/gw#me`,
  lookup: (h) => dir[h] || null,
  putDirectory: async (h, r) => { attachN++; if (attachN === 1) throw new Error('gateway down (test)'); dir[h] = r; },
  listDirectory: async () => dir,
  podPut: async () => true, podGet: async (u) => fetch(u, { headers: { accept: 'application/activity+json' } }) };
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/' ) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loader); }
  if (p === '/test.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(bundle)); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(FRONT + req.url, { method: req.method, headers: req.headers, body, duplex: body ? 'half' : undefined });
  const out = await routeFront(request, ctx).catch((e) => ({ status: 500, headers: {}, body: String(e.stack || e) }));
  res.writeHead(out.status, out.headers || {}); res.end(out.body || '');
});
await new Promise((r) => server.listen(FRONT_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let tabt; for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tabt = l.find((t) => t.type === 'page'); if (tabt) break; } catch {} await sleep(500); }
const ws = new WebSocket(tabt.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('cdp'))); });
let seq = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }; return r.result?.result?.value; };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `${FRONT}/` });
  for (let i = 0; i < 40; i++) { if (await ev('window.__ready === true')) break; await sleep(200); }
  const handle = 'resume' + Math.floor(Math.random() * 1e6);
  const out = await ev(`(async () => { const T = window.T;
    const session = await T.podSession({ issuer:${JSON.stringify(ISSUER)}, email:${JSON.stringify(handle + '@example.org')}, password:'correct horse battery staple', podName:${JSON.stringify(handle)}, name:'resume-test' });
    const answers = { handle:${JSON.stringify(handle)} };
    const ev1 = []; let err1 = null;
    try { await T.signUp(answers, { session, frontOrigin:${JSON.stringify(FRONT)}, onStep:(k,st)=>ev1.push(k+':'+st) }); } catch(e){ err1 = e.message; }
    const ev2 = []; let addr2 = null, err2 = null;
    try { const s = await T.signUp(answers, { session, frontOrigin:${JSON.stringify(FRONT)}, onStep:(k,st)=>ev2.push(k+':'+st) }); addr2 = s.address; } catch(e){ err2 = e.message; }
    return { err1, ev1, addr2, err2, ev2 }; })()`);
  if (out?.__error) throw new Error('resume run: ' + out.__error);
  // First attempt: checked the pod, then failed at the gateway — which comes
  // before the key, because a fronted key is stamped with the gateway actor.
  check(!!out.err1 && /gateway/i.test(out.err1), `first attempt fails at the gateway: ${out.err1}`);
  check(out.ev1.includes('pod:ok') && !out.ev1.includes('keys:ok'), 'first attempt checked the pod and never reached the key');
  check(out.ev1.includes('gateway:running') && !out.ev1.includes('gateway:ok'), 'first attempt reached the gateway but did not finish it');
  // Second attempt: RESUMES — the pod step reports ok with NO running, gateway retried, key made.
  check(!out.err2 && !!out.addr2, `second attempt succeeds: ${out.addr2 || out.err2}`);
  check(out.ev2.includes('pod:ok') && !out.ev2.includes('pod:running'), 'resume skips the pod check (ok, no running)');
  check(out.ev2.includes('gateway:running') && out.ev2.includes('gateway:ok'), 'resume retries and finishes the gateway');
  check(out.ev2.includes('keys:running') && out.ev2.includes('keys:ok'), 'and then makes and stores the key');
  check(Object.values(dir).some((r) => r.handle === handle && r.hmacSecret), 'the gateway directory row exists after resume');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally { ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300); delete process.env.AP_ALLOW_PRIVATE_TARGETS; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
