// oidc-run.mjs — lib/session/oidc-session.mjs proven correct and secure.
//
// Uses a mock IdP that checks exactly what a real Solid-OIDC provider checks: the
// token request carries a DPoP proof and a PKCE verifier, resource requests carry
// a DPoP-bound token, and refresh works. Real CSS accepts the same requests (the
// uvdsl client already proves CSS speaks this flow); this test proves OUR client
// forms them right and persists the session securely. In headless Chrome:
// beginLogin (PKCE + non-extractable DPoP key in IndexedDB) -> completeLogin
// (token exchange) -> authFetch a resource -> non-extractable check -> reload ->
// silent restore -> refresh.
//
//   node claude/validation/browser-agent/oidc-run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
const mockKeysSalt = randomBytes(16).toString('base64'); // per-run salt; a static salt would defeat PBKDF2's rainbow-table defense
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const IDP_PORT = 3349; const APP_PORT = 8983; const CDP_PORT = 9345; const MASTO_PORT = 3351;
const IDP = `http://localhost:${IDP_PORT}`; const APP = `http://localhost:${APP_PORT}`; const MASTO = `http://localhost:${MASTO_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-oidc-'));
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64u({ alg: 'none' })}.${b64u(payload)}.`;
const WEBID = `${IDP}/alice/profile/card#me`;
let issued = 0; let refreshed = 0;

// --- mock IdP (with CORS for the browser) ---
const cors = (res) => { res.setHeader('access-control-allow-origin', APP); res.setHeader('access-control-allow-headers', 'authorization,dpop,content-type'); res.setHeader('access-control-allow-methods', 'GET,PUT,POST,DELETE,OPTIONS'); };
const idp = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, IDP);
  const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/.well-known/openid-configuration') return json({ issuer: IDP, authorization_endpoint: `${IDP}/auth`, token_endpoint: `${IDP}/token`, registration_endpoint: `${IDP}/reg` });
  if (u.pathname === '/reg') return json({ client_id: 'mock-client' });
  if (u.pathname === '/token') {
    const p = new URLSearchParams(body);
    const hasDpop = !!req.headers.dpop && req.headers.dpop.split('.').length === 3;
    if (!hasDpop) { res.writeHead(400); return res.end('no dpop'); }
    if (p.get('grant_type') === 'authorization_code') {
      if (!p.get('code_verifier') || !p.get('code')) { res.writeHead(400); return res.end('no pkce/code'); }
      issued++; return json({ access_token: jwt({ webid: WEBID, iss: IDP }), refresh_token: 'refresh-1', token_type: 'DPoP', expires_in: 300 });
    }
    if (p.get('grant_type') === 'refresh_token') {
      if (p.get('refresh_token') !== 'refresh-1' && p.get('refresh_token') !== 'refresh-2') { res.writeHead(400); return res.end('bad refresh'); }
      refreshed++; return json({ access_token: jwt({ webid: WEBID, iss: IDP, r: refreshed }), refresh_token: 'refresh-2', token_type: 'DPoP', expires_in: 300 });
    }
    res.writeHead(400); return res.end('bad grant');
  }
  if (u.pathname.startsWith('/res')) {
    const ok = (req.headers.authorization || '').startsWith('DPoP ') && !!req.headers.dpop;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'text/plain' }); return res.end(ok ? 'resource-ok' : 'unauthorized');
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => idp.listen(IDP_PORT, '127.0.0.1', r));

