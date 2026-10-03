// unlock-run.mjs — a new browser needs nothing, and an old account is opened once.
//
// Since 1.28.0 the signing key is stored on the pod as it is, in the owner-only
// state container, and a browser that has never seen this account reads it
// with its pod session and asks for nothing. The one password a new browser
// used to ask for is gone — except for an account made before 1.28.0, whose
// key on the pod is still under the sign-up password: that browser is asked
// once, the key is written back as it is, and nobody is asked again. The same
// pane offers a new key to someone who has lost that password.
//
// The state under test is "this browser has never opened this key", reached
// here by throwing the opened copy away rather than by starting a second
// browser. That is the same state, reached by the same door: everything from
// `fedipodOnLoad` onwards is the code a genuinely new browser runs. The
// pre-1.28.0 state is reached by putting an envelope on the pod, the way the
// old sign-up did.
//
//   node claude/validation/browser-agent/unlock-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
import { dependentDir } from '../../../scripts/dependents.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const { signUpThroughPage } = await import(new URL('./page-signup.mjs', import.meta.url));
const { mintCredential, makeDpopSession } = await import(path.join(root, 'web/app/pod-auth.mjs'));
const CSS_BIN = path.join(dependentDir('fedipod-server'), 'node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3344; const APP_PORT = 8984;
const ISSUER = `http://localhost:${CSS_PORT}`;
const APP = `http://localhost:${APP_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-unlock-'));

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.UNLOCK_DEBUG) process.stderr.write(d); });
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }

// The mail door, stubbed: sign-up attaches to it, and there is no front here.
const attachStub = (req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    const { handle } = JSON.parse(raw || '{}');
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, handle, doorInbox: `${APP}/u/${handle}/ap/inbox/`,
      hmacSecret: Buffer.from(`door-secret-for-${handle}`).toString('base64') }));
  });
};

// The page exactly as it ships, plus the CSP's one concession to a scratch
// server on plain http (see full-run.mjs) — and the admin pages boot.js sends
// the browser to once the agent is up.
const indexHtml = (() => {
  const html = fs.readFileSync(path.join(root, 'web/app/index.html'), 'utf8');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i);
  const relaxed = csp[1].replace(/connect-src ([^;]*)/, `connect-src $1 ${ISSUER} http://*.localhost:${CSS_PORT}`);
  return html.replace(csp[1], relaxed);
})();
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/attach') return attachStub(req, res);
  if (u === '/' || u === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(indexHtml); }
  const rel = u === '/boot.js' ? 'web/app/dist/boot.js' : u === '/sw.js' ? 'web/app/dist/sw.js'
    : u.startsWith('/admin/') ? path.join('web', u.endsWith('/') ? u + 'index.html' : u) : null;
  const f = rel && path.join(root, rel);
  if (f && f.startsWith(root) && fs.existsSync(f) && !fs.statSync(f).isDirectory()) {
    const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css' : 'text/javascript';
    res.writeHead(200, { 'content-type': type }); return res.end(fs.readFileSync(f));
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(APP_PORT, '127.0.0.1', r));

// One browser, driven over the devtools protocol. Two of these run in turn.
async function browser(name, cdpPort) {
  const proc = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*',
    `--user-data-dir=${path.join(tmp, name)}`, 'about:blank'], { stdio: 'ignore' });
  let tab;
  for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json(); tab = l.find((t) => t.type === 'page'); if (tab) break; } catch {} await sleep(500); }
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
  await send('Page.enable'); await send('Runtime.enable');
  return { send, evaluate, close() { try { ws.close(); } catch {} proc.kill('SIGKILL'); } };
}

const handle = 'tester' + Math.floor(Math.random() * 1e6);
const email = `${handle}@example.org`;
const password = 'correct horse battery staple';

