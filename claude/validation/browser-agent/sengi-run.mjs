// sengi-run.mjs — Sengi, the real built client, signing in to a real
// BrowserAgent in headless Chrome, with every console line and every failed
// request captured.
//
// Sengi builds every instance URL as `https://${instance}`, so the site has to
// be served over TLS or nothing it does resolves. That is the one difference
// from sw-run.mjs, which this is otherwise a copy of: a scratch CSS, the
// STAGED site (web/app/site, so /sengi/ is the same bundle the alias serves),
// sign-up, the worker, the agent — and then the add-account form driven the
// way a person drives it.
//
// The point is the transcript: a client-side error in Sengi shows for a second
// and is gone, so this prints the console, the failed responses and the login
// URL it was sent to, which is where an OAuth flow actually goes wrong.
//
//   node claude/validation/browser-agent/sengi-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import https from 'node:https'; import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const CSS_BIN = path.join(root, 'packages/fedipod-server/node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { signUpThroughPage } = await import(new URL('./page-signup.mjs', import.meta.url));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3341; const APP_PORT = 8979; const CDP_PORT = 9341;
const ISSUER = `http://localhost:${CSS_PORT}`;
const APP = `https://localhost:${APP_PORT}`;
const INSTANCE = `localhost:${APP_PORT}`;
const SITE = path.join(root, 'web/app/site');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-sengi-'));

if (!fs.existsSync(path.join(SITE, 'sengi/index.html'))) {
  console.error('no staged Sengi — run `node scripts/stage-site.mjs` first'); process.exit(2);
}

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.SENGI_DEBUG) process.stderr.write(d); });
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }

// A self-signed cert for localhost. Chrome is told to ignore it; the only thing
// that matters is that the origin is https, because Sengi will not build a URL
// any other way and a service worker will not register on anything else.
const key = path.join(tmp, 'k.pem'); const crt = path.join(tmp, 'c.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
  '-keyout', key, '-out', crt, '-subj', '/CN=localhost',
  // Pods are subdomains of the issuer, and every one of them is fetched by name.
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const TLS = { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };

// Sign-up attaches to the front's mail door and relays its signed requests
// through it; there is no front here, so both are stubbed exactly as sw-run
// stubs them. Nothing after this cares about more than the shape.
const readAll = (req) => new Promise((r) => { let raw = ''; req.on('data', (d) => { raw += d; }); req.on('end', () => r(raw)); });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const server = https.createServer(TLS, async (q, s) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/api/attach') {
    const { handle } = JSON.parse(await readAll(q) || '{}');
    s.writeHead(201, { 'content-type': 'application/json' });
    return s.end(JSON.stringify({ ok: true, handle, doorInbox: `${APP}/u/${handle}/ap/inbox/`,
      hmacSecret: Buffer.from(`door-secret-for-${handle}`).toString('base64') }));
  }
  if (u === '/api/relay') {
    let out = [];
    try {
      const { requests = [] } = JSON.parse(await readAll(q) || '{}');
      out = await Promise.all(requests.map(async (r) => {
        const method = r.method || 'POST';
        try {
          const sent = await fetch(r.url, { method, headers: r.headers,
            ...(method === 'GET' || method === 'HEAD' ? {} : { body: r.body }) });
          const one = { url: r.url, status: sent.status };
          if (method === 'GET') { one.contentType = sent.headers.get('content-type'); one.body = await sent.text(); }
          return one;
        } catch (e) { return { url: r.url, status: 0, error: String(e.message || e) }; }
      }));
    } catch (e) { out = [{ status: 0, error: String(e.message || e) }]; }
    s.writeHead(200, { 'content-type': 'application/json' });
    return s.end(JSON.stringify({ results: out }));
  }
  // The staged site, with the two _redirects rules this server has to stand in
  // for: a bare /sengi is the directory, and the directory is its index.
  if (u === '/sengi') { s.writeHead(301, { location: '/sengi/' }); return s.end(); }
  let rel = u === '/' ? '/index.html' : u;
  if (rel.endsWith('/')) rel += 'index.html';
  const f = path.join(SITE, rel);
  if (f.startsWith(SITE) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    let out = fs.readFileSync(f);
    // The sign-in page's own CSP says `connect-src 'self' https:` — right for a
    // real deployment, where the pod is https, and fatal here, where the scratch
    // pod is plain http. Widened for this origin only; the file on disk and the
    // page the alias serves are untouched.
    if (rel === '/index.html') out = Buffer.from(String(out).replace("connect-src 'self' https:", `connect-src 'self' https: ${ISSUER} http://*.localhost:${CSS_PORT}`));
    s.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
      ...(rel === '/sw.js' ? { 'service-worker-allowed': '/' } : {}) });
    return s.end(out);
  }
  s.writeHead(404, { 'content-type': 'text/plain' }); s.end('not found');
});
await new Promise((r) => server.listen(APP_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu',
  '--ignore-certificate-errors',
  // The scratch CSS is plain http and the site has to be https for Sengi, so
  // every call to the pod is mixed content and Chrome blocks it by default.
  '--allow-running-insecure-content',
  `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let tab;
for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tab = l.find((t) => t.type === 'page'); if (tab) break; } catch {} await sleep(500); }
if (!tab) { console.error('chrome never came up'); process.exit(2); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('cdp'))); });

// Everything the page says and every response that was not a success. This is
// the whole reason the harness exists: the toast that carries the message is
// gone off the screen before it can be read.
const console_ = []; const bad = []; const seen = new Map();
let seq = 0; const pend = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.consoleAPICalled') {
    console_.push(`${d.params.type}: ` + d.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  // The browser's OWN messages — mixed content, CSP, a blocked worker — arrive
  // on Log, not on Runtime. Without this the most useful line is invisible.
  if (d.method === 'Log.entryAdded') {
    console_.push(`${d.params.entry.level}/${d.params.entry.source}: ${d.params.entry.text}`);
  }
  if (d.method === 'Runtime.exceptionThrown') {
    console_.push('uncaught: ' + (d.params.exceptionDetails?.exception?.description || d.params.exceptionDetails?.text));
  }
  if (d.method === 'Network.responseReceived') {
    const { url, status } = d.params.response;
    seen.set(d.params.requestId, { url, status });
    if (status >= 300) bad.push(`${status}  ${url}`);
  }
  if (d.method === 'Network.loadingFailed') {
    bad.push(`FAILED (${d.params.errorText})  ${seen.get(d.params.requestId)?.url || '?'}`);
  }
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  await send('Page.navigate', { url: `${APP}/` });
  for (let i = 0; i < 40; i++) { if (await evaluate('typeof window.fedipodSignup === "function"')) break; await sleep(250); }

  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  const password = 'correct horse battery staple';
  await signUpThroughPage(evaluate, sleep, { issuer: ISSUER, appOrigin: APP, handle, email: `${handle}@example.org`, password });

  let ready = null;
  for (let i = 0; i < 60; i++) {
    ready = await evaluate('(async () => { const r = await fetch("/api/v1/instance"); return r.ok ? (await r.json()).uri : null; })()');
    if (ready) break;
    await sleep(500);
  }
  check(!!ready, `the agent answers the facade on this origin (${ready || 'never came up'})`);
  if (!ready) throw new Error('no agent — nothing below can be tested');
  // One post with an emoji in it, so the timeline has a picture to draw:
  // Sengi turns a unicode emoji into a JoyPixels picture, and where that
  // picture comes from is patch 10.
  const posted = await evaluate(`(async () => {
    const app = await (await fetch('/api/v1/apps', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'sengi-test', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write' }) })).json();
    const authz = await (await fetch('/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', response_type: 'code', scope: 'read write' }))).json();
    const tok = await (await fetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: authz.code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' }) })).json();
    const r = await fetch('/api/v1/statuses', { method: 'POST', headers: { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'a face \u{1F636} for the timeline', visibility: 'public' }) });
    return r.status; })()`);
  check(posted === 200, `a post with an emoji is on the timeline (${posted})`);

  // --- Sengi ---
  await send('Page.navigate', { url: `${APP}/sengi/` });
  let loaded = null;
  for (let i = 0; i < 60; i++) { loaded = await evaluate('document.querySelector("app-root") ? document.body.innerText.slice(0,200) : null'); if (loaded) break; await sleep(500); }
  check(!!loaded, `Sengi loads from /sengi/ (${JSON.stringify((loaded || '').replace(/\s+/g, ' ').slice(0, 70))})`);

  // The add-account panel is behind the "+" in the left bar; the form only
  // exists once it is open. Then the instance box, then Submit — which is
  // exactly the three things a person does.
  // Sengi signs itself in now: with no account yet it opens the add-account
  // panel and submits the host it was served from, without a click. The "+"
  // still has to be there for a SECOND account.
  const plus = await evaluate(`(() => !!document.querySelector('[title="add new account"]'))()`);
  check(plus === true, 'the "+" is in the left bar for adding another account');

  const type_ = (v) => evaluate(`(() => {
    const el = document.querySelector('app-add-new-account input[name=instance]');
    if (!el) return { ok: false, why: 'no instance input' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`);
  const submit = () => evaluate(`(() => {
    const b = document.querySelector('app-add-new-account button[type=submit]');
    if (!b) return { ok: false, why: 'no Submit button' };
    b.click();
    return { ok: true };
  })()`);
  const toastText = () => evaluate(`(() => {
    const n = document.querySelector('.notification-hub__notification');
    return n ? n.innerText.replace(/\\s+/g, ' ').trim() : null;
  })()`);

  // Nothing above clicked anything: the panel opened itself and submitted the
  // host it was served from. What settles it is a bearer.
  // Registration, then the navigation to /oauth/authorize, then the code back
  // at /sengi/ and the token exchange — all of it is just "where did the page
  // end up and what did it say on the way".
  // The code comes back in the query and Sengi consumes it and navigates away,
  // so watching location alone misses it. What settles it is a bearer: the
  // access_token Sengi stores once the exchange has gone through.
  let where = null; let token = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    where = await evaluate('location.href');
    token = await evaluate(`(() => { for (const k of Object.keys(localStorage)) {
      const v = String(localStorage.getItem(k) || '');
      const m = /"access_token"\\s*:\\s*"([^"]+)"/.exec(v);
      if (m) return k + ' → ' + m[1].slice(0, 8) + '…';
    } return null; })()`);
    if (token) break;
  }
  const toast = await evaluate('(document.body.innerText.match(/[^\\n]*(error|Error|failure|failed|wrong|invalid)[^\\n]*/g) || []).join(" | ")');

  console.log('\n--- where the page ended up ---\n ', where);
  if (toast) console.log('--- what it says on screen ---\n ', toast);
  console.log('--- console ---'); for (const l of console_.slice(-40)) console.log(' ', l);
  console.log('--- responses that were not 2xx ---'); for (const l of bad) console.log(' ', l);

  check(!!token, `Sengi signs itself in, with no clicking (${token || 'none — never got through the exchange'})`);
  const acct = await evaluate(`(() => { for (const k of Object.keys(localStorage)) {
    const v = String(localStorage.getItem(k) || '');
    if (/"instance"\\s*:\\s*"/.test(v) && /"token"/.test(v)) return k + ' = ' + v.slice(0, 160);
  } return null; })()`);
  check(!!acct, `the account is stored against the instance (${acct || 'none'})`);
  const ngsw = console_.filter((l) => /ngsw-worker/.test(l)).length;
  check(ngsw === 0, `Sengi registers no service worker of its own (${ngsw} tried)`);

  // A stored login that has stopped working. The agent keeps only its most
  // recent tokens, so an older one is eventually not recognised and every call
  // answers "The access token is invalid" — which Sengi showed, repeatedly,
  // with no way out. It has to notice and sign in again by itself.
  const broke = await evaluate(`(() => {
    for (const k of Object.keys(localStorage)) {
      const v = String(localStorage.getItem(k) || '');
      if (!/"access_token"/.test(v)) continue;
      localStorage.setItem(k, v.replace(/("access_token"\\s*:\\s*")[^"]+/g, '$1deadbeefdeadbeef'));
      return true;
    }
    return false;
  })()`);
  check(broke === true, 'the stored token can be broken for the test');
  await send('Page.navigate', { url: `${APP}/sengi/` });
  let fresh = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    fresh = await evaluate(`(() => { for (const k of Object.keys(localStorage)) {
      const m = /"access_token"\\s*:\\s*"([^"]+)"/.exec(String(localStorage.getItem(k) || ''));
      if (m && m[1] !== 'deadbeefdeadbeef') return m[1].slice(0, 8) + '…';
    } return null; })()`);
    if (fresh) break;
  }
  check(!!fresh, `a dead token is noticed and replaced without being asked (${fresh || 'still dead — Sengi kept using it'})`);

  // A SECOND account is the ordinary flow, and a failure in it has to stay put
  // long enough to be read — Sengi cleared every notification after five
  // seconds, errors included, so the one account of what went wrong was gone
  // before it could be copied.
  await evaluate(`(() => { const p = document.querySelector('[title="add new account"]'); if (p) p.click(); return true; })()`);
  for (let i = 0; i < 20; i++) { if (await evaluate('!!document.querySelector("app-add-new-account input[name=instance]")')) break; await sleep(250); }
  await type_(`localhost:${APP_PORT - 1}`); await submit();
  let shown = null;
  for (let i = 0; i < 120; i++) { shown = await toastText(); if (shown) break; await sleep(250); }
  check(!!shown, `a failure puts a message on screen (${shown || 'nothing appeared'})`);
  await sleep(8000);
  const still = await toastText();
  check(!!still, `and it is still readable 8s later (${still || 'GONE — it cleared itself'})`);
  await evaluate(`(() => { const n = document.querySelector('.notification-hub__notification'); if (n) n.click(); return true; })()`);
  check(!(await toastText()), 'clicking it closes it');

  // --- and then: clicking the account icon, which is the next thing a person
  // does and the point at which a timeline either appears or does not ---
  const icon = await evaluate(`(() => {
    const a = document.querySelector('app-account-icon a.account-icon');
    if (!a) return { ok: false, why: 'no account icon in the left bar' };
    const img = a.querySelector('img');
    return { ok: true, title: a.title, avatar: img && img.getAttribute('src'),
      box: JSON.stringify(a.getBoundingClientRect().toJSON()) };
  })()`);
  check(icon?.ok === true, `the account icon is in the left bar (${icon?.why || icon?.title || ''})`);
  console.log('  icon avatar src:', icon?.avatar);
  console.log('  icon box:', icon?.box);

  const wasBad = bad.length; const wasLog = console_.length;
  await evaluate(`(() => { const a = document.querySelector('app-account-icon a.account-icon'); if (a) a.click(); return true; })()`);
  await sleep(4000);
  const after = await evaluate(`(() => ({
    selected: !!document.querySelector('.account-icon__avatar--selected'),
    streams: document.querySelectorAll('app-stream-column, app-stream-toots, app-streams-selection-footer').length,
    body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
  }))()`);
  check(after?.selected === true, `clicking it selects the account (${after?.selected})`);
  console.log('  stream elements after the click:', after?.streams);
  console.log('  what the page shows:', JSON.stringify(after?.body));
  // The three calls Sengi makes to fill a column, verbatim — including the
  // `exclude_types[]` brackets, which is the one thing about them that is not
  // an ordinary path. Answered by the worker, so a 404 here is the facade's
  // and a 404 only in a deployment is the worker not controlling the page.
  const routes = [
    '/api/v1/notifications?limit=10&exclude_types[]=mention',
    '/api/v1/timelines/public?local=false&limit=20',
    '/api/v1/timelines/home?limit=20',
  ];
  for (const r of routes) {
    const got = await evaluate(`(async () => {
      const tok = (() => { for (const k of Object.keys(localStorage)) {
        const m = /"access_token"\\s*:\\s*"([^"]+)"/.exec(String(localStorage.getItem(k) || ''));
        if (m) return m[1];
      } return null; })();
      const res = await fetch(${JSON.stringify(r)}, { headers: { authorization: 'Bearer ' + tok } });
      return res.status + ' ' + (await res.text()).slice(0, 120);
    })()`);
    check(String(got).startsWith('200'), `${r} → ${got}`);
  }

  console.log('  new console lines since the click:'); for (const l of console_.slice(wasLog)) console.log('   ', l);
  console.log('  new failed responses since the click:'); for (const l of bad.slice(wasBad)) console.log('   ', l);

  // --- the client switch: which app the shell frames, and that the choice
  // sticks. Every shell declares its own frame source in markup; the only
  // thing remembered is which shell to hand back. ---
  const framed = async () => evaluate(`(() => { const f = document.getElementById('client'); return f ? f.getAttribute('src') : null; })()`);
  const goTo = async (p) => { await send('Page.navigate', { url: APP + p }); for (let i = 0; i < 40; i++) { if (await evaluate('document.readyState === "complete"')) break; await sleep(250); } await sleep(400); };
  const clickClient = async (name) => evaluate(`(() => {
    const a = [...document.querySelectorAll('a.client-switch')].find((x) => x.textContent.trim() === ${'JSON_NAME'});
    if (!a) return false; a.click(); return true;
  })()`.replace('JSON_NAME', JSON.stringify(name)));

  // A picture of the bar, because "there is a control in the bar" is a claim a
  // line of PASS cannot settle. SENGI_SHOTS names where they go.
  const shotDir = process.env.SENGI_SHOTS || tmp;
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const b = r.result?.data;
    if (b) { fs.writeFileSync(path.join(shotDir, name), Buffer.from(b, 'base64')); console.log('  shot:', path.join(shotDir, name)); }
  };

  await goTo('/admin/client/');
  check(await framed() === '/sengi/', `/admin/client/ frames Sengi by default (${await framed()})`);

  // The one-time notice: an owner who knew this page with one client is told
  // once that it now has two, and never again. Signing in already landed here
  // once, which is where it was said — so this clears the mark to get a first
  // visit back, which is the thing worth testing.
  await evaluate(`(() => { try { localStorage.removeItem('fedipod-client-news'); } catch (e) { } return true; })()`);
  await goTo('/admin/client/');
  let news = null;
  for (let i = 0; i < 20; i++) {
    news = await evaluate(`(() => { const d = document.getElementById('client-news');
      let flag = null; try { flag = localStorage.getItem('fedipod-client-news'); } catch (e) { flag = 'blocked'; }
      return d ? { open: d.open, flag, text: d.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90) } : null; })()`);
    if (news?.open) break;
    await sleep(250);
  }
  check(news?.open === true, `the two-clients notice is shown (${JSON.stringify(news)})`);
  await shot('client-news.png');
  await evaluate(`(() => { document.getElementById('client-news-ok').click(); return true; })()`);
  await sleep(300);
  check(await evaluate(`(() => !document.getElementById('client-news').open)()`) === true,
    'and "Got it" closes it');
  await goTo('/admin/client/');
  await sleep(600);
  check(await evaluate(`(() => !document.getElementById('client-news').open)()`) === true,
    'and it does not come back on the next visit');
  await shot('client-sengi.png');
  // The whole point of the default Home column: does anything actually land in
  // it? The tag feed has already swept by now and /timelines/home answered with
  // posts above, so an empty column here is Sengi not rendering what it has.
  // Twelve tags is twelve polls plus a dereference each, every one of them a
  // round trip through the relay, so the first sweep takes a while — and it is
  // the first sweep that decides whether a new account sees anything at all.
  let posts = 0;
  for (let i = 0; i < 180; i++) {
    posts = await evaluate(`(() => { const f = document.getElementById('client'); try {
      const d = f.contentDocument;
      return { status: d.querySelectorAll('app-status').length,
        stream: d.querySelectorAll('app-stream-statuses').length,
        text: (d.querySelector('app-stream-statuses') || d.body).innerText.replace(/\\s+/g, ' ').slice(0, 160) };
    } catch (e) { return { err: e.message }; } })()`);
    if (posts && posts.status > 0) break;
    await sleep(500);
  }
  // Patch 10: the emoji in the post is drawn as a JoyPixels picture from the
  // CDN, and the picture loads — nothing under /sengi/assets/emoji exists.
  let emoji = null;
  for (let i = 0; i < 40 && !(emoji && emoji.complete); i++) {
    emoji = await evaluate(`(() => { try { const img = document.getElementById('client').contentDocument.querySelector('app-status img.joypixels');
      return img ? { src: img.src, complete: img.complete, width: img.naturalWidth } : null; } catch (e) { return { err: e.message }; } })()`);
    if (!(emoji && emoji.complete)) await sleep(500);
  }
  check(!!emoji?.src && emoji.src.startsWith('https://cdn.jsdelivr.net/joypixels/') && emoji.width > 0,
    `the emoji in a post is the CDN's picture and it loaded (${emoji?.src ? `…${emoji.src.slice(-28)} ${emoji.width}px` : JSON.stringify(emoji)})`);
  // What the tag feed itself says it did. An empty column is either Sengi not
  // drawing what it has or the feed having brought nothing, and those are very
  // different problems.
  const tf = await evaluate(`(async () => { try {
    const r = await fetch('/status', { headers: { 'x-fedipod-page': '1' } });
    const j = await r.json();
    return j.tagfeed ? { tags: (j.tagfeed.tags || []).length, instance: j.tagfeed.instance,
      lastSweep: j.tagfeed.lastSweep, lastAdded: j.tagfeed.lastAdded } : 'no tagfeed in status';
  } catch (e) { return 'status: ' + e.message; } })()`);
  console.log('  tag feed:', JSON.stringify(tf));
  // Reported, not asserted. Whether anything is IN the column on a given run
  // depends on somebody else's server having posts under four of our tags and
  // on the browser letting the sweep finish before it kills the worker — the
  // column being there is ours, what lands in it is not.
  console.log('  posts in the default Home column:', JSON.stringify(posts));
  check(posts?.stream === 1, `a Home column is there by default (${posts?.stream} stream columns)`);

  await shot('client-sengi-home.png');
  const marked = await evaluate(`(() => { const a = document.querySelector('a.client-switch[aria-current]'); return a ? a.textContent.trim() : null; })()`);
  check(marked === 'Sengi', `and the bar marks Sengi as the one in use (${marked})`);

  check(await clickClient('Phanpy') === true, 'the bar offers Phanpy');
  await sleep(1200);
  check(String(await evaluate('location.pathname')) === '/admin/client-phanpy/',
    `choosing Phanpy opens its shell (${await evaluate('location.pathname')})`);
  check(await framed() === '/app/', `which frames Phanpy (${await framed()})`);
  await shot('client-phanpy.png');

  await goTo('/admin/client/');
  check(String(await evaluate('location.pathname')) === '/admin/client-phanpy/',
    `the choice sticks — /admin/client/ hands back Phanpy (${await evaluate('location.pathname')})`);

  check(await clickClient('Sengi') === true, 'and Sengi is one click back');
  await sleep(1200);
  await goTo('/admin/client/');
  check(await framed() === '/sengi/' && String(await evaluate('location.pathname')) === '/admin/client/',
    `switching back sticks too (${await evaluate('location.pathname')} framing ${await framed()})`);

  // The record page is where the owner is when they want to change it.
  await goTo('/admin/');
  await shot('record.png');
  const onRecord = await evaluate(`(() => [...document.querySelectorAll('a.client-switch')].map((a) => a.textContent.trim() + (a.hasAttribute('aria-current') ? '*' : '')).join(' '))()`);
  check(String(onRecord) === 'Sengi* Phanpy', `the record page names the current client too (${onRecord})`);

  // Back to the client — the record page has no frame to reach into.
  await goTo('/admin/client/');
  await sleep(1500);

  // An account that already existed before this build has no columns against
  // it, and Sengi's answer to that is the same "right-click your avatar"
  // screen. Take the columns away from a signed-in account and it has to come
  // back with one — that is the case Jeff hit on his own account.
  const wiped = await evaluate(`(() => { const f = document.getElementById('client'); try {
    const w = f.contentWindow;
    for (const k of Object.keys(w.localStorage)) {
      const v = String(w.localStorage.getItem(k) || '');
      if (!/"streamsstatemodel"/.test(v)) continue;
      const j = JSON.parse(v);
      j.streamsstatemodel.streams = [];
      w.localStorage.setItem(k, JSON.stringify(j));
      return true;
    }
    return false;
  } catch (e) { return 'err: ' + e.message; } })()`);
  check(wiped === true, `an existing account can be left with no columns for the test (${wiped})`);
  await goTo('/admin/client/');
  let back = 0;
  for (let i = 0; i < 60; i++) {
    back = await evaluate(`(() => { const f = document.getElementById('client'); try {
      return f.contentDocument.querySelectorAll('app-stream-statuses').length; } catch (e) { return -1; } })()`);
    if (back > 0) break;
    await sleep(500);
  }
  check(back > 0, `an account with no columns is given one on the next visit (${back})`);

  // Switching clients is a navigation, and a navigation can take the service
  // worker with it — so the agent reboots. It must come back as the SAME
  // holder of the lease, or the owner is told their own account is active on
  // another device and asked to take it over.
  const held = async () => evaluate(`(async () => { try {
    const r = await fetch('/status', { headers: { 'x-fedipod-page': '1' } });
    const j = await r.json();
    return { mode: j.mode || null, viewer: !!j.viewer };
  } catch (e) { return 'status: ' + e.message; } })()`);
  const first = await held();
  await goTo('/admin/client-phanpy/');
  await goTo('/admin/client/');
  await goTo('/admin/client-phanpy/');
  await sleep(2500);
  const stillOurs = await held();
  console.log('  lease before/after switching:', JSON.stringify(first), JSON.stringify(stillOurs));
  check(stillOurs && stillOurs.viewer === false,
    `switching clients does not demote this browser to a viewer (${JSON.stringify(stillOurs)})`);
} catch (e) {
  console.error('\nharness error:', e.message);
  console.log('--- console ---'); for (const l of console_.slice(-40)) console.log(' ', l);
  console.log('--- responses that were not 2xx ---'); for (const l of bad) console.log(' ', l);
  fails++;
} finally {
  try { ws.close(); } catch {}
  chrome.kill(); css.kill(); server.close();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `\n${fails} failed` : '\nall green');
  process.exit(fails ? 1 : 0);
}