// The library itself, bound the way web/app/oidc-session.mjs binds it.
// The library itself, bound the way web/app/oidc-session.mjs binds it. The
// Fediverse-address login is given a fetch that reaches this test's http
// hosts where the library would ask https.
const mapped = `(u, i) => fetch(String(u).replace(/^https:\\/\\/localhost/, 'http://localhost'), i)`;
const loader = `<!doctype html><meta charset=utf-8><title>oidc</title><script type=module>
import { solidOidcSession } from '/oidc-session.mjs'; import { fediLogin } from '/fedi-login.mjs'; import { fediAccount } from '/fedi-account.mjs';
window.O=solidOidcSession({ dbName: 'fedipod-oidc', clientName: 'FediPod' });
window.F=fediLogin({ dbName: 'fedipod-oidc', clientName: 'FediPod', fetch: ${mapped} });
window.A=fediAccount({ dbName: 'acct-test', clientName: 'Account test', fetch: ${mapped} });
window.__ready=true;</script>`;
const doorSeen = [];   // what the pod account's outbox door received
const app = http.createServer(async (req, res) => {
  const j = (o, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
  if (req.url === '/' || req.url.startsWith('/callback') || req.url.startsWith('/where-i-was')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loader); }
  for (const m of ['oidc-session', 'fedi-login', 'fedi-account']) {
    if (req.url.startsWith(`/${m}.mjs`)) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(root, `lib/session/${m}.mjs`))); }
  }
  // This host plays a Gateway: WebFinger names the actor here and, as an
  // alias, the actor on the pod; the pod (the same host, for the test)
  // answers OIDC discovery by pointing at the IdP.
  if (req.url.startsWith('/.well-known/webfinger')) { res.writeHead(200, { 'content-type': 'application/jrd+json' }); return res.end(JSON.stringify({ subject: 'acct:mei@localhost', aliases: [`${APP}/pod/ap/actor`], links: [{ rel: 'self', type: 'application/activity+json', href: `${APP}/u/mei/ap/actor` }] })); }
  if (req.url === '/.well-known/openid-configuration') { res.writeHead(302, { location: `${IDP}/.well-known/openid-configuration` }); return res.end(); }
  // …and it plays the pod account: the actor, the WebID naming the door, the
  // door itself, and the owner-only records (a sealed key: a browser account).
  if (req.url === '/pod/ap/actor' || req.url === '/u/mei/ap/actor') return j({ id: `${APP}/u/mei/ap/actor`, type: 'Person', preferredUsername: 'mei', name: 'Mei', followers: `${APP}/u/mei/ap/followers`, outbox: `${APP}/door`, alsoKnownAs: [`${APP}/profile/card#me`] });
  if (req.url === '/profile/card') return j([{ '@id': `${APP}/profile/card#me`, 'http://www.w3.org/ns/solid/terms#oidcIssuer': [{ '@id': IDP }], 'http://xmlns.com/foaf/0.1/account': [{ '@id': `${APP}/u/mei/ap/actor` }], 'https://www.w3.org/ns/activitystreams#outbox': [{ '@id': `${APP}/door` }] }]);
  if (req.url === '/door' && req.method === 'POST') {
    const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
    doorSeen.push({ auth: req.headers.authorization || '', dpop: !!req.headers.dpop, body: JSON.parse(body) });
    res.writeHead(202, { location: `${APP}/u/mei/ap/notes/n${doorSeen.length}` }); return res.end();
  }
  if (req.url.startsWith('/pod/ap-state/')) {
    if (!(req.headers.authorization || '').startsWith('DPoP ')) return j({ error: 'owner only' }, 401);
    if (req.url.endsWith('keys.json')) return j({ v: 1, kdf: 'PBKDF2-SHA256', ct: 'sealed', salt: 'salt' });
    if (req.url.endsWith('statuses.json')) return j([{ noteId: 'https://x.example/n/1', actor: 'https://x.example/u/tamara', content: '<p>one</p>', published: '2026-09-20T09:00:00Z', kind: 'timeline' }, { noteId: 'https://x.example/n/2', actor: 'https://x.example/u/tamara', content: '<p>dm</p>', published: '2026-09-20T09:30:00Z', kind: 'timeline', direct: true }]);
    if (req.url.endsWith('actors.json')) return j({ 'https://x.example/u/tamara': { preferredUsername: 'tamara', name: 'Tamara' } });
  }
  res.writeHead(404); res.end();
});