// Throw this browser's opened key away and stop its worker: the state a browser
// that has never seen this account arrives in, reached by the same door.
const forgetOpenedKey = (page) => page.evaluate(`(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('fedipod-accounts', 1);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const before = await new Promise((res) => { const rq = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys(); rq.onsuccess = () => res(rq.result || []); });
  const keys = before.filter((k) => String(k).startsWith('signing-keys:'));
  await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite');
    for (const k of keys) tx.objectStore('kv').delete(k);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  // The worker holds the key it was handed at boot, so leaving it running
  // would leave this browser able to sign — which is the opposite of the
  // state being set up. A browser that has never seen this account has no
  // worker either.
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  return keys.length;
})()`);
const waitForPane = async (page) => {
  let pane = null;
  for (let i = 0; i < 60; i++) {
    pane = await page.evaluate(`(() => { const u = document.getElementById('unlock');
      return u ? { shown: !u.hidden, hasField: !!document.getElementById('unlock-password') } : null; })()`);
    if (pane?.shown) break;
    await sleep(500);
  }
  return pane;
};
// The first error the pane shows after a click, or '' if none within ten seconds.
const clickForError = (page, buttonId, value) => page.evaluate(`(async () => {
  document.getElementById('unlock-password').value = ${JSON.stringify(value)};
  document.getElementById(${JSON.stringify(buttonId)}).click();
  for (let i = 0; i < 40; i++) {
    const e = document.getElementById('unlock-error').textContent;
    if (e) return e;
    await new Promise((r) => setTimeout(r, 250));
  }
  return '';
})()`);
const INSTANCE = '(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()';
const waitForAgent = async (page) => {
  let up = null;
  for (let i = 0; i < 120; i++) { up = await page.evaluate(INSTANCE); if (up) break; await sleep(500); }
  return up;
};
// A client token, then who the account is — and, when asked, one post through
// it: a write is what makes a read-only viewer take the lease over and act.
const whoAmI = (page, { post = false } = {}) => page.evaluate(`(async () => {
  const app = await (await fetch('/api/v1/apps', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'unlock-test', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write' }) })).json();
  const authz = await (await fetch('/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', response_type: 'code', scope: 'read write' }))).json();
  const tok = await (await fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: authz.code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' }) })).json();
  const h = { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json' };
  if (${post ? 'true' : 'false'}) await fetch('/api/v1/statuses', { method: 'POST', headers: h, body: JSON.stringify({ status: 'signed with the new key' }) });
  const me = await (await fetch('/api/v1/accounts/verify_credentials', { headers: h })).json();
  return me.username || me.acct || null;
})()`);
let first = null; let second = null;
try {
  // --- the browser that makes the account -------------------------------
  first = await browser('chrome-a', 9344);
  await first.send('Page.navigate', { url: `${APP}/` });
  for (let i = 0; i < 40; i++) { if (await first.evaluate('typeof window.fedipodSignup === "function"')) break; await sleep(250); }
  await signUpThroughPage(first.evaluate, sleep, { issuer: ISSUER, appOrigin: APP, handle, email, password });
  let up = null;
  for (let i = 0; i < 60; i++) {
    up = await first.evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()');
    if (up) break;
    await sleep(500);
  }
  check(!!up, `the first browser makes the account and runs it: ${up}`);

  const pod = `http://${handle}.localhost:${CSS_PORT}/`;
  // The public key the world sees, or null while the document is not yet
  // public: provisioning runs in the background after the feed is up, and
  // the actor's Read ACL is set inside it.
  const publishedKey = async () => {
    const r = await fetch(`${pod}fedipod/ap/actor`, { headers: { accept: 'application/activity+json' } });
    if (!r.ok) return null;
    return (await r.json().catch(() => ({}))).publicKey?.publicKeyPem || null;
  };
  let keyBefore = null;
  for (let i = 0; i < 120 && !keyBefore; i++) { keyBefore = await publishedKey(); if (!keyBefore) await sleep(500); }
  check(!!keyBefore, 'the actor document is public and publishes a key once provisioning finishes');
  const keyDoc = await fetch(`${pod}fedipod/ap-state/keys.json`);
  check(keyDoc.status === 401 || keyDoc.status === 403,
    `the key on the pod is not readable by a stranger (${keyDoc.status})`);

  // --- and now a browser that has never opened this key --------------------
  //
  // The pod session stays: being signed in is what lets a browser read the
  // key from the pod. Throwing the opened key away leaves exactly the pair a
  // new browser arrives with — a session, and no copy of its own.
  second = first;
  const forgotten = await forgetOpenedKey(second);
  check(forgotten === 1, `the account made exactly one opened key in this browser (${forgotten})`);
  await second.send('Page.navigate', { url: `${APP}/` });
  const secondUp = await waitForAgent(second);
  // A boot that asked for nothing goes straight on into the client; the
  // pane, had it shown, would have held the page at the root.
  let where = '';
  for (let i = 0; i < 40 && !/\/admin\/client\//.test(where); i++) { where = await second.evaluate('location.pathname'); if (!/\/admin\/client\//.test(where)) await sleep(250); }
  check(!!secondUp && /\/admin\/client\//.test(where), `a browser with no opened key reads the pod's and runs, asking for nothing: ${secondUp} → ${where}`);
  const acct = await whoAmI(second);
  check(acct === handle, `and it is the same account, not a new one: @${acct}`);

  // --- an account made before 1.28.0: the key on the pod under a password ---
  //
  // Put the old envelope back where the key is, the way the old sign-up
  // wrote it (PBKDF2-SHA256 + AES-GCM under the password), and forget the
  // opened copy: this browser is now the one that has to ask.
  const cred = await mintCredential({ issuer: ISSUER, email, password, podUrl: pod, name: 'unlock-test' });
  const dpop = await makeDpopSession(cred);
  const keysUrl = `${pod}fedipod/ap-state/keys.json`;
  const readKeyDoc = async () => (await dpop.fetch(keysUrl, { headers: { accept: 'application/json' } })).json();
  const plain = await readKeyDoc();
  check(!!plain?.rsa?.privatePem && !plain.ct, 'the key on the pod is the record itself, not an envelope');
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  const wrap = async (rec, pw) => {
    const salt = crypto.getRandomValues(new Uint8Array(16)); const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
    const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(rec)));
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations: 310000, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  };
  const putEnvelope = async () => {
    const r = await dpop.fetch(keysUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await wrap(plain, password)) });
    if (r.status >= 400) throw new Error(`could not write the envelope (HTTP ${r.status})`);
  };
  await putEnvelope();
  await forgetOpenedKey(second);
  await second.send('Page.navigate', { url: `${APP}/` });
  const pane = await waitForPane(second);
  check(pane?.shown && pane.hasField, 'a pre-1.28.0 key is asked for its password, not left broken');

  const wrong = await clickForError(second, 'unlock-go', 'not the password');
  check(!!wrong && !/^\s*$/.test(String(wrong)), `a wrong password is refused and says so (${String(wrong).slice(0, 60)})`);

  const opened = await second.evaluate(`(async () => {
    document.getElementById('unlock-password').value = ${JSON.stringify(password)};
    document.getElementById('unlock-go').click();
    return true;
  })()`);
  if (opened?.__error) throw new Error('unlock: ' + opened.__error);
  const thirdUp = await waitForAgent(second);
  check(!!thirdUp, `the right password opens it and the account runs here too: ${thirdUp}`);
  check(await whoAmI(second) === handle, 'and it is still the same account');
  const rewritten = await readKeyDoc();
  check(!!rewritten?.rsa?.privatePem && !rewritten.ct && rewritten.rsa.privatePem === plain.rsa.privatePem,
    'and the opened key is written back to the pod as it is, so no browser asks again');

  // --- the old password is gone: a new key from the same pane ----------
  await putEnvelope();
  await forgetOpenedKey(second);
  await second.send('Page.navigate', { url: `${APP}/` });
  check((await waitForPane(second))?.shown, 'with the envelope back and the opened key gone, the pane is back');
  const confirmShown = await second.evaluate(`(() => {
    document.getElementById('unlock-newkey').click();
    return !document.getElementById('unlock-newkey-confirm').hidden; })()`);
  check(confirmShown, 'the new-key button asks before replacing anything');
  await second.evaluate(`(async () => { document.getElementById('unlock-newkey-go').click(); return true; })()`);
  const fourthUp = await waitForAgent(second);
  check(!!fourthUp, `a new key, with nothing typed, runs the account: ${fourthUp}`);
  // The boot after a new key is a viewer until it acts (the old agent's lease
  // is still on the pod); one post makes it take over, and going active
  // publishes the profile — with the new key in it.
  check(await whoAmI(second, { post: true }) === handle, 'still the same account, and it can post');
  let keyAfter = keyBefore;
  for (let i = 0; i < 120 && (!keyAfter || keyAfter === keyBefore); i++) { await sleep(500); keyAfter = await publishedKey(); }
  check(!!keyAfter && keyAfter !== keyBefore, 'and the actor document now publishes the new public key');
  const fresh = await readKeyDoc();
  check(!!fresh?.rsa?.privatePem && !fresh.ct && fresh.rsa.privatePem !== plain.rsa.privatePem, 'and the new key sits on the pod as it is');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  first?.close(); if (second && second !== first) second.close();
  css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
