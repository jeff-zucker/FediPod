// gateway-run.mjs — the deployed browser-only gateway path, end to end, offline.
//
// One local server plays fedipod.net: it serves the bundled app modules AND runs
// the real gateway (routeFront). A scratch CSS provides pods. In headless Chrome:
// signUp attaches to the gateway and writes the key + config to the pod
// (owner-only); then the agent boots from a SESSION that reads that config + key
// back from the pod — the same boot path the real OIDC redirect uses (here the
// session is a client-credential stand-in, since a real OIDC session needs CSS's
// consent screen, which oidc-run covers separately). Asserts the gateway row, the
// actor advertising the door as its inbox, and that boot-from-session works.
//
//   node claude/validation/browser-agent/gateway-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url'; import { createRequire } from 'node:module';
import { buildApp } from '../../../scripts/build-app.mjs';
import { dependentDir } from '../../../scripts/dependents.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const { routeFront } = await import(pathToFileURL(path.join(root, 'lib/gateway/front-core.mjs')));
const CSS_BIN = path.join(dependentDir('fedipod-server'), 'node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3341; const FRONT_PORT = 8980; const CDP_PORT = 9342;
const ISSUER = `http://localhost:${CSS_PORT}`; const FRONT = `http://localhost:${FRONT_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-gw-'));
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
const bundle = path.join(tmp, 'test.js');
await buildApp({ entry: path.join(here, 'entry.mjs'), out: bundle });

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.GW_DEBUG) process.stderr.write(d); });
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }

const dir = {};
const loader = `<!doctype html><meta charset=utf-8><title>gw</title><script type=module>import * as t from '/test.js'; window.T=t; window.__ready=true;</script>`;
const ctx = { host: `localhost:${FRONT_PORT}`, frontOrigin: FRONT, offersPods: false, gatewayWebId: `${FRONT}/gw#me`,
  lookup: (h) => dir[h] || null, putDirectory: async (h, r) => { dir[h] = r; }, listDirectory: async () => dir,
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
let tabt; for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tabt = l.find((t) => t.type === 'page'); if (tabt) break; } catch {} await sleep(500); }
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
  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  const out = await ev(`(async () => { const T = window.T;
    // The pod first, then sign-up on a session for it, then boot the agent
    // from that SESSION reading config + key back from the pod (the deployed
    // path). The deployed path's session is Solid-OIDC, which needs a person
    // at a login form; a DPoP session over a credential presents the same
    // WebID to the pod and is what this test stands in with.
    const session = await T.podSession({ issuer:${JSON.stringify(ISSUER)}, email:${JSON.stringify(handle + '@example.org')}, password:'correct horse battery staple', podName:${JSON.stringify(handle)}, name:'gateway-test' });
    window.__session = session;
    const s = await T.signUp({ handle:${JSON.stringify(handle)} }, { session, frontOrigin: ${JSON.stringify(FRONT)} });
    const a = new T.BrowserAgent({ log: ()=>{} });
    await a.boot({ oidc: session, frontOrigin: ${JSON.stringify(FRONT)} });
    await a.provisioning;   // provisioning is now backgrounded; the test needs the published face

    return { address: s.address, pod: s.pod, handle: a.store.getConfig().handle }; })()`);
  if (out?.__error) throw new Error('signup+boot-from-session: ' + out.__error);
  check(!!out.address, `sign-up (gateway attach) + boot-from-session: ${out.address}`);
  check(out.handle === handle, 'boot read the account config back from the pod');
  const key = `${handle}@${new URL(out.pod).host}`;                 // the directory is keyed by full address now
  check(!!dir[key] && dir[key].inboxOnly && !!dir[key].hmacSecret, 'the gateway has an inbox-only directory row (keyed by full address)');
  check(dir[key] && dir[key].actorUrl === out.pod + 'fedipod/ap/actor', `the stored actor url is under the pod root: ${dir[key] && dir[key].actorUrl}`);
  check(dir[key] && dir[key].address === `@${handle}@${new URL(out.pod).host}`, `the row records the full address: ${dir[key] && dir[key].address}`);
  const doorInbox = `${FRONT}/u/${encodeURIComponent(key)}/ap/inbox/`;
  const actor = await ev(`fetch(${JSON.stringify(out.pod)} + 'fedipod/ap/actor', { headers:{accept:'application/activity+json'} }).then(r=>r.json()).catch(e=>({__e:e.message}))`);
  check(actor && actor.inbox === doorInbox, `the actor's inbox is the gateway door: ${actor?.inbox}`);
  const policy = await ev(`fetch(${JSON.stringify(out.pod)} + 'fedipod/ap/gateway-policy.json').then(r=>r.ok?r.json():null).catch(()=>null)`);
  check(policy && policy.inboxUrl === `${out.pod}fedipod/ap/inbox/`, 'the gateway policy names the pod inbox to forward to');
  // A second sign-up on a pod that already hosts an account is refused, and
  // says so — never a second account, never a second attach.
  const again = await ev(`(async () => { try { const s = await window.T.signUp({ handle:${JSON.stringify(handle)} }, { session: window.__session, frontOrigin:${JSON.stringify(FRONT)} }); return { ok:true, address:s.address }; } catch(e){ return { ok:false, error:e.message }; } })()`);
  check(again?.ok === false && /already hosts/.test(again?.error || ''), `signing up again on the same pod is refused: ${again?.error || again?.address}`);
} catch (e) { console.log('ERROR', e.message); fails++; }
finally { ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300); delete process.env.AP_ALLOW_PRIVATE_TARGETS; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