// --- mock Mastodon server: what a Mastodon-family server answers this library ---
const mastoSeen = [];
const masto = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization,content-type'); res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const u = new URL(req.url, MASTO);
  const body = await new Promise((r) => { let d = ''; req.on('data', (c) => d += c); req.on('end', () => r(d)); });
  const j = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const bearer = (req.headers.authorization || '') === 'Bearer kwame-token';
  mastoSeen.push(`${req.method} ${u.pathname}${bearer ? ' [bearer]' : ''}`);
  if (u.pathname === '/.well-known/webfinger') return j({ subject: 'acct:kwame@localhost', links: [{ rel: 'self', type: 'application/activity+json', href: `${MASTO}/users/kwame` }] });
  if (u.pathname === '/api/v1/instance') return j({ uri: `localhost:${MASTO_PORT}`, title: 'Mock Mastodon' });
  if (u.pathname === '/api/v1/apps') return j({ client_id: 'kwame-app', client_secret: 'kwame-secret' });
  if (u.pathname === '/oauth/authorize') { res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=KCODE&state=${encodeURIComponent(u.searchParams.get('state'))}` }); return res.end(); }
  if (u.pathname === '/oauth/token') { const p = JSON.parse(body || '{}'); return p.code === 'KCODE' && p.client_id === 'kwame-app' ? j({ access_token: 'kwame-token', token_type: 'Bearer' }) : j({ error: 'bad code' }, 400); }
  if (!bearer) return j({ error: 'The access token is invalid' }, 401);
  if (u.pathname === '/api/v1/accounts/verify_credentials') return j({ username: 'kwame', display_name: 'Kwame', url: `${MASTO}/@kwame` });
  if (u.pathname === '/api/v1/timelines/home') return j([{ id: '1', url: `${MASTO}/@aisha/1`, created_at: '2026-09-20T10:00:00Z', content: '<p>hi</p>', account: { acct: 'aisha', display_name: 'Aisha', url: `${MASTO}/@aisha` } }]);
  if (u.pathname === '/api/v1/statuses' && req.method === 'POST') return j({ id: '77', url: `${MASTO}/@kwame/77` });
  if (u.pathname === '/api/v1/accounts/lookup') return j({ id: '9', acct: 'aisha' });
  if (u.pathname === '/api/v1/accounts/9/follow') return j({ id: '9', following: true });
  if (u.pathname === '/oauth/revoke') return j({});
  return j({ error: 'not here' }, 404);
});
await new Promise((r) => masto.listen(MASTO_PORT, '127.0.0.1', r));
await new Promise((r) => app.listen(APP_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let tab; for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); tab = l.find((t) => t.type === 'page'); if (tab) break; } catch {} await sleep(500); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('cdp'))); });
let seq = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text }; return r.result?.result?.value; };
const nav = async (url) => { await send('Page.navigate', { url }); for (let i = 0; i < 40; i++) { if (await ev('window.__ready === true')) return; await sleep(200); } };
try {
  await send('Page.enable'); await send('Runtime.enable');
  await nav(`${APP}/`);
  const authUrl = await ev(`window.O.beginLogin({ issuer:${JSON.stringify(IDP)}, redirectUri:${JSON.stringify(APP + '/callback')} }).then(r=>r.authorizationUrl).catch(e=>({__error:e.message}))`);
  if (authUrl?.__error) throw new Error('beginLogin: ' + authUrl.__error);
  check(typeof authUrl === 'string' && authUrl.includes('code_challenge=') && authUrl.startsWith(`${IDP}/auth`), 'beginLogin builds the authorize URL (PKCE, non-extractable key stashed)');
  const state = new URL(authUrl).searchParams.get('state');
  await nav(`${APP}/callback?code=THECODE&state=${encodeURIComponent(state)}`);
  const s = await ev(`window.O.completeLogin({ currentUrl: location.href }).then(x=>({webId:x.webId})).catch(e=>({__error:e.message}))`);
  if (s?.__error) throw new Error('completeLogin: ' + s.__error);
  check(s.webId === WEBID && issued === 1, `token exchange (DPoP + PKCE) succeeds and yields the WebID: ${s.webId}`);
  const io = await ev(`(async()=>{ const s=await window.O.getSession(); const r=await s.fetch(${JSON.stringify(IDP)}+'/res/x'); return { status:r.status, body: await r.text() }; })()`);
  check(io.status === 200 && io.body === 'resource-ok', 'authFetch sends a DPoP-bound request the resource accepts');
  const nx = await ev(`(async()=>{ const r=indexedDB.open('fedipod-oidc',1); return new Promise(res=>{ r.onsuccess=()=>{ const t=r.result.transaction('session').objectStore('session').get('session'); t.onsuccess=()=>res(t.result?.pair?.privateKey?.extractable); }; }); })()`);
  check(nx === false, `the DPoP private key in IndexedDB is non-extractable (extractable=${nx})`);
  await nav(`${APP}/`);
  const restored = await ev(`(async()=>{ const s=await window.O.getSession(); if(!s) return {none:true}; const r=await s.fetch(${JSON.stringify(IDP)}+'/res/y'); return { webId:s.webId, status:r.status }; })()`);
  check(restored.webId === WEBID && restored.status === 200, 'after reload the session restores from IndexedDB with no re-login and still authFetches');
  const ref = await ev(`(async()=>{ const s=await window.O.getSession(); await s.refresh(); const r=await s.fetch(${JSON.stringify(IDP)}+'/res/z'); return r.status; })()`);
  check(ref === 200 && refreshed >= 1, 'the session refreshes its token and keeps working');

  // --- the Fediverse-address login: address -> pod -> login page -> back to where they were ---
  const addr = `@mei@localhost:${APP_PORT}`;
  const found = await ev(`window.F.resolve(${JSON.stringify(addr)}).catch(e=>({__error:e.message}))`);
  if (found?.__error) throw new Error('resolve: ' + found.__error);
  check(found.issuer === IDP && found.actor === `${APP}/u/mei/ap/actor`, `an address resolves through WebFinger and the pod's discovery to its login provider: ${found.issuer}`);
  const start = await ev(`window.F.startLogin(${JSON.stringify(addr)}, { returnTo: ${JSON.stringify(APP + '/where-i-was?tab=3')}, redirectUri: ${JSON.stringify(APP + '/callback')} }).catch(e=>({__error:e.message}))`);
  if (start?.__error) throw new Error('startLogin: ' + start.__error);
  check(typeof start.authorizationUrl === 'string' && start.authorizationUrl.startsWith(`${IDP}/auth`), 'startLogin hands back the pod login page to go to');
  await nav(`${APP}/callback?code=THECODE&state=${encodeURIComponent(new URL(start.authorizationUrl).searchParams.get('state'))}`);
  const back = await ev(`window.F.resume({ currentUrl: location.href, go: (u) => { window.__went = u; } }).then(s => ({ webId: s?.webId, went: window.__went })).catch(e=>({__error:e.message}))`);
  if (back?.__error) throw new Error('resume: ' + back.__error);
  check(back.webId === WEBID && back.went === `${APP}/where-i-was?tab=3`, `resume finishes the sign-in and sends them back to where they were: ${back.went}`);
  const idle = await ev(`window.F.resume({ currentUrl: ${JSON.stringify(APP + '/')}, go: (u) => { window.__went2 = u; } }).then(s => ({ s, went: window.__went2 })).catch(e=>({__error:e.message}))`);
  check(idle.s === null && idle.went === undefined, 'resume on a page nobody is returning to does nothing');
  const notPod = await ev(`window.F.resolve('@kwame@mastodon.example').then(()=>'', e=>e.message)`);
  check(/mastodon\.example/.test(notPod), `an address whose host is not a pod is refused in words: "${notPod}"`);

  // --- the account library, pod kind: handle -> pod sign-in -> an account that posts through its door ---
  const podAddr = `@mei@localhost:${APP_PORT}`;
  const d1 = await ev(`window.A.describe(${JSON.stringify(podAddr)}).catch(e=>({__error:e.message}))`);
  check(d1?.kind === 'pod' && d1.root === `${APP}/pod/`, `a FediPod address is described as a pod account with its records at ${d1?.root}`);
  const s1 = await ev(`window.A.startLogin(${JSON.stringify(podAddr)}, { returnTo: ${JSON.stringify(APP + '/where-i-was?a=1')}, redirectUri: ${JSON.stringify(APP + '/callback')} }).catch(e=>({__error:e.message}))`);
  if (s1?.__error) throw new Error('startLogin(pod): ' + s1.__error);
  await nav(`${APP}/callback?code=THECODE&state=${encodeURIComponent(new URL(s1.authorizationUrl).searchParams.get('state'))}`);
  const r1 = await ev(`window.A.resume({ currentUrl: location.href, go: (u) => { window.__went = u; } }).then(a => ({ kind: a?.kind, handle: a?.handle, notice: a?.notice, went: window.__went })).catch(e=>({__error:e.message}))`);
  if (r1?.__error) throw new Error('resume(pod): ' + r1.__error);
  check(r1.kind === 'pod' && r1.handle === podAddr && r1.went === `${APP}/where-i-was?a=1`, `resume hands back the pod account and sends them back: ${r1.handle}`);
  check(/browser-based account/.test(r1.notice || ''), `a browser-based account carries the notice: "${r1.notice}"`);
  const act1 = await ev(`(async()=>{ const me=await window.A.current(); const p=await me.post({ text: 'hello <world>' }); const t=await me.timeline(); const f=await me.follow('@tamara@x.example'); return { p, n: t.length, who: t[0]?.author?.handle, f }; })().catch(e=>({__error:e.message}))`);
  if (act1?.__error) throw new Error('pod account acting: ' + act1.__error);
  check(act1.p.queued && act1.p.id === `${APP}/u/mei/ap/notes/n1` && act1.f.queued, `post and follow are queued at the door with the future address: ${act1.p.id}`);
  check(act1.n === 1 && act1.who === '@tamara@x.example', 'the timeline is read from the account\'s own records, direct posts left out, authors named');
  const prof1 = await ev(`window.A.current().then(me => me.profile()).catch(e=>({__error:e.message}))`);
  // The WebID is the one the sign-in proved (the token's), not one read off a document.
  check(prof1?.name === 'Mei' && prof1.handle === podAddr && prof1.webId === WEBID, `the pod account's profile comes from its actor and names the signed-in WebID: ${prof1?.name}, ${prof1?.webId}`);
  check(doorSeen.length === 2 && doorSeen.every((d) => d.auth.startsWith('DPoP ') && d.dpop) && doorSeen[0].body.type === 'Note' && doorSeen[0].body.content === '<p>hello &lt;world&gt;</p>' && doorSeen[1].body.type === 'Follow', 'the door received a Note and a Follow, each with the pod sign-in');
  await ev(`window.A.signOut()`);

  // --- the account library, Mastodon kind: handle -> OAuth at the server -> an account that acts at once ---
  const mAddr = `@kwame@localhost:${MASTO_PORT}`;
  const d2 = await ev(`window.A.describe(${JSON.stringify(mAddr)}).catch(e=>({__error:e.message}))`);
  check(d2?.kind === 'mastodon', `a Mastodon address is described as one: ${JSON.stringify(d2)}`);
  const s2 = await ev(`window.A.startLogin(${JSON.stringify(mAddr)}, { returnTo: ${JSON.stringify(APP + '/where-i-was?b=2')}, redirectUri: ${JSON.stringify(APP + '/callback')} }).catch(e=>({__error:e.message}))`);
  if (s2?.__error) throw new Error('startLogin(mastodon): ' + s2.__error);
  // The library sends people to https, as it must; this test's server is http.
  const approveUrl = s2.authorizationUrl.replace(/^https:\/\/localhost/, 'http://localhost');
  check(approveUrl.startsWith(`${MASTO}/oauth/authorize`), 'the person is sent to their Mastodon server to approve the app');
  await nav(approveUrl);   // the mock approves at once and sends them back
  const r2 = await ev(`window.A.resume({ currentUrl: location.href, go: (u) => { window.__went = u; } }).then(a => ({ kind: a?.kind, handle: a?.handle, notice: a?.notice, went: window.__went })).catch(e=>({__error:e.message}))`);
  if (r2?.__error) throw new Error('resume(mastodon): ' + r2.__error);
  check(r2.kind === 'mastodon' && r2.handle === mAddr && r2.notice === null && r2.went === `${APP}/where-i-was?b=2`, `resume hands back the Mastodon account with no notice and sends them back: ${r2.handle}`);
  const act2 = await ev(`(async()=>{ const me=await window.A.current(); const p=await me.post({ text: 'hello' }); const t=await me.timeline(); const f=await me.follow('@aisha@localhost:${MASTO_PORT}'); return { p, n: t.length, who: t[0]?.author?.handle, f }; })().catch(e=>({__error:e.message}))`);
  if (act2?.__error) throw new Error('mastodon account acting: ' + act2.__error);
  check(act2.p.sent && act2.p.id === '77' && act2.n === 1 && act2.who === `@aisha@localhost:${MASTO_PORT}` && act2.f.sent, 'post, timeline and follow go through the Mastodon API at once');
  const prof2 = await ev(`window.A.current().then(me => me.profile()).catch(e=>({__error:e.message}))`);
  check(prof2?.name === 'Kwame' && prof2.handle === mAddr && prof2.url === `${MASTO}/@kwame`, `the Mastodon account's profile comes from its server: ${prof2?.name}, ${prof2?.url}`);
  check(mastoSeen.some((s) => s === 'POST /api/v1/statuses [bearer]') && mastoSeen.some((s) => s === 'POST /api/v1/accounts/9/follow [bearer]'), 'the server saw the post and the follow with the granted token');
  await ev(`window.A.signOut()`);
  check(mastoSeen.some((s) => s.startsWith('POST /oauth/revoke')) && (await ev(`window.A.current().then(a => a === null)`)) === true, 'signing out revokes the token at the server and forgets the account');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally { ws.close(); chrome.kill('SIGKILL'); idp.close(); app.close(); masto.close(); await sleep(200); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
