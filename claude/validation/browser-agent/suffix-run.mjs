// suffix-run.mjs — a pod on a PATH of a suffix-based host becomes a Fediverse account
// with its address at the Gateway, end to end, offline.
//
// A scratch CSS 7 in suffix mode (css-memory-suffix.json: pods at
// http://localhost:PORT/<name>/). One local server plays fedipod.net: it serves
// the bundled app AND runs the real Gateway (routeFront). In headless Chrome:
// signUp makes the account and pod, sees the pod is a path, and attaches
// FRONTED; the BrowserAgent then boots from a session, builds its ids at the
// Gateway, writes the actor to the pod under those ids, and the Gateway answers
// WebFinger and serves the actor. A Follow POSTed to the door lands in the pod's
// inbox and the agent answers it through the relay, signed as the Gateway actor.
//
//   node claude/validation/browser-agent/suffix-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url'; import { createRequire } from 'node:module';
import { buildApp } from '../../../scripts/build-app.mjs';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { signRequest } from '@fedify/fedify/sig';
import { dependentDir } from '../../../scripts/dependents.mjs';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const { routeFront } = await import(pathToFileURL(path.join(root, 'lib/gateway/front-core.mjs')));
const CSS_BIN = path.join(dependentDir('fedipod-server'), 'node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3343; const FRONT_PORT = 8982; const CDP_PORT = 9344; const REMOTE_PORT = 8983;
const ISSUER = `http://localhost:${CSS_PORT}`; const FRONT = `http://localhost:${FRONT_PORT}`; const REMOTE = `http://127.0.0.1:${REMOTE_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-suffix-'));
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
const bundle = path.join(tmp, 'test.js');
await buildApp({ entry: path.join(here, 'entry.mjs'), out: bundle });

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', path.join(here, 'css-memory-suffix.json'), '-b', `${ISSUER}/`, '-l', 'warn'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.GW_DEBUG) process.stderr.write(d); });
let cssUp = false;
for (let i = 0; i < 360; i++) { try { if ((await fetch(`${ISSUER}/`)).status === 200) { cssUp = true; break; } } catch {} await sleep(500); }
if (!cssUp) { console.log('FAIL  the scratch CSS did not come up within 180s' + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); css.kill('SIGKILL'); process.exit(1); }

// A remote server's inbox, to receive the Accept. Its actor publishes a key,
// so a Follow it signs is verified at the door and answered without approval —
// as a Mastodon follow is.
const remoteKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const remotePem = remoteKeys.publicKey.export({ type: 'spki', format: 'pem' });
const remoteSigner = await webcrypto.subtle.importKey('pkcs8', remoteKeys.privateKey.export({ type: 'pkcs8', format: 'der' }),
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);   // Fedify's signer insists on extractable
const delivered = [];
const remote = http.createServer((req, res) => {
  const m = /^\/u\/([a-z]+)$/u.exec(req.url || '');
  if (m) { res.writeHead(200, { 'content-type': 'application/activity+json' }); return res.end(JSON.stringify({
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'], id: `${REMOTE}/u/${m[1]}`, type: 'Person', preferredUsername: m[1],
    inbox: `${REMOTE}/u/${m[1]}/inbox`, outbox: `${REMOTE}/u/${m[1]}/outbox`,
    publicKey: { id: `${REMOTE}/u/${m[1]}#main-key`, owner: `${REMOTE}/u/${m[1]}`, publicKeyPem: remotePem } })); }
  if (req.method === 'POST' && /^\/u\/[a-z]+\/inbox$/u.test(req.url || '')) {
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { delivered.push(JSON.parse(Buffer.concat(c).toString())); } catch {} res.writeHead(202).end(); });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => remote.listen(REMOTE_PORT, '127.0.0.1', r));

const dir = {};
const loader = `<!doctype html><meta charset=utf-8><title>suffix</title><script type=module>import * as t from '/test.js'; window.T=t; window.__ready=true;</script>`;
const ctx = { host: `localhost:${FRONT_PORT}`, frontOrigin: FRONT, offersPods: false, gatewayWebId: `${FRONT}/gw#me`,
  lookup: (h) => dir[h] || null, putDirectory: async (h, r) => { dir[h] = r; }, listDirectory: async () => dir,
  // The door writes into the pod's public-Append inbox as the front does.
  podPut: async (_h, url, body, ct) => { const r = await fetch(url, { method: 'PUT', headers: { 'content-type': ct }, body }).catch(() => null); return !!r && r.status < 400; },
  // No verifier stub: the real Solid-OIDC token check runs against the local
  // CSS, for the attach and for the relay alike, as gateway-run does.
  podGet: async (u) => fetch(u, { headers: { accept: 'application/activity+json' } }) };
