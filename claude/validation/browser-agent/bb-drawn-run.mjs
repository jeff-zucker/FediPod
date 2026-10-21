// bb-drawn-run.mjs — a forum's page at its own host, drawn by the Gateway, in
// a real browser: read with scripts off, read with scripts on without a single
// document fetched again, a category chosen without a load, an old link taken
// to its topic, and the category the browser draws the same as the one the
// server drew. The forum is the checkout beside FediPod (scripts/dependents.mjs),
// written by its own publishing code; the site is served over https at
// bb.fedipod.localhost, as bb.fedipod.net is, with the Gateway's own route
// (lib/gateway/forum-pages.mjs). Screenshots land in tmp/bb-drawn/.
//
//   node claude/validation/browser-agent/bb-drawn-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import https from 'node:https'; import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url'; import { createRequire } from 'node:module';
import { readyDependent } from '../../../scripts/dependents.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const PORT = 8992; const CDP_PORT = 9352;
const GATEWAY = `https://fedipod.localhost:${PORT}`;
const BB = `https://bb.fedipod.localhost:${PORT}`;
const POD = `${GATEWAY}/pod/`;
const shots = path.join(root, 'tmp/bb-drawn');
fs.mkdirSync(shots, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-bb-drawn-'));

const bb = readyDependent('fedipod-bb', { log: () => {} });
const at = (p) => import(pathToFileURL(path.join(bb, p)).href);
const { forumUrls } = await at('src/urls.mjs');
const fwire = await at('src/wire.mjs');
const topics = await at('src/topics.mjs');
const publish = await at('src/publish.mjs');
const { renderPage } = await at('src/render.mjs');
const { cacheKey } = await at('site/read.mjs');
const { PodStore } = await import('../../../lib/core/store.mjs');
const { routeFront } = await import('../../../lib/gateway/front-core.mjs');

// --- a forum, written as its host writes one ---------------------------------
const memStore = () => {
  const st = new PodStore({ log: () => {} });
  st.attach({ base: 'mem://', list: async () => ({ names: [], etag: null }), read: async () => ({ ok: false }), remove: async () => true, write: async () => ({ ok: true }) });
  return st;
};
const docs = new Map();
const remote = { putJson: async (u, o) => { docs.set(u, o); return { ok: true }; }, setAcl: async () => {} };
const site = forumUrls(POD);
const g = site.category('gardening');
const s = site.category('seeds');
const siteStore = memStore(); const gStore = memStore(); const sStore = memStore();
const MEI = 'https://mei.pod.example/fedipod/ap/actor';
docs.set(site.actor, fwire.siteActorDoc({ urls: site, handle: 'forum', name: 'Federated Solid Forum', publicKeyPem: 'x', summary: 'Growing things together.' }));
docs.set(g.actor, { id: g.actor, type: 'Group', preferredUsername: 'gardening', name: 'Gardening' });
docs.set(s.actor, { id: s.actor, type: 'Group', preferredUsername: 'seeds', name: 'Seed swap' });
await publish.publishCategories({ remote, store: siteStore, urls: site }, [g.actor, s.actor]);
const A = 'https://mei.pod.example/fedipod/ap/notes/blight';
const R = 'https://mei.pod.example/fedipod/ap/notes/blight-r1';
const B = 'https://mei.pod.example/fedipod/ap/notes/swap';
const gctx = { remote, store: gStore, urls: g };
const sctx = { remote, store: sStore, urls: s };
const tid = topics.open(gStore, { title: 'Tomato blight', post: { id: A, author: MEI, published: '2026-09-15T10:00:00Z', inReplyTo: null } });
topics.append(gStore, tid, { id: R, author: MEI, published: '2026-09-15T11:00:00Z', inReplyTo: A });
const sid = topics.open(sStore, { title: 'Bean swap', post: { id: B, author: MEI, published: '2026-09-14T09:00:00Z', inReplyTo: null } });
await publish.cachePost(gctx, { id: A, type: 'Note', attributedTo: MEI, content: '<p>Three beds gone, and the fourth is going the same way.</p>',
  published: '2026-09-15T10:00:00Z', context: g.topic(tid), audience: g.actor });
await publish.cachePost(gctx, { id: R, type: 'Note', attributedTo: MEI, content: '<p>Same here. Copper spray helped a little.</p>',
  published: '2026-09-15T11:00:00Z', inReplyTo: A, context: g.topic(tid), audience: g.actor });
await publish.cachePost(sctx, { id: B, type: 'Note', attributedTo: MEI, content: '<p>Runner beans for anything.</p>',
  published: '2026-09-14T09:00:00Z', context: s.topic(sid), audience: s.actor });
await publish.cacheAuthor(gctx, { id: MEI, type: 'Person', preferredUsername: 'mei', name: 'Mei' });
await publish.cacheAuthor(sctx, { id: MEI, type: 'Person', preferredUsername: 'mei', name: 'Mei' });
for (const [ctx, t] of [[gctx, tid], [sctx, sid]]) { await publish.publishTopic(ctx, t); await publish.publishTopicIndex(ctx); }
siteStore.write('latest.json', [{ copy: g.cached(R), at: '2026-09-15T11:00:00Z' }, { copy: g.cached(A), at: '2026-09-15T10:00:00Z' },
  { copy: s.cached(B), at: '2026-09-14T09:00:00Z' }]);
await publish.publishLatest({ remote, store: siteStore, urls: site });

// What the Gateway answers for the forum's documents: through /u/forum/, as
// fedipod.net does, and at the pod's own addresses the documents name.
const docAt = (url) => {
  const u = url.startsWith(`${GATEWAY}/u/forum/`) ? POD + 'fedipod-bb/' + url.slice(`${GATEWAY}/u/forum/`.length) : url.split('?')[0];
  const d = docs.get(u);
  return d ? { status: 200, body: JSON.stringify(d) } : { status: 404, body: '' };
};
const readFetch = async (url) => { const d = docAt(String(url)); return new Response(d.body || null, { status: d.status, headers: { 'content-type': 'application/activity+json' } }); };

// --- the site, staged from the checkout as stage-site.mjs stages it ----------
const staged = path.join(tmp, 'bb');
fs.mkdirSync(staged);
for (const f of fs.readdirSync(path.join(bb, 'site'))) fs.copyFileSync(path.join(bb, 'site', f), path.join(staged, f));
fs.copyFileSync(path.join(root, 'web/admin/tokens.css'), path.join(staged, 'tokens.css'));
fs.copyFileSync(path.join(root, 'node_modules/fediverse-session/oidc-session.mjs'), path.join(staged, 'solid-oidc-session.mjs'));
fs.writeFileSync(path.join(staged, 'oidc-session.mjs'), fs.readFileSync(path.join(staged, 'oidc-session.mjs'), 'utf8')
  .replace("'fediverse-session/oidc-session.mjs'", "'./solid-oidc-session.mjs'"));
const shell = fs.readFileSync(path.join(staged, 'index.html'), 'utf8');
const ctx = {
  lookup: () => null,
  siteFetch: async () => new Response(shell),
  forum: { isForumRow: () => false, renderPage: (o) => renderPage({ ...o, fetch: readFetch }) },
};

// --- one https server for both hosts --------------------------------------------
const key = path.join(tmp, 'key.pem'); const cert = path.join(tmp, 'cert.pem');
spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
  '-subj', '/CN=fedipod.localhost', '-addext', 'subjectAltName=DNS:fedipod.localhost,DNS:bb.fedipod.localhost'], { stdio: 'ignore' });
