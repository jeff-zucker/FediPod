// gateway-move-run.mjs — an address moves from one gateway to another, end to
// end, offline.
//
// Two local servers play two gateways, a and b, each running the real
// routeFront over its own directory; a scratch CSS provides the pod; a stub
// follower's inbox sits on a. In headless Chrome, on a's page: sign up
// fronted at a, boot the agent, give it one follower. Then on b's page: the
// same pod signs in, the account is read as one held at a, moveIn brings it
// to b, the agent boots under b's ids and, once active, tells a and sends
// the Move. Asserts a's row, a's stub actor, a's redirects, b's actor, and
// the Move the follower received — actor a, target b, signed under a's key.
//
//   node claude/validation/browser-agent/gateway-move-run.mjs
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

const CSS_PORT = 3346; const A_PORT = 8987; const B_PORT = 8988; const CDP_PORT = 9347;
const ISSUER = `http://localhost:${CSS_PORT}`; const A = `http://localhost:${A_PORT}`; const B = `http://localhost:${B_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-gwmove-'));
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
const bundle = path.join(tmp, 'test.js');
await buildApp({ entry: path.join(here, 'entry.mjs'), out: bundle });

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.GW_DEBUG) process.stderr.write(d); });
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }

const loader = `<!doctype html><meta charset=utf-8><title>gw</title><script type=module>import * as t from '/test.js'; window.T=t; window.__ready=true;</script>`;
// The follower: an actor on a, whose inbox records what it is sent.
const received = [];
const peerActor = `${A}/peer/1`; const peerInbox = `${A}/peer/1/inbox`;
const gateway = (origin, port) => {
  const dir = {};
  const ctx = { host: `localhost:${port}`, frontOrigin: origin, offersPods: false, gatewayWebId: `${origin}/gw#me`,
    lookup: (h) => dir[h] || null, putDirectory: async (h, r) => { dir[h] = r; }, listDirectory: async () => dir,
    podPut: async () => true, podGet: async (u) => fetch(u, { headers: { accept: 'application/activity+json' } }) };
  const server = http.createServer(async (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loader); }
    if (p === '/test.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(bundle)); }
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (p === '/peer/1') { res.writeHead(200, { 'content-type': 'application/activity+json' }); return res.end(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: peerActor, type: 'Person', preferredUsername: 'peer1', inbox: peerInbox })); }
    if (p === '/peer/1/inbox') { received.push({ headers: req.headers, body: JSON.parse(body?.toString() || '{}') }); res.writeHead(202); return res.end(); }
    const request = new Request(origin + req.url, { method: req.method, headers: req.headers, body, duplex: body ? 'half' : undefined });
    const out = await routeFront(request, ctx).catch((e) => ({ status: 500, headers: {}, body: String(e.stack || e) }));
    res.writeHead(out.status, out.headers || {}); res.end(out.body || '');
  });
  return { dir, ctx, server };
};
const a = gateway(A, A_PORT); const b = gateway(B, B_PORT);
await new Promise((r) => a.server.listen(A_PORT, '127.0.0.1', r));
await new Promise((r) => b.server.listen(B_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let tabt; for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tabt = l.find((t) => t.type === 'page'); if (tabt) break; } catch {} await sleep(500); }
const ws = new WebSocket(tabt.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('cdp'))); });
let seq = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }; return r.result?.result?.value; };
const ready = async () => { for (let i = 0; i < 40; i++) { if (await ev('window.__ready === true')) return; await sleep(200); } throw new Error('page never ready'); };
const handle = 'mover' + Math.floor(Math.random() * 1e6);
const email = `${handle}@example.org`; const password = 'correct horse battery staple';
const podSession = (name) => `window.T.podSession({ issuer:${JSON.stringify(ISSUER)}, email:${JSON.stringify(email)}, password:${JSON.stringify(password)}, podName:${JSON.stringify(handle)}, name:${JSON.stringify(name)} })`;
try {
  await send('Page.enable'); await send('Runtime.enable');

  // --- at a: sign up fronted, boot, and have one follower -------------------
  await send('Page.navigate', { url: `${A}/` }); await ready();
  const atA = await ev(`(async () => { const T = window.T;
    const session = await ${podSession('move-a')};
    const s = await T.signUp({ handle:${JSON.stringify(handle)}, shape:'front' }, { session, frontOrigin: ${JSON.stringify(A)} });
    window.__log = []; const ag = new T.BrowserAgent({ log: (m)=>window.__log.push(String(m)) });
    await ag.boot({ oidc: session, frontOrigin: ${JSON.stringify(A)} });
    await ag.provisioning;
    ag.tagfeed?.stop?.();
    // One follower, on record, so there is somebody to tell.
    ag.store.setContacts({ followers: [{ id: ${JSON.stringify(peerActor)}, inbox: ${JSON.stringify(peerInbox)} }], following: [] });
    await ag.store.flush();
    // Hand the lease back: this page is about to be left for b's.
    await ag.lease.release();
    return { address: s.address, pod: s.pod, actor: ag.urls.actor, mode: ag.status().mode }; })()`);
  if (atA?.__error) throw new Error('at a: ' + atA.__error);
  check(atA.address === `@${handle}@localhost:${A_PORT}` && atA.actor === `${A}/u/${handle}/ap/actor`, `the account lives at a: ${atA.address}`);
  const actorAtA = await (await fetch(`${A}/u/${handle}/ap/actor`, { headers: { accept: 'application/activity+json' } })).json();
  check(actorAtA.id === atA.actor && !actorAtA.movedTo, 'a serves the actor under its own id, not moved');
  const keyPem = actorAtA.publicKey?.publicKeyPem;

  // --- at b: the same pod signs in, and the account is read as held at a ----
  await send('Page.navigate', { url: `${B}/` }); await ready();
  const newHandle = handle + 'b';
  const atB = await ev(`(async () => { const T = window.T;
    const session = await ${podSession('move-b')};
    const here = await T.readAccount(session);
    let refused = null;
    try { await T.signUp({ handle:${JSON.stringify(newHandle)} }, { session, frontOrigin: ${JSON.stringify(B)} }); } catch (e) { refused = e.message; }
    const m = await T.moveIn({ handle:${JSON.stringify(newHandle)} }, { session, frontOrigin: ${JSON.stringify(B)} });
    window.__log = []; const ag = new T.BrowserAgent({ log: (m)=>window.__log.push(String(m)) });
    await ag.boot({ oidc: session, frontOrigin: ${JSON.stringify(B)} });
    await ag.provisioning;
    ag.tagfeed?.stop?.();
    if (ag.status().mode !== 'active') await ag.requestTakeover();
    let cfg = null;
    for (let i = 0; i < 120; i++) { cfg = ag.store.getConfig(); if (cfg.movedFrom?.completedAt) break; await new Promise((r) => setTimeout(r, 500)); }
    window.__agent = ag;
    return { here, refused, address: m.address, actor: ag.urls.actor, mode: ag.status().mode, movedFrom: cfg.movedFrom, aliases: cfg.aliases, log: window.__log.slice(-15) }; })()`);
  if (atB?.__error) throw new Error('at b: ' + atB.__error);
  check(atB.here?.frontHost === `localhost:${A_PORT}` && atB.here.address === `@${handle}@localhost:${A_PORT}`, `b reads the pod's account as held at a: ${atB.here?.address}`);
  check(/already hosts/.test(atB.refused || ''), 'a plain sign-up on that pod is still refused');
  check(atB.address === `@${newHandle}@localhost:${B_PORT}` && atB.actor === `${B}/u/${newHandle}/ap/actor`, `moveIn brings it to b under a new handle: ${atB.address}`);
  check(atB.mode === 'active', `the agent at b is the active one (${atB.mode})`);
  check(!!atB.movedFrom?.completedAt && atB.movedFrom.actor === atA.actor, `the move completed: ${JSON.stringify(atB.movedFrom)}`);
  check(atB.movedFrom?.moveSent === 1 && !atB.movedFrom.moveFailed, 'the Move went to the one follower');
  if (!atB.movedFrom?.completedAt) for (const l of atB.log) console.log('  agent:', l);

  // --- a: the row, the stub, the redirects, the shut door -------------------
  check(a.dir[handle]?.movedTo === atB.actor && !!a.dir[handle].movedAt, 'a\'s row records the new address');
  const stub = await (await fetch(`${A}/u/${handle}/ap/actor`, { headers: { accept: 'application/activity+json' } })).json();
  check(stub.id === atA.actor && stub.movedTo === atB.actor && stub.alsoKnownAs?.includes(atB.actor) && !stub.alsoKnownAs.includes(atA.actor),
    'a serves the old actor as a stub: old id, movedTo the new, the new among its aliases');
  check(stub.publicKey?.id === `${atA.actor}#main-key` && stub.publicKey.publicKeyPem === keyPem, 'under the same key, keyed by the old id');
  const redir = await fetch(`${A}/u/${handle}/ap/outbox`, { redirect: 'manual', headers: { accept: 'application/activity+json' } });
  check(redir.status === 301 && redir.headers.get('location') === `${B}/u/${newHandle}/ap/outbox`, 'an old id redirects to the new one');
  const door = await fetch(`${A}/u/${handle}/ap/inbox/`, { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: '{}' });
  check(door.status === 410, `a's door for it is shut (${door.status})`);

  // --- b: the new actor names the old as an alias ------------------------------
  const fresh = await (await fetch(`${B}/u/${newHandle}/ap/actor`, { headers: { accept: 'application/activity+json' } })).json();
  check(fresh.id === atB.actor && fresh.alsoKnownAs?.includes(atA.actor) && fresh.publicKey?.publicKeyPem === keyPem,
    'b serves the actor under the new id, the old as an alias, the same key');

  // --- the follower: a Move from the old actor, signed under the old key ------
  const mv = received.find((r) => r.body?.type === 'Move');
  check(!!mv && mv.body.actor === atA.actor && mv.body.object === atA.actor && mv.body.target === atB.actor,
    `the follower received a Move from the old actor to the new: ${mv ? mv.body.id : 'nothing arrived'}`);
  check(!!mv && /keyId="[^"]*#main-key"/.test(mv.headers.signature || '') && mv.headers.signature.includes(`${atA.actor}#main-key`),
    'signed under the old key id, which the stub at a vouches for');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally { ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); a.server.close(); b.server.close(); await sleep(300); delete process.env.AP_ALLOW_PRIVATE_TARGETS; try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
