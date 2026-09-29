// run.mjs — the in-browser agent, end to end against a scratch server.
//
// Boots a real CSS (subdomain pods), serves the bundled agent from another
// origin, and in headless Chrome: signs up (account + pod + keys), boots the
// agent, and checks the account is REAL — the actor and WebFinger are served by
// the pod for anyone — then drives the Mastodon facade through a full sign-in
// (app register -> authorize -> token -> verify_credentials) and posts a status,
// confirming it lands in the pod's outbox. No live Mastodon and no relay are
// needed for any of this; federation OUT is the one part that needs a real peer.
//
//   node claude/validation/browser-agent/run.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import http from 'node:http'; import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
import { buildApp } from '../../../scripts/build-app.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { WebSocket } = require(path.join(root, 'node_modules/undici/index.js'));
const CSS_BIN = path.join(root, 'packages/fedipod-server/node_modules/.bin/community-solid-server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const CSS_PORT = 3337; const APP_PORT = 8974; const CDP_PORT = 9336;
const ISSUER = `http://localhost:${CSS_PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-agent-'));

const bundle = path.join(tmp, 'test.js');
await buildApp({ entry: path.join(here, 'entry.mjs'), out: bundle });

const css = spawn(CSS_BIN, ['-p', String(CSS_PORT), '-c', '@css:config/memory-subdomains.json', '-b', `${ISSUER}/`, '-l', 'warn'],
  { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
let cssErr = ''; css.stderr.on('data', (d) => { cssErr = (cssErr + d).slice(-3000); if (process.env.AGENT_DEBUG) process.stderr.write(d); });
let cssUp = false; for (let i = 0; i < 360 && !cssUp; i++) { try { cssUp = !!(await fetch(`${ISSUER}/`)).status; } catch {} if (!cssUp) await sleep(500); }
if (!cssUp) { console.log(`FAIL  the scratch server never answered at ${ISSUER} in 180s` + (cssErr ? `\n--- its output ---\n${cssErr}` : '')); process.exit(1); }

const loader = `<!doctype html><meta charset=utf-8><title>agent</title>
<script type=module>import * as t from '/test.js'; window.T = t; window.__ready = true;</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(loader); }
  if (req.url.startsWith('/test.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(bundle)); }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(APP_PORT, '127.0.0.1', r));

const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--disable-gpu',
  `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank'], { stdio: 'ignore' });
let page;
for (let i = 0; i < 120; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); page = l.find((t) => t.type === 'page'); if (page) break; } catch {} await sleep(500); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
  for (let i = 0; i < 40; i++) { if (await evaluate('window.__ready === true')) break; await sleep(250); }

  const handle = 'tester' + Math.floor(Math.random() * 1e6);
  const password = 'correct horse battery staple';
  const boot = await evaluate(`(async () => {
    const { signUp, BrowserAgent, podSession } = window.T;
    // The pod first, as the provider's own page would make it; then sign-up
    // on a session for it — the one place this test departs from a browser
    // is that the session comes from a credential, not a login form.
    const session = await podSession({ issuer:${JSON.stringify(ISSUER)}, email:${JSON.stringify(handle + '@example.org')}, password:${JSON.stringify(password)}, podName:${JSON.stringify(handle)} });
    const s = await signUp({ handle:${JSON.stringify(handle)} }, { session });
    const agent = new BrowserAgent({ log: (m) => console.log('[agent]', m) });
    await agent.boot({ oidc: session, keysRecord: s.keys, config: s.config, frontOrigin: 'https://front.local' });
    window.__agent = agent; window.__pod = s.pod; window.__handle = ${JSON.stringify(handle)};
    return { address: s.address, actorUrl: s.actorUrl, pod: s.pod };
  })()`);
  if (boot?.__error) throw new Error('boot failed: ' + boot.__error);
  check(!!boot.address, `sign-up + agent boot: ${boot.address}`);

  // The account is real: the pod serves the actor and WebFinger to anyone.
  const host = new URL(boot.pod).host;
  // boot() returns as soon as the agent is usable; publishing the public face
  // happens in the background. Nothing below is true until that has landed.
  const provisioned = await evaluate(`(async () => { try { await window.__agent.provisioning; return 'ok'; }
    catch (e) { return String(e && e.message || e); } })()`);
  check(provisioned === 'ok', `the agent finishes provisioning the pod (${provisioned})`);
  const actorRes = await fetch(boot.actorUrl, { headers: { accept: 'application/activity+json' } });
  const actor = actorRes.status === 200 ? await actorRes.json() : {};
  check(actorRes.status === 200 && actor.type === 'Person' && actor.publicKey?.publicKeyPem?.includes('PUBLIC KEY'),
    'the pod serves the actor with its public key, to anyone');
  check(actor.preferredUsername === handle && actor.inbox === `${boot.pod}fedipod/ap/inbox/`, 'the actor names the handle and its pod inbox');
  const wf = await fetch(`${boot.pod}.well-known/webfinger?resource=acct:${handle}@${host}`);
  const wfDoc = wf.status === 200 ? await wf.json() : {};
  check(wf.status === 200 && wfDoc.links?.some((l) => l.href === boot.actorUrl), 'WebFinger resolves the handle to the actor');

  // The facade answers, and a real sign-in works (no second password).
  const facade = await evaluate(`(async () => {
    const { facadeFetch } = window.T; const a = window.__agent;
    const inst = JSON.parse((await facadeFetch(a, 'GET', '/api/v1/instance')).body);
    const app = JSON.parse((await facadeFetch(a, 'POST', '/api/v1/apps', { headers:{'content-type':'application/json'},
      body: JSON.stringify({ client_name:'test', redirect_uris: self.location.origin + '/', scopes:'read write' }) })).body);
    // Phanpy navigates the browser to authorize (a GET). With no password set,
    // the facade mints for a request the worker has vouched for as this origin's
    // own, sent to a redirect on an address this agent answers on.
    const authz = await facadeFetch(a, 'GET', '/oauth/authorize?' + new URLSearchParams({ client_id: app.client_id, redirect_uri: self.location.origin + '/', response_type:'code', scope:'read write' }).toString());
    const loc = authz.headers.location || authz.headers.Location || '';
    const code = new URL(loc, self.location.origin).searchParams.get('code');
    const tok = JSON.parse((await facadeFetch(a, 'POST', '/oauth/token', { headers:{'content-type':'application/json'},
      body: JSON.stringify({ grant_type:'authorization_code', code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: self.location.origin + '/' }) })).body);
    const me = JSON.parse((await facadeFetch(a, 'GET', '/api/v1/accounts/verify_credentials', { headers:{ authorization:'Bearer '+tok.access_token } })).body);
    const posted = await facadeFetch(a, 'POST', '/api/v1/statuses', { headers:{ authorization:'Bearer '+tok.access_token, 'content-type':'application/json' },
      body: JSON.stringify({ status:'hello from a browser agent', visibility:'public' }) });
    const st = JSON.parse(posted.body || '{}');
    return { instanceUri: inst.uri, gotToken: !!tok.access_token, meAcct: me.username || me.acct, postId: st.id, postContent: st.content };
  })()`);
  if (facade?.__error) throw new Error('facade: ' + facade.__error);
  check(!!facade.instanceUri, `the facade serves instance (${facade.instanceUri})`);
  check(facade.gotToken, 'a full OAuth sign-in yields a token with no second password');
  check(facade.meAcct === handle, `verify_credentials returns the account: @${facade.meAcct}`);
  check(!!facade.postId && /hello from a browser agent/.test(facade.postContent || ''), 'a status posted through the facade is created');

  // That post is on the pod's outbox now.
  const outbox = await fetch(`${boot.pod}fedipod/ap/outbox`, { headers: { accept: 'application/activity+json' } });
  check(outbox.status === 200, 'the pod serves the outbox the post went to');
} catch (e) { console.log('ERROR', e.message); fails++; }
finally {
  ws.close(); chrome.kill('SIGKILL'); css.kill('SIGKILL'); server.close(); await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