const asked = [];
const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
  const url = `https://${req.headers.host}${req.url}`;
  asked.push(url);
  const u = new URL(url);
  if (u.hostname === 'fedipod.localhost') {
    const d = docAt(url);
    res.writeHead(d.status, { 'content-type': 'application/activity+json', 'access-control-allow-origin': '*' });
    return res.end(d.body);
  }
  if (u.pathname.startsWith('/bb/')) {
    const file = path.join(staged, path.basename(u.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript' });
    return res.end(fs.readFileSync(file));
  }
  const out = await routeFront(new Request(url), ctx).catch(() => null);
  if (out) { res.writeHead(out.status, out.headers); return res.end(out.body ?? ''); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(shell);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu', '--ignore-certificate-errors',
  '--window-size=1200,900', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
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
// Opened, and settled: the page's main part is there, and then a moment more
// for its script to do whatever it does on arrival.
const open = async (url, wait = 1500) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    if (await evaluate("document.readyState === 'complete' && !!document.querySelector('main')") === true) break;
    await sleep(250);
  }
  await sleep(wait);
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) fs.writeFileSync(path.join(shots, name), Buffer.from(r.result.data, 'base64'));
};
const words = (s) => String(s || '').replace(/\s+/gu, ' ').trim();
const mainText = () => evaluate("document.querySelector('main').innerText");
const docsAsked = () => asked.filter((u) => new URL(u).hostname === 'fedipod.localhost');