const server = http.createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loader); }
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
const until = async (label, pred, ms = 30000) => { const end = Date.now() + ms; for (;;) { try { if (await pred()) return true; } catch {} if (Date.now() > end) { check(false, `${label} (timed out)`); return false; } await sleep(500); } };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `${FRONT}/` });
  for (let i = 0; i < 40; i++) { if (await ev('window.__ready === true')) break; await sleep(200); }
  const handle = 'pathy' + Math.floor(Math.random() * 1e6);
  const out = await ev(`(async () => { const T = window.T;
    const session = await T.podSession({ issuer:${JSON.stringify(ISSUER)}, email:${JSON.stringify(handle + '@example.org')}, password:'correct horse battery staple', podName:${JSON.stringify(handle)}, name:'suffix-test' });
    const s = await T.signUp({ handle:${JSON.stringify(handle)}, shape:'pod' }, { session, frontOrigin: ${JSON.stringify(FRONT)} });
    window.__log = []; const a = new T.BrowserAgent({ log: (m)=>window.__log.push(String(m)) });
    await a.boot({ oidc: session, frontOrigin: ${JSON.stringify(FRONT)} });
    await a.provisioning;
    // No reading of public hashtags from real servers in a test.
    a.tagfeed?.stop?.(); a.tagfeed?.setConfig?.({ tags: [] });
    window.__agent = a;
    return { address: s.address, pod: s.pod, webId: session.webId, gateway: s.config.gateway, actor: a.urls.actor, podActor: a.urls.toPod ? a.urls.toPod(a.urls.actor) : null, keyId: a.deliverer.keyId, host: a.masto?.host || null }; })()`);
  if (out?.__error) throw new Error('signup+boot: ' + out.__error);
  check(new URL(out.pod).pathname !== '/', `the pod the server made is on a path: ${out.pod}`);
  check(out.address === `@${handle}@localhost:${FRONT_PORT}`, `so the address lives at the Gateway even though 'pod' was asked for: ${out.address}`);
  check(out.gateway?.frontActor === `${FRONT}/u/${handle}/ap/actor` && out.gateway.mode === 'trust', 'the config carries the Gateway actor');
  check(!!dir[handle] && !dir[handle].inboxOnly && dir[handle].podHome === out.pod + 'fedipod/', 'the Gateway row is fronted, keyed by the bare handle, pointing at the pod tree');
  check(out.actor === `${FRONT}/u/${handle}/ap/actor` && out.podActor === out.pod + 'fedipod/ap/actor',
    'the agent advertises the Gateway actor and maps it back to the pod for writes');
  check(out.keyId === `${FRONT}/u/${handle}/ap/actor#main-key`, 'and signs with the Gateway key id, which is what the relay checks');
  const onPodRes = await fetch(out.pod + 'fedipod/ap/actor', { headers: { accept: 'application/activity+json' } });
  const onPod = onPodRes.status === 200 ? await onPodRes.json().catch(() => ({})) : {};
  check(onPod.id === `${FRONT}/u/${handle}/ap/actor`, `the actor written to the pod carries the Gateway id (${onPodRes.status}): ${onPod?.id}`);
  if (onPodRes.status !== 200) {
    const inboxRes = await fetch(out.pod + 'fedipod/ap/inbox/', { headers: { accept: 'text/turtle' } });
    console.log(`  pod actor → ${onPodRes.status}; pod inbox → ${inboxRes.status}`);
    const log = await ev('window.__log.slice(-25)');
    for (const l of log || []) console.log('  agent:', l);
  }
  const wf = await (await fetch(`${FRONT}/.well-known/webfinger?resource=acct:${handle}@localhost:${FRONT_PORT}`)).json().catch(() => ({}));
  check((wf.links || []).some((l) => l.rel === 'self' && l.href === `${FRONT}/u/${handle}/ap/actor`) && (wf.aliases || []).includes(out.pod + 'fedipod/ap/actor'),
    'the Gateway answers WebFinger for the handle, naming the pod actor as an alias');
  const served = await (await fetch(`${FRONT}/u/${handle}/ap/actor`, { headers: { accept: 'application/activity+json' } })).json().catch(() => ({}));
  check(served.id === `${FRONT}/u/${handle}/ap/actor` && served.inbox === `${FRONT}/u/${handle}/ap/inbox/` && !!served.publicKey?.publicKeyPem,
    'and serves the actor with its key, inbox at the door');
  // A stranger follows the fronted identity: the door writes into the pod inbox, the agent answers.
  const followReq = await signRequest(new Request(`${FRONT}/u/${handle}/ap/inbox/`, { method: 'POST', headers: { 'content-type': 'application/activity+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${REMOTE}/f/1`, type: 'Follow', actor: `${REMOTE}/u/dave`, object: `${FRONT}/u/${handle}/ap/actor` }) }),
  remoteSigner, new URL(`${REMOTE}/u/dave#main-key`));
  const follow = await fetch(followReq);
  const followWhy = await follow.json().catch(() => ({}));
  check(follow.status === 202, `a signed Follow to the door is taken and verified (${follow.status} ${followWhy.reason || ''})`);
  await ev('window.__agent.intake.drain().catch(()=>{})');
  const answered = await until('the Follow is answered through the relay', async () => delivered.some((d) => d.type === 'Accept'));
  if (!answered) for (const l of (await ev('window.__agent && window.__log.slice(-15)')) || []) console.log('  agent:', l);
  const acc = delivered.find((d) => d.type === 'Accept');
  check(answered && acc?.actor === `${FRONT}/u/${handle}/ap/actor`, `the Accept is signed and sent as the Gateway actor (${acc?.actor})`);
} catch (e) { console.log('ERROR', e.message); fails++; }
finally { ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); remote.close(); await sleep(300); delete process.env.AP_ALLOW_PRIVATE_TARGETS; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