try {
  await send('Page.enable'); await send('Runtime.enable');
  const topic = `${BB}/forum/t/gardening/${tid}`;

  // Scripts off: what a text browser, a privacy setup or a link preview sees.
  await send('Emulation.setScriptExecutionDisabled', { value: true });
  await open(topic, 800);
  const offTopic = words(await mainText());
  check(/Three beds gone/u.test(offTopic) && /Copper spray/u.test(offTopic), `a topic reads with scripts off (${offTopic.slice(0, 80)}…)`);
  check(await evaluate('document.title') === 'Tomato blight', 'and the tab is named by the topic');
  await shot('topic-without-javascript.png');
  await open(`${BB}/forum/`, 800);
  const links = await evaluate(`[...document.querySelectorAll('main a[href]')].map(a => a.getAttribute('href'))`);
  check(Array.isArray(links) && links.some((h) => h.startsWith(`/forum/t/gardening/${tid}`)) && links.includes('/forum/c/seeds'),
    `the front page links each topic and category by its own address (${(links || []).length} links)`);
  await shot('front-page-without-javascript.png');
  await open(`${BB}/forum/c/seeds`, 800);
  const drawnSeeds = words(await mainText());

  // Scripts on: the page takes what it was drawn from and reads none of it again.
  await send('Emulation.setScriptExecutionDisabled', { value: false });
  asked.length = 0;
  await open(topic, 2500);
  const onTopic = await evaluate(`({ posts: document.querySelectorAll('main article.post').length,
    replies: document.querySelectorAll('main [data-act="reply"]').length, text: document.querySelector('main').innerText,
    title: document.title })`);
  check(onTopic?.posts === 2 && onTopic.replies === 2, `with scripts on the topic shows each post once, with its buttons (${onTopic?.posts} posts)`);
  check(words(onTopic?.text) === offTopic, 'and reads the same as with scripts off');
  check(docsAsked().length === 0, `a signed-out reader's page fetches no document after it arrives (${docsAsked().length}: ${docsAsked().slice(0, 3).join(' ')})`);
  await shot('topic-with-javascript.png');

  // A category chosen from the front page: no load, no reads, and drawn by
  // the browser exactly as the server draws it.
  await open(`${BB}/forum/`, 2500);
  asked.length = 0;
  await evaluate(`document.querySelector('main a.chip[href="/forum/c/seeds"]').click()`);
  await sleep(800);
  const chosen = await evaluate(`({ path: location.pathname, text: document.querySelector('main').innerText })`);
  check(chosen?.path === '/forum/c/seeds', `choosing a category moves to its address (${chosen?.path})`);
  check(asked.length === 0, `without loading anything (${asked.length} requests)`);
  check(words(chosen?.text) === drawnSeeds, `and the browser draws it as the server does (${words(chosen?.text).slice(0, 60)}… / ${drawnSeeds.slice(0, 60)}…)`);
  await shot('category-chosen-with-javascript.png');

  // A link shared before the change still opens its topic, at the new address.
  await open(`${BB}/forum/#/t/gardening/${tid}/${await cacheKey(R)}`, 3000);
  const old = await evaluate(`({ path: location.pathname, hash: location.hash, text: document.querySelector('main').innerText })`);
  check(old?.path === `/forum/t/gardening/${tid}` && /Copper spray/u.test(old?.text || ''),
    `an old link opens its topic at the new address (${old?.path}${old?.hash})`);
  check(old?.hash === `#p-${await cacheKey(R)}`, 'still pointing at the post it named');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  ws.close(); chrome.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
console.log(`screenshots: ${shots}`);
process.exit(fails ? 1 : 0);
