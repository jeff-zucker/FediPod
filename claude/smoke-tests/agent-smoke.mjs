// agent-smoke.mjs — offline smoke for fedipod. No network; no pod.
// From project root:  node claude/smoke-tests/agent-smoke.mjs
//
// 1. boots run-agent.mjs unconfigured (no credential) on a scratch AP_HOME
// 2. gate + unconfigured admin behavior + static Phanpy serving
// 3. Mastodon facade: oauth theater, stubs, auth gating
// 4. keys + Fedify sign→verify round-trip on the PodStore
// 5. wire builders (nested /activitypods-js/ layout)
// 6. pod-RDF turtle builders (escaping, paths) via injected fetch
// 7. facade M1–M3 surface on a seeded in-memory PodStore, faked delivery
// 8. Announce ingestion + tag-feed sweep with faked fetches
// 12. the setup page, the preflight, the setup run (real account API vs a
//     mock CSS), and the editable record

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Throwaway agents must not claim (or yield) the real machine's directory
// door on 8030 — every child spawned below inherits this.
process.env.AP_DIRECTORY = '0';
let bootLog = '';
const HOME = fs.mkdtempSync('/tmp/fedipod-smoke-');
const PORT = 18621;
const TOKEN = 'smoke-token';

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

// Every port in this suite is a fixed number, so an agent LEFT OVER FROM AN
// EARLIER RUN answers in our child's place. That is not a flake, it is a suite
// that passes while testing a different process: the child dies on EADDRINUSE,
// its complaint goes into a bootLog nobody prints unless a check fails, and
// every request lands on the old one. Verified — a leftover agent on 18621
// produced 451 PASS against code that was never under test. When it then dies
// mid-run you get ECONNRESET instead, which is how this was noticed at all.
//
// They leaked because the child is killed on the last line of a clean run, and
// a crash never reaches it. Both halves are fixed: this refuses to start, and
// the child is reaped on every exit path below.
async function refusePortInUse(port) {
  const answered = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })
    .then(() => true).catch(() => false);
  if (!answered) return;
  console.log(`FAIL  port ${port} is already answering — most likely an agent left over`);
  console.log('      from an earlier run of this suite. It would answer in place of the one');
  console.log('      under test, and the run would go green without testing your changes.');
  console.log(`      Find it with:  ss -ltnp | grep ${port}`);
  process.exit(1);
}
await refusePortInUse(PORT);

// --- 1. boot (unconfigured: no credential.json in HOME) ---
const child = spawn(process.execPath, [path.join(root, 'run-agent.mjs')], {
  cwd: root,
  env: { ...process.env, AP_HOME: HOME, AP_PORT: String(PORT), AP_GATE_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// The child is killed at the END of a clean run. A crash never reached that
// line, so every crashed run leaked an agent onto 18621 and poisoned the next
// one — which is what made this self-sustaining rather than a one-off.
const reap = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
process.on('exit', reap);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { reap(); process.exit(1); });
process.on('uncaughtException', (e) => {
  reap();
  console.log(`FAIL  the suite threw: ${e.message}`);
  console.log('--- agent log ---\n' + bootLog);
  process.exit(1);
});

// A child that dies mid-run makes every later request fail in a way that looks
// like a broken test. Say which it was.
child.on('exit', (code, sig) => {
  if (code === 0 || sig === 'SIGTERM' || sig === 'SIGKILL') return;
  console.log(`FAIL  the agent under test exited early (code=${code} signal=${sig})`);
  console.log('--- agent log ---\n' + bootLog);
});
child.stdout.on('data', d => { bootLog += d; });
child.stderr.on('data', d => { bootLog += d; });

const up = await new Promise(resolve => {
  const t0 = Date.now();
  const tick = async () => {
    try { await fetch(`http://127.0.0.1:${PORT}/status`); return resolve(true); } catch {}
    if (Date.now() - t0 > 15_000) return resolve(false);
    setTimeout(tick, 300);
  };
  tick();
});
check(up, 'agent boots and listens');

if (up) {
  const gh = { 'x-dk-token': TOKEN };

  // --- 2. gate + unconfigured + static ---
  const anon = await fetch(`http://127.0.0.1:${PORT}/status`);
  check(anon.status === 401, `/status without token → 401 (got ${anon.status})`);
  const authed = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: gh });
  const status = await authed.json();
  check(authed.status === 200 && status.configured === false,
    `/status with token → unconfigured (got ${JSON.stringify(status).slice(0, 80)})`);

  const post = await fetch(`http://127.0.0.1:${PORT}/post`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'nope' }),
  });
  check(post.status === 409, `/post while unconfigured → 409 (got ${post.status})`);

  // --- security: Host/Origin firewall, headers, cross-site authorize ---
  // fetch() refuses to set Host (forbidden header), so speak HTTP directly.
  const { default: netMod } = await import('node:net');
  const rawGet = (headerLines) => new Promise((resolve) => {
    const s = netMod.connect(PORT, '127.0.0.1', () => {
      s.write(`GET /status HTTP/1.1\r\n${headerLines}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    s.on('data', d => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', () => resolve(''));
  });
  const rebind = await rawGet(`Host: evil.example\r\nx-dk-token: ${TOKEN}`);
  check(/^HTTP\/1\.1 403/.test(rebind), `rebound Host refused (got ${rebind.slice(9, 12) || 'nothing'})`);
  const goodHost = await rawGet(`Host: localhost:${PORT}\r\nx-dk-token: ${TOKEN}`);
  check(/^HTTP\/1\.1 200/.test(goodHost), 'expected Host still served');
  const xorigin = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { ...gh, origin: 'https://evil.example' } });
  check(xorigin.status === 403, `cross-origin request refused (got ${xorigin.status})`);
  const xsite = await fetch(`http://127.0.0.1:${PORT}/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb`, {
    headers: { ...gh, 'sec-fetch-site': 'cross-site' },
  });
  check(xsite.status === 403, `cross-site authorize refused (got ${xsite.status})`);
  const badRedirect = await fetch(`http://127.0.0.1:${PORT}/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb`, {
    headers: gh, redirect: 'manual',
  });
  check(badRedirect.status === 400, `off-origin redirect_uri refused (got ${badRedirect.status})`);
  const hdrs = await fetch(`http://127.0.0.1:${PORT}/`, { headers: gh });
  // 'self', not 'none': /admin/client/ frames the bundled client under a bar of
  // ours. Same origin only — anything wider would let a visited page put the
  // agent in a frame, which is what these two headers exist to stop.
  check(hdrs.headers.get('x-content-type-options') === 'nosniff'
    && /frame-ancestors 'self'/.test(hdrs.headers.get('content-security-policy') || '')
    && hdrs.headers.get('x-frame-options') === 'SAMEORIGIN',
    'security headers present on HTML, framing limited to our own origin');

  const niPtr = await fetch(`http://127.0.0.1:${PORT}/.well-known/nodeinfo`, { headers: gh });
  const niPtrBody = await niPtr.json();
  const niDoc = await fetch(`http://127.0.0.1:${PORT}/nodeinfo/2.0`, { headers: gh });
  const niDocBody = await niDoc.json();
  check(niPtr.status === 200 && /\/nodeinfo\/2\.0$/.test(niPtrBody.links?.[0]?.href)
    && niDoc.status === 200 && niDocBody.software?.name === 'fedipod'
    && niDocBody.protocols?.includes('activitypub'),
    'nodeinfo pointer + document served');

  // Unconfigured, `/` is the setup page, not a client with nothing to show.
  // (A CONFIGURED agent still gets Phanpy at `/` — asserted in §14.)
  const bare = await fetch(`http://127.0.0.1:${PORT}/`, { headers: gh, redirect: 'manual' });
  check(bare.status === 302 && bare.headers.get('location') === '/admin/setup/',
    `/ sends an unconfigured agent to setup (${bare.status} → ${bare.headers.get('location')})`);
  const ui = await fetch(`http://127.0.0.1:${PORT}/`, { headers: gh });
  const uiBody = await ui.text();
  check(ui.status === 200 && /text\/html/.test(ui.headers.get('content-type')) && /setup\.js/.test(uiBody),
    `and that page is served (got ${ui.status})`);
  const jail = await fetch(`http://127.0.0.1:${PORT}/..%2f..%2fpackage.json`, { headers: gh });
  check(jail.status === 403 || jail.status === 404, `path traversal blocked (got ${jail.status})`);

  // The vendored client must not install a service worker. One that outlives
  // the page answers navigations from its precache with the headers it stored,
  // so a header fix (the CSP script-src hash) never reaches a browser that has
  // it. sw.js stays as a kill-switch so old installs clean themselves up.
  const noRegister = ['phanpy/dist/index.html', 'phanpy/dist/compose/index.html']
    .every(f => !/inline-sw/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  const swSrc = fs.readFileSync(path.join(root, 'phanpy/dist/sw.js'), 'utf8');
  check(noRegister && /registration\.unregister\(\)/.test(swSrc),
    'UI registers no service worker; sw.js is the kill-switch');

  // --- 3. facade basics ---
  const inst = await fetch(`http://127.0.0.1:${PORT}/api/v1/instance`, { headers: gh });
  const instBody = await inst.json();
  check(inst.status === 200 && /fedipod/.test(instBody.version), `/api/v1/instance → 200 (got ${inst.status})`);

  const apps = await fetch(`http://127.0.0.1:${PORT}/api/v1/apps`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'smoke', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob' }),
  });
  check((await apps.json()).client_id === 'dk-ap-client', 'POST /api/v1/apps returns client');

  const authz = await fetch(`http://127.0.0.1:${PORT}/oauth/authorize?redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=dk-ap-client`, { headers: gh });
  const { code } = await authz.json();
  const tok = await fetch(`http://127.0.0.1:${PORT}/oauth/token`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${code}&client_id=dk-ap-client`,
  });
  const tokBody = await tok.json();
  check(!!tokBody.access_token, 'oauth authorize → token round-trip');

  // Minting for an unknown code handed a bearer to anyone who could reach the
  // port; a non-browser client sends no Origin, so the firewall never saw it.
  const forged = await fetch(`http://127.0.0.1:${PORT}/oauth/token`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=authorization_code&code=not-a-real-code&client_id=dk-ap-client',
  });
  const forgedBody = await forged.json();
  check(forged.status === 400 && !forgedBody.access_token,
    `/oauth/token refuses an unknown code (got ${forged.status})`);
  const empty = await fetch(`http://127.0.0.1:${PORT}/oauth/token`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/json' }, body: '{}',
  });
  check(empty.status === 400, `/oauth/token refuses a missing code (got ${empty.status})`);
  const reuse = await fetch(`http://127.0.0.1:${PORT}/oauth/token`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=authorization_code&code=${tokBody.access_token}&client_id=dk-ap-client`,
  });
  check((await reuse.json()).access_token === tokBody.access_token,
    'a live token still exchanges for itself');

  // --- the admin body must say it is JSON ---
  // A cross-origin form POST needs no preflight, and JSON.parse never cared
  // what Content-Type claimed, so a visited page could reach every write route.
  const formish = await fetch(`http://127.0.0.1:${PORT}/block`, {
    method: 'POST', headers: { ...gh, 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ domain: 'evil.example' }),
  });
  check(formish.status === 400 && /application\/json/.test((await formish.json()).error),
    `a form-shaped POST is refused whatever the body says (got ${formish.status})`);
  const urlencoded = await fetch(`http://127.0.0.1:${PORT}/block`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/x-www-form-urlencoded' },
    body: '{"domain":"evil.example"}',
  });
  check(urlencoded.status === 400, `and so is the other preflight-free encoding (got ${urlencoded.status})`);
  // `stop` POSTs /shutdown with neither, so an empty body still has to parse.
  const noType = await fetch(`http://127.0.0.1:${PORT}/block`, { method: 'POST', headers: gh });
  check(noType.status === 400 && /domain or actor/.test((await noType.json()).error),
    'an empty body with no content-type still reaches the route');
  const proper = await fetch(`http://127.0.0.1:${PORT}/block`, {
    method: 'POST', headers: { ...gh, 'content-type': 'application/json' },
    body: JSON.stringify({ domain: 'evil.example' }),
  });
  check(proper.status === 200, `a JSON POST is unaffected (got ${proper.status})`);

  const stubs = await fetch(`http://127.0.0.1:${PORT}/api/v1/filters`, { headers: gh });
  check(stubs.status === 200 && Array.isArray(await stubs.json()), 'stub endpoint returns []');

  const noAuth = await fetch(`http://127.0.0.1:${PORT}/api/v1/timelines/home`, { headers: gh });
  check(noAuth.status === 401, `timeline without bearer → 401 (got ${noAuth.status})`);
  const badCfg = await fetch(`http://127.0.0.1:${PORT}/api/v1/timelines/home`, {
    headers: { ...gh, authorization: `Bearer ${tokBody.access_token}` },
  });
  check(badCfg.status === 503, `timeline with bearer but unconfigured → 503 (got ${badCfg.status})`);
}

// --- 4. keys + signing round-trip on PodStore (in-memory) ---
const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
const { HttpStorage, FileStorage } = await import(path.join(root, 'lib/storage.mjs'));
// Production attaches a Storage; most of these tests think in (url, fetch).
const attachHttp = (s, base, fetchImpl) => s.attach(new HttpStorage(base, fetchImpl));
const { resolveKeys } = await import(path.join(root, 'lib/keys.mjs'));
const store = new PodStore({ log: () => {} });
const keys = await resolveKeys(store);                       // no localDir → pod mode
check(/^-----BEGIN PUBLIC KEY-----/.test(keys.rsaPublicPem), 'RSA public PEM present');
check(store.has('keys.json'), 'keys persisted through PodStore (--keys pod)');

// Local-by-default: fresh install writes the key to AP_HOME, 0600, never the pod.
{
  const home = fs.mkdtempSync('/tmp/dk-ap-keys-');
  const s = new PodStore({ log: () => {} });
  const k = await resolveKeys(s, { localDir: home });
  const mode = fs.statSync(path.join(home, 'keys.json')).mode & 0o777;
  check(/BEGIN PUBLIC KEY/.test(k.rsaPublicPem) && mode === 0o600 && !s.has('keys.json'),
    `local keys are the default (mode ${mode.toString(8)}, pod untouched)`);

  // Migration: an actor whose key sits in pod state adopts it locally and
  // the pod copy is removed — same identity, key no longer on the pod.
  const home2 = fs.mkdtempSync('/tmp/dk-ap-keys2-');
  const s2 = new PodStore({ log: () => {} });
  const podKeys = await resolveKeys(s2);                     // seed a pod-held key
  const migrated = await resolveKeys(s2, { localDir: home2 });
  check(migrated.rsaPublicPem === podKeys.rsaPublicPem && !s2.has('keys.json')
    && fs.existsSync(path.join(home2, 'keys.json')),
    'pod-held key migrates to local and is deleted from the pod');

  // The guard: no key material anywhere but the actor already publishes one
  // → refuse to mint (that would invalidate every cached signature).
  const s3 = new PodStore({ log: () => {} });
  const home3 = fs.mkdtempSync('/tmp/dk-ap-keys3-');
  const refused = await resolveKeys(s3, { localDir: home3, actorHasKey: async () => true })
    .then(() => null).catch(e => e.message);
  check(/already publishes a signing key/.test(refused || ''),
    'refuses to mint when the actor already publishes a key');
  const rotated = await resolveKeys(s3, { localDir: home3, actorHasKey: async () => true, rotate: true });
  check(/BEGIN PUBLIC KEY/.test(rotated.rsaPublicPem), '--rotate-key mints deliberately');
  for (const d of [home, home2, home3]) fs.rmSync(d, { recursive: true, force: true });
}

const { createRequire } = await import('node:module');
const req = createRequire(path.join(root, 'package.json'));
const { signRequest, verifyRequest } = await import(req.resolve('@fedify/fedify/sig'));

const keyId = 'https://pod.example/activitypods-js/ap/actor#main-key';
const signed = await signRequest(
  new Request('https://mastodon.example/users/alice/inbox', {
    method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: '{}',
  }),
  keys.rsaPrivate, new URL(keyId),
);
check(!!signed.headers.get('signature'), 'signRequest adds Signature header');

const actorId = 'https://pod.example/activitypods-js/ap/actor';
const actorDocJson = {
  '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
  id: actorId, type: 'Person',
  publicKey: { id: keyId, owner: actorId, publicKeyPem: keys.rsaPublicPem },
};
const documentLoader = async (url) => ({ document: actorDocJson, documentUrl: url, contextUrl: null });
const verified = await verifyRequest(signed, { documentLoader }).catch(e => e);
check(verified && !(verified instanceof Error),
  `verifyRequest round-trip (${verified instanceof Error ? verified.message : 'signature valid'})`);

// --- 5. wire builders (nested layout) ---
const wire = await import(path.join(root, 'lib/wire.mjs'));
const urls = wire.apUrls('https://pod.example/');
check(urls.webfinger === 'https://pod.example/.well-known/webfinger'
  && urls.actor === 'https://pod.example/activitypods-js/ap/actor'
  && urls.state === 'https://pod.example/activitypods-js/ap-state/'
  && urls.fediverse === 'https://pod.example/activitypods-js/fediverse/',
  'apUrls nests under /activitypods-js/, webfinger at root');
const urlsCustom = wire.apUrls('https://pod.example/', 'other-root/');
check(urlsCustom.actor === 'https://pod.example/other-root/ap/actor', 'apUrls root is configurable');
// base was normalized and root was not, so `--root foo` produced .../fooap/actor
const urlsNoSlash = wire.apUrls('https://pod.example/', 'other-root');
check(urlsNoSlash.actor === 'https://pod.example/other-root/ap/actor'
  && urlsNoSlash.state === 'https://pod.example/other-root/ap-state/',
  `a root without a trailing slash is normalized (${urlsNoSlash.actor})`);
const jrd = wire.jrd({ handle: 'jeff', host: 'pod.example', actor: urls.actor });
check(jrd.subject === 'acct:jeff@pod.example' && jrd.links[0].href === urls.actor, 'webfinger JRD shape');
const actor = wire.actorDoc({ urls, handle: 'jeff', name: 'Jeff', publicKeyPem: 'PEM' });
check(actor.inbox === urls.inbox && actor.publicKey.id === urls.actor + '#main-key', 'actor doc shape');
const note = wire.noteDoc({ urls, slug: 'x', content: 'a<b>&\n\nc', published: '2026-07-28T00:00:00Z' });
check(note.content === '<p>a&lt;b&gt;&amp;</p><p>c</p>', `content HTML escaping (got ${note.content})`);

// --- 5b. a handle only resolves from a pod at a host root ---
{
  check(wire.webfingerHost('https://you.solidcommunity.net/') === 'you.solidcommunity.net'
    && wire.webfingerHost('https://you.solidcommunity.net') === 'you.solidcommunity.net'
    && wire.webfingerHost('https://server.example/you/') === null,
    'webfingerHost: host-root pod yes, path pod no');
}

// --- 5c. the private trees are re-checked and repaired on every start ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const config = { remotePod: 'https://pod.example/', handle: 'you', name: 'You' };
  const mkPub = (probeStatus) => {
    const acls = [];
    const pub = new Publisher({
      config,
      remote: { setAcl: async (url, modes) => { acls.push([url, modes]); } },
      local: {}, store: { getStatuses: () => [] }, deliverer: {}, publicKeyPem: 'x',
      log: () => {},
      probeFetch: async () => ({ status: probeStatus }),
    });
    return { pub, acls };
  };

  // A stranger can read them → rewrite the ACL on all three private trees.
  const leaky = mkPub(200);
  await leaky.pub.ensurePrivateAcls();
  const wanted = [leaky.pub.urls.home, leaky.pub.urls.state, leaky.pub.urls.fediverse];
  check(leaky.acls.length === 3
    && wanted.every((u, i) => leaky.acls[i][0] === u && leaky.acls[i][1].length === 0),
    'ensurePrivateAcls repairs home + ap-state + fediverse when they read publicly');

  // Already private → no writes at all.
  const tight = mkPub(401);
  await tight.pub.ensurePrivateAcls();
  check(tight.acls.length === 0, 'ensurePrivateAcls writes nothing when the trees are already private');
}

// --- 5c0. a follower event publishes what it changed, and nothing else ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const mk = () => {
    const seen = [];
    const pub = new Publisher({
      config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
      remote: {
        putJson: async (u) => { seen.push(`PUT ${u.replace('https://pod.example/', '')}`); },
        setAcl: async (u) => { seen.push(`ACL ${u.replace('https://pod.example/', '')}`); },
        // both reconcile paths read through getJson now (followers walks pages)
        fetch: async (u) => { seen.push(`GET ${u.replace('https://pod.example/', '')}`); return { ok: false }; },
        getJson: async (u) => { seen.push(`GET ${u.replace('https://pod.example/', '')}`); return null; },
      },
      local: { writeContacts: async () => {} },
      store: {
        read: () => [], write: () => {}, getStatuses: () => [],
        getContacts: () => ({ followers: [{ actor: 'https://a.example/u/x' }], following: [] }),
        setContacts: () => {},
      },
      deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'x', log: () => {},
      // Answers the privateReady canary as world-readable: the FEP pending and
      // blocked collections are then (correctly) withheld, and the probe never
      // leaves the fixture. Their own coverage is section 25.
      probeFetch: async () => ({ status: 200 }),
    });
    return { pub, seen };
  };

  const all = mk();
  await all.pub.publishCollections();
  check(all.seen.length === 14,
    `an unnarrowed publish is still the whole surface — pages + heads, plus the private container the pending/blocked probe ensures (saw ${all.seen.length})`);

  // One new follower changes the follower list. It does not change what this
  // actor follows, it does not change the outbox, and it cannot change an ACL
  // whose body is a pure function of the WebID.
  const one = mk();
  await one.pub.publishCollections({ followers: true });
  // Paged like the outbox: a page document and a small head, not one document
  // that grows without limit.
  check(one.seen.some(s => s.startsWith('PUT') && /ap\/followers-\d+$/.test(s))
    && one.seen.some(s => s.startsWith('PUT') && s.endsWith('ap/followers')),
    `a follower event writes a page and the head (saw ${one.seen.join(', ') || 'nothing'})`);
  check(!one.seen.some(s => s.includes('outbox') || s.includes('following')),
    'and touches neither the outbox nor the following collection');

  // The reconcile is the guard that stops a restored-and-behind machine
  // publishing a short list over the pod's longer one, so a narrowed publish
  // must still run the one belonging to what it overwrites.
  check(one.seen[0].startsWith('GET') && one.seen[0].endsWith('ap/followers'),
    'the followers reconcile still runs — it is what protects a restored machine');
  const ob = mk();
  await ob.pub.publishCollections({ outbox: true });
  check(ob.seen[0].startsWith('GET') && ob.seen[0].endsWith('ap/outbox'),
    'and the outbox reconcile runs when the outbox is what is being written');
  check(ob.seen.some(x => x.startsWith('PUT') && /ap\/outbox-\d+$/.test(x))
    && ob.seen.some(x => x.startsWith('PUT') && x.endsWith('ap/outbox')),
    'which writes a page and the head, not one document carrying everything');

  // Every caller that knows what it changed says so.
  for (const [file, fn] of [['lib/intake.mjs', 'intake'], ['lib/social.mjs', 'social']]) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    check(!/publishCollections\(\)/.test(src),
      `${fn} never publishes the whole surface for a single event`);
  }
}

// --- 5c1. a Create is a document of its own, so a group's Announce resolves ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const put = [];
  const pub = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: { putJson: async (u, b) => put.push({ u, b }), setAcl: async () => {}, delete: async () => true },
    local: { writeNote: async () => {} },
    store: {
      getStatuses: () => [], read: () => [], write: () => {}, addStatus: () => {},
      getContacts: () => ({ followers: [], following: [] }),
    },
    deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'x', log: () => {},
  });
  const made = await pub.publishNote('hello');
  const createId = wire.createActivityId(made.id);
  check(!createId.includes('#') && createId === made.id + '-create',
    `the Create id is a document, not a fragment (${createId})`);
  const doc = put.find(x => x.u === createId);
  check(doc && doc.b.type === 'Create' && doc.b.object?.id === made.id,
    'publishNote publishes the Create too, so a wrapped Announce can be dereferenced');

  // A mentioned actor has to be delivered to as well as tagged, or they never
  // hear about it.
  const sent = [];
  const asked = [];
  const pub2 = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: { putJson: async () => {}, setAcl: async () => {}, delete: async () => true },
    local: { writeNote: async () => {} },
    store: {
      getStatuses: () => [], read: () => [], write: () => {}, addStatus: () => {},
      getContacts: () => ({ followers: [{ actor: 'f', inbox: 'https://f.example/inbox' }], following: [] }),
    },
    deliverer: { deliverToAll: async (i, a) => sent.push({ i, a }) },
    publicKeyPem: 'x', log: () => {},
    resolveMention: async (h) => {
      asked.push(h);
      return h === 'kofi@b.example'
        ? { id: 'https://b.example/u/kofi', inbox: 'https://b.example/u/kofi/inbox' } : null;
    },
  });
  const n2 = await pub2.publishNote('hi @kofi@b.example and @ghost@z.example');
  check(JSON.stringify(asked) === JSON.stringify(['kofi@b.example', 'ghost@z.example']),
    'every handle in the text is looked up');
  check(n2.tag?.length === 1 && n2.tag[0].href === 'https://b.example/u/kofi',
    'only the resolved mention becomes a tag');
  check(sent[0]?.i.includes('https://b.example/u/kofi/inbox') && sent[0].i.includes('https://f.example/inbox'),
    `the Create goes to followers and to the mentioned actor (${JSON.stringify(sent[0]?.i)})`);

  // Replying without retyping the handles must still reach the group, or a
  // thread breaks the first time somebody trims their reply. A PERSON trimmed
  // out of that same reply is not carried: the text is authoritative, which is
  // what every fediverse client leads people to expect.
  const PARENT = 'https://grp.example/activitypods-js/ap/notes/p9';
  const sent3 = [];
  const pub3 = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: { putJson: async () => {}, setAcl: async () => {}, delete: async () => true },
    local: { writeNote: async () => {} },
    store: {
      getStatuses: () => [{ noteId: PARENT, mentions: [
        { href: 'https://grp.example/a/actor', name: '@grp@grp.example' },
        { href: 'https://b.example/u/mei', name: '@mei@b.example' },
      ] }],
      read: () => [], write: () => {}, addStatus: () => {},
      getContacts: () => ({ followers: [], following: [] }),
    },
    deliverer: { deliverToAll: async (i) => sent3.push(...i) }, publicKeyPem: 'x', log: () => {},
    resolveMention: async (h) => ({
      'grp@grp.example': { id: 'https://grp.example/a/actor', type: 'Group', inbox: 'https://grp.example/a/inbox' },
      'mei@b.example': { id: 'https://b.example/u/mei', type: 'Person', inbox: 'https://b.example/u/mei/inbox' },
    })[h] || null,
  });
  const n3 = await pub3.publishNote('just replying', { inReplyTo: PARENT });
  check(n3.tag?.some(t => t.href === 'https://grp.example/a/actor')
    && n3.cc.includes('https://grp.example/a/actor'),
    'a reply carries the parent thread\'s group even when the text drops it');
  check(!n3.tag?.some(t => t.href === 'https://b.example/u/mei'),
    'a person trimmed out of the reply text is not carried forward as a tag');
  check(!sent3.includes('https://b.example/u/mei/inbox'),
    'and is not delivered to either — trimming the handle means not notifying them');
  const n3b = await pub3.publishNote('still here @mei@b.example', { inReplyTo: PARENT });
  check(n3b.tag?.some(t => t.href === 'https://b.example/u/mei'),
    'but a person the author does retype is mentioned normally');
}

// --- 5b2. editing, visibility and content warnings ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const PUB = 'https://www.w3.org/ns/activitystreams#Public';
  const putDocs = {};
  const statuses = [];
  const sent = [];
  const pub = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: { putJson: async (id, doc) => { putDocs[id] = doc; }, setAcl: async () => {}, delete: async () => true },
    local: { writeNote: async () => {} },
    store: {
      getStatuses: () => statuses, read: () => [], write: () => {},
      addStatus: (s) => statuses.unshift(s),
      updateStatus: (noteId, patch) => {
        const i = statuses.findIndex(x => x.noteId === noteId);
        if (i < 0) return null;
        statuses[i] = { ...statuses[i], ...patch };
        return statuses[i];
      },
      getContacts: () => ({ followers: [{ actor: 'f', inbox: 'https://f.example/inbox' }], following: [] }),
    },
    deliverer: { deliverToAll: async (i, a) => sent.push({ i, a }) },
    publicKeyPem: 'x', log: () => {},
    resolveMention: async (h) => (h === 'kofi@b.example'
      ? { id: 'https://b.example/u/kofi', inbox: 'https://b.example/u/kofi/inbox' } : null),
  });
  const note = await pub.publishNote('first words', { visibility: 'unlisted', spoilerText: 'cw here' });
  check(note.summary === 'cw here', 'a content warning rides the note as its summary');
  check(!note.to.includes(PUB) && note.cc.includes(PUB), 'unlisted: Public moves from to into cc');
  const s = statuses.find(x => x.noteId === note.id);
  check(s.visibility === 'unlisted' && s.spoiler === 'cw here' && s.text === 'first words',
    'the store keeps visibility, the spoiler and the raw text');
  const patched = await pub.updateNote(s, { content: 'second words', spoilerText: null });
  check(!!patched.editedAt && patched.text === 'second words',
    'an edit patches the store and stamps editedAt');
  const up = sent.find(x => x.a.type === 'Update')?.a;
  check(!!up && up.object.id === note.id && up.object.updated === patched.editedAt,
    'the Update keeps the note id and carries the edit stamp');
  check(String(putDocs[note.id]?.content || '').includes('second words'),
    'the pod note document is overwritten in place');
  check(String(putDocs[note.id + '-create']?.object?.content || '').includes('second words'),
    'and the Create document resolves to the edited text');

  // followers-only and direct: addressing, container, outbox, delivery, gate
  pub.probeFetch = async () => ({ status: 403 });
  const OUTBOX = 'https://pod.example/activitypods-js/ap/outbox';
  const outboxBefore = JSON.stringify(putDocs[OUTBOX] || null);
  const pn = await pub.publishNote('for followers only', { visibility: 'private' });
  check(!JSON.stringify([pn.to, pn.cc]).includes(PUB) && pn.id.includes('/ap/private/'),
    'a followers-only note carries no Public address and lives in the private container');
  const dm = await pub.publishNote('psst @kofi@b.example', { visibility: 'direct' });
  const dmSent = sent[sent.length - 1];
  check(dm.to.length === 1 && dm.to[0] === 'https://b.example/u/kofi' && dm.cc.length === 0,
    'a direct note is addressed to the people it names and nobody else');
  check(dmSent.i.length === 1 && dmSent.i[0] === 'https://b.example/u/kofi/inbox',
    'and is delivered to their inbox alone — no followers');
  check(JSON.stringify(putDocs[OUTBOX] || null) === outboxBefore,
    'neither private nor direct touched the public outbox');
  pub._privateVerdict = undefined;
  pub.probeFetch = async () => ({ status: 200 });
  const refused = await pub.publishNote('secret', { visibility: 'private' }).then(() => null, e => e.message);
  check(/serves private documents to strangers/.test(refused || ''),
    'a pod that hands the canary to strangers refuses private posts');
}

// --- 5b3. voting: one bare Note per choice, to the poll's author alone ---
{
  const social = await import(path.join(root, 'lib/social.mjs'));
  const sent = [];
  let patched = null;
  const agent = {
    publisher: { urls: { actor: 'https://you.example/ap/actor', notes: 'https://you.example/ap/notes/' } },
    intake: { fetchAP: async () => ({ id: 'https://poll.example/u/a', inbox: 'https://poll.example/inbox' }) },
    remote: { putJson: async () => {} },
    deliverer: { deliverToAll: async (i, a) => sent.push({ i, a }) },
    store: { updateStatus: (id, patch) => { patched = patch; return patch; } },
  };
  const s = { noteId: 'https://poll.example/n/1', actor: 'https://poll.example/u/a',
    poll: { multiple: false, options: [{ title: 'yes', votes: 2 }, { title: 'no', votes: 5 }] } };
  check(!(await social.votePoll(agent, s, [0, 1])).ok, 'a single-choice poll refuses two choices');
  const r = await social.votePoll(agent, s, [1]);
  check(r.ok && sent.length === 1 && sent[0].i[0] === 'https://poll.example/inbox',
    'the vote goes to the poll author alone');
  check(sent[0].a.type === 'Create' && sent[0].a.object.name === 'no'
    && sent[0].a.object.inReplyTo === s.noteId && !sent[0].a.object.content,
    'and is a bare Note naming the option');
  check(!!patched?.poll?.voted && patched.poll.ownVotes[0] === 1 && patched.poll.options[1].votes === 6,
    'our copy marks the vote and bumps the tally');
  check(!(await social.votePoll(agent, { ...s, poll: patched.poll }, [0])).ok, 'voting twice is refused');
  check(!(await social.votePoll(agent, { ...s, poll: { ...s.poll, closed: true } }, [0])).ok,
    'a closed poll is refused');
}

// --- 5c0. the websocket origins the CSP allows ---
{
  const { wsOrigins } = await import(path.join(root, 'lib/admin.mjs'));
  const plain = wsOrigins(8041);
  check(plain.includes('ws://localhost:8041') && plain.includes('ws://127.0.0.1:8041'),
    'the loopback websocket origins are allowed');
  // No IPv6 in either form. Chrome rejects `ws://[::1]:8041` as a CSP source
  // expression and then discards the WHOLE connect-src directive — so listing
  // it cost every other origin on the line, including the one streaming uses.
  check(!plain.some(o => /::|\[/.test(o)),
    `no IPv6, bracketed or bare — it invalidates the directive (${plain.join(' ')})`);
  check(new Set(plain).size === plain.length, 'and no duplicates');
  process.env.AP_ALLOWED_HOSTS = 'solo.localhost:8041';
  const named = wsOrigins(8041);
  delete process.env.AP_ALLOWED_HOSTS;
  // Pinning connect-src to localhost silently killed streaming for anyone
  // browsing an agent at its own name.
  check(named.includes('ws://solo.localhost:8041'),
    'a declared extra host may open the streaming socket too');

  // --- the agent's own name, without AP_ALLOWED_HOSTS ---
  const { hostLabel, allowedAuthorities, Authorities, checkRequest } =
    await import(path.join(root, 'lib/guard.mjs'));
  check(hostLabel('solo') === 'solo' && hostLabel('jeff-zucker') === 'jeff-zucker',
    'a clean handle is a host label');
  check([null, 'a_b', 'A B', 'x@y', '-lead', 'trail-', ''].every(h => hostLabel(h) === null),
    'anything that is not already a DNS label gets no named origin, rather than being mangled');
  const withLabel = allowedAuthorities(8041, ['solo']);
  check(withLabel.has('solo.localhost:8041') && withLabel.has('localhost:8041'),
    'the named origin joins the loopback set, it does not replace it');
  // `http://localhost` IS port 80. Emitting the port-less form whatever port we
  // are on put every other local server's pages inside our own origin set — a
  // page on 127.0.0.1:80 sends `Origin: http://localhost`, which passed.
  check(!withLabel.has('solo.localhost') && !withLabel.has('localhost')
    && !withLabel.has('127.0.0.1'),
    'the port-less authority is not ours unless we are on 80/443');
  const on80 = allowedAuthorities(80, ['solo']);
  check(on80.has('localhost') && on80.has('solo.localhost') && on80.has('localhost:80'),
    'on port 80 the port-less authority really is ours');
  const wsNamed = wsOrigins(8041, ['solo']);
  check(wsNamed.includes('ws://solo.localhost:8041')
    && new Set(wsNamed).size === wsNamed.length,
    `the CSP lets it open the streaming socket, once (${wsNamed.length} origins)`);

  const auth = new Authorities(8041);
  check(!auth.has('solo.localhost:8041'), 'before the handle is known, its name is not allowed');
  // startAdmin listens before connect reads pod state, so the set has to be
  // live — a snapshot would refuse the named origin for the whole process.
  check(auth.setHandle('solo') === true && auth.has('solo.localhost:8041')
    && auth.setHandle('solo') === false,
    'setHandle admits it, and says whether anything changed');
  check(checkRequest({ headers: { host: 'solo.localhost:8041' } }, auth) === null
    && checkRequest({ headers: { host: 'evil.example' } }, auth) !== null,
    'the firewall takes the name and still refuses everything else');
  process.env.AP_ALLOWED_HOSTS = 'box.tailnet.example:8041';
  const exposed = new Authorities(8041, 'solo');
  delete process.env.AP_ALLOWED_HOSTS;
  check(exposed.has('box.tailnet.example:8041') && !exposed.isLocal('box.tailnet.example:8041')
    && exposed.isLocal('solo.localhost:8041') && exposed.isLocal('localhost:8041'),
    'a deliberately exposed host is allowed but is not "this machine"');

  // --- locality is a property of the connection too, not the header alone ---
  const { isLoopbackSocket, exposureProblem } = await import(path.join(root, 'lib/guard.mjs'));
  const req = (host, addr) => ({ headers: { host }, socket: { remoteAddress: addr } });
  check(isLoopbackSocket(req('x', '127.0.0.1')) && isLoopbackSocket(req('x', '::1'))
    && isLoopbackSocket(req('x', '::ffff:127.0.0.1'))
    && !isLoopbackSocket(req('x', '10.0.0.4')) && !isLoopbackSocket({ headers: {} }),
    'a loopback socket is recognised in all three spellings, and absence is not one');
  check(auth.isLocalRequest(req('localhost:8041', '127.0.0.1'))
    && !auth.isLocalRequest(req('localhost:8041', '10.0.0.4'))
    && !auth.isLocalRequest(req('evil.example', '127.0.0.1')),
    'a local-only route wants the Host AND the socket to agree');

  // The whole reason the check above is not enough: a same-host proxy connects
  // from loopback and rewrites Host to one, so an exposed agent has nothing
  // left but a shared secret. Refuse rather than pretend.
  check(exposureProblem({ allowedHosts: '', gateToken: '' }) === null
    && exposureProblem({ allowedHosts: '  , ', gateToken: '' }) === null,
    'an agent that is not exposed needs no gate token');
  check(exposureProblem({ allowedHosts: 'box.tailnet.example', gateToken: 's3cret' }) === null,
    'an exposed agent with a gate token is allowed to start');
  const why = exposureProblem({ allowedHosts: 'box.tailnet.example', gateToken: '' });
  check(typeof why === 'string' && /AP_GATE_TOKEN/.test(why) && /box\.tailnet\.example/.test(why),
    'an exposed agent with no gate token is refused, and told which host and which variable');
}

// --- 5c1b. bio, avatar and mentions ---
{
  const u = wire.apUrls('https://pod.example/');
  const bare = wire.actorDoc({ urls: u, handle: 'you', publicKeyPem: 'K' });
  check(bare.summary === undefined && bare.icon === undefined,
    'an actor with no bio or avatar advertises neither');
  const full = wire.actorDoc({
    urls: u, handle: 'you', publicKeyPem: 'K',
    summary: 'a group for <script>birds', icon: 'https://cdn.example/logo.png',
  });
  check(full.summary === '<p>a group for &lt;script&gt;birds</p>'
    && full.icon?.type === 'Image' && full.icon.url === 'https://cdn.example/logo.png',
    `summary is escaped HTML and icon is an Image (${full.summary})`);

  check(JSON.stringify(wire.mentionsIn('hi @mei@a.example and @kofi@b.example and @mei@a.example'))
    === JSON.stringify(['mei@a.example', 'kofi@b.example']),
    'mentions are parsed once each, in order');
  check(wire.mentionsIn('mail me at nobody@example').length === 0,
    'a bare email-looking string is not a mention');
  // Found live: the port was being dropped, so every handle on a host with one
  // resolved to the wrong host and silently became plain text.
  check(JSON.stringify(wire.mentionsIn('@finches@finches.localhost:4000 hi'))
    === JSON.stringify(['finches@finches.localhost:4000']),
    'a handle on a host with a port keeps the port');

  const mentions = [{ handle: 'mei@a.example', actor: 'https://a.example/u/mei' }];
  const note = wire.noteDoc({
    urls: u, slug: 'x', content: 'hey @mei@a.example', published: '2026-07-30T00:00:00Z', mentions,
  });
  check(note.tag?.[0]?.type === 'Mention' && note.tag[0].href === 'https://a.example/u/mei'
    && note.tag[0].name === '@mei@a.example',
    'a Mention tag names the actor and the full handle');
  check(note.cc.includes('https://a.example/u/mei'),
    'the mentioned actor is addressed in cc, or Mastodon will not notify them');
  check(note.content === '<p>hey <a href="https://a.example/u/mei" class="u-url mention">@mei</a></p>',
    `the handle is linkified in the content (${note.content})`);
  const unresolved = wire.noteDoc({ urls: u, slug: 'y', content: 'hey @nobody@x.example', published: 'p' });
  check(unresolved.content === '<p>hey @nobody@x.example</p>' && !unresolved.tag,
    'a mention nobody could resolve stays plain text');

  check(bare.endpoints?.sharedInbox === u.inbox,
    'the actor advertises a sharedInbox, as every Mastodon actor does');
  check(note.replies === wire.repliesId(note.id) && note.replies === note.id + '-replies',
    `a note points at its own replies collection (${note.replies})`);
  const coll = wire.collection('https://x/c', ['a', 'b']);
  check(coll.type === 'Collection' && coll.totalItems === 2 && coll.items.length === 2,
    'the replies collection is an AS2 Collection with its items');
}

// --- 5c1c. replies are collected so a server can discover what it was not sent ---
{
  const { Intake: IntakeCls } = await import(path.join(root, 'lib/intake.mjs'));
  const rUrls = wire.apUrls('https://pod.example/');
  const OURS = rUrls.notes + 'n1';
  const put = {};
  const rStore = new PodStore({ log: () => {} });
  rStore.addStatus({ noteId: OURS, kind: 'post', actor: rUrls.actor });
  const ri = new IntakeCls({
    config: {}, urls: rUrls, store: rStore, log: () => {},
    remote: { getJson: async (u) => put[u] || null, putJson: async (u, b) => { put[u] = b; } },
    local: {}, deliverer: {}, publisher: { urls: rUrls },
  });
  await ri.addReply(OURS, 'https://a.example/u/mei/n/9');
  await ri.addReply(OURS, 'https://b.example/u/kofi/n/3');
  await ri.addReply(OURS, 'https://a.example/u/mei/n/9');     // re-delivered
  const coll = put[OURS + '-replies'];
  check(coll?.type === 'Collection' && coll.items.length === 2
    && coll.items[0] === 'https://a.example/u/mei/n/9',
    `replies accumulate without duplicates (${coll?.items?.length})`);
  check(coll.totalItems === 2 && coll.id === OURS + '-replies',
    'the collection carries its own id and count');

  // `inReplyTo` is read off a document at the SENDER's origin, and the only
  // check used to be that it started with our notes prefix — so a stranger
  // named a note we never wrote and we created a document on the pod at a URL
  // of their choosing, then grew it one whole re-PUT at a time.
  const invented = rUrls.notes + 'never-written-this';
  await ri.addReply(invented, 'https://evil.example/n/1');
  check(!put[invented + '-replies'],
    'a reply to a note we never wrote creates nothing, however our the URL looks');

  // And the collection is rewritten whole each time, so it needs a ceiling of
  // its own — the number of replies is a stranger's to choose.
  for (let i = 0; i < 600; i++) await ri.addReply(OURS, `https://flood.example/n/${i}`);
  const capped = put[OURS + '-replies'];
  check(capped.items.length === 500 && capped.items.at(-1) === 'https://flood.example/n/599',
    `the replies collection is capped, newest kept (${capped.items.length})`);
}

// --- 5c2. the public surface is verified, not assumed ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const config = { remotePod: 'https://pod.example/', handle: 'you', name: 'You' };
  const mkPub = (probeStatus) => new Publisher({
    config, remote: { setAcl: async () => {} }, local: {}, store: { getStatuses: () => [] },
    deliverer: {}, publicKeyPem: 'x', log: () => {},
    probeFetch: async () => ({ status: probeStatus }),
  });

  // The probe must not ask for turtle: a JSON document answers 501 to that,
  // which would report a perfectly public actor as invisible.
  let sentAccept = null;
  const sniffer = new Publisher({
    config, remote: { setAcl: async () => {} }, local: {}, store: { getStatuses: () => [] },
    deliverer: {}, publicKeyPem: 'x', log: () => {},
    probeFetch: async (_u, init) => { sentAccept = init?.headers?.accept; return { status: 200 }; },
  });
  await sniffer.publiclyReadable('https://pod.example/whatever');
  check(sentAccept === '*/*', 'the public probe asks for */*, not turtle');

  const blind = await mkPub(401).verifyPublicSurface();
  check(blind.length === 7 && blind.includes('actor') && blind.includes('webfinger'),
    'verifyPublicSurface names every document the fediverse cannot read');

  const open = await mkPub(200).verifyPublicSurface();
  check(open.length === 0, 'verifyPublicSurface is silent when the actor is reachable');
}

// --- 5c3. a missing actor is republished at start ---
{
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const mk = (actorDoc) => {
    const agent = new Agent({ home: '/tmp', log: () => {} });
    let published = 0;
    agent.urls = { actor: 'https://pod.example/activitypods-js/ap/actor' };
    agent.remote = { getJson: async () => actorDoc };
    agent.publisher = { publishProfile: async () => { published++; return { unreachable: [] }; } };
    return { agent, published: () => published };
  };

  const gone = mk(null);
  const republished = await gone.agent.ensureActorPublished();
  check(republished === true && gone.published() === 1, 'a missing actor is republished at start');

  const there = mk({ id: 'https://pod.example/activitypods-js/ap/actor', type: 'Person' });
  const again = await there.agent.ensureActorPublished();
  check(again === false && there.published() === 0, 'an actor that exists is left alone');
}

// --- 5d. a pod that says 429/503 is left alone until Retry-After passes ---
{
  const { RemotePod } = await import(path.join(root, 'lib/remote.mjs'));
  const mkRes = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    text: async () => body,
  });
  const pod = new RemotePod({ clientId: 'x', secret: 'y', webId: 'https://p.example/profile/card#me',
    tokenEndpoint: 'https://p.example/.oidc/token', issuerOrigin: 'https://p.example' });

  let calls = 0;
  pod.session = { fetch: async () => { calls++; return mkRes(429, { 'retry-after': '120' }); } };
  await pod.fetch('https://p.example/a');                   // learns the cooldown
  const paused = pod.pausedUntil - Date.now();
  let threw = null;
  try { await pod.fetch('https://p.example/b'); } catch (e) { threw = e.message; }
  check(calls === 1 && paused > 100_000 && paused <= 120_000 && /back off/.test(threw || ''),
    'Retry-After pauses every request to that pod, opening no further sockets');

  pod.pausedUntil = 0;                                       // window elapsed
  pod.session = { fetch: async () => mkRes(503, {}) };
  await pod.fetch('https://p.example/c');
  check(pod.pausedUntil - Date.now() > 50_000, '503 without Retry-After falls back to a 60s pause');

  // Container listings revalidate: unchanged inbox costs a 304, not a body.
  pod.pausedUntil = 0;
  const ttl = '<https://p.example/in/> a <http://www.w3.org/ns/ldp#Container> ;'
    + ' <http://www.w3.org/ns/ldp#contains> <https://p.example/in/one>. '
    + '<https://p.example/in/one> a <http://www.w3.org/ns/ldp#Resource>.';
  const seen = [];
  pod.session = { fetch: async (u, init) => {
    seen.push(init?.headers?.['if-none-match'] || null);
    return seen.length === 1 ? mkRes(200, { etag: '"v1"' }, ttl) : mkRes(304, { etag: '"v1"' });
  } };
  const first = await pod.listContainer('https://p.example/in/');
  const second = await pod.listContainer('https://p.example/in/');
  check(first.length === 1 && second.length === 1 && seen[0] === null && seen[1] === '"v1"',
    'listContainer sends If-None-Match and serves the 304 from cache');
}

// --- 5e. state reads revalidate instead of re-downloading ---
{
  const store = new PodStore({ log: () => {} });
  const mkRes = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    text: async () => body,
  });
  const listing = '<https://p.example/st/> a <http://www.w3.org/ns/ldp#Container> ;'
    + ' <http://www.w3.org/ns/ldp#contains> <https://p.example/st/config.json>.';
  let containerEtag = '"c1"', docEtag = '"d1"', reqs = [];
  attachHttp(store, 'https://p.example/st/', async (url, init) => {
    const inm = init?.headers?.['if-none-match'] || null;
    reqs.push([url.endsWith('/') ? 'container' : 'doc', inm]);
    if (url.endsWith('/')) {
      return inm === containerEtag ? mkRes(304) : mkRes(200, { etag: containerEtag }, listing);
    }
    return inm === docEtag ? mkRes(304) : mkRes(200, { etag: docEtag }, JSON.stringify({ handle: 'jeff' }));
  });

  await store.load();
  const afterFirst = reqs.length;                    // container + doc
  reqs = [];
  await store.load();                                // nothing changed at all
  const quiet = reqs.length;
  reqs = [];
  containerEtag = '"c2"';                            // container moved, doc did not
  await store.load();
  const docRevalidated = reqs.filter(([kind]) => kind === 'doc').length;

  check(afterFirst === 2 && quiet === 1 && reqs.length === 2 && docRevalidated === 1
    && store.getConfig()?.handle === 'jeff',
    'store.load revalidates: quiet minute = 1 request, and a 304 doc keeps its cache');
}

// --- 5e2. retiring an actor tells the fediverse and leaves a Tombstone ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const config = { remotePod: 'https://pod.example/', handle: 'you', name: 'You' };
  const delivered = [];
  const written = new Map();
  const acls = [];
  let flushed = false, savedConfig = { ...config };
  const pub = new Publisher({
    config,
    remote: {
      putJson: async (url, obj) => { written.set(url, obj); },
      setAcl: async (url, modes) => { acls.push([url, modes]); },
    },
    local: {},
    store: {
      getStatuses: () => [],
      getContacts: () => ({
        followers: [
          { actor: 'https://m.example/users/a', inbox: 'https://m.example/users/a/inbox', sharedInbox: 'https://m.example/inbox' },
          { actor: 'https://m.example/users/b', inbox: 'https://m.example/users/b/inbox', sharedInbox: 'https://m.example/inbox' },
          { actor: 'https://other.example/users/c', inbox: 'https://other.example/users/c/inbox' },
        ],
        following: [],
      }),
      getConfig: () => savedConfig,
      setConfig: (c) => { savedConfig = c; },
      flush: async () => { flushed = true; },
    },
    deliverer: { deliverToAll: async (inboxes, activity) => { delivered.push({ inboxes, activity }); } },
    publicKeyPem: 'x', log: () => {},
  });

  const r = await pub.retireActor();
  const sent = delivered[0];
  const tomb = written.get(pub.urls.actor);
  check(sent.inboxes.length === 2 && sent.inboxes.includes('https://m.example/inbox')
    && sent.activity.type === 'Delete' && sent.activity.object === pub.urls.actor
    && sent.activity.to.includes('https://www.w3.org/ns/activitystreams#Public'),
    'retire delivers one Delete per distinct inbox, sharedInbox deduped');
  check(tomb?.type === 'Tombstone' && tomb.formerType === 'Person' && tomb.id === pub.urls.actor
    && !!tomb.deleted, 'the actor is replaced with a Tombstone that keeps its id');
  check(acls.some(([u, m]) => u === pub.urls.actor && m.includes('Read')),
    'the Tombstone stays publicly readable');
  check(savedConfig.retiredAt === r.deletedAt && flushed && r.inboxes === 2,
    'retirement is recorded in pod state so the agent will not restart the identity');
}

// --- 5h. we identify ourselves, and never exceed a local request ceiling ---
{
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(root, 'vendor/idp-grant.cjs'));
  const { createGrantSession } = req(path.join(root, 'vendor/idp-grant.cjs'));
  const { USER_AGENT } = await import(path.join(root, 'lib/ua.mjs'));
  const rec = { clientId: 'c', secret: 's', webId: 'https://p.example/profile/card#me',
    tokenEndpoint: 'https://p.example/.oidc/token', issuerOrigin: 'https://p.example' };
  const realFetch = globalThis.fetch;
  const ok = (body = { access_token: 't', expires_in: 300 }) => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body),
  });

  check(/^fedipod\/\d+\.\d+\.\d+ \(\+https?:\/\/\S+\)$/.test(USER_AGENT),
    `the User-Agent names the software and where to complain (${USER_AGENT})`);

  // Both the token endpoint and resource requests must carry it.
  const seen = [];
  globalThis.fetch = async (u, init) => { seen.push(init?.headers?.['user-agent']); return ok(); };
  const s1 = createGrantSession(rec);
  await s1.warmup();
  await s1.fetch('https://p.example/some/doc');
  check(seen.length === 2 && seen.every(ua => ua === USER_AGENT),
    'token requests and pod requests both send it');

  // The ceiling holds regardless of what any caller does — by DEFERRING, not by
  // failing. It is our own politeness, not the server's refusal, and a first-run
  // setup legitimately needs more writes than one minute allows. Both caps are
  // set before the session is built, because it reads them once.
  process.env.AP_MAX_REQUESTS_PER_MIN = '3';
  process.env.AP_SLOT_WAIT_MAX_MS = '400';        // so the deferred ones give up fast here
  let hits = 0;
  globalThis.fetch = async () => { hits++; return ok(); };
  const s2 = createGrantSession(rec);
  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => s2.fetch(`https://p.example/doc${i}`)));
  delete process.env.AP_SLOT_WAIT_MAX_MS;
  delete process.env.AP_MAX_REQUESTS_PER_MIN;
  const gaveUp = settled.filter(r => r.status === 'rejected').map(r => r.reason.message);
  check(hits <= 4,                                // 3 resource slots + the token grant
    `a ceiling of 3/min opens at most 3 sockets, not 10 (opened ${hits})`);
  check(gaveUp.length === 10 - (hits - 1) && gaveUp.every(m => /no slot after/.test(m)),
    `over the ceiling it waits and then says so, rather than failing instantly (${gaveUp[0]})`);

  globalThis.fetch = realFetch;
}

// --- 5i. a refused write is not retried; a 503 is, politely ---
{
  const mkStore = () => new PodStore({ log: () => {} });
  const res = (status, headers = {}) => ({ status, headers: { get: (h) => headers[h.toLowerCase()] ?? null } });

  // 403 means "no": one attempt, then stop.
  const s403 = mkStore();
  let puts403 = 0;
  attachHttp(s403, 'https://p.example/st/', async (_u, init) => {
    if (init?.method !== 'PUT') return { status: 404, headers: { get: () => null }, text: async () => '' };
    puts403++; return res(403);
  });
  s403.write('config.json', { a: 1 });
  await s403.flush();
  check(puts403 === 1, `a 403 is final — one write attempt, not five (saw ${puts403})`);

  // 503 with Retry-After is retried, and the header is what sets the delay.
  const s503 = mkStore();
  const gaps = [];
  let last = Date.now(), puts503 = 0;
  attachHttp(s503, 'https://p.example/st/', async (_u, init) => {
    if (init?.method !== 'PUT') return { status: 404, headers: { get: () => null }, text: async () => '' };
    puts503++; gaps.push(Date.now() - last); last = Date.now();
    return res(503, { 'retry-after': '1' });
  });
  s503.write('config.json', { a: 2 });
  await s503.flush();
  check(puts503 === 5 && gaps.slice(1).every(g => g >= 900 && g < 1600),
    `a 503 retries to the cap, spaced by Retry-After (${puts503} attempts)`);
}

// --- 5j. periodic work is stretched and jittered, not a shared beat ---
{
  const { Lease } = await import(path.join(root, 'lib/lease.mjs'));
  const src = fs.readFileSync(path.join(root, 'lib/lease.mjs'), 'utf8');
  const ttl = Number((src.match(/const TTL_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''));
  const renew = Number((src.match(/const RENEW_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''));
  check(renew === 90_000 && ttl === 300_000 && ttl / renew >= 3,
    `lease renews every ${renew / 1000}s against a ${ttl / 1000}s TTL (3+ misses of headroom)`);

  // Renewal must be self-scheduling so agents drift apart rather than beating together.
  const lease = new Lease({ url: 'https://p.example/st/lease.json', fetchImpl: async () => ({ status: 404 }), log: () => {} });
  lease.startRenewal();
  const isTimeout = typeof lease.timer === 'object' && lease.timer !== null;
  clearTimeout(lease.timer);
  check(isTimeout && /setTimeout\(/.test(src) && !/setInterval\(/.test(src),
    'lease renewal is a jittered self-scheduling timer, not setInterval');

  for (const f of ['lib/intake.mjs', 'lib/tagfeed.mjs']) {
    const body = fs.readFileSync(path.join(root, f), 'utf8');
    check(/0\.85 \+ Math\.random\(\) \* 0\.3/.test(body) && !/setInterval\(/.test(body),
      `${f} schedules its own next run with jitter`);
  }
}

// --- 5k. a failing inbox is left alone, and the agent says what it is doing ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const logs = [];
  const intake = new Intake({
    config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
    remote: { listContainer: async () => { throw new Error('fetch failed'); } },
    local: {}, store: { read: (_n, d) => d, write: () => {} },
    deliverer: {}, publisher: {}, log: (m) => logs.push(m),
  });

  await intake.drain();
  const firstCooldown = intake.drainCooldownUntil - Date.now();
  await intake.drain();                          // must not touch the pod again
  check(firstCooldown > 100_000 && firstCooldown <= 2.5 * 60_000
    && logs.some(m => /next sweep in/.test(m)) && logs.some(m => /skipped/.test(m)),
    'an unreadable inbox sets a cooldown and the next sweep is skipped');

  intake.drainCooldownUntil = 0;
  intake.drainFailures = 3;
  await intake.drain();
  const grown = intake.drainCooldownUntil - Date.now();
  check(grown > firstCooldown * 2, `the cooldown doubles with repeated failure (${Math.round(grown / 1000)}s)`);
}

// --- 5k-bis. a pod that will not give us an item has not told us to bin it ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const mk = (itemStatus) => {
    const deleted = [];
    const state = {};
    const store = {
      read: (n, d) => (n in state ? JSON.parse(JSON.stringify(state[n])) : d),
      write: (n, v) => { state[n] = v; },
      commit: async () => true,
      addDeadLetter: (e) => { (state.dead ||= []).push(e); },
      getDeadLetters: () => state.dead || [],
    };
    const intake = new Intake({
      config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
      remote: {
        listContainer: async () => [{ url: 'https://p.example/in/1', size: 10, modified: '2026-01-01' }],
        fetch: async () => ({ status: itemStatus, text: async () => '', json: async () => null }),
        delete: async (u) => { deleted.push(u); return true; },
      },
      local: {}, store, deliverer: {}, publisher: {}, log: () => {},
    });
    return { intake, deleted, state, store };
  };

  // A 500 on the item read used to be filed as 'unparsable JSON' — a REJECTION,
  // dead-lettered with a null body and then DELETEd. The delivery was destroyed
  // by a transient pod fault and nothing recorded what it had been.
  const bad = mk(500);
  await bad.intake.drain();
  check(bad.deleted.length === 0, 'a 500 on an inbox item does not delete it');
  check((bad.store.getDeadLetters() || []).length === 0,
    'and does not dead-letter it as unparsable — the pod said nothing about its contents');
  check(bad.state['intake-attempts.json']?.['https://p.example/in/1']?.n === 1,
    'it counts as one failed attempt, so five of them still dead-letter it eventually');

  // 404 is different: the item really is gone, so removing it is right.
  const gone = mk(404);
  await gone.intake.drain();
  check(gone.deleted.length === 1, 'a 404 still deletes — the item is already gone');
}

// --- 5r. a restart reuses its token instead of asking for another ---
{
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(root, 'vendor/idp-grant.cjs'));
  const { createGrantSession } = req(path.join(root, 'vendor/idp-grant.cjs'));
  const home = fs.mkdtempSync('/tmp/dk-ap-token-');
  const tokenFile = path.join(home, 'token.json');
  const rec = { clientId: 'c', secret: 's', webId: 'https://p.example/profile/card#me',
    tokenEndpoint: 'https://p.example/.oidc/token', issuerOrigin: 'https://p.example' };
  const realFetch = globalThis.fetch;
  let grants = 0;
  globalThis.fetch = async (u) => {
    if (String(u).includes('/.oidc/token')) {
      grants++;
      return { ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ access_token: 'tok-1', expires_in: 3600 }), text: async () => '' };
    }
    return { status: 200, headers: { get: () => null }, text: async () => 'ok' };
  };

  const first = createGrantSession(rec, { tokenFile });
  await first.fetch('https://p.example/doc');
  const savedRaw = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const mode = (fs.statSync(tokenFile).mode & 0o777).toString(8);

  // A brand-new session, as a restart would build: no second grant.
  const afterRestart = createGrantSession(rec, { tokenFile });
  await afterRestart.fetch('https://p.example/doc');
  globalThis.fetch = realFetch;

  check(grants === 1 && !!savedRaw.privateJwk && savedRaw.accessToken === 'tok-1' && mode === '600',
    `the token and its DPoP key are stored 0600 and reused (grants: ${grants})`);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 5o. an idle agent asks for as little as the design allows ---
{
  const { Lease } = await import(path.join(root, 'lib/lease.mjs'));
  const res = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => body,
  });

  // Steady renewal is ONE conditional PUT — no preceding GET.
  const calls = [];
  const lease = new Lease({
    url: 'https://p.example/st/lease.json',
    fetchImpl: async (_u, init) => {
      calls.push(init?.method || 'GET');
      return init?.method === 'PUT' ? res(205, { etag: '"v2"' }) : res(404);
    },
    log: () => {},
  });
  lease.etag = '"v1"';
  await lease.renewOnce();
  await lease.renewOnce();
  check(calls.length === 2 && calls.every(m => m === 'PUT'),
    `two renewals cost two PUTs and no reads (saw ${calls.join(',')})`);

  // A 412 is the takeover signal, and only then do we pay for a read.
  const seen = [];
  let lost = false;
  const contested = new Lease({
    url: 'https://p.example/st/lease.json',
    fetchImpl: async (_u, init) => {
      seen.push(init?.method || 'GET');
      if (init?.method === 'PUT') return res(412);
      return res(200, { etag: '"other"' },
        JSON.stringify({ holder: 'someone-else', expiresAt: Date.now() + 60_000 }));
    },
    log: () => {},
  });
  contested.etag = '"v1"';
  contested.onLost = () => { lost = true; };
  const kept = await contested.renewOnce();
  check(kept === false && lost && seen[0] === 'PUT' && seen[1] === 'GET',
    'a 412 costs one extra read and reports the lease lost');

  // Losing it must STOP the chain. It used to re-arm in `finally` regardless of
  // what renewOnce returned, so a demoted agent kept paying ~80 requests/hour
  // for the life of the process.
  check(contested.stopped === true && contested.timer === null,
    'a lost lease stops renewing rather than re-arming');

  // And the loser must not keep the winner's ETag: with it, the next conditional
  // PUT succeeds and the stood-down agent silently takes the lease back.
  check(contested.etag === null,
    "losing the lease forgets the new holder's ETag, so it cannot be re-claimed");

  // startRenewal is reached twice on the parked path; two chains would double a
  // parked agent's writes, which is the one thing a parked agent must not do.
  const idem = new Lease({
    url: 'https://p.example/st/lease.json', fetchImpl: async () => res(404), log: () => {},
  });
  idem.startRenewal();
  const first = idem.timer;
  idem.startRenewal();
  check(idem.timer === first, 'startRenewal is idempotent — a second call adds no second chain');
  idem.stopRenewal();
  check(idem.timer === null && idem.stopped, 'stopRenewal clears the timer and latches');
  idem.startRenewal();
  check(idem.timer !== null && idem.stopped === false,
    'and it is restartable afterwards, for a viewer promoted back to active');
  idem.stopRenewal();
}

// --- 5a-bis. section E: the eight that were verified and fixed ---
{
  const { Deliverer } = await import(path.join(root, 'lib/deliver.mjs'));
  const { Lease } = await import(path.join(root, 'lib/lease.mjs'));
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));

  // --- the static jail: %2f decoded BEFORE the split made '..' a mount name ---
  const admin = fs.readFileSync(path.join(root, 'lib/admin.mjs'), 'utf8');
  const ss = admin.slice(admin.indexOf('function serveStatic'), admin.indexOf('function webDirRedirect'));
  check(/path\.resolve\(UI_DIR, uiName\)/.test(ss) && /startsWith\(UI_DIR \+ path\.sep\)/.test(ss),
    'the static mount is resolved and contained, not just joined');
  // /shutdown was the one state-changing route above BOTH gates.
  check(/LOCAL_ONLY_POSTS = new Set\(\[[^\]]*'\/shutdown'/.test(admin),
    '/shutdown is local-only like the other lifecycle routes');
  check(admin.indexOf("case '/shutdown'") > admin.indexOf('LOCAL_ONLY_POSTS.has(p)'),
    'and is dispatched below the gate rather than above it');

  // --- the delivery queue: one dead host must not be POSTed once per item ---
  const items = (n, host) => Array.from({ length: n }, (_, i) => ({
    inbox: `https://${host}/users/u${i}/inbox`, activity: { type: 'Create' }, attempts: 1, nextAt: 0,
  }));
  const store = {
    q: [...items(5, 'down.example'), ...items(1, 'up.example')],
    getQueue() { return JSON.parse(JSON.stringify(this.q)); },
    setQueue(v) { this.q = v; },
  };
  const posted = [];
  const d = new Deliverer({ store, keyId: 'k', rsaPrivate: null, log: () => {}, passive: true });
  d.deliverNow = async (inbox) => {
    posted.push(inbox);
    if (inbox.includes('down.example')) {
      const e = new Error('POST → 503'); e.status = 503; e.retryAfterMs = 900_000; throw e;
    }
  };
  await d.drainQueue();
  const toDown = posted.filter(u => u.includes('down.example')).length;
  check(toDown === 1, `a dead host is tried once per drain, not once per item (saw ${toDown} of 5)`);
  check(posted.some(u => u.includes('up.example')),
    'and a healthy peer behind it is still delivered to, rather than blocked');
  const deferred = store.q.filter(i => i.inbox.includes('down.example'));
  check(deferred.length === 5 && deferred.every(i => i.nextAt >= Date.now() + 800_000),
    'the whole host is deferred by the Retry-After it asked for');
  d.stop();

  const dsrc = fs.readFileSync(path.join(root, 'lib/deliver.mjs'), 'utf8');
  check(/const ra = retryAfterMs\(res/.test(dsrc) && /if \(ra != null\) err\.retryAfterMs = ra/.test(dsrc),
    'deliverNow carries a Retry-After only when the server actually sent one');
  check(/retryAfterMs\(res, 24 \* 60 \* 60_000\)/.test(dsrc),
    "and honours a long one rather than clipping it to the pod path's 30-minute ceiling");
  check(/0\.85 \+ Math\.random\(\) \* 0\.3/.test(dsrc),
    'and the ladder is jittered, so failures do not come back in lockstep');

  // --- the lease: unreadable is not absent, and an expiry we could not renew is a loss ---
  const res = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => body,
  });
  let writes = 0;
  const unreadable = new Lease({
    url: 'https://p.example/st/lease.json', log: () => {},
    fetchImpl: async (_u, init) => { if (init?.method === 'PUT') { writes++; return res(205); } return res(500); },
  });
  check(await unreadable.acquire() === false,
    'a lease that cannot be READ is not treated as a lease nobody holds');
  check(writes === 0, 'and no speculative PUT is spent claiming it');

  // A real 404 IS an answer: nobody holds it, so claim it. The stub reflects
  // the write, or the confirming GET would 404 the acquire it just made.
  let stored = null;
  const absent = new Lease({
    url: 'https://p.example/st/lease.json', log: () => {},
    fetchImpl: async (_u, init) => {
      if (init?.method === 'PUT') { stored = init.body; return res(205, { etag: '"v1"' }); }
      return stored ? res(200, { etag: '"v1"' }, stored) : res(404);
    },
  });
  check(await absent.acquire() === true, 'a genuine 404 means nobody holds it, so it is claimed');
  check(absent.heldUntil > Date.now() && absent.heldUntil <= Date.now() + 300_000,
    'and heldUntil comes from the document actually written');

  // A 200 carrying garbage is not a lease anybody holds — overwriting it is
  // the repair, so it must not brick the agent into viewer mode forever.
  let wrote = null;
  const corrupt = new Lease({
    url: 'https://p.example/st/lease.json', log: () => {},
    fetchImpl: async (_u, init) => {
      if (init?.method === 'PUT') { wrote = init.body; return res(205, { etag: '"v2"' }); }
      return wrote ? res(200, { etag: '"v2"' }, wrote) : res(200, {}, 'not json at all');
    },
  });
  check(await corrupt.acquire() === true, 'an unparsable lease document is repaired, not fatal');

  const stale = new Lease({
    url: 'https://p.example/st/lease.json', log: () => {},
    fetchImpl: async () => { throw new Error('pod unreachable'); },
  });
  let lost = false;
  stale.onLost = () => { lost = true; };
  stale.heldUntil = Date.now() - 1;            // the TTL we last wrote has passed
  check(await stale.renewOnce() === false && lost && stale.stopped,
    'a lease whose TTL passed unrenewed stands the agent down rather than draining on');

  // --- intake: bare-string Undo, redelivery, oversized item ---
  const isrc = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  const undo = isrc.slice(isrc.indexOf('async onUndo('), isrc.indexOf('concernsUs('));
  check(/typeof activity\.object === 'string' \? activity\.object/.test(undo),
    'an Undo naming its Follow as a bare IRI is understood');
  check(/typeof activity\.object === 'object'/.test(undo),
    'and only a TYPED non-Follow is dismissed as not ours');
  const create = isrc.slice(isrc.indexOf('async onCreate('), isrc.indexOf('async amplify('));
  check(/x\.kind === 'timeline' \|\| x\.kind === 'mention'/.test(create),
    'onCreate skips the dereference only for a note it has actually ingested');
  check(!/some\(x => x\.noteId === objectId\)\s*\)/.test(create),
    "and not for a tag-feed placeholder, which has no note, notification or reply entry");
  check(create.indexOf('amplify(') > create.indexOf('ingestNote('),
    'while a group still reaches amplify, which is idempotent on its own');
  check(/MAX_ITEM_BYTES/.test(isrc) && /size > MAX_ITEM_BYTES/.test(isrc),
    'an oversized inbox item is dead-lettered on the size the listing already gave us');
}

// --- 5a-nonies. both setup paths produce the same install ---
{
  const bin = fs.readFileSync(path.join(root, 'bin/fedipod.mjs'), 'utf8');
  const setupJs = fs.readFileSync(path.join(root, 'lib/setup.mjs'), 'utf8');

  // They diverged: the browser path defaulted privateRoot to a local file: URL
  // and the CLI path left it unset, so the same answers produced two different
  // installs — one keeping the timeline, contacts, blocklist and notifications
  // on this machine, the other putting all of it on the pod. The second is the
  // layout the relay design exists to avoid, and it makes RECEIVING a post cost
  // pod writes rather than nothing.
  const local = /pathToFileURL\(path\.join\(\w+, 'private'\)\)\.href \+ '\/'/;
  check(local.test(setupJs), 'the browser setup keeps the private half on this machine');
  check(local.test(bin), 'and so does the CLI setup');
  check(/privateRoot: flag\('private-root'\)/.test(bin),
    'with the same escape hatch for putting it somewhere else on purpose');
}

// --- 5a-octies. the outbox is paged, so posting costs the same at 5000 posts ---
{
  const wireM = await import(path.join(root, 'lib/wire.mjs'));
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));

  // Pages are anchored at the OLDEST end. Number them from the newest and every
  // boundary shifts each time you post, which is the original problem again.
  const items = Array.from({ length: 45 }, (_, i) => `n${45 - i}`);      // newest-first
  const b4 = wireM.outboxPages(items).map(x => JSON.stringify(x));
  const aft = wireM.outboxPages(['n46', ...items]).map(x => JSON.stringify(x));
  check(aft.filter((x, i) => x !== b4[i]).length === 1,
    'one new activity changes exactly one page, however long the history');
  check(wireM.outboxPages([]).length === 1,
    'an empty outbox still has a page, so `first` always points somewhere');

  const head = wireM.outboxHead('https://p/ap/outbox', 45);
  check(head.first === 'https://p/ap/outbox-3' && head.last === 'https://p/ap/outbox-1',
    '`first` is the NEWEST page, which is the direction a client reads');
  check(wireM.outboxPage('https://p/ap/outbox', 3, []).next === 'https://p/ap/outbox-2'
    && !wireM.outboxPage('https://p/ap/outbox', 1, []).next,
    '`next` walks backwards in time and stops at the oldest page');
  check(!wireM.outboxPage('https://p/ap/outbox', 2, []).prev,
    'and a sealed page carries no prev, so it never needs rewriting');

  // --- followers, paged the same way ---
  const FB = 'https://p/ap/followers';
  const mkActors = (n) => Array.from({ length: n }, (_, i) => `https://a.example/u/${i}`);
  const fHead = wireM.followersHead(FB, 45, 3);
  check(fHead.type === 'OrderedCollection' && fHead.totalItems === 45
    && fHead.first === `${FB}-1` && fHead.last === `${FB}-3`,
    'a followers head carries the count and points at its first and last page');
  check(wireM.followersPage(FB, 1, [], 3).next === `${FB}-2`
    && !wireM.followersPage(FB, 3, [], 3).next,
    '`next` walks forward and the last page has none');

  const fp = wireM.followersPaging(mkActors(45));
  check(fp.pages.length === 3 && fp.pages[0].length === 20 && fp.pages[2].length === 5
    && fp.pages.flat().length === 45,
    '45 followers page into 20 + 20 + 5, every one placed');
  // A follow extends the newest page; existing full pages are untouched.
  const grown = wireM.followersPaging(mkActors(46), fp.index);
  check(JSON.stringify(grown.pages[0]) === JSON.stringify(fp.pages[0])
    && grown.pages[2].length === 6,
    'a new follower extends the newest page and leaves the sealed ones alone');
  // An unfollow leaves its page one short rather than re-slicing everything.
  const without = mkActors(45).filter(a => a !== 'https://a.example/u/5');
  const shrunk = wireM.followersPaging(without, fp.index);
  check(shrunk.pages[0].length === 19 && shrunk.pages[1].length === 20
    && !shrunk.pages.flat().includes('https://a.example/u/5'),
    'an unfollow leaves its page one short, not a re-slice of the rest');

  // The cost that used to grow with everything you had ever said.
  const seen = [];
  const state = {};
  const pub = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: {
      put: async () => {}, putJson: async (u) => seen.push(`PUT ${u.split('/ap/')[1]}`),
      setAcl: async (u) => seen.push(`ACL ${u.split('/ap/')[1]}`),
      fetch: async () => ({ ok: false }),
      getJson: async () => null,
    },
    local: { writeContacts: async () => {} },
    store: {
      read: (n, d) => (n in state ? JSON.parse(JSON.stringify(state[n])) : d),
      write: (n, v) => { state[n] = v; },
      getStatuses: () => [], getContacts: () => ({ followers: [], following: [] }), setContacts: () => {},
    },
    deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'x', log: () => {},
  });
  const costs = [];
  for (let i = 1; i <= 45; i++) {
    seen.length = 0;
    await pub.recordOutbox(`https://pod.example/ap/notes/n${i}`);
    costs.push(seen.length);
  }
  check(costs[1] === 2 && costs[43] === 2,
    `posting costs the same at 45 posts as at 2 (${costs[1]} then ${costs[43]} requests)`);
  check(costs[20] === 3, 'except the post that opens a new page, which also writes its ACL');
  check(state['outbox.json'].length === 45, 'and nothing is dropped — every activity is still there');

  // rebuild reads this to recover posts a lost machine no longer has, so the
  // walk has to work — including against the flat collection this used to write.
  const OB = pub.urls.outbox;
  const docs = { [OB]: wireM.outboxHead(OB, 45) };
  wireM.outboxPages(state['outbox.json']).forEach((pg, i) => {
    docs[wireM.outboxPageId(OB, i + 1)] = wireM.outboxPage(OB, i + 1, pg);
  });
  pub.remote.getJson = async (u) => docs[u] || null;
  const walked = await pub.readPublishedOutbox();
  check(walked?.length === 45, `walking the pages recovers every activity (${walked?.length})`);

  docs[OB] = wireM.orderedCollection(OB, ['a', 'b']);
  check((await pub.readPublishedOutbox())?.length === 2,
    'and the flat collection an older actor still publishes is read as it always was');

  // --- and REMOVING one costs the same as adding one ---
  //
  // Anchoring at the oldest end is right for appends and wrong for removals:
  // deriving the pages from position meant every entry after the hole shifted
  // back one, so every page from there to the newest was rewritten. Taking down
  // one old post rewrote the whole history.
  pub.remote.delete = async (u) => { seen.push(`DEL ${u.split('/ap/')[1]}`); };
  const firstIndex = state['published.json'].outboxIndex;
  check(Array.isArray(firstIndex) && firstIndex.length === 3
    && firstIndex[0].length === 20 && firstIndex[2].length === 5,
    `the page assignment is kept, oldest page first (${firstIndex?.map(p => p.length).join('/')})`);

  // The contrast, kept in the suite rather than measured once: derive the pages
  // from position, as outboxPages does, and taking the oldest entry out changes
  // every one of them.
  const full = state['outbox.json'];
  const short = full.filter(i => i !== 'https://pod.example/ap/notes/n1');
  const derivedBefore = wireM.outboxPages(full).map(p => JSON.stringify(p));
  const derivedAfter = wireM.outboxPages(short).map(p => JSON.stringify(p));
  check(derivedAfter.filter((x, i) => x !== derivedBefore[i]).length === 3,
    'deriving pages from position would rewrite all three for one old removal');
  const keptAfter = wireM.outboxPaging(short, state['published.json'].outboxIndex).pages
    .map(p => JSON.stringify(p));
  const keptBefore = wireM.outboxPaging(full, state['published.json'].outboxIndex).pages
    .map(p => JSON.stringify(p));
  check(keptAfter.filter((x, i) => x !== keptBefore[i]).length === 1,
    'keeping the assignment rewrites exactly the one that held it');

  seen.length = 0;
  await pub.unrecordOutbox(i => i === 'https://pod.example/ap/notes/n1');   // the OLDEST
  check(seen.filter(x => x.startsWith('PUT outbox-')).length === 1,
    `removing the oldest entry rewrites one page, not all of them (${seen.join(', ')})`);
  check(state['published.json'].outboxIndex[0].length === 19
    && state['published.json'].outboxIndex[2].length === 5,
    'the page it was on is simply one shorter, and the pages above it do not move');

  // A short page must not confuse the head, or `first` points below the newest
  // page and everything above it stops being reachable.
  seen.length = 0;
  await pub.publishOutbox(state['outbox.json']);
  const headDoc = wireM.outboxHead(OB, 44, 3);
  check(headDoc.first === `${OB}-3`,
    '`first` still names the newest page once a page has gone short');

  // The repair path: the pod has lost the pages, our digests still match, and
  // without force we would rewrite the head to point at documents that 404.
  seen.length = 0;
  await pub.publishOutbox(state['outbox.json'], { force: true });
  check(seen.filter(x => x.startsWith('PUT outbox-')).length === 3,
    `force rewrites every page, which is the whole point of the repair path (${seen.filter(x => x.startsWith('PUT outbox-')).length})`);
  check(seen.filter(x => x.startsWith('ACL outbox-')).length === 3,
    'and their ACLs, because a lost page lost those too');

  // Emptying an OLD page leaves it numbered where it is. Closing the gap up
  // would renumber every page above it, which is the re-slicing this exists to
  // avoid — one empty document is the cheaper end of that trade.
  seen.length = 0;
  const oldest = new Set(state['outbox.json'].slice(-19));                 // all of page 1
  await pub.unrecordOutbox(i => oldest.has(i));
  check(state['published.json'].outboxIndex.length === 3
    && state['published.json'].outboxIndex[0].length === 0
    && state['published.json'].outboxIndex[2].length === 5,
    `an emptied old page keeps its number rather than renumbering the rest (${
      state['published.json'].outboxIndex.map(p => p.length).join('/')})`);

  // Removing the NEWEST entries is the case that really shrinks the collection:
  // the pages above the new count are orphans the head no longer points at, but
  // whose URLs are public and guessable, still serving activities taken back.
  seen.length = 0;
  const newest = new Set(state['outbox.json'].slice(0, 5));                // all of page 3
  await pub.unrecordOutbox(i => newest.has(i));
  check(seen.filter(x => x.startsWith('DEL outbox-')).length === 1,
    `the page the outbox shrank past is deleted, not left serving (${
      seen.filter(x => x.startsWith('DEL')).join(', ') || 'none'})`);
  check(state['published.json'].outboxIndex.length === 2,
    'and the assignment shrinks with it');
}

// --- 5a-septies. paging, revocation, and two helpers that were two ---
{
  const masto = fs.readFileSync(path.join(root, 'lib/mastoapi.mjs'), 'utf8');

  // A client walks a timeline by following the Link header. Nothing emitted
  // one, so an account's posts stopped at the first page whatever it asked for.
  check(/rel="next"/.test(masto) && /rel="prev"/.test(masto),
    'the API emits the Link header clients page with');
  check(/max_id/.test(masto) && /since_id/.test(masto) && /min_id/.test(masto),
    'and honours all three cursors, not just max_id');
  const accStatuses = masto.slice(masto.indexOf('mAccStatuses'), masto.indexOf('mAccStatuses') + 600);
  check(/this\.page\(/.test(accStatuses),
    "an account's own statuses paginate rather than stopping at 20");

  // Logging out of a client left a working 90-day bearer behind.
  const rev = masto.slice(masto.indexOf("'/oauth/revoke'"), masto.indexOf("'/oauth/revoke'") + 700);
  check(/masto-tokens\.json/.test(rev) && /filter\(r => r\.token !== gone\)/.test(rev),
    '/oauth/revoke actually drops the token');

  // idFor scanned the whole map on the status-render path, once per status,
  // for a mapping the hash already determines.
  const store = fs.readFileSync(path.join(root, 'lib/store.mjs'), 'utf8');
  const idFor = store.slice(store.indexOf('idFor(url)'), store.indexOf('urlFor(id)'));
  check(idFor.indexOf('createHash') < idFor.indexOf('Object.entries'),
    'idFor computes the id before it considers scanning for a legacy one');
  const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
  const st = new PodStore({ log: () => {} });
  const a = st.idFor('https://x.example/n/1');
  check(st.idFor('https://x.example/n/1') === a, 'and is stable for the same url');
  st.write('ids.json', { legacyid: 'https://y.example/n/2' });
  check(st.idFor('https://y.example/n/2') === 'legacyid',
    'while an id a client is still holding keeps resolving');

  // portFree/freePortFrom lived twice and had already drifted — one returned
  // null on exhaustion, the other threw, and both spawn agents.
  for (const f of ['lib/admin.mjs', 'bin/fedipod.mjs']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    check(!/^(async )?function (portFree|freePortFrom)/m.test(src),
      `${f} no longer carries its own copy`);
    check(/from '(\.\.\/lib|\.)\/ports\.mjs'/.test(src), `${f} imports the shared one`);
  }
  const { freePortFrom } = await import(path.join(root, 'lib/ports.mjs'));
  check(await freePortFrom(1, 1) === null, 'the shared helper returns null rather than throwing');

  // rebuild is one pod GET per post ever made, in one burst.
  check(/REBUILD_MAX_PER_RUN/.test(fs.readFileSync(path.join(root, 'lib/publisher.mjs'), 'utf8')),
    'rebuild is capped per run and says so when it stops');
  // and an empty state migration used to report success
  check(/NOTHING WAS COPIED/.test(fs.readFileSync(path.join(root, 'bin/fedipod.mjs'), 'utf8')),
    '`state --to` says when it moved nothing rather than reporting a move');
}

// --- 5a-sexies. a profile save that changes nothing costs nothing ---
{
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const seen = [];
  const state = {};
  const pub = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: {
      put: async (u) => { seen.push(`PUT ${u}`); },
      putJson: async (u) => { seen.push(`PUT ${u}`); },
      setAcl: async (u) => { seen.push(`ACL ${u}`); },
      fetch: async () => ({ ok: false }), getJson: async () => null,
    },
    local: { writeSettings: async () => {}, writeContacts: async () => {} },
    store: {
      read: (n, d) => (n in state ? JSON.parse(JSON.stringify(state[n])) : d),
      write: (n, v) => { state[n] = v; },
      getStatuses: () => [], getContacts: () => ({ followers: [], following: [] }),
      setContacts: () => {},
    },
    deliverer: { deliverToAll: async () => {} },
    publicKeyPem: 'x', log: () => {},
    probeFetch: async () => ({ status: 200 }),
  });

  await pub.publishProfile();
  check(seen.length > 20, `the first publish writes the whole surface (${seen.length} requests)`);

  // Phanpy's editor submits the whole form every time, so "saved without
  // changing anything" is the ordinary case rather than a rare one.
  const before = seen.length;
  const again = await pub.publishProfile();
  check(seen.length === before && again.skipped === true,
    `saving again with nothing changed costs 0 requests (was ${before})`);

  pub.config.summary = 'birds, mostly';
  await pub.publishProfile();
  check(seen.length > before, 'while an actual edit publishes as before');

  // The digest cannot know the pod has LOST the actor — which is exactly when
  // the repair path runs, and skipping there would leave the agent reporting
  // success while nobody can resolve the account.
  const n = seen.length;
  await pub.publishProfile({ force: true });
  check(seen.length > n, 'and force publishes regardless of the digest');

  check(/publishProfile\(\{ force: true \}\)/.test(fs.readFileSync(path.join(root, 'run-agent.mjs'), 'utf8')),
    'the repair path forces, because it publishes BECAUSE the pod is missing it');
  check(/publishProfile\(\{ force: true \}\)/.test(fs.readFileSync(path.join(root, 'lib/admin.mjs'), 'utf8')),
    'and so does the explicit republish control');
}

// --- 5a-quinquies. the low tail ---
{
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const admin = read('lib/admin.mjs');
  const masto = read('lib/mastoapi.mjs');

  // The mount check was lexical while sendFile's has always been realpath, so
  // a mount that IS a symlink out of ui/ still escaped it.
  check(/realpathSync\(cand\)/.test(admin) && /realpathSync\(UI_DIR\)/.test(admin),
    'the static mount is resolved through symlinks, like the jail below it');
  // Loopback-only bind, no CORS: the only caller is the operator, so a generic
  // sentence hid the reason from the one person entitled to it.
  check(/error: e\.message \|\| String\(e\)/.test(admin) && /e\.stack \|\| e\.message/.test(admin),
    'the console shows the real error and the stack still goes to the log');
  // The CSP comment claimed a containment property connect-src does not have.
  check(/it is a code-execution one/.test(admin),
    'the CSP comment says what the policy actually buys');

  // readBody destroyed the socket and never settled, so the handler awaited
  // for the life of the process.
  const rbAt = masto.indexOf('function readBody');
  const rb = masto.slice(rbAt, rbAt + 900);
  check(/req\.destroy\(\); reject\(new Error\('request body too large'\)\)/.test(rb),
    'an oversized body is rejected rather than left hanging');
  // status() clones the whole array for its reply count, so every render of
  // more than one status has to pass `all`.
  check(!/\.map\(s => this\.status\(s\)\)/.test(masto),
    'no timeline render clones the statuses array once per status');
  check(/published\?\.unreachable/.test(masto),
    'and a save that left the actor unreadable says so rather than reporting success');

  // One timeout default, in one place.
  const sf = read('lib/safefetch.mjs');
  check(/export const HTTP_TIMEOUT_MS/.test(sf),
    'AP_HTTP_TIMEOUT_MS has one default, exported once');
  for (const f of ['lib/publisher.mjs', 'lib/intake.mjs', 'lib/deliver.mjs']) {
    check(!/AP_HTTP_TIMEOUT_MS/.test(read(f)), `${f} reads it rather than redeclaring it`);
  }
  check(/signal: init\.signal \|\| AbortSignal\.timeout\(HTTP_TIMEOUT_MS\)/.test(sf),
    'and safeFetch itself now has the deadline it never had');

  // A leftover .<pid>.tmp is not a note.
  const { PodRdf } = await import(path.join(root, 'lib/podrdf.mjs'));
  const listed = [];
  const rdf = new PodRdf({ storage: { base: 'file:///tmp/x/', list: async () => ({
    names: ['2026-01-01-abcd1234', '2026-01-01-abcd1234.4242.tmp', 'notes.acl'],
  }) } });
  listed.push(...await rdf.listNotes('timeline'));
  check(listed.length === 1 && listed[0].endsWith('2026-01-01-abcd1234'),
    `an interrupted write's leftover is not offered to the parser (${listed.length} listed)`);

  // An Accept has to answer the Follow we sent.
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const mkA = (rec) => {
    const state = { contacts: { followers: [], following: [rec] } };
    const intake = new Intake({
      config: {}, urls: {}, remote: {}, local: {},
      store: {
        read: (_n, d) => d, write: () => {},
        getContacts: () => JSON.parse(JSON.stringify(state.contacts)),
        setContacts: (c) => { state.contacts = c; },
        getStatuses: () => [], getActors: () => ({}), isBlocked: () => false,
      },
      deliverer: {}, publisher: { publishCollections: async () => {} }, log: () => {},
    });
    return { intake, state };
  };
  const THEM = 'https://them.example/u/z';
  const wrong = mkA({ actor: THEM, accepted: false, followActivity: { id: 'https://us.example/f/1' } });
  await wrong.intake.onAccept({ type: 'Accept', object: { id: 'https://us.example/f/OTHER' } }, THEM);
  check(wrong.state.contacts.following[0].accepted === false,
    'an Accept answering a Follow we never sent does not mark us accepted');
  const right = mkA({ actor: THEM, accepted: false, followActivity: { id: 'https://us.example/f/1' } });
  await right.intake.onAccept({ type: 'Accept', object: { id: 'https://us.example/f/1' } }, THEM);
  check(right.state.contacts.following[0].accepted === true, 'and the one that does, does');

  // The ACL probe should not ask about a tree the default layout keeps on disk.
  check(/privateOnPod === false \? \[\] :/.test(read('lib/publisher.mjs')),
    'ensurePrivateAcls does not probe a fediverse tree that is not on the pod');
  check(/privateOnPod: !cred\.privateRoot/.test(read('run-agent.mjs')),
    'and the agent tells it which layout this install uses');
}

// --- 5a-quater. the fediverse posts more than Notes, and a tag is not a hole ---
{
  const { isContentType } = await import(path.join(root, 'lib/intake.mjs'));
  const { TagFeed } = await import(path.join(root, 'lib/tagfeed.mjs'));

  // Insisting on Note dead-lettered an Article, a poll, a PeerTube video and a
  // Lemmy post from people the owner had chosen to follow — silently.
  for (const t of ['Note', 'Article', 'Question', 'Page', 'Video', 'Audio', 'Image', 'Event']) {
    check(isContentType(t), `${t} is content the fediverse actually posts`);
  }
  for (const t of ['Person', 'Follow', 'Collection', undefined]) {
    check(!isContentType(t), `${t} is not, and is still refused`);
  }
  const isrc = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  check(!/note\.type !== 'Note'/.test(isrc),
    'and neither ingestNote nor onUpdate insists on Note any more');

  // --- the steady-state writes that changed nothing ---
  {
    const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
    const { Deliverer } = await import(path.join(root, 'lib/deliver.mjs'));
    const puts = [];
    const st = new PodStore({ log: () => {} });
    st.attach({
      base: 'mem://', list: async () => ({ names: [], etag: null }),
      read: async () => ({ ok: false }), remove: async () => true,
      write: async (name) => { puts.push(name); return { ok: true }; },
    });

    // One item waiting on a far-future nextAt. The only early return is on an
    // EMPTY queue, so every 60s tick used to rewrite queue.json byte for byte —
    // 1440 identical writes a day, and the ordinary ladder reaches hours-long
    // waits by attempt 6, so any peer that fails a few times got there.
    const d = new Deliverer({ store: st, keyId: 'k', rsaPrivate: null, log: () => {}, passive: true });
    st.setQueue([{ inbox: 'https://down.example/in', activity: { type: 'Create' }, attempts: 3, nextAt: Date.now() + 3600_000 }]);
    await st.commit();
    puts.length = 0;
    await d.drainQueue();
    await d.drainQueue();
    await st.commit();
    check(puts.length === 0,
      `a queue where nothing was due is not rewritten (${puts.length} write(s))`);
    // ...but one that moved still is, or the attempt counts never converge.
    st.setQueue([{ inbox: 'https://down.example/in', activity: { type: 'Create' }, attempts: 3, nextAt: Date.now() - 1000 }]);
    await st.commit();
    puts.length = 0;
    await d.drainQueue();
    await st.commit();
    check(puts.includes('queue.json'), 'and one where something was due still is');

    // hold(): a sweep's writes are left to the commit boundary it already has,
    // because the 300ms debounce cannot coalesce a drain — every handler awaits
    // somebody else's server first, so each timer fires before the next item.
    puts.length = 0;
    st.hold();
    for (let i = 0; i < 20; i++) st.write('statuses.json', [{ n: i }]);
    check(puts.length === 0, 'a held store writes nothing on its own');
    const landed = await st.commit();
    check(landed && puts.filter(p => p === 'statuses.json').length === 1,
      `twenty writes inside a sweep are one document write (${puts.length})`);
    // Anything still dirty when the hold ends is re-armed, not stranded.
    st.write('actors.json', { a: 1 });
    st.release();
    await new Promise(r => setTimeout(r, 60));
    await st.commit();
    check(puts.includes('actors.json'),
      'and a write made while held is never dropped when the hold ends');

    // Remote text is bounded where it enters, because these documents are
    // serialized WHOLE on every change: one planted actor with a megabyte of
    // bio permanently inflated actors.json.
    st.cacheActor('https://evil.example/u/x', {
      id: 'https://evil.example/u/x', type: 'Person',
      name: 'n'.repeat(9000), summary: 'x'.repeat(900_000),
    });
    const cached = st.getActors()['https://evil.example/u/x'];
    check(cached.name.length <= 500 && cached.summary.length <= 5_000,
      `a planted name and bio are clamped (${cached.name.length}, ${cached.summary.length})`);
    st.addStatus({ noteId: 'https://evil.example/n/1', content: 'c'.repeat(200_000) });
    const got = st.getStatuses().find(s => s.noteId === 'https://evil.example/n/1');
    check(got.content.length === 100_000 && got.truncated === true,
      'and so is a planted post, which says so rather than pretending');
  }

  // --- a sweep publishes the collections once, not once per event ---
  {
    const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
    let published = [];
    const intake = new Intake({
      config: {}, urls: {}, remote: {}, local: {},
      store: { read: (n, d) => d, write: () => {} },
      deliverer: {}, log: () => {},
      publisher: { publishCollections: async (w) => { published.push(w); } },
    });
    // Outside a sweep there is no boundary to wait for.
    await intake.republish({ followers: true });
    check(published.length === 1, 'outside a sweep a republish happens straight away');

    published = [];
    intake._inSweep = true;
    for (let i = 0; i < 50; i++) await intake.republish({ followers: true });
    await intake.republish({ following: true });
    check(published.length === 0, 'inside one, fifty follow events publish nothing yet');
    await intake._publishPending();
    check(published.length === 1 && published[0].followers && published[0].following,
      `and the sweep ends with a single publish covering both lists (${published.length})`);
    // Each publishCollections({followers}) is a full GET of the pod's followers
    // collection plus a PUT of it, and the answer is built from contacts.json in
    // memory — so fifty of them were a hundred requests for one result.
    await intake._publishPending();
    check(published.length === 1, 'and it takes what it published, so it cannot fire twice');
  }

  // --- one inbound Delete{actor} is one outbox publish ---
  {
    const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
    const GONE = 'https://gone.example/u/x';
    const statuses = Array.from({ length: 12 }, (_, i) => ({
      noteId: `${GONE.replace('/u/x', '')}/n/${i}`, actor: GONE,
      announceActivity: { id: `https://p.example/ap/a/${i}`, type: 'Announce' },
    }));
    let unrecords = 0;
    let removed = 0;
    const intake = new Intake({
      config: { kind: 'group' },
      urls: { actor: 'https://p.example/ap/actor', notes: 'https://p.example/ap/notes/' },
      remote: {}, local: { delete: async () => {}, fedi: 'x/' },
      store: {
        read: (n, d) => d, write: () => {},
        getContacts: () => ({ followers: [{ actor: GONE }], following: [] }),
        setContacts: () => {}, getStatuses: () => statuses, getActors: () => ({}),
        isBlocked: () => false, removeStatus: () => {}, updateStatus: () => {},
      },
      deliverer: { deliverToAll: async () => {} },
      publisher: {
        publishCollections: async () => {},
        unrecordOutbox: async (m) => { unrecords++; removed = statuses.filter(s => m(s.announceActivity)).length; },
      },
      log: () => {},
    });
    intake.isGone = async () => true;
    intake.known = () => true;
    await intake.onDelete({ type: 'Delete', object: GONE, actor: GONE }, GONE);
    check(unrecords === 1,
      `a departing member's whole history is one outbox publish, not one each (${unrecords})`);
    check(removed === 12, `and all ${removed} of their carried posts come out of it`);
  }

  // --- a publish that could not be confirmed does not record its digest ---
  {
    const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
    const state = {};
    const mkPub = (readable) => new Publisher({
      config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
      remote: {
        put: async () => {}, putJson: async () => {}, setAcl: async () => {},
        delete: async () => {}, getJson: async () => null, fetch: async () => ({ ok: false }),
      },
      local: { writeContacts: async () => {}, writeSettings: async () => {} },
      store: {
        read: (n, d) => (n in state ? JSON.parse(JSON.stringify(state[n])) : d),
        write: (n, v) => { state[n] = v; },
        getStatuses: () => [], getContacts: () => ({ followers: [], following: [] }), setContacts: () => {},
        getRequests: () => [], getBlocklist: () => ({ domains: [], actors: [] }),
      },
      deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'x', log: () => {},
      probeFetch: async () => ({ ok: readable, status: readable ? 200 : 403 }),
    });
    const bad = await mkPub(false).publishProfile();
    check(bad.unreachable.length > 0 && !state['published.json']?.surfaceDigest,
      `a publish nobody can read records no digest (${bad.unreachable.length} unreachable)`);
    // ...so the save the operator makes BECAUSE the first did not work is not
    // waved through as "profile unchanged".
    const retry = await mkPub(true).publishProfile();
    check(!retry.skipped && state['published.json'].surfaceDigest,
      'and the retry actually republishes rather than being skipped as a no-op');
    const third = await mkPub(true).publishProfile();
    check(third.skipped, 'once it is genuinely up there, the digest does its job again');
  }

  // --- an upload cannot become a page on the pod's origin ---
  //
  // The media container is world-readable and sits on the pod's own origin, the
  // same origin as the WebID and the ACLs. A file stored as text/html is a page
  // served from that identity. A bearer is not "only you": the facade exists so
  // third-party clients can connect, tokens last 90 days, no scope is enforced.
  {
    const { attachmentType, extensionFor } = await import(path.join(root, 'lib/mastoapi.mjs'));
    const stored = (t) => attachmentType(t);
    check(stored('image/jpeg') === 'image/jpeg' && stored('video/mp4') === 'video/mp4'
      && stored('audio/ogg') === 'audio/ogg',
      'pictures, video and sound are stored as what they are');
    for (const t of ['text/html', 'text/html; charset=utf-8', 'application/xhtml+xml',
      'image/svg+xml', 'application/javascript', 'garbage', '', null]) {
      check(stored(t) === 'application/octet-stream',
        `${t || '(no type)'} is stored as bytes, not as something a browser runs`);
    }
    check(extensionFor(stored('text/html'), 'evil.html') === 'bin',
      'and the filename cannot put .html back on it');
    check(extensionFor('image/png', 'x.png') === 'png' && extensionFor('video/mp4', 'c.mp4') === 'mp4',
      'while an ordinary attachment keeps the suffix it should have');
  }

  // --- the push socket has to be the pod's own ---
  {
    const { sameSocketOrigin } = await import(path.join(root, 'lib/intake.mjs'));
    check(sameSocketOrigin('wss://pod.example/ws/abc', 'https://pod.example/')
      && sameSocketOrigin('ws://localhost:3000/ws', 'http://localhost:3000/'),
      'the pod\'s own socket is accepted, including a pod on this machine');
    // The real deployment: a CSS server giving every pod a subdomain answers
    // notifications from the server root. Requiring an exact host dropped the
    // live agents to polling, which the suite had no way to know.
    check(sameSocketOrigin('wss://teamid.live/.notifications/WebSocketChannel2023/abc',
      'https://jeff-zucker.teamid.live/'),
      'and so is the server root that serves a subdomain pod');
    check(!sameSocketOrigin('wss://evil.example/ws', 'https://pod.example/'),
      'a subscription naming somebody else is not');
    check(!sameSocketOrigin('wss://other.teamid.live/ws', 'https://jeff-zucker.teamid.live/'),
      'nor a sibling subdomain, which is a different pod on the same server');
    check(!sameSocketOrigin('wss://live/ws', 'https://jeff-zucker.teamid.live/'),
      'nor a one-label host posing as everyone\'s parent');
    check(!sameSocketOrigin('ws://pod.example/ws', 'https://pod.example/'),
      'and neither is a downgrade to ws:// from an https pod');
    check(!sameSocketOrigin('https://pod.example/ws', 'https://pod.example/')
      && !sameSocketOrigin('', 'https://pod.example/') && !sameSocketOrigin(null, null),
      'nor a non-socket scheme, nor nothing at all');
  }

  // --- one host does not get to name another host's actor ---
  //
  // A handle arrives in the Mention tags of a note somebody else wrote, so
  // evil.example answering for @x@evil.example with a real, busy actor
  // elsewhere got that actor addressed, tagged and delivered to, over our
  // signature, in a thread they had nothing to do with.
  {
    const { confirmDelegation } = await import(path.join(root, 'lib/social.mjs'));
    const jrdFor = (href) => ({ links: [{ rel: 'self', type: 'application/activity+json', href }] });
    const ok = async (p) => { await p; return true; };
    const threw = async (p) => { try { await p; return false; } catch { return true; } };

    let asked = 0;
    const count = async (a) => { asked++; return jrdFor('https://m.example/users/mei'); };
    check(await ok(confirmDelegation('m.example',
      { id: 'https://m.example/users/mei', preferredUsername: 'mei' }, count)) && asked === 0,
      'a handle on the actor\'s own host is self-consistent, and costs no second lookup');

    // The ordinary delegated setup: @mei@example.com served by m.example.
    check(await ok(confirmDelegation('example.com',
      { id: 'https://m.example/users/mei', preferredUsername: 'mei' }, count)) && asked === 1,
      'a delegated handle passes when the actor\'s own host agrees, at one extra lookup');

    check(await threw(confirmDelegation('evil.example',
      { id: 'https://m.example/users/mei', preferredUsername: 'mei' },
      async () => jrdFor('https://m.example/users/SOMEONE-ELSE'))),
      'but not when that host says the name belongs to a different actor');
    check(await threw(confirmDelegation('evil.example',
      { id: 'https://m.example/users/mei', preferredUsername: 'mei' }, async () => null)),
      'nor when it will not answer at all');
    check(await threw(confirmDelegation('evil.example',
      { id: 'https://m.example/users/mei' }, async () => jrdFor('https://m.example/users/mei'))),
      'nor when the actor names no username to confirm it by');
    check(await threw(confirmDelegation('evil.example', { id: 'not-a-url' }, async () => null)),
      'and an actor id that is not a URL is refused outright');
  }

  // --- the SSRF pinning dependency is declared, not inherited ---
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check(!!pkg.dependencies?.undici,
      'undici is a declared dependency — DNS-rebinding pinning silently depends on it');
  }

  // --- a flood of forged favourites cannot erase real notifications ---
  {
    const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
    const { httpUrl } = await import(path.join(root, 'lib/intake.mjs'));
    check(httpUrl('https://a.example/u/x') && httpUrl('http://localhost:3000/x')
      && !httpUrl('javascript:alert(1)') && !httpUrl('data:text/html,x')
      && !httpUrl('') && !httpUrl(null),
      'an actor has to be an http(s) URL, and the two that reach a client href do not qualify');

    const st = new PodStore({ log: () => {} });
    // Fifty real ones, then a thousand forged favourites — each a different
    // actor string, so the content-hash dedupe does not catch them.
    for (let i = 0; i < 50; i++) st.addNotification({ type: 'mention', actor: `https://friend.example/u/${i}` });
    for (let i = 0; i < 1000; i++) {
      st.addNotification({ type: 'favourite', actor: `https://evil.example/u/${i}`, unverified: true });
    }
    const after = st.getNotifications();
    check(after.filter(n => !n.unverified).length === 50,
      `every real notification survives a 1000-strong flood (${after.filter(n => !n.unverified).length}/50)`);
    check(after.length === 500, `and the list is still capped (${after.length})`);
    check(after.filter(n => n.unverified).length === 450,
      'the flood fills what is left over and evicts only itself');
    // Nothing changes for an ordinary run that never reaches the cap.
    const calm = new PodStore({ log: () => {} });
    for (let i = 0; i < 10; i++) {
      calm.addNotification({ type: 'favourite', actor: `https://e.example/u/${i}`, unverified: true });
    }
    check(calm.getNotifications().length === 10,
      'below the cap an unverified one is kept like any other, so strangers still show up');
  }

  // --- a document may only speak for its own origin ---
  {
    const { authorOf } = await import(path.join(root, 'lib/intake.mjs'));
    const NOTE = 'https://evil.example/n/1';
    const ALICE = 'https://mastodon.example/users/alice';
    check(authorOf({ id: NOTE, attributedTo: ALICE }) === null,
      'a note cannot be attributed to an actor at another origin');
    check(authorOf({ id: NOTE, attributedTo: { id: ALICE } }) === null
      && authorOf({ id: NOTE, attributedTo: [ALICE] }) === null,
      'and the object and array spellings of attributedTo are refused too');
    const MINE = 'https://evil.example/u/x';
    check(authorOf({ id: NOTE, attributedTo: MINE }) === MINE
      && authorOf({ id: NOTE, attributedTo: [{ id: MINE }] }) === MINE,
      'its own origin still vouches for its own author, however it is spelled');
    // The Create envelope is same-origin-checked already, so the delivering
    // actor is a safe fallback there — and is refused on a boost, where it is
    // the booster and crediting them would be its own small forgery.
    check(authorOf({ id: NOTE }, MINE) === MINE && authorOf({ id: NOTE }, ALICE) === null,
      'an unattributed note falls back to the deliverer only at its own origin');
    check(authorOf({ id: NOTE }) === null && authorOf({}, MINE) === null
      && authorOf(null) === null,
      'and with nothing to go on it names nobody rather than guessing');
  }

  // --- the actor cache is keyed on who vouched, not on who claimed ---
  {
    const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
    const cached = {};
    const intake = new Intake({
      config: {}, urls: {}, remote: {}, local: {},
      store: { read: (n, d) => d, write: () => {}, cacheActor: (u, d) => { cached[u] = d; } },
      deliverer: {
        signedFetch: async (u) => ({
          status: 200,
          headers: { get: () => 'application/activity+json' },
          // Whatever we ask for, this host answers with a document claiming to
          // BE somebody else's actor.
          text: async () => JSON.stringify({
            id: 'https://mastodon.example/users/alice', type: 'Person',
            name: 'Alice (verified)', preferredUsername: 'alice',
          }),
          body: null,
        }),
      },
      publisher: {}, log: () => {},
    });
    const doc = await intake.fetchAP('https://evil.example/actor');
    check(doc && doc.id === 'https://mastodon.example/users/alice',
      'the document is still returned, so the callers can reject it on id');
    check(Object.keys(cached).length === 0,
      'but a stranger claiming another actor\'s id does not get cached under it');
  }

  // --- the tag feed ---
  const mk = (fetcher, blocked = [], attributedTo = null) => {
    const added = [];
    const tf = new TagFeed({
      store: {
        read: (_n, d) => ({ ...d, instance: 'https://inst.example', tags: ['solid'] }),
        write: () => {}, getStatuses: () => [], getActors: () => ({}),
        isBlocked: (u) => blocked.some(b => String(u).startsWith(b)),
        addStatus: (s) => added.push(s),
      },
      // The author is at the note's OWN origin, because a note cannot speak for
      // an actor anywhere else — the fixture used to serve every note as
      // spam.example's work whatever host it came from, which is the forgery
      // authorOf now refuses.
      intake: {
        fetchAP: async (u) => ({
          id: u, type: 'Note', content: 'hi',
          attributedTo: attributedTo || `${new URL(u).origin}/u/x`,
        }),
      },
      log: () => {}, fetcher,
    });
    return { tf, added };
  };

  // A blocked author reached the timeline by posting under a tag: this path
  // never went through ingestNote, where the author check lives.
  const blockedRun = mk(
    async () => ({ status: 200, json: async () => [{ uri: 'https://spam.example/n/1' }] }),
    ['https://spam.example'],
  );
  await blockedRun.tf.sweep();
  check(blockedRun.added.length === 0,
    'a blocked author does not reach the timeline through a hashtag');

  const okRun = mk(async () => ({ status: 200, json: async () => [{ uri: 'https://ok.example/n/1' }] }));
  await okRun.tf.sweep();
  check(okRun.added.length === 1, 'while an unblocked one still does');

  // The other way round a block, and the reason it worked: nothing checked that
  // the note's origin had any business naming that author. Post under a
  // followed tag from a host you control, credit it to anyone.
  const forged = mk(
    async () => ({ status: 200, json: async () => [{ uri: 'https://evil.example/n/1' }] }),
    [], 'https://mastodon.example/users/alice',
  );
  await forged.tf.sweep();
  check(forged.added.length === 0,
    'a tagged note cannot name an author its own origin does not vouch for');

  // It is somebody else's server, polled on our schedule, with no other way to
  // ask us to stop. A 429 used to log a line and change nothing.
  let asked = 0;
  const refused = mk(async () => { asked++; return { status: 429, headers: { get: () => null }, json: async () => [] }; });
  await refused.tf.sweep();
  const first = asked;
  check(refused.tf.quietUntil > Date.now() + 10 * 60_000,
    'a 429 puts the tag feed to sleep rather than continuing on cadence');
  await refused.tf.sweep();
  check(asked === first, 'and the next sweep does not ask again while it is backing off');

  const src = fs.readFileSync(path.join(root, 'lib/tagfeed.mjs'), 'utf8');
  check(/retryAfterMs\(res\)/.test(src), 'a Retry-After it sends is honoured');
  check(/this\.failures = 0/.test(src), 'and an instance that answers clears the ladder');
}

// --- 5a-ter. the regressions the first cut of those fixes introduced ---
{
  const { Deliverer } = await import(path.join(root, 'lib/deliver.mjs'));
  const { Lease } = await import(path.join(root, 'lib/lease.mjs'));
  const res = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => body,
  });
  const mkQueue = (q) => ({ q, getQueue() { return JSON.parse(JSON.stringify(this.q)); }, setQueue(v) { this.q = v; } });

  // A 410 Gone is about ONE recipient. Cooling the whole host for it starved
  // every other follower on that instance — which on a big one is most of them.
  const store = mkQueue([
    { inbox: 'https://big.example/users/gone/inbox', activity: { type: 'Create' }, attempts: 1, nextAt: 0 },
    { inbox: 'https://big.example/users/alice/inbox', activity: { type: 'Create' }, attempts: 1, nextAt: 0 },
  ]);
  const seen = [];
  const d = new Deliverer({ store, keyId: 'k', rsaPrivate: null, log: () => {}, passive: true });
  d.deliverNow = async (inbox) => {
    seen.push(inbox);
    if (inbox.includes('gone')) { const e = new Error('410'); e.status = 410; throw e; }
  };
  await d.drainQueue();
  check(seen.some(u => u.includes('alice')),
    'a per-recipient 410 does not cool the host — the healthy follower is still delivered to');

  // A 503 with NO Retry-After must keep the exponential ladder. Defaulting to
  // 60s collapsed it, and 512 minutes became one — the hammering shape.
  const s2 = mkQueue([{ inbox: 'https://down.example/inbox', activity: { type: 'Create' }, attempts: 6, nextAt: 0 }]);
  const d2 = new Deliverer({ store: s2, keyId: 'k', rsaPrivate: null, log: () => {}, passive: true });
  d2.deliverNow = async () => { const e = new Error('503'); e.status = 503; throw e; };
  await d2.drainQueue();
  const waited = s2.q[0].nextAt - Date.now();
  check(waited > 60 * 60_000,
    `a header-less 503 keeps the ladder (${Math.round(waited / 60000)} min, not a flat 60s)`);
  d.stop(); d2.stop();

  // Deferred siblings must ADVANCE, or only the item that opened the socket
  // ever climbs the ladder and a queue of K takes K times as long to give up.
  const dsrc = fs.readFileSync(path.join(root, 'lib/deliver.mjs'), 'utf8');
  const cool = dsrc.slice(dsrc.indexOf('if (until && until > now)'), dsrc.indexOf('      try {'));
  check(/item\.attempts \+= 1/.test(cool) && /MAX_ATTEMPTS/.test(cool),
    'a cooled sibling advances its own ladder and can still be given up on');
  check(dsrc.indexOf('this._cooling.set(host') < dsrc.indexOf('giving up on'),
    'and the host is cooled before the give-up test, not after it');
  check(/this\._cooling \|\|= new Map\(\)/.test(dsrc),
    'the breaker outlives one drain, so a Retry-After reaches items not yet due');

  // The lease sentinel must not read as "somebody else holds it".
  const flaky = new Lease({
    url: 'https://p.example/st/lease.json', log: () => {},
    fetchImpl: async (_u, init) => (init?.method === 'PUT' ? res(412) : res(500)),
  });
  flaky.etag = '"v1"';
  flaky.heldUntil = Date.now() + 300_000;                // still ours by the clock
  let lost = false;
  flaky.onLost = () => { lost = true; };
  const kept = await flaky.renewOnce();
  check(kept === true && !lost && !flaky.stopped,
    'a pod GET we could not make is not a takeover — the agent keeps its lease');

  // And the destructive path can ask, rather than waiting up to ~117s for the
  // next renewal tick to notice the TTL passed.
  const held = new Lease({ url: 'x', fetchImpl: async () => res(404), log: () => {} });
  held.heldUntil = Date.now() + 60_000;
  check(held.stillHeld() === true, 'stillHeld is true inside the TTL');
  held.heldUntil = Date.now() - 1;
  check(held.stillHeld() === false, 'and false once it has passed');
  const isrc = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  check(/this\.lease && !this\.lease\.stillHeld\(\)/.test(isrc),
    'and the drain asks before it deletes anything from the pod');
}

// --- 5b-bis. a password does not go out in clear over a real network ---
{
  const { insecureUrlReason } = await import(path.join(root, 'lib/safefetch.mjs'));
  const { setupInputError } = await import(path.join(root, 'lib/setup.mjs'));

  // Loopback cannot leak: it never reaches a network interface, so plaintext
  // there crosses nothing — and a pod on this machine is a documented way to
  // run this, `state --to http://localhost:8000/…` included.
  for (const ok of ['https://you.solidcommunity.net/', 'http://localhost:8000/dk-pod/',
    'http://127.0.0.1:3000/', 'http://jeff.localhost:8030/', 'http://[::1]:3000/']) {
    check(insecureUrlReason(ok, 'pod address') === null, `allowed: ${ok}`);
  }
  // A LAN address is a real wire, shared with everything else on it — the
  // mistake this is actually here to catch, since it looks local and is not.
  for (const no of ['http://192.168.1.50:3000/', 'http://10.0.0.7/', 'http://pod.example.org/']) {
    check(!!insecureUrlReason(no, 'pod address'), `refused: ${no}`);
  }
  check(/ftp/.test(insecureUrlReason('ftp://pod.example.org/', 'pod address') || ''),
    'and a scheme that is neither http nor https says so');
  check(insecureUrlReason(undefined, 'pod address') === null,
    'an absent address is not this check’s business');

  // Refused BEFORE the password is asked for, not after it has been sent.
  const base = { handle: 'you', mode: 'existing', email: 'you@example.org' };
  // No password supplied here on purpose: the scheme is refused ahead of the
  // "password is required" check, so the answer is about the address rather
  // than about a field the user has not reached yet.
  const noPw = setupInputError({ ...base, issuer: 'http://idp.example.org', pod: 'https://ok.example/' });
  check(/identity provider/.test(noPw || '') && noPw !== 'the account password is required',
    'an http identity provider is refused before the password is even required');
  const badPod = setupInputError({ ...base, issuer: 'https://ok.example', password: 'x', pod: 'http://pod.example.org/' });
  check(/pod address/.test(badPod || ''), 'and an http pod address is refused too');
  check(setupInputError({ ...base, issuer: 'https://ok.example', password: 'x', pod: 'https://ok.example/' }) === null,
    'while an ordinary https setup passes');
  check(setupInputError({ ...base, issuer: 'http://localhost:3000', password: 'x', pod: 'http://localhost:3000/me/' }) === null,
    'and so does a wholly local one');

  // The private half is timelines, contacts and notifications; a file: root has
  // no transport to secure and must not be caught by this.
  check(setupInputError({ ...base, issuer: 'https://ok.example', password: 'x', pod: 'https://ok.example/',
    privateRoot: 'file:///home/you/.solid-activitypub/private/' }) === null,
    'a file: private root is a directory, not a transport');
  check(!!setupInputError({ ...base, issuer: 'https://ok.example', password: 'x', pod: 'https://ok.example/',
    privateRoot: 'http://192.168.1.50/private/' }),
    'but an http one off this machine is refused');

  const bin = fs.readFileSync(path.join(root, 'bin/fedipod.mjs'), 'utf8');
  check((bin.match(/insecureUrlReason/g) || []).length >= 2,
    'the CLI checks it too — setup and `state --to` both take these addresses');
}

// --- 5c-bis. the answers to a Follow that were dropped on the floor ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const mk = (following, origin = {}) => {
    const state = { contacts: { followers: [], following }, notes: [] };
    let published = 0;
    const intake = new Intake({
      config: { kind: 'person' },
      urls: { inbox: 'https://p.example/in/', actor: 'https://p.example/ap/actor' },
      remote: {}, local: {},
      store: {
        read: (n, d) => d, write: () => {},
        getContacts: () => JSON.parse(JSON.stringify(state.contacts)),
        setContacts: (c) => { state.contacts = c; },
        getStatuses: () => [], getActors: () => ({}), isBlocked: () => false,
        addNotification: (n) => state.notes.push(n),
      },
      deliverer: {}, publisher: { publishCollections: async () => { published++; } }, log: () => {},
    });
    intake.fetchAP = async (u) => origin[u] || null;
    return { intake, state, pub: () => published };
  };
  const THEM = 'https://them.example/u/z';

  // Reject: their server has recorded that we do NOT follow them. Ours went on
  // saying we did, and published it — a disagreement that could never resolve,
  // because as far as they are concerned the question was answered.
  const rej = mk([{ actor: THEM, accepted: false }]);
  await rej.intake.onReject({ type: 'Reject', object: { type: 'Follow' }, actor: THEM }, THEM);
  check(rej.state.contacts.following.length === 0 && rej.pub() === 1,
    'a Reject drops the following it refused, and republishes the list');

  const other = mk([{ actor: 'https://someone.else/u/a', accepted: true }]);
  await other.intake.onReject({ type: 'Reject', object: { type: 'Follow' }, actor: THEM }, THEM);
  check(other.state.contacts.following.length === 1,
    'and one from somebody we never followed changes nothing');

  // Move: believed only where the actor's OWN document agrees, since a redirect
  // anyone can Append is not a redirect.
  const moved = mk([{ actor: THEM, accepted: true }],
    { [THEM]: { id: THEM, type: 'Person', movedTo: 'https://new.example/u/z' } });
  await moved.intake.onMove({ type: 'Move', actor: THEM, target: 'https://new.example/u/z' }, THEM);
  check(moved.state.contacts.following[0].movedTo === 'https://new.example/u/z'
    && moved.state.notes.some(n => n.type === 'move'),
    'a corroborated Move is recorded against the follow, and raised');

  const lying = mk([{ actor: THEM, accepted: true }], { [THEM]: { id: THEM, type: 'Person' } });
  const verdict = await lying.intake.onMove(
    { type: 'Move', actor: THEM, target: 'https://attacker.example/u/x' }, THEM);
  check(typeof verdict === 'string' && !lying.state.contacts.following[0].movedTo,
    'one the actor does not confirm is refused rather than followed');
}

// --- 5c-ter. nothing grows without a bound ---
{
  const st = new PodStore({ log: () => {} });
  st.setContacts({ followers: [{ actor: 'https://keep.example/u/f' }], following: [] });
  for (let i = 0; i < 2100; i++) {
    st.cacheActor(`https://n.example/u/${i}`, { id: `https://n.example/u/${i}`, type: 'Person', name: `n${i}` });
  }
  st.cacheActor('https://keep.example/u/f', { id: 'https://keep.example/u/f', type: 'Person', name: 'Follower' });
  const cached = st.getActors();
  check(Object.keys(cached).length <= 2000,
    `the actor cache is bounded (${Object.keys(cached).length} entries)`);
  check(!!cached['https://keep.example/u/f'],
    'and a follower is never evicted from it, however old the entry');
  check(!cached['https://n.example/u/0'] && !!cached['https://n.example/u/2099'],
    'the least recently fetched strangers go first');

  const ra = fs.readFileSync(path.join(root, 'run-agent.mjs'), 'utf8');
  check(/LOG_MAX_BYTES/.test(ra) && /renameSync\(logFile, logFile \+ '\.1'\)/.test(ra),
    'agent.log rotates rather than growing for the life of the install');
  // connect() can run twice — the CLI does it deliberately now.
  check(/this\.intake\?\.stop\(\);\s*\n\s*this\.deliverer\?\.stop\(\);/.test(ra),
    'and connect stops the timers it is about to replace');
}

// --- 5d-bis. a remote actor's own fields are not markup we run ---
{
  const st = new PodStore({ log: () => {} });
  st.cacheActor('https://evil.example/u/x', {
    id: 'https://evil.example/u/x', type: 'Person',
    name: 'Ann<img src=x onerror=alert(1)>',
    preferredUsername: 'ann<script>alert(2)</script>',
    summary: '<p>hi<script>alert(3)</script><img src=x onerror=alert(4)></p>',
    icon: { url: 'javascript:alert(5)' },
    image: { url: 'https://ok.example/h.png' },
  });
  const rec = st.getActors()['https://evil.example/u/x'];
  // The facade serves `summary` as an account's `note`, which every Mastodon
  // client renders as HTML. Note CONTENT was sanitized at all four of its entry
  // points; this, the other thing a remote party writes, was not.
  check(!/<script|onerror/i.test(rec.summary), `a hostile bio is sanitized (${rec.summary})`);
  check(rec.name === 'Ann' && rec.preferredUsername === 'ann',
    `and names are plain text, not markup (${rec.name} / ${rec.preferredUsername})`);
  check(rec.icon === null, 'a javascript: avatar is dropped rather than written into an img src');
  check(rec.image === 'https://ok.example/h.png', 'while an ordinary https one is kept');

  st.cacheActor('https://ok.example/u/y', {
    id: 'https://ok.example/u/y', type: 'Person', name: 'Kofi',
    summary: '<p>birds, <em>mostly</em>. <a href="https://ok.example">site</a></p>',
  });
  const good = st.getActors()['https://ok.example/u/y'];
  check(/<em>mostly<\/em>/.test(good.summary) && /<a /.test(good.summary),
    'an ordinary bio keeps the markup a bio is allowed to have');
}

// --- 5d-ter. an inbound Follow cannot be bound to the actor it names ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const mk = (config) => {
    const state = { contacts: { followers: [], following: [] }, requests: [] };
    const sent = [];
    const intake = new Intake({
      config,
      urls: { inbox: 'https://p.example/in/', actor: 'https://p.example/ap/actor' },
      remote: {}, local: {},
      store: {
        read: (n, d) => d, write: () => {},
        getContacts: () => JSON.parse(JSON.stringify(state.contacts)),
        setContacts: (c) => { state.contacts = c; },
        getRequests: () => JSON.parse(JSON.stringify(state.requests)),
        setRequests: (r) => { state.requests = r; },
        getStatuses: () => [], getActors: () => ({}), isBlocked: () => false,
        addNotification: () => {},
      },
      deliverer: { deliver: async (i, a) => sent.push({ i, a }) },
      publisher: { publishCollections: async () => {} }, log: () => {},
    });
    intake.fetchAP = async (u) => ({ id: u, type: 'Person', inbox: u + '/inbox' });
    return { intake, state, sent };
  };
  const follow = { type: 'Follow', id: 'https://them.example/f/9', actor: 'https://them.example/u/z' };

  // Nothing proves the Follow came from the actor it names, so it waits rather
  // than earning a signed Accept delivered to that person in our name.
  const person = mk({ kind: 'person' });
  await person.intake.onFollow(follow, follow.actor);
  check(person.state.contacts.followers.length === 0 && person.state.requests.length === 1,
    'an unverifiable Follow becomes a request rather than a follower');
  check(person.sent.length === 0, 'and no Accept is signed and delivered to whoever it named');

  const trusting = mk({ kind: 'person', autoAcceptFollows: true });
  await trusting.intake.onFollow(follow, follow.actor);
  check(trusting.state.contacts.followers.length === 1 && trusting.sent.length === 1,
    'autoAcceptFollows: true restores the old behaviour for anyone who wants it');

  // A GROUP is left alone: approveJoins:false is its operator saying in as many
  // words that anyone may join, which is documented behaviour.
  const openGroup = mk({ kind: 'group', approveJoins: false });
  await openGroup.intake.onFollow(follow, follow.actor);
  check(openGroup.state.contacts.followers.length === 1,
    'an open group still admits at once — its gate is its own opt-in setting');

  const gatedGroup = mk({ kind: 'group', approveJoins: true });
  await gatedGroup.intake.onFollow(follow, follow.actor);
  check(gatedGroup.state.requests.length === 1, 'and a gated one still queues');

  // A queue nobody can answer is worse than no queue.
  const admin = fs.readFileSync(path.join(root, 'lib/admin.mjs'), 'utf8');
  const gated = (route) => {
    const at = admin.indexOf(route);
    return admin.slice(at, at + 300).includes("error: 'not a group'");
  };
  check(!gated("p === '/requests'") && !gated("case '/admit':"),
    'reading and answering the queue are not group-only routes');
  check(/refreshRequests/.test(fs.readFileSync(path.join(root, 'web/admin/admin.js'), 'utf8')),
    'and the record page shows it to a person');
}

// --- 5e-bis. accessibility: contrast, reflow, language, status messages ---
{
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const record = read('web/admin/index.html');
  const setup = read('web/admin/setup/index.html');
  const masto = read('lib/mastoapi.mjs');

  // --- contrast, computed rather than eyeballed ---
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const token = (css, name, dark = false) => {
    // the dark block redeclares :root, so search from it when asked
    const from = dark ? css.indexOf('prefers-color-scheme: dark') : 0;
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,6})`).exec(css.slice(from));
    return m && m[1];
  };

  check(Math.abs(ratio('#ffffff', '#000000') - 21) < 0.01, 'the contrast helper agrees with the known 21:1');

  // The page background is --surface from bar.css, not white — that is the
  // pair a reader actually sees.
  const SURFACE = '#f0f2f5', SURFACE_DARK = '#18191a';
  for (const [name, dark, bg] of [['--link', false, SURFACE], ['--heading', false, SURFACE],
    ['--link', true, SURFACE_DARK], ['--heading', true, SURFACE_DARK]]) {
    const c = token(record, name, dark);
    check(c && ratio(c, bg) >= 4.5,
      `${name}${dark ? ' (dark)' : ''} ${c} on ${bg} = ${ratio(c, bg).toFixed(2)}:1, AA text`);
  }

  // A control boundary needs 3:1, and the fill alone cannot carry it: --btn-bg
  // against the page is 1.15:1, so the edge is the only thing that says where a
  // button is.
  for (const dark of [false, true]) {
    const edge = token(record, '--btn-edge', dark);
    const fill = token(record, '--btn-bg', dark);
    check(edge && fill && ratio(edge, fill) >= 3,
      `--btn-edge${dark ? ' (dark)' : ''} ${edge} on ${fill} = ${ratio(edge, fill).toFixed(2)}:1, 1.4.11`);
  }
  for (const [label, css] of [['record', record], ['setup', setup]]) {
    const m = /border: 1px solid (#[0-9a-f]{3,6});[^\n]*background: Field/.exec(css);
    check(m && ratio(m[1], '#ffffff') >= 3,
      `${label} input border ${m?.[1]} on a white Field = ${m ? ratio(m[1], '#ffffff').toFixed(2) : '?'}:1, 1.4.11`);
  }

  // Error text in dark mode: #b00020 on a near-black canvas is 2.40:1, and on
  // both these pages the error IS the message.
  for (const [label, css] of [['record', record], ['setup', setup], ['login form', masto]]) {
    // From the LAST dark block: the login form has two, and the earlier one
    // is followed by the light .err, which is the value being corrected.
    const darkFrom = css.lastIndexOf('prefers-color-scheme');
    const m = /\.err\s*\{[^}]*color:\s*(#[0-9a-fA-F]{3,6})/.exec(css.slice(darkFrom));
    check(m && ratio(m[1], SURFACE_DARK) >= 4.5,
      `${label} .err in dark ${m?.[1]} = ${m ? ratio(m[1], SURFACE_DARK).toFixed(2) : '?'}:1`);
  }

  // --- the author's own 16px floor, which holds because the root is 18px
  // (112.5% of the browser's 16px default — a percentage so it respects a
  // user's own font-size preference) ---
  const rootDecl = /:root\s*\{[^}]*font-size:\s*([\d.]+)(px|%)/.exec(record);
  const rootPx = rootDecl ? (rootDecl[2] === '%' ? Number(rootDecl[1]) / 100 * 16 : Number(rootDecl[1])) : NaN;
  check(rootPx === 18, `the record page root is ${rootPx}px`);
  const smallest = Math.min(...[...record.matchAll(/font-size:\s*([\d.]+)rem/g)].map(m => Number(m[1])));
  check(smallest * rootPx >= 16,
    `the smallest rule is ${smallest}rem = ${(smallest * rootPx).toFixed(1)}px, above the 16px floor`);

  // --- reflow: the window does not scroll, so the column must ---
  check(/#page \{[^}]*overflow-y: auto/.test(record),
    'the record page has a scroll container, so its lower sections are reachable');
  check(/@media \(min-width: 34rem\)/.test(record),
    'and its two-column grids collapse to one when there is no room');
  // Measured at 320px in a real browser: the bar was the last thing running
  // past the viewport, and it is on every page, so it scrolled all of them.
  check(/#bar \{[^}]*flex-wrap: wrap/.test(read('web/admin/bar.css')),
    'the bar wraps rather than pushing every page sideways at 320px');

  // --- Level A: every page declares its language ---
  for (const [label, css] of [['record', record], ['setup', setup],
    ['client', read('web/admin/client/index.html')], ['login form', masto]]) {
    check(/<html lang="en"/.test(css), `${label} declares its language (3.1.1)`);
  }

  // --- 4.1.3: a message the user must act on is announced ---
  check(/id="fatal" role="alert"/.test(record), 'the record page announces a fatal error');
  check((setup.match(/class="err" id="[a-z-]+" role="alert"/g) || []).length === 2,
    'and setup announces both of its errors');
  check(/class="err"(?: id="[a-z-]+")? role="alert"/.test(masto), 'as does the login form');
  check(/<label for="password">/.test(masto),
    'whose password field has a real label, not just a placeholder');

  // A live region put into the accessibility tree in the SAME task as its text
  // does not reliably announce, so none of them is toggled with `hidden`: they
  // stay in the tree and disappear by being empty.
  check(!/id="(say|fatal)"[^>]*hidden/.test(record)
    && /#say:empty, #fatal:empty \{ display: none/.test(record),
    'the record page keeps its status regions in the tree and hides them when empty');
  check(!/id="(form|run)-error"[^>]*hidden/.test(setup)
    && /#form-error:empty, #run-error:empty \{ display: none/.test(setup),
    'and so does setup');
  const adminJs = read('web/admin/admin.js');
  check(!/\$\('say'\)[\s\S]{0,40}hidden = false/.test(adminJs)
    && !/\$\('fatal'\)\.hidden = false/.test(adminJs),
    'and nothing unhides one on its way to writing into it');

  // Setup progress was a bare glyph per step, and a run that DIED said nothing.
  const setupJs = read('web/admin/setup/setup.js');
  check(/mark\.setAttribute\('aria-label'/.test(setupJs),
    'each setup step glyph has a name — a rotating arrow is not a word');
  check(/id="run-say" role="status"/.test(setup) && /\$\('run-say'\)/.test(setupJs),
    'and one polite line reports the step that is actually moving');
  // Deliberately not a live region over the whole list: it is rebuilt on every
  // 700ms poll, and announcing six steps twice a second is noise, not progress.
  check(!/id="run-steps"[^>]*aria-live/.test(setup),
    'rather than making the rebuilt step list itself a live region');

  // --- focus management (verified end-to-end in a browser, asserted here) ---
  const winJs = read('web/admin/window.js');
  check(/setAttribute\('role', 'dialog'\)/.test(winJs)
    && /aria-labelledby', 'win-title'/.test(winJs),
    'the floating panel is a dialog, and says what it is called');
  check(/focusFirst\(\)/.test(winJs) && /returnTo/.test(winJs),
    'opening it takes focus, and closing gives it back to whatever opened it');
  // Which also settles 2.4.11: the window is centred over the very buttons that
  // open it, so the fix for one is the fix for the other.
  check(winJs.indexOf('returnTo = opener') < winJs.indexOf('focusFirst();'),
    'the opener is recorded before focus moves, or there would be nothing to return to');

  // 3.2.2 On Input: arrowing a closed <select> fires change per keypress.
  check(!/id="actor-go"/.test(record),
    'the picker is the control — no extra button beside it');
  check(/arrowing = true/.test(adminJs) && /if \(!arrowing\) goToActor\(\)/.test(adminJs),
    'so arrowing suppresses it, while a mouse pick navigates as it always did');

  check(/focusAfterRefresh/.test(adminJs),
    'a group row action puts focus back rather than dropping it on <body>');

  // --- semantics ---
  check(/<main id="page">/.test(record), 'the record page wraps its content in a main landmark');
  check(/<nav id="bar" aria-label="Site">/.test(record)
    && /<section id="pane-others" aria-label="[^"]+"/.test(record),
    'the site nav and the actors region are both named, so they can be told apart');
  // The buttons used to sit INSIDE the headings, so heading navigation read
  // "Upkeep Drain the inbox Recover posts Show the log Show dead letters".
  check(/<h2><span class="hlabel">Upkeep<\/span><\/h2>/.test(record)
    && /class="headrow"/.test(record),
    'headings end at their own name, with the toolbar beside rather than inside');
  check(!/\.headrow h2, \.headrow h3 \{ display: contents/.test(record),
    'and not via display:contents, which drops the heading from the tree in some browsers');

  // Navigations are links: they belong in a links list, and open in a new tab.
  for (const [label, f] of [['record', 'web/admin/index.html'], ['client', 'web/admin/client/index.html'],
    ['setup', 'web/admin/setup/index.html']]) {
    const page = read(f);
    check((page.match(/<a id="bar-(fediverse|manage|add)" href="/g) || []).length === 3,
      `${label}'s three destinations are links, not buttons that assign location.href`);
  }
  check(!/location\.href = href/.test(read('web/admin/bar.js')),
    'and bar.js no longer drives them by hand');

  // Hints were reachable only by hovering a title attribute.
  check((record.match(/aria-describedby="[a-z-]+-hint"/g) || []).length >= 3
    && /<label for="new-handle">/.test(record),
    'field hints are announced with their field, and the handle has a real label');

  check(/#win-close \{[\s\S]*?min-height: 24px/.test(read('web/admin/window.css')),
    'the close button meets the 24px target minimum (2.5.8)');
  check((record.match(/<ul class="rows" role="list"/g) || []).length === 4,
    'and list-style:none no longer strips the group lists of their list semantics');
}

// --- 5f-bis. the unauthenticated probes are still this pod's traffic ---
{
  const { RemotePod } = await import(path.join(root, 'lib/remote.mjs'));
  const pod = new RemotePod({ webId: 'https://p.example/profile/card#me' }, { log: () => {} });
  check(pod.stats().probes === 0, 'probes are counted, so /status stops under-reporting by design');

  // A cooldown armed by anything else silences them too: ten of these ride on
  // every profile save, and a pod that asked for quiet is asking them as well.
  pod.pausedUntil = Date.now() + 60_000;
  let refused = false;
  await pod.probe('https://p.example/ap/actor').catch(() => { refused = true; });
  check(refused && pod.stats().probes === 0,
    'and are refused inside the pod cooldown, without opening a socket');

  const pub = fs.readFileSync(path.join(root, 'lib/publisher.mjs'), 'utf8');
  check(/this\.remote\.probe\(u, i\)/.test(pub) && !/probeFetch = \(u, i\) => fetch/.test(pub),
    'publisher probes through the pod rather than round the side of it');
  // Still credential-free: it asks what a STRANGER sees, and answering that
  // with our own credentials would answer a different question.
  const rem = fs.readFileSync(path.join(root, 'lib/remote.mjs'), 'utf8');
  const probeBody = rem.slice(rem.indexOf('async probe('), rem.indexOf('async fetch('));
  check(/await fetch\(url, init\)/.test(probeBody) && !/session\.fetch/.test(probeBody),
    'and still without credentials, which is the whole point of a probe');
}

// --- 5g-bis. a command you decline should not have acted already ---
{
  const bin = fs.readFileSync(path.join(root, 'bin/fedipod.mjs'), 'utf8');
  const ra = fs.readFileSync(path.join(root, 'run-agent.mjs'), 'utf8');

  check(/async connect\(\{ name = null, repair = true, act = true \} = \{\}\)/.test(ra)
    && /if \(!act\) return true;/.test(ra),
    'connect({ act: false }) reads the identity and stops short of acting');
  // The stop has to come BEFORE the lease, or a declined command still holds it
  // for the full 300s TTL and demotes the next start to a read-only viewer.
  check(ra.indexOf('if (!act) return true;') < ra.indexOf('this.lease = new Lease('),
    'and stops before the lease is acquired, not after');

  check((bin.match(/connect\(\{ act: false \}\)/g) || []).length === 3,
    'park/revive, retire and rotate-key all ask before they act');
  check((bin.match(/now it may act/g) || []).length === 4,
    'and each connects for real once the answer is yes');

  // A forced reload belongs on promotion only: connect() has already loaded.
  check(/if \(promoted\) await this\.refreshBeforeActing\(\)/.test(ra)
    && (ra.match(/startActive\(\{ promoted: true \}\)/g) || []).length === 2,
    'state is re-read when a viewer is promoted, not on every start');
  const store = fs.readFileSync(path.join(root, 'lib/store.mjs'), 'utf8');
  check(/async load\(\{ force = false \} = \{\}\)/.test(store)
    && (store.match(/force \? null : this\.etags/g) || []).length === 2,
    'load({ force }) sends no ETag, for the container or for any document under it');
}

// --- 5h-bis. a pod container is a boundary, in both implementations ---
{
  const { HttpStorage, FileStorage } = await import(path.join(root, 'lib/storage.mjs'));
  const asked = [];
  const st = new HttpStorage('https://pod.example/ap/fediverse/',
    async (u, i) => { asked.push(`${i?.method || 'GET'} ${u}`); return { status: 200, text: async () => '', headers: { get: () => null } }; });

  // FileStorage has checked this since it was written; HttpStorage concatenated
  // and let fetch normalise the segments away.
  for (const escape of ['../../ap/actor', '../../../.well-known/solid', 'a/../../../x']) {
    let threw = false;
    try { await st.read(escape); } catch { threw = true; }
    check(threw, `HttpStorage refuses a path that climbs out: ${escape}`);
  }
  let wrote = false;
  try { await st.write('../../ap/actor', 'x', 'text/turtle'); } catch { wrote = true; }
  check(wrote, 'and refuses to write outside its container');
  let removed = false;
  try { await st.remove('../../ap/actor'); } catch { removed = true; }
  check(removed, 'and to delete outside it');
  check(asked.length === 0, 'none of which reached the pod at all');

  await st.read('timeline/2026-01-01-abcd1234');
  check(asked.length === 1 && asked[0].endsWith('/ap/fediverse/timeline/2026-01-01-abcd1234'),
    'while an ordinary child still resolves under the base');

  // The reachable input: `published` comes from a remote document, and its
  // first ten characters lead the storage path.
  const src = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  check(/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/.test(src),
    'a note published-date is a date before it is used as a path component');

  const fst = new FileStorage('/tmp/ap-jail-check/');
  let fsThrew = false;
  try { await fst.read('../../etc/passwd'); } catch { fsThrew = true; }
  check(fsThrew, 'and the filesystem implementation still refuses the same thing');
}

// --- 5i-bis. what cannot be replaced is not written in place ---
{
  const { writeJsonAtomic, writeFileAtomic } = await import(path.join(root, 'lib/home.mjs'));
  const dir = fs.mkdtempSync('/tmp/ap-atomic-');
  const file = path.join(dir, 'keys.json');

  writeJsonAtomic(file, { rsa: { privatePem: 'first' } });
  check(JSON.parse(fs.readFileSync(file, 'utf8')).rsa.privatePem === 'first', 'the file is written');
  check((fs.statSync(file).mode & 0o777) === 0o600, 'and is owner-only, as key material must be');

  // The point of the exercise: the old content is intact right up to the
  // rename, so there is no instant at which the file is empty or half there.
  writeJsonAtomic(file, { rsa: { privatePem: 'second' } });
  check(JSON.parse(fs.readFileSync(file, 'utf8')).rsa.privatePem === 'second', 'and replaced whole');
  check(fs.readdirSync(dir).filter(n => n.endsWith('.tmp')).length === 0,
    'leaving no temporary file behind');

  writeFileAtomic(path.join(dir, 'sub', 'deep.json'), '{}\n');
  check(fs.existsSync(path.join(dir, 'sub', 'deep.json')), 'a missing parent directory is created');
  fs.rmSync(dir, { recursive: true, force: true });

  // No irreplaceable file is still written with a truncating writeFileSync.
  for (const f of ['lib/keys.mjs', 'lib/setup.mjs', 'lib/home.mjs', 'run-agent.mjs', 'bin/fedipod.mjs']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    const bad = src.split('\n').filter(l => /writeFileSync/.test(l) && /JSON\.stringify/.test(l));
    check(bad.length === 0, `${f} writes no JSON state non-atomically${bad.length ? ': ' + bad[0].trim() : ''}`);
  }

  // The advice a missing key prints has to name a command that can run —
  // rotate-key connects before it rotates, so the bare form meets the same
  // refusal that sent you there.
  const keysSrc = fs.readFileSync(path.join(root, 'lib/keys.mjs'), 'utf8');
  check(/rotate-key --force/.test(keysSrc), 'the no-key error points at a command that works');
  const binSrc = fs.readFileSync(path.join(root, 'bin/fedipod.mjs'), 'utf8');
  check(/const forced = has\('force'\)/.test(binSrc) && /rotateKeyOnce: true/.test(binSrc),
    'and rotate-key --force arms the one-shot rotation so connect can get past it');
}

// --- 5j-bis. the ACL document is built by rdflib, and round-trips ---
{
  const { RemotePod } = await import(path.join(root, 'lib/remote.mjs'));
  const $rdf = await import('rdflib');
  const ACL = $rdf.Namespace('http://www.w3.org/ns/auth/acl#');
  const pod = Object.create(RemotePod.prototype);
  pod.webId = 'https://me.example/profile/card#me';
  const target = 'https://me.example/ap/inbox/';

  const modesOf = (ttl, frag) => {
    const g = $rdf.graph();
    $rdf.parse(ttl, g, target + '.acl', 'text/turtle');   // throws if it is not Turtle
    return {
      modes: g.each($rdf.sym(`${target}.acl#${frag}`), ACL('mode'), null).map(n => n.value.split('#')[1]).sort(),
      agent: g.any($rdf.sym(`${target}.acl#owner`), ACL('agent'), null)?.value,
      accessTo: g.any($rdf.sym(`${target}.acl#owner`), ACL('accessTo'), null)?.value,
    };
  };

  const pubRead = pod.aclDoc(target, ['Read']);
  check(modesOf(pubRead, 'public').modes.join() === 'Read'
    && modesOf(pubRead, 'owner').modes.join() === 'Control,Read,Write',
    'a public-Read ACL round-trips: the world reads, the owner controls');
  const append = pod.aclDoc(target, ['Append']);
  check(modesOf(append, 'public').modes.join() === 'Append',
    'and a public-Append one — what the inbox actually needs');
  const ownerOnly = pod.aclDoc(target, []);
  check(modesOf(ownerOnly, 'public').modes.length === 0
    && modesOf(ownerOnly, 'owner').modes.length === 3,
    'an empty mode list yields an owner-only document, with no public authorization at all');
  const one = modesOf(pubRead, 'owner');
  check(one.agent === pod.webId && one.accessTo === target,
    'the owner authorization names the WebID and the resource it governs');

  // rdflib refuses an illegal IRI locally, rather than serialising a document
  // that means something other than what was asked for.
  let threw = false;
  try { pod.aclDoc('not a url', ['Read']); } catch { threw = true; }
  check(threw, 'an unusable target throws here rather than being PUT to the pod');

  const src = fs.readFileSync(path.join(root, 'lib/remote.mjs'), 'utf8');
  check(!/@prefix acl:/.test(src) && /\$rdf\.serialize/.test(src),
    'no Turtle is assembled from template literals — the last such site in the project');
}

// --- 5k-ter. every self-scheduling loop stops when it is told to ---
{
  const { TagFeed } = await import(path.join(root, 'lib/tagfeed.mjs'));
  const store = { read: (_n, d) => d, write: () => {}, getStatuses: () => [], isBlocked: () => false };

  // stop() read `this.stopped` in its `finally` and never wrote it, so a stop
  // landing while a sweep was in flight re-armed the chain regardless.
  const tf = new TagFeed({ store, intake: {}, log: () => {}, fetcher: async () => ({ status: 500 }) });
  tf.stop();
  check(tf.stopped === true, 'TagFeed.stop() latches, like Intake.stop() always has');
  tf.start();
  check(tf.stopped === false, 'and start() clears it, so a demoted agent can be promoted back');
  tf.stop();

  // demote() stops the feed but does not clear it, so constructing a new one
  // over the top left the old chain sweeping with nothing able to reach it.
  const src = fs.readFileSync(path.join(root, 'run-agent.mjs'), 'utf8');
  check(!/this\.tagfeed = new TagFeed/.test(src) && (src.match(/this\.tagfeed \|\|= new TagFeed/g) || []).length === 2,
    'run-agent reuses its TagFeed rather than orphaning a live one');

  // The push socket's backoff must not treat "opened, then dropped" as success.
  const intakeSrc = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  const onopen = intakeSrc.slice(intakeSrc.indexOf('this.ws.onopen'), intakeSrc.indexOf('this.ws.onmessage'));
  check(!/reconnectTries = 0/.test(onopen),
    'a bare open no longer resets the reconnect backoff to its 2s floor');
  const onclose = intakeSrc.slice(intakeSrc.indexOf('this.ws.onclose'), intakeSrc.indexOf('this.ws.onerror'));
  check(/RECONNECT_STABLE_MS/.test(onclose) && /reconnectTries = 0/.test(onclose),
    'only a socket that stayed up for a while does');
}

// --- 5l-bis. a stranger cannot spend our requests, or evict our followers ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const mk = (contacts) => {
    const state = { contacts };
    const fetched = [];
    const intake = new Intake({
      config: {}, urls: { inbox: 'https://p.example/in/', actor: 'https://p.example/ap/actor', notes: 'https://p.example/ap/notes/' },
      remote: {}, local: {},
      store: {
        read: (n, d) => d, write: () => {},
        getContacts: () => JSON.parse(JSON.stringify(state.contacts)),
        setContacts: (c) => { state.contacts = c; },
        getStatuses: () => [], getActors: () => ({}), getRequests: () => [], setRequests: () => {},
        isBlocked: () => false, addNotification: () => {}, addDeadLetter: () => {},
      },
      deliverer: {}, publisher: { publishCollections: async () => {} }, log: () => {},
    });
    intake.fetchAP = async (u) => { fetched.push(u); return null; };
    return { intake, state, fetched };
  };

  // Update{actor} from someone we have never heard of. onDelete has refused
  // this since the day it was written; onUpdate did not, so any of the many
  // Update activities Mastodon broadcasts — or one anybody Appends by hand —
  // bought a signed GET to a host of the sender's choosing, and because the
  // failure throws rather than returning a rejection, five of them.
  const stranger = mk({ followers: [], following: [] });
  const verdict = await stranger.intake.onUpdate(
    { type: 'Update', actor: 'https://victim.example/u/x', object: 'https://victim.example/u/x' },
    'https://victim.example/u/x');
  check(stranger.fetched.length === 0,
    'an Update for an actor we do not know costs no outbound request');
  check(verdict === undefined, 'and is dropped rather than retried five times');

  // Someone we DO know still gets refetched — that is the whole point of it.
  const knownOne = mk({ followers: [{ actor: 'https://friend.example/u/y' }], following: [] });
  await knownOne.intake.onUpdate(
    { type: 'Update', actor: 'https://friend.example/u/y', object: 'https://friend.example/u/y' },
    'https://friend.example/u/y').catch(() => {});
  check(knownOne.fetched.length === 1, 'an Update from a follower we hold is still verified at its origin');

  // Undo{Follow} with no object.id. The mismatch guard read `undoneId &&`, so
  // omitting the id skipped it entirely — and this path dereferences nothing,
  // so there was no origin to disagree. Three lines, any follower, evicted.
  const held = mk({ followers: [{ actor: 'https://them.example/u/z', followId: 'https://them.example/f/1' }], following: [] });
  await held.intake.onUndo(
    { type: 'Undo', actor: 'https://them.example/u/z', object: { type: 'Follow' } },
    'https://them.example/u/z');
  check(held.state.contacts.followers.length === 1,
    'an Undo that names no Follow evicts nobody');

  const wrong = mk({ followers: [{ actor: 'https://them.example/u/z', followId: 'https://them.example/f/1' }], following: [] });
  await wrong.intake.onUndo(
    { type: 'Undo', actor: 'https://them.example/u/z', object: { type: 'Follow', id: 'https://them.example/f/OTHER' } },
    'https://them.example/u/z');
  check(wrong.state.contacts.followers.length === 1, 'nor does one naming a different Follow');

  const right = mk({ followers: [{ actor: 'https://them.example/u/z', followId: 'https://them.example/f/1' }], following: [] });
  await right.intake.onUndo(
    { type: 'Undo', actor: 'https://them.example/u/z', object: { type: 'Follow', id: 'https://them.example/f/1' } },
    'https://them.example/u/z');
  check(right.state.contacts.followers.length === 0,
    'and a genuine unfollow, naming the Follow we hold, still works');

  // A record with NO followId cannot be matched at all, and used to be evicted
  // by an Undo naming anything. reconcileFollowers writes exactly those when a
  // restored machine recovers its followers from the pod — the pod publishes WHO
  // follows and never the id of the Follow that did it — so after a restore one
  // unauthenticated POST removed any follower, permanently: dropFollower leaves
  // a mark, the next reconcile will not undo it, and their server recorded no
  // unfollow so it never resends.
  for (const [what, rec] of [
    ['recovered from the pod', { actor: 'https://them.example/u/z', recovered: true, followId: null }],
    ['recorded before ids were kept', { actor: 'https://them.example/u/z' }],
  ]) {
    for (const [shape, object] of [
      ['naming nothing', { type: 'Follow' }],
      ['naming an id of their choosing', { type: 'Follow', id: 'https://them.example/f/anything' }],
      ['a bare IRI', 'https://them.example/f/anything'],
    ]) {
      const u = mk({ followers: [{ ...rec }], following: [] });
      await u.intake.onUndo({ type: 'Undo', actor: 'https://them.example/u/z', object },
        'https://them.example/u/z');
      check(u.state.contacts.followers.length === 1,
        `a follower ${what} survives an Undo ${shape}`);
    }
  }

  // ...and the id an Undo matches on cannot be SET by an inbound Follow, or the
  // attacker just chooses it first: Follow naming any published follower, then
  // Undo naming the id you picked.
  const HIM = 'https://them.example/u/z';
  const reFollow = mk({ followers: [{ actor: HIM, inbox: HIM + '/in', followId: 'https://them.example/f/1' }], following: [] },
    { [HIM]: { id: HIM, type: 'Person', inbox: HIM + '/in' } });
  await reFollow.intake.onFollow({ type: 'Follow', actor: HIM, id: 'https://evil.example/chosen' }, HIM);
  check(reFollow.state.contacts.followers[0].followId === 'https://them.example/f/1',
    'a re-Follow does not overwrite the follow id we already hold');
  await reFollow.intake.onUndo(
    { type: 'Undo', actor: HIM, object: { type: 'Follow', id: 'https://evil.example/chosen' } }, HIM);
  check(reFollow.state.contacts.followers.length === 1,
    'so an Undo naming the attacker-chosen id evicts nobody');
}

// --- 5m-bis. commit() reports on writes that fired their own debounce ---
{
  const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
  const mk = (ok) => new PodStore({
    storage: { base: 'https://p.example/st/', write: async () => ({ ok, retry: false, why: 'refused' }) },
    log: () => {},
  });

  // Forced out by commit itself: this path always worked.
  const forced = mk(false);
  forced.write('contacts.json', { followers: [] });
  check(await forced.commit() === false, 'commit reports a refused write it forced out itself');

  // Fired on its own 300ms debounce BEFORE commit was called. `chain` waits for
  // it but used to discard the result, so commit returned true for a document
  // the pod had refused — and commit's caller is the drain, about to delete the
  // pod's only copy of what that document describes.
  const selfFired = mk(false);
  selfFired.write('deadletter.json', [{ at: 'now' }]);
  await new Promise(r => setTimeout(r, 400));            // let the debounce fire
  check(selfFired.timers.size === 0, 'the debounce fired on its own, outside any commit');
  check(await selfFired.commit() === false,
    'and commit still reports the refusal rather than a clean sweep');

  // A verdict is consumed once reported: one refusal must not condemn every
  // later commit for the life of the process.
  const recovering = new PodStore({
    storage: { base: 'https://p.example/st/', write: async () => ({ ok: true }) }, log: () => {},
  });
  recovering.verdicts.set('deadletter.json', false);
  check(await recovering.commit() === false, 'a recorded refusal is reported once');
  check(await recovering.commit() === true, 'and cleared, so a later good commit is not condemned by it');
}

// --- 5n-bis. outbound delivery: bounded, and one drain at a time ---
{
  const { Deliverer } = await import(path.join(root, 'lib/deliver.mjs'));
  const src = fs.readFileSync(path.join(root, 'lib/deliver.mjs'), 'utf8');

  // The deadline is on the object built ONCE, above the redirect loop, so four
  // hops share it rather than each getting a fresh 15s.
  const signed = src.slice(src.indexOf('async signedFetch('), src.indexOf('async deliverNow('));
  check(/AbortSignal\.timeout/.test(signed) && signed.indexOf('AbortSignal.timeout') < signed.indexOf('for (let hop'),
    'signedFetch sets one deadline for the whole redirect chain, not one per hop');
  check(/init\.signal \|\| AbortSignal/.test(signed),
    'and a caller may still pass its own signal');

  // A drain that outlives its 60s tick must not be joined by the next one.
  const store = {
    q: [{ inbox: 'https://slow.example/inbox', activity: { type: 'Create' }, attempts: 1, nextAt: 0 }],
    getQueue() { return JSON.parse(JSON.stringify(this.q)); },
    setQueue(v) { this.q = v; },
  };
  let inFlight = 0; let overlapped = false; let posts = 0;
  const d = new Deliverer({ store, keyId: 'k', rsaPrivate: null, log: () => {}, passive: true });
  d.deliverNow = async () => {
    posts++;
    inFlight++;
    if (inFlight > 1) overlapped = true;
    await new Promise(r => setTimeout(r, 40));
    inFlight--;
    throw new Error('still down');
  };
  await Promise.all([d.drainQueue(), d.drainQueue()]);   // two ticks, together
  await d._draining;                                     // the single follow-up, if any
  check(!overlapped, 'two ticks landing together never run two drains at once');
  check(posts <= 2, `and a stalled peer is not re-POSTed once per overlapping tick (saw ${posts})`);
  check(store.q.length === 1 && store.q[0].attempts === 2,
    `the attempt count advances exactly once, so the backoff converges (${store.q[0]?.attempts})`);
  d.stop();
}

// --- 5o-ter. a pod asking to be left alone is left alone by EVERY method ---
{
  const { RemotePod } = await import(path.join(root, 'lib/remote.mjs'));
  const res = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    text: async () => body, json: async () => JSON.parse(body),
  });

  const mk = (answer) => {
    const seen = [];
    const pod = new RemotePod({ webId: 'https://p.example/profile/card#me' }, { log: () => {} });
    pod.session = { fetch: async (u, init) => { seen.push(init?.method || 'GET'); return answer(u, init); } };
    return { pod, seen };
  };

  // A 429 answered to a WRITE must arm the cooldown. It never did: put/putJson/
  // getJson/delete all went straight to session.fetch, so only a read could
  // ever record that the pod had asked for quiet.
  const w = mk(() => res(429, { 'retry-after': '120' }));
  await w.pod.put('https://p.example/ap/actor', '{}', 'application/json').catch(() => {});
  check(w.pod.pausedUntil > Date.now() + 60_000, 'a 429 on a PUT arms the pod cooldown');

  // And once armed, nothing opens another socket until it expires.
  const before = w.seen.length;
  let threw = 0;
  for (const call of [
    () => w.pod.putJson('https://p.example/ap/outbox', {}),
    () => w.pod.getJson('https://p.example/ap/actor'),
    () => w.pod.delete('https://p.example/ap/inbox/1'),
  ]) await call().catch(() => { threw++; });
  check(threw === 3 && w.seen.length === before,
    'inside the cooldown, writes/reads/deletes fail fast without opening a socket');

  // A read that FAILED is not a document that is ABSENT — the distinction the
  // replies collection depends on.
  const g = mk(() => res(500));
  let gotNull = false;
  await g.pod.getJson('https://p.example/ap/n/1-replies')
    .then((v) => { gotNull = v === null; }).catch(() => {});
  check(gotNull === false, 'getJson throws on a failed read rather than reporting the document absent');

  const g404 = mk(() => res(404));
  check(await g404.pod.getJson('https://p.example/ap/n/1-replies') === null,
    'a genuine 404 is still reported as absent');

  // The caller that rewrites what it read must not treat a failure as empty.
  const intakeSrc = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  const addReply = intakeSrc.slice(intakeSrc.indexOf('async addReply('), intakeSrc.indexOf('async onAccept('));
  check(!/getJson\([^)]*\)\.catch/.test(addReply),
    'addReply does not swallow a failed read into an empty replies collection');

  const remoteSrc = fs.readFileSync(path.join(root, 'lib/remote.mjs'), 'utf8');
  const body = remoteSrc.slice(remoteSrc.indexOf('async put('));
  check(!/this\.session\.fetch/.test(body),
    'no method below fetch() reaches session.fetch directly, bypassing the cooldown');
}

// --- 5o-bis. demoting stands the lease down with everything else ---
{
  const src = fs.readFileSync(path.join(root, 'run-agent.mjs'), 'utf8');
  const demote = src.slice(src.indexOf('  demote() {'), src.indexOf('  async requestTakeover'));
  check(/this\.lease\?\.stopRenewal\(\)/.test(demote),
    'demote() stops lease renewal, not just intake/tagfeed/deliverer');
  const active = src.slice(src.indexOf('async startActive'), src.indexOf('  demote() {'));
  check((active.match(/lease\.startRenewal\(\)/g) || []).length === 1,
    'startActive arms lease renewal exactly once, including on the parked path');
}

// --- 5p. the poll stands down while push is up ---
{
  const body = fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8');
  const fallback = Number((body.match(/const POLL_MS = (\d+) \* 60_000/) || [])[1]);
  const pushOk = Number((body.match(/const POLL_PUSH_OK_MS = (\d+) \* 60_000/) || [])[1]);
  check(fallback === 2 && pushOk === 10
    && /wsState === 'open' \? POLL_PUSH_OK_MS : POLL_MS/.test(body),
    `poll is ${fallback}min without push and ${pushOk}min with it`);
}

// --- 5q. a dropped socket reuses its channel instead of making another ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const docs = new Map([['inbox-channel.json',
    { receiveFrom: 'wss://p.example/ch/abc', endAt: new Date(Date.now() + 3600_000).toISOString() }]]);
  let posted = 0, openedWith = null;
  class FakeWS { constructor(u) { openedWith = u; } close() {} }
  const realWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeWS;
  const intake = new Intake({
    config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
    remote: { fetch: async () => { posted++; return { status: 200, json: async () => ({}) }; } },
    local: {},
    store: { read: (n, d) => (docs.has(n) ? docs.get(n) : d), write: (n, v) => docs.set(n, v) },
    deliverer: {}, publisher: {}, log: () => {},
  });
  await intake._subscribeOnce();
  globalThis.WebSocket = realWS;
  check(posted === 0 && openedWith === 'wss://p.example/ch/abc',
    'a live saved channel is reconnected without POSTing a new one');
}

// --- 5r2. a pod's own infrastructure is never deletable ---
// Standing rule after a pod was crippled: settings/, the root .well-known, any
// .acl or .meta, and the profile are what make a pod a pod. Deleting one does
// not degrade it, it stops it — and it cannot be repaired by the tool that broke
// it, because that tool can no longer authenticate. The guard lives on
// RemotePod.delete because every DELETE goes through there, so no script can
// route around it, and it is a DENY-list: the next script will have a different
// allow-prefix and the same things it must never touch.
{
  const { protectedFromDeletion } = await import(path.join(root, 'lib/remote.mjs'));
  const refuses = (u) => { try { protectedFromDeletion(u); return false; } catch { return true; } };
  const P = 'https://pod.example';
  check(refuses(`${P}/profile/card`) && refuses(`${P}/profile/`),
    'the WebID document cannot be deleted — nothing could authenticate as the pod again');
  check(refuses(`${P}/settings/prefs.ttl`) && refuses(`${P}/settings/`),
    "nor anything in the pod's settings");
  check(refuses(`${P}/.well-known/webfinger`),
    'nor discovery, which is how the handle resolves at all');
  check(refuses(`${P}/ap/notes/n1.acl`) && refuses(`${P}/ap/notes/n1.meta`),
    'nor an .acl or .meta anywhere — what they govern becomes unreachable');
  check(refuses(`${P}/`), 'nor the pod root');
  check(!refuses(`${P}/ap/notes/2026-01-01-abcd`) && !refuses(`${P}/ap/inbox/item`)
    && !refuses(`${P}/activitypods-js/ap-state/statuses.json`)
    && !refuses(`${P}/activitypods-js/fediverse/posts/n1`),
    'and everything the agent legitimately deletes still goes through');
  check(!refuses(`${P}/profiles-of-mine/x`),
    'the match is on a path SEGMENT — a container merely starting with "profile" is not the profile');
}

// --- 5s. standing an actor down keeps the handle and stops the mail ---
{
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const config = { remotePod: 'https://pod.example/', handle: 'you', name: 'You' };

  const build = () => {
    const acls = [];
    const written = new Map();
    const delivered = [];
    let saved = { ...config };
    const docs = new Map();
    const store = {
      getStatuses: () => [],
      getConfig: () => saved,
      setConfig: (c) => { saved = c; },
      // publishProfile records the digest of the actor document it published,
      // so it can tell a real change from the republish every start does.
      read: (n, d) => (docs.has(n) ? docs.get(n) : d),
      write: (n, v) => { docs.set(n, v); },
      flush: async () => {},
      getContacts: () => ({
        followers: [{ actor: 'https://m.example/users/a', inbox: 'https://m.example/inbox' }],
        following: [{ actor: 'https://m.example/users/b' }, { actor: 'https://other.example/users/c' }],
      }),
    };
    const publisher = new Publisher({
      config, store, local: {},
      remote: {
        setAcl: async (u, m) => { acls.push([u, m]); },
        putJson: async (u, o) => { written.set(u, o); },
        put: async (u, body) => { written.set(u, body); },
      },
      deliverer: { deliverToAll: async (inboxes, activity) => { delivered.push({ inboxes, activity }); } },
      publicKeyPem: 'x', log: () => {},
      probeFetch: async () => ({ status: 200 }),       // no live pod in a unit test
    });
    const agent = new Agent({ home: '/tmp', log: () => {} });
    agent.store = store; agent.publisher = publisher; agent.urls = publisher.urls;
    agent.remote = publisher.remote;
    return { agent, publisher, acls, written, delivered, saved: () => saved };
  };

  // --keep-handle: unfollow everyone, close the inbox, publish nothing away.
  const q = build();
  const unfollowed = [];
  const qr = await q.agent.quiesce({ unfollow: async (_a, actor) => { unfollowed.push(actor); } });
  check(qr.unfollowed === 2 && unfollowed.length === 2
    && q.acls.some(([u, m]) => u === q.publisher.urls.inbox && m.length === 0)
    && !!q.saved().quiescedAt,
    'quiesce unfollows everyone, closes the inbox, and records it');

  // A later republish must not re-open the inbox it just closed.
  const reopened = [];
  q.publisher.remote.setAcl = async (u, m) => { reopened.push([u, m]); };
  q.publisher.config = { ...config, quiescedAt: q.saved().quiescedAt };
  q.publisher.local = { writeSettings: async () => {}, writeContacts: async () => {} };
  await q.publisher.publishProfile();
  const inboxAcl = reopened.filter(([u]) => u === q.publisher.urls.inbox).pop();
  check(inboxAcl && inboxAcl[1].length === 0,
    'a republish leaves a quiesced inbox closed rather than re-opening it');

  // --move-to: Move to the followers, movedTo on the actor, handle still resolves.
  const m = build();
  const target = 'https://jeff-zucker.teamid.live/activitypods-js/ap/actor';
  const mr = await m.agent.moveTo(target, { unfollow: async () => {} });
  const move = m.delivered[0];
  const actor = m.written.get(m.publisher.urls.actor);
  check(move?.activity.type === 'Move' && move.activity.target === target
    && move.activity.object === m.publisher.urls.actor && mr.inboxes === 1,
    'move delivers a Move naming the target to each follower inbox');
  check(actor?.movedTo === target && actor.type === 'Person' && actor.id === m.publisher.urls.actor
    && m.saved().movedTo === target,
    'the actor stays a Person and advertises movedTo, so the old handle still resolves');

  // ---- an edited profile reaches the people looking at it ----
  // Nothing obliges a server to re-fetch an actor it already holds, so a bio or
  // an avatar was invisible to everyone until their cache expired — and a
  // follower count with it, which is what made this visible.
  {
    const u = build();
    u.publisher.local = { writeSettings: async () => {}, writeContacts: async () => {} };
    u.publisher.publishCollections = async () => {};

    // Nothing calls publishProfile on a plain start — every caller is a
    // deliberate republish — so the first one is a real change and goes out.
    // A silent first publish would spend an edit recording a digest, and that
    // edit is the one whose invisibility this exists to fix.
    const first = await u.publisher.publishProfile();
    check(first.updated === 1 && u.delivered.length === 1,
      'the first publish is a republish like any other, so it goes out');

    const again = await u.publisher.publishProfile();
    check(again.updated === 0 && u.delivered.length === 1,
      'a republish that changes nothing sends nothing — which /config does whenever you save a field the actor does not carry');

    u.publisher.config = { ...config, summary: 'now with a bio' };
    const changed = await u.publisher.publishProfile();
    const up = u.delivered[1]?.activity;
    check(changed.updated === 1 && up?.type === 'Update' && up.actor === u.publisher.urls.actor,
      `a real edit delivers an Update to each follower inbox (${changed.updated})`);
    check(up?.object?.id === u.publisher.urls.actor && /now with a bio/.test(up.object.summary || '')
      && up.object['@context'] === undefined && !!up['@context'],
      `carrying the whole actor document, with its context hoisted onto the activity (${JSON.stringify(up?.object?.summary)})`);

    const settled = await u.publisher.publishProfile();
    check(settled.updated === 0 && u.delivered.length === 2,
      'and the publish after that is quiet again — it is the document that decides, not the call');
  }
}

// --- 5t. parking is quiet AND revivable ---
{
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const config = { remotePod: 'https://pod.example/', handle: 'you', name: 'You' };
  const following = [
    { actor: 'https://m.example/users/b', handle: 'b@m.example' },
    { actor: 'https://other.example/users/c' },
  ];

  const acls = [];
  const docs = new Map();
  let saved = { ...config };
  const store = {
    getStatuses: () => [],
    getConfig: () => saved,
    setConfig: (c) => { saved = c; },
    flush: async () => {},
    read: (n, d) => (docs.has(n) ? docs.get(n) : d),
    write: (n, v) => docs.set(n, v),
    remove: async (n) => { docs.delete(n); },
    getContacts: () => ({ followers: [], following }),
  };
  const publisher = new Publisher({
    config, store, local: {},
    remote: { setAcl: async (u, m) => { acls.push([u, m]); }, putJson: async () => {}, put: async () => {} },
    deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'x', log: () => {},
    probeFetch: async () => ({ status: 200 }),
  });
  const agent = new Agent({ home: '/tmp', log: () => {} });
  agent.store = store; agent.publisher = publisher; agent.urls = publisher.urls; agent.remote = publisher.remote;

  const unfollowed = [];
  const parked = await agent.park({ unfollow: async (_a, actor) => { unfollowed.push(actor); } });
  const snap = docs.get('parked.json');
  check(unfollowed.length === 2 && snap?.following?.length === 2
    && snap.following[0].handle === 'b@m.example' && !!snap.parkedAt
    && acls.some(([u, m]) => u === publisher.urls.inbox && m.length === 0)
    && !!saved.quiescedAt,
    'park unfollows, remembers who, and closes the inbox');

  // Revive: inbox re-opened, quiesced flag gone, every remembered follow re-sent.
  const refollowed = [];
  const revived = await agent.revive({ follow: async (_a, actor) => { refollowed.push(actor); } });
  const lastInboxAcl = acls.filter(([u]) => u === publisher.urls.inbox).pop();
  check(revived.refollowed === 2 && refollowed.length === 2
    && lastInboxAcl[1].includes('Append') && !saved.quiescedAt && !docs.has('parked.json'),
    'revive re-opens the inbox, re-sends every remembered Follow, and clears the snapshot');
}

// --- 5f. the token endpoint is asked once, and backed off when it refuses ---
{
  const { createRequire } = await import('node:module');
  const req = createRequire(path.join(root, 'vendor/idp-grant.cjs'));
  const { createGrantSession } = req(path.join(root, 'vendor/idp-grant.cjs'));
  const rec = { clientId: 'c', secret: 's', webId: 'https://p.example/profile/card#me',
    tokenEndpoint: 'https://p.example/.oidc/token', issuerOrigin: 'https://p.example' };
  const realFetch = globalThis.fetch;
  const tokenRes = (status, body, headers = {}) => ({
    ok: status < 400, status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => body, text: async () => JSON.stringify(body),
  });

  // Concurrent callers must produce ONE grant, not one each.
  let grants = 0;
  globalThis.fetch = async () => { grants++; await new Promise(r => setTimeout(r, 20));
    return tokenRes(200, { access_token: 't', expires_in: 300 }); };
  const s1 = createGrantSession(rec);
  globalThis.fetch = globalThis.fetch;           // keep the stub for the session
  await Promise.all([s1.warmup(), s1.warmup(), s1.warmup(), s1.warmup(), s1.warmup()]);
  check(grants === 1, `five concurrent grants coalesce into one (saw ${grants})`);

  // A failing endpoint opens the breaker: the next attempt does not hit it.
  let hits = 0;
  globalThis.fetch = async () => { hits++; return tokenRes(500, { error: 'boom' }); };
  const s2 = createGrantSession(rec);
  let first = null, second = null;
  try { await s2.warmup(); } catch (e) { first = e.message; }
  try { await s2.warmup(); } catch (e) { second = e.message; }
  check(hits === 1 && /HTTP 500/.test(first || '') && /backing off/.test(second || ''),
    'a 500 opens the breaker, so the second attempt never reaches the endpoint');

  // Retry-After outranks the computed backoff.
  globalThis.fetch = async () => tokenRes(429, { error: 'slow down' }, { 'retry-after': '45' });
  const s3 = createGrantSession(rec);
  const t0 = Date.now();
  try { await s3.warmup(); } catch {}
  let msg = '';
  try { await s3.warmup(); } catch (e) { msg = e.message; }
  const left = Number((msg.match(/(\d+)s left/) || [])[1] || 0);
  check(left >= 40 && left <= 45, `Retry-After sets the pause (${left}s from a 45s header)`);

  globalThis.fetch = realFetch;
}

// --- 5g. a flapping socket backs off instead of re-subscribing every 2s ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const intake = new Intake({
    config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
    remote: {}, local: {}, store: {}, deliverer: {}, publisher: {}, log: () => {},
  });
  const delays = [intake._reconnectDelay(), intake._reconnectDelay(), intake._reconnectDelay(),
    intake._reconnectDelay(), intake._reconnectDelay()];
  const grows = delays.every((d, i) => i === 0 || d > delays[i - 1]);
  for (let i = 0; i < 20; i++) intake._reconnectDelay();
  const ceiling = intake._reconnectDelay();
  intake.reconnectTries = 0;
  const reset = intake._reconnectDelay();
  check(delays[0] >= 1600 && delays[0] <= 2400 && grows && ceiling <= 5 * 60_000 * 1.2
    && reset < 2500, 'reconnect delay grows, is capped at ~5min, and resets on open');
}

// --- 5l. one unreadable state doc does not restart the whole load ---
{
  const res = (status, headers = {}, body = '') => ({
    status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, text: async () => body,
  });
  const listing = '<https://p.example/st/> a <http://www.w3.org/ns/ldp#Container> ;'
    + ' <http://www.w3.org/ns/ldp#contains> <https://p.example/st/config.json>,'
    + ' <https://p.example/st/statuses.json>.';
  const mk = (docStatus) => {
    const store = new PodStore({ log: () => {} });
    const seen = [];
    attachHttp(store, 'https://p.example/st/', async (url) => {
      if (url.endsWith('/')) return res(200, { etag: '"c"' }, listing);
      seen.push(url);
      if (url.includes('statuses')) return res(docStatus(url));
      return res(200, { etag: '"cfg"' }, JSON.stringify({ handle: 'jeff' }));
    });
    return { store, seen };
  };

  // A broken statuses.json is skipped; config.json still lands.
  const partial = mk(() => 500);
  await partial.store.load();
  check(partial.store.getConfig()?.handle === 'jeff' && !partial.store.has('statuses.json'),
    'a 500 on one doc is skipped and the rest of the load completes');

  // Nothing recorded for it, so the next load retries unconditionally.
  partial.seen.length = 0;
  await partial.store.load().catch(() => {});
  check(partial.seen.some(u => u.includes('statuses')),
    'the skipped doc is retried on the next load, not written off');

  // config.json is the exception: unreadable and uncached must throw, or the
  // caller would report a working pod as "never set up".
  const noConfig = new PodStore({ log: () => {} });
  attachHttp(noConfig, 'https://p.example/st/', async (url) =>
    url.endsWith('/') ? res(200, { etag: '"c"' }, listing) : res(503));
  let threw = null;
  await noConfig.load().catch(e => { threw = e.message; });
  check(/config\.json unreadable/.test(threw || ''),
    'an unreadable config.json still fails loudly');
}

// --- 5m. inbox attempt counts survive a restart ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const docs = new Map();
  const store = {
    read: (n, d) => (docs.has(n) ? docs.get(n) : d),
    write: (n, v) => docs.set(n, v),
    addDeadLetter: () => {},
  };
  const item = 'https://p.example/in/one';
  const mkIntake = () => new Intake({
    config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
    remote: {
      listContainer: async () => [{ url: item, size: 420, modified: "2026-07-30T00:00:00.000Z" }],
      fetch: async () => { throw new Error('remote down'); },
      delete: async () => true,
    },
    local: {}, store, deliverer: {}, publisher: {}, log: () => {},
  });

  await mkIntake().drain();
  const afterFirst = docs.get('intake-attempts.json')?.[item]?.n;
  await mkIntake().drain();                     // a "restart": brand new Intake, same pod state
  const afterRestart = docs.get('intake-attempts.json')?.[item]?.n;
  check(afterFirst === 1 && afterRestart === 2,
    `a restart continues the count instead of resetting it (${afterFirst} then ${afterRestart})`);

  // Stale records are pruned rather than accumulating forever.
  docs.set('intake-attempts.json', {
    'https://p.example/in/ancient': { n: 3, at: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() },
    [item]: { n: 2, at: new Date().toISOString() },
  });
  const pruner = mkIntake();
  pruner._pruneAttempts();
  const left = Object.keys(docs.get('intake-attempts.json'));
  check(left.length === 1 && left[0] === item, 'records older than a week are pruned');
}

// --- 5n. a failed subscribe schedules another, it does not end push ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const logs = [];
  const intake = new Intake({
    config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
    remote: {}, local: {}, store: { read: (_n, d) => d, write: () => {} },
    deliverer: {}, publisher: {}, log: (m) => logs.push(m),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  await intake.subscribe();
  globalThis.fetch = realFetch;
  const scheduled = !!intake.resubTimer;
  clearTimeout(intake.resubTimer);
  check(scheduled && intake.wsState === 'subscribe-error'
    && logs.some(m => /subscribe failed \(fetch failed\) — retrying in/.test(m)),
    'a network error during subscribe schedules a retry instead of ending push');
}

// --- 5u. one identity per home: profiles, and no silent clobbering ---
{
  const { execFileSync } = await import('node:child_process');
  const cli = path.join(root, 'bin/fedipod.mjs');
  const fake = fs.mkdtempSync('/tmp/dk-ap-ids-');
  const mk = (dir, pod, port) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'credential.json'), JSON.stringify({ remotePod: pod }));
    if (port) fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ port }));
  };
  // Every identity is profiles/<name>/ — none of them at the root. The root
  // holds only the pointer saying which was used last.
  mk(path.join(fake, '.activitypod/profiles/first'), 'https://first.example/', 18991);
  mk(path.join(fake, '.activitypod/profiles/work'), 'https://work.example/', 18992);
  mk(path.join(fake, '.activitypod/profiles/play'), 'https://play.example/', null);
  fs.writeFileSync(path.join(fake, '.activitypod/root.json'), JSON.stringify({ default: 'first' }));
  const run = (args) => {
    try {
      return { out: execFileSync(process.execPath, [cli, ...args],
        { env: { ...process.env, HOME: fake, AP_HOME: '' }, stdio: 'pipe' }).toString(), code: 0 };
    } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
  };

  const listed = run(['profiles']);
  check(/first\s+first\.example/.test(listed.out) && /work\s+work\.example\s+18992/.test(listed.out)
    && /play\s+play\.example/.test(listed.out) && /not running/.test(listed.out),
    'profiles lists every identity by its own name — none of them nameless');
  // Which one a plain command means. It is a property of the ROOT, not of any
  // identity, which is the whole reason it is a pointer.
  check(/first\s+first\.example.*\(default\)/.test(listed.out)
    && !/work.*\(default\)/.test(listed.out),
    'and marks the one that was used last, from root.json');

  // Setup must refuse before asking for anything, and say where to go instead.
  // --handle, so the home is decided: the identity is named after it now, and
  // nothing can be refused before the name exists.
  const clobber = run(['setup', '--handle', 'first', '--pod', 'https://x.example/', '--email', 'a@b.c']);
  check(clobber.code === 2 && /already holds an identity: https:\/\/first\.example\//.test(clobber.out)
    && /profiles[\\/]first already holds/.test(clobber.out),
    'setup refuses to overwrite an existing credential, and names the home it means');

  // --profile selects its own home, and is refused there on its own merits.
  const perProfile = run(['setup', '--profile', 'work', '--pod', 'https://x.example/']);
  check(perProfile.code === 2 && /profiles\/work already holds/.test(perProfile.out),
    '--profile resolves to ~/.activitypod/profiles/<name>');

  // A free profile name gets past the guard (and then fails for want of input).
  const fresh = run(['setup', '--profile', 'brand-new', '--pod', 'https://x.example/']);
  check(fresh.code === 2 && !/already holds/.test(fresh.out) && /email/.test(fresh.out),
    'an unused profile is not blocked by the guard');

  // A handle becomes a directory name, so it is checked before it is one.
  const climb = run(['setup', '--handle', '../escape', '--pod', 'https://x.example/', '--email', 'a@b.c']);
  check(climb.code === 2 && /cannot be a handle/.test(climb.out)
    && !fs.existsSync(path.join(fake, '.activitypod/profiles/../escape')),
    'a handle that would climb out of profiles/ is refused before it is a directory');

  // No pointer and more than one identity is a real question. Picking silently
  // would be picking somebody's fediverse account for them.
  fs.rmSync(path.join(fake, '.activitypod/root.json'));
  const ambiguous = run(['status']);
  check(ambiguous.code === 2 && /more than one identity/.test(ambiguous.out)
    && /first/.test(ambiguous.out) && /work/.test(ambiguous.out),
    'with no pointer and several identities, a plain command asks rather than guesses');
  fs.writeFileSync(path.join(fake, '.activitypod/root.json'), JSON.stringify({ default: 'nobody' }));
  const dangling = run(['status']);
  check(dangling.code === 2 && /nobody/.test(dangling.out),
    'and a pointer at an identity that is not there says so rather than falling back');

  fs.rmSync(fake, { recursive: true, force: true });
}

// --- 5v-bis. the home root: an old install keeps its name until it is moved ---
{
  const { apRoot, CURRENT_ROOT, LEGACY_ROOTS } = await import(path.join(root, 'lib/home.mjs'));
  const LEGACY_ROOT = LEGACY_ROOTS.at(-1);   // the oldest name, for the end-to-end move below
  const { execFileSync } = await import('node:child_process');
  const cli = path.join(root, 'bin/fedipod.mjs');

  // Resolution is the whole feature: an install that already exists is never
  // moved by an upgrade, and a fresh one never lands on the retired name.
  const box = fs.mkdtempSync('/tmp/dk-ap-home-');
  const fresh = path.join(box, 'fresh');
  fs.mkdirSync(fresh);
  check(apRoot(fresh) === path.join(fresh, CURRENT_ROOT),
    'a machine with neither directory gets the current name');

  for (const name of LEGACY_ROOTS) {
    const old = path.join(box, `old-${name}`);
    fs.mkdirSync(path.join(old, name), { recursive: true });
    check(apRoot(old) === path.join(old, name),
      `an install from before the rename keeps the directory holding its keys (${name})`);
  }

  const twoOld = path.join(box, 'two-old');
  for (const name of LEGACY_ROOTS) fs.mkdirSync(path.join(twoOld, name), { recursive: true });
  check(apRoot(twoOld) === path.join(twoOld, LEGACY_ROOTS[0]),
    'with two retired names present, the more recent one wins');

  const both = path.join(box, 'both');
  for (const name of LEGACY_ROOTS) fs.mkdirSync(path.join(both, name), { recursive: true });
  fs.mkdirSync(path.join(both, CURRENT_ROOT), { recursive: true });
  check(apRoot(both) === path.join(both, CURRENT_ROOT),
    'and once the new one exists it wins, so a half-finished move resolves forward');

  // End to end: os.homedir() reads $HOME on POSIX, so the CLI can be pointed at
  // a throwaway machine.
  const fake = fs.mkdtempSync('/tmp/dk-ap-move-');
  const legacy = path.join(fake, LEGACY_ROOT);
  const priv = path.join(legacy, 'profiles', 'solo', 'private');
  fs.mkdirSync(path.join(priv, 'ap-state'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'credential.json'), JSON.stringify({ remotePod: 'https://a.example/' }));
  fs.mkdirSync(path.join(legacy, 'profiles', 'solo'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'profiles', 'solo', 'credential.json'), JSON.stringify({
    remotePod: 'https://solo.example/', privateRoot: pathToFileURL(priv).href + '/',
  }));
  fs.writeFileSync(path.join(priv, 'ap-state', 'config.json'), JSON.stringify({ handle: 'solo' }));
  const run = (args) => {
    try {
      return { out: execFileSync(process.execPath, [cli, ...args],
        { env: { ...process.env, HOME: fake, AP_HOME: '' }, stdio: 'pipe' }).toString(), code: 0 };
    } catch (e) { return { out: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
  };

  const shown = run(['home']);
  // Displayed paths are tildified — the home directory is the least interesting
  // part of every one of them. The runnable line is NOT: a command you are meant
  // to paste says exactly which directory it means.
  check(shown.code === 0 && /root:\s+~\/\.activitypod/.test(shown.out) && /before the rename/.test(shown.out)
    && shown.out.includes(`home --to ${path.join(fake, CURRENT_ROOT)}`),
    'home names the root as ~/…, flags the old name, and prints the move as a runnable absolute line');
  check(!/root:\s+\/.*\.activitypod/.test(shown.out),
    'and does not also print the long form of the root it just shortened');

  const occupied = path.join(fake, 'taken');
  fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'x'), 'x');
  const refused = run(['home', '--to', occupied]);
  check(refused.code === 2 && /not empty/.test(refused.out) && fs.existsSync(legacy),
    'moving onto a non-empty directory is refused rather than merged');

  const target = path.join(fake, CURRENT_ROOT);
  const moved = run(['home', '--to', target]);
  check(moved.code === 0 && !fs.existsSync(legacy) && fs.existsSync(path.join(target, 'credential.json')),
    'the move takes the whole root, profiles and all');

  // The trap: privateRoot is absolute, so a move that ignores it leaves an
  // agent pointing at a directory that no longer exists.
  const after = JSON.parse(fs.readFileSync(path.join(target, 'profiles/solo/credential.json'), 'utf8'));
  const movedPriv = path.join(target, 'profiles/solo/private');
  check(after.privateRoot === pathToFileURL(movedPriv).href + '/'
    && fs.existsSync(path.join(movedPriv, 'ap-state/config.json')),
    'and rewrites the privateRoot that pointed inside it, data and all');

  check(/\(default\)/.test(run(['profiles']).out), 'profiles finds them again at the new root');
  check(/already there/.test(run(['home', '--to', target]).out), 'moving it where it already is does nothing');

  fs.rmSync(box, { recursive: true, force: true });
  fs.rmSync(fake, { recursive: true, force: true });
}

// --- 5w. rotating a key republishes the actor that advertises it ---
{
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const home = fs.mkdtempSync('/tmp/dk-ap-rot-');
  fs.writeFileSync(path.join(home, 'credential.json'), JSON.stringify({
    remotePod: 'https://pod.example/', webId: 'https://pod.example/profile/card#me',
  }));
  const config = { remotePod: 'https://pod.example/', handle: 'you', name: 'You' };
  const written = new Map();
  let saved = { ...config };
  const store = {
    getStatuses: () => [], getConfig: () => saved, setConfig: (c) => { saved = c; },
    flush: async () => {}, read: (_n, d) => d, write: () => {},
    getContacts: () => ({ followers: [], following: [] }),
  };
  const publisher = new Publisher({
    config, store, local: { writeSettings: async () => {}, writeContacts: async () => {} },
    remote: {
      putJson: async (u, o) => { written.set(u, o); }, put: async () => {},
      setAcl: async () => {},
    },
    deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'ORIGINAL-KEY', log: () => {},
    probeFetch: async () => ({ status: 200 }),
  });
  const agent = new Agent({ home, log: () => {} });
  agent.store = store; agent.publisher = publisher; agent.urls = publisher.urls;
  agent.remote = publisher.remote;
  agent.deliverer = { rsaPrivate: 'OLD' };

  const r = await agent.rotateKey();
  const actor = written.get(publisher.urls.actor);
  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'keys.json'), 'utf8'));

  check(r.changed && /BEGIN PUBLIC KEY/.test(r.publicKeyPem)
    && actor?.publicKey?.publicKeyPem === r.publicKeyPem
    && publisher.publicKeyPem === r.publicKeyPem && agent.deliverer.rsaPrivate !== 'OLD'
    && onDisk.mintedFor === publisher.urls.actor,
    'rotate mints a key, republishes the actor with it, and re-arms the live signer');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 5x. a stranded lease can be claimed instead of waited out ---
{
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const agent = new Agent({ home: '/tmp', log: () => {} });
  let started = 0, claimed = 0;
  agent.viewer = true;
  agent.lease = { takeover: async () => { claimed++; return true; } };
  agent.startActive = async () => { started++; agent.viewer = false; };

  const took = await agent.takeOver();
  const again = await agent.takeOver();          // already active: nothing to claim
  check(took === true && claimed === 1 && started === 1 && again === false,
    'takeOver claims the lease once and promotes, and is a no-op when already active');

  // A refused takeover must leave the agent read-only rather than half-promoted.
  const stubborn = new Agent({ home: '/tmp', log: () => {} });
  stubborn.viewer = true;
  stubborn.lease = { takeover: async () => false };
  stubborn.startActive = async () => { throw new Error('must not start'); };
  check((await stubborn.takeOver()) === false && stubborn.viewer === true,
    'a refused takeover leaves the agent a viewer');
}

// --- 5v. a signing key belongs to one actor ---
{
  const { resolveKeys } = await import(path.join(root, 'lib/keys.mjs'));
  const store = { read: () => null, write: () => {}, remove: async () => true };
  const mine = 'https://a.example/activitypods-js/ap/actor';
  const theirs = 'https://b.example/activitypods-js/ap/actor';

  // Stamped for another actor → treated as absent, so a fresh key is minted.
  const dir1 = fs.mkdtempSync('/tmp/dk-ap-keys-');
  const first = await resolveKeys(store, { localDir: dir1, actorId: theirs, log: () => {} });
  const reused = await resolveKeys(store, { localDir: dir1, actorId: theirs, log: () => {} });
  const logs = [];
  const foreign = await resolveKeys(store, {
    localDir: dir1, actorId: mine, actorHasKey: async () => false, log: (m) => logs.push(m),
  });
  const stamped = JSON.parse(fs.readFileSync(path.join(dir1, 'keys.json'), 'utf8'));
  check(reused.rsaPublicPem === first.rsaPublicPem
    && foreign.rsaPublicPem !== first.rsaPublicPem
    && stamped.mintedFor === mine
    && logs.some(m => /belongs to https:\/\/b\.example/.test(m)),
    'a key stamped for another actor is not reused, and the replacement is stamped');

  // The dangerous case still refuses: no key here, but the actor publishes one.
  const dir2 = fs.mkdtempSync('/tmp/dk-ap-keys-');
  fs.writeFileSync(path.join(dir2, 'keys.json'), JSON.stringify({ ...stamped, mintedFor: theirs }));
  let refused = null;
  await resolveKeys(store, {
    localDir: dir2, actorId: mine, actorHasKey: async () => true, log: () => {},
  }).catch(e => { refused = e.message; });
  check(/already publishes a signing key/.test(refused || ''),
    'a foreign key plus a published key still refuses rather than breaking federation');

  fs.rmSync(dir1, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
}

// --- 6. pod-RDF builders via injected fetch ---
const { PodRdf } = await import(path.join(root, 'lib/podrdf.mjs'));
const rdfPuts = [];
// Remembers what it was given, so a note can be read back the way it was
// written. Asserting on the serialised TEXT is what the hand-rolled version
// invited; with rdflib the output is correctly prefixed and abbreviated
// (`media:p.png`, not `<https://m.example/media/p.png>`), so the thing worth
// testing is the round trip, not the spelling.
const FEDI = 'https://pod.example/activitypods-js/fediverse/';
const rdfDocs = new Map();
const rdf = new PodRdf({
  storage: new HttpStorage(FEDI, async (url, init = {}) => {
    if (init.method === 'PUT') {
      rdfPuts.push({ url, body: init.body });
      rdfDocs.set(url, init.body);
      return { status: 201, headers: { get: () => null }, text: async () => '' };
    }
    const body = rdfDocs.get(url);
    return body === undefined
      ? { status: 404, headers: { get: () => null }, text: async () => '' }
      : { status: 200, headers: { get: () => null }, text: async () => body };
  }),
});
// A tab is in here on purpose: the hand-rolled escaper handled \\, " and \n
// and passed tabs through raw. See claude/plans/no-regex-rdf.md.
await rdf.writeNote('timeline', 's1', {
  noteId: 'https://m.example/n/1', actor: 'https://m.example/u/a',
  published: '2026-07-28T00:00:00Z', content: 'say "hi"\nnew\tline',
});
check(rdfPuts[0].url === FEDI + 'timeline/s1', `timeline path (got ${rdfPuts[0].url})`);
const back1 = await rdf.readNote(FEDI + 'timeline/s1');
check(back1.content === 'say "hi"\nnew\tline' && back1.noteId === 'https://m.example/n/1'
  && back1.actor === 'https://m.example/u/a' && back1.published === '2026-07-28T00:00:00Z',
  `a note round-trips whole — quotes, newline and tab (${JSON.stringify(back1.content)})`);
check(/\^\^xsd:dateTime/.test(rdfPuts[0].body),
  'published keeps its dateTime datatype (rdflib takes it as the SECOND argument)');

await rdf.writeNote('timeline', 's2', {
  noteId: 'https://m.example/n/2', actor: 'https://m.example/u/a', published: '2026-07-28T00:00:00Z',
  content: 'with pic', attachments: [{ url: 'https://m.example/media/p.png', mediaType: 'image/png', description: 'a "pic"' }],
});
const back = await rdf.readNote(FEDI + 'timeline/s2');
check(back.attachments?.length === 1 && back.attachments[0].url === 'https://m.example/media/p.png'
  && back.attachments[0].mediaType === 'image/png' && back.attachments[0].description === 'a "pic"',
  'an attachment round-trips with its type and description');

// --- 7. facade M1–M3 on a seeded in-memory PodStore, faked delivery ---
const { MastoApi } = await import(path.join(root, 'lib/mastoapi.mjs'));

const store2 = new PodStore({ log: () => {} });
const urls2 = wire.apUrls('https://pod.example/');
store2.setConfig({ remotePod: 'https://pod.example/', handle: 'jeff', name: 'jeff' });

const OWN = urls2.notes + 'n1';
const REPLY = 'https://m.example/n/r1';
const OWN2 = urls2.notes + 'n2';
const ALICE = 'https://m.example/u/alice';
store2.write('statuses.json', [
  { noteId: OWN2, actor: urls2.actor, content: '<p>own reply</p>', published: '2026-07-28T03:00:00Z', inReplyTo: REPLY, kind: 'post', slug: 'n2' },
  { noteId: REPLY, actor: ALICE, content: '<p>a reply</p>', published: '2026-07-28T02:00:00Z', inReplyTo: OWN, kind: 'timeline' },
  { noteId: OWN, actor: urls2.actor, content: '<p>root</p>', published: '2026-07-28T01:00:00Z', kind: 'post', slug: 'n1' },
]);
const DAN = 'https://m.example/u/dan';
store2.setContacts({
  // Append order is arrival order: dan followed after alice.
  followers: [{ actor: ALICE, inbox: 'https://m.example/u/alice/inbox', followId: 'f1' },
    { actor: DAN, inbox: 'https://m.example/u/dan/inbox', followId: 'f2' }],
  following: [{ actor: 'https://m.example/u/bob', inbox: 'https://m.example/u/bob/inbox', accepted: true,
    followActivity: { id: 'x#follow-1', type: 'Follow' } }],
});
store2.addNotification({ type: 'follow', actor: ALICE });
store2.addNotification({ type: 'favourite', actor: ALICE, noteId: OWN });

const delivered = [];
const puts = [];
const outbox2 = [];
const fakeAgent = {
  store: store2,
  configured: () => true,
  publisher: {
    urls: urls2, ensureMediaContainer: async () => {}, publishCollections: async () => {},
    recordOutbox: async (i) => { outbox2.unshift(i); },
    unrecordOutbox: async (m) => {
      for (let k = outbox2.length - 1; k >= 0; k--) if (m(outbox2[k])) outbox2.splice(k, 1);
    },
  },
  deliverer: {
    deliver: async (inbox, a) => delivered.push({ inbox, a }),
    deliverToAll: async (inboxes, a) => delivered.push({ inboxes, a }),
  },
  remote: { put: async (u, b, ct) => puts.push({ u, ct, len: b.length }), putJson: async () => {}, setAcl: async () => {}, delete: async () => true },
  local: { fedi: urls2.fediverse, delete: async () => {} },
  intake: { fetchAP: async (u) => ({ id: u, type: 'Person', inbox: u + '/inbox', preferredUsername: 'who' }) },
};
const masto2 = new MastoApi({ agent: fakeAgent, log: () => {} });
const bearer = masto2.mintToken();

async function call(pathAndQuery, { method = 'GET', body = null, contentType = 'application/json' } = {}) {
  const req2 = Readable.from(body === null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  req2.method = method;
  req2.headers = { authorization: `Bearer ${bearer}`, 'content-type': contentType };
  const res = {
    status: 0, body: '',
    writeHead(s) { this.status = s; },
    end(b) { this.body = String(b || ''); },
  };
  const u = new URL('http://x' + pathAndQuery);
  await masto2.handle(req2, res, u.pathname, u);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, json: parsed };
}

const notif = await call('/api/v1/notifications');
check(notif.status === 200 && notif.json.length === 2 && notif.json[0].type === 'favourite'
  && notif.json[0].status?.uri === OWN && notif.json[1].type === 'follow',
  `notifications render follow + favourite w/ status (got ${JSON.stringify(notif.json?.map(n => n.type))})`);

const relIds = [store2.idFor('https://m.example/u/bob'), store2.idFor(ALICE)];
const rels = await call(`/api/v1/accounts/relationships?id[]=${relIds[0]}&id[]=${relIds[1]}`);
check(rels.status === 200 && rels.json[0].following === true && rels.json[1].followed_by === true,
  'relationships from contacts (following + followed_by)');

const ctx = await call(`/api/v1/statuses/${store2.idFor(REPLY)}/context`);
check(ctx.status === 200 && ctx.json.ancestors.length === 1 && ctx.json.ancestors[0].uri === OWN
  && ctx.json.descendants.length === 1 && ctx.json.descendants[0].uri === OWN2,
  'context walks inReplyTo both ways');

const fav = await call(`/api/v1/statuses/${store2.idFor(REPLY)}/favourite`, { method: 'POST' });
check(fav.status === 200 && fav.json.favourited === true
  && delivered.some(d => d.a?.type === 'Like' && d.a.object === REPLY),
  'favourite delivers Like + flags mirror');
const unfav = await call(`/api/v1/statuses/${store2.idFor(REPLY)}/unfavourite`, { method: 'POST' });
check(unfav.json.favourited === false && delivered.some(d => d.a?.type === 'Undo'),
  'unfavourite delivers Undo + clears flag');

const boost = await call(`/api/v1/statuses/${store2.idFor(REPLY)}/reblog`, { method: 'POST' });
check(boost.json.reblogged === true && delivered.some(d => d.a?.type === 'Announce' && d.a.object === REPLY),
  'reblog delivers Announce to followers');
// A boost is something the actor said, so it belongs in the public outbox. It
// used to go only to inboxes, leaving nothing for anyone crawling the outbox.
check(outbox2.some(i => i?.type === 'Announce' && i.object === REPLY),
  'the boost is recorded in the outbox');
const unboost = await call(`/api/v1/statuses/${store2.idFor(REPLY)}/unreblog`, { method: 'POST' });
check(unboost.json.reblogged === false && !outbox2.some(i => i?.type === 'Announce' && i.object === REPLY),
  'unreblog takes it back out again');

const fol = await call(`/api/v1/accounts/${store2.idFor('https://m.example/u/carol')}/follow`, { method: 'POST' });
check(fol.status === 200 && fol.json.requested === true
  && delivered.some(d => d.a?.type === 'Follow' && d.a.object === 'https://m.example/u/carol'),
  'follow by id delivers Follow, relationship requested');

// Phanpy renders the counts from `account`, then opens them through these two
// routes. Neither existed, so every profile said "error loading accounts".
// carol is pending at this point (the follow above), bob is accepted.
const selfId = store2.idFor(urls2.actor);
const myFollowing = await call(`/api/v1/accounts/${selfId}/following`);
check(myFollowing.status === 200 && myFollowing.json.length === 1
  && myFollowing.json[0].uri === 'https://m.example/u/bob',
  `following lists the accepted follow and not the pending one (got ${JSON.stringify(myFollowing.json?.map(a => a.uri))})`);

// Newest first, like Mastodon: the contact arrays append, so serving them as
// stored put the oldest on page one and made since_id answer its complement.
const myFollowers = await call(`/api/v1/accounts/${selfId}/followers`);
check(myFollowers.status === 200 && myFollowers.json.length === 2
  && myFollowers.json[0].uri === DAN && myFollowers.json[1].uri === ALICE,
  `followers list newest first (got ${JSON.stringify(myFollowers.json?.map(a => a.uri))})`);

// The number and the list it opens read the same array — they disagreed while
// the count included pending follows, so clicking "2" showed one account.
const me = await call('/api/v1/accounts/verify_credentials');
check(me.json.following_count === myFollowing.json.length
  && me.json.followers_count === myFollowers.json.length,
  `the counts equal the lists behind them (${me.json?.following_count}/${me.json?.followers_count})`);

// A stranger's collections live on their own server; opening a profile does not
// buy a fetch of it. Empty is a truthful answer, an error is not.
const theirs = await call(`/api/v1/accounts/${store2.idFor(ALICE)}/following`);
check(theirs.status === 200 && Array.isArray(theirs.json) && theirs.json.length === 0,
  'a remote account lists empty rather than erroring');

const noSuch = await call('/api/v1/accounts/deadbeef/followers');
check(noSuch.status === 404, 'an unknown account is still 404');

// Cursors name an ACTOR here, not a note — page() took the field as a parameter
// so the statuses paths keep naming notes.
const oneOf = await call(`/api/v1/accounts/${selfId}/following?limit=1`);
check(oneOf.status === 200 && oneOf.json.length === 1, 'limit is honoured on an account list');

const fam = await call('/api/v1/accounts/familiar_followers?id[]=aa&id[]=bb');
check(fam.status === 200 && fam.json.length === 2 && fam.json[0].id === 'aa'
  && Array.isArray(fam.json[0].accounts) && fam.json[0].accounts.length === 0,
  'familiar_followers answers per requested id, with no graph to report');

const mark = await call('/api/v1/markers', { method: 'POST', body: JSON.stringify({ home: { last_read_id: 'abc' } }) });
const markBack = await call('/api/v1/markers');
check(mark.status === 200 && markBack.json.home?.last_read_id === 'abc', 'markers persist');

const boundary = 'xyzBOUNDARY';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
const mp = Buffer.concat([
  Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="description"\r\n\r\na pic\r\n`),
  Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="p.png"\r\ncontent-type: image/png\r\n\r\n`),
  png,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
const media = await call('/api/v2/media', {
  method: 'POST', body: mp, contentType: `multipart/form-data; boundary=${boundary}`,
});
check(media.status === 200 && media.json.type === 'image' && media.json.description === 'a pic'
  && puts.length === 1 && puts[0].len === png.length && puts[0].ct === 'image/png',
  `media upload → remote put, binary intact (got ${JSON.stringify({ s: media.status, puts: puts.length })})`);

const del = await call(`/api/v1/statuses/${store2.idFor(OWN2)}`, { method: 'DELETE' });
check(del.status === 200 && delivered.some(d => d.a?.type === 'Delete' && d.a.object?.id === OWN2)
  && !store2.getStatuses().some(s => s.noteId === OWN2),
  'DELETE status federates Delete + removes from mirror');

// A pod that refuses the delete used to be invisible: the writes were
// unchecked, so the post came off this machine and stayed publicly readable,
// with nothing to show for it and nothing left to try again with.
{
  const wasPut = fakeAgent.remote.putJson;
  const wasDelete = fakeAgent.remote.delete;

  // The pod will not accept the note's Tombstone → the post is still published.
  fakeAgent.remote.putJson = async () => { throw new Error('refused'); };
  const refused = await call(`/api/v1/statuses/${store2.idFor(OWN)}`, { method: 'DELETE' });
  check(refused.status === 502 && /still published/.test(refused.json?.error || ''),
    `a pod that will not tombstone the note is reported, not reported as deleted (${refused.status})`);
  check(store2.getStatuses().some(s => s.noteId === OWN),
    'and the post is kept here, because otherwise there is nothing to try again with');
  fakeAgent.remote.putJson = wasPut;

  // The -create embeds the whole note, so a -create that will not delete keeps
  // the post too.
  const tried = [];
  fakeAgent.remote.delete = async (u) => { tried.push(u); return !u.endsWith('-create'); };
  const refusedCreate = await call(`/api/v1/statuses/${store2.idFor(OWN)}`, { method: 'DELETE' });
  check(refusedCreate.status === 502 && tried.includes(OWN + '-create'),
    'the -create is checked too: it embeds the whole note, so leaving it behind republishes the post');

  // An empty replies collection that will not go is not a reason to keep the post.
  fakeAgent.remote.delete = async (u) => !u.endsWith('-replies');
  const anyway = await call(`/api/v1/statuses/${store2.idFor(OWN)}`, { method: 'DELETE' });
  check(anyway.status === 200 && !store2.getStatuses().some(s => s.noteId === OWN),
    'an empty replies collection that will not go is not a reason to keep the post');
  fakeAgent.remote.delete = wasDelete;
  store2.addStatus({ noteId: OWN, actor: urls2.actor, content: '<p>root</p>',
    published: '2026-07-28T01:00:00Z', kind: 'post', slug: 'n1' });
}

const q = await call('/api/v2/search?q=root');
check(q.status === 200 && q.json.statuses.length === 1 && q.json.statuses[0].uri === OWN,
  'text search finds mirror content');

const accSelf = await call('/api/v1/accounts/search?q=jeff');
check(accSelf.status === 200 && accSelf.json.some(a => a.acct.startsWith('jeff@')),
  'accounts/search finds self by handle');
const accContact = await call('/api/v2/search?type=accounts&q=alice');
check(accContact.status === 200 && accContact.json.accounts.some(a => a.url === ALICE),
  'v2 accounts search finds contact');

const local = await call('/api/v1/timelines/public?local=true');
const fed = await call('/api/v1/timelines/public');
const trend = await call('/api/v1/trends/statuses');
check(local.json.every(s => s.account.acct.startsWith('jeff@')) && local.json.length >= 1,
  `public?local → own posts only (got ${local.json.length})`);
check(fed.json.length >= local.json.length && trend.json.length === fed.json.length,
  'public + trends serve known statuses');

// --- 8. Announce ingestion + tag feed ---
const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
const { TagFeed } = await import(path.join(root, 'lib/tagfeed.mjs'));

const BOB = 'https://m.example/u/bob';
const written = [];
const intake3 = new Intake({
  config: {}, urls: urls2, remote: {}, store: store2, deliverer: {}, publisher: {},
  local: { writeNote: async (kind, slug, n) => written.push({ kind, slug, n }) },
  log: () => {},
});
intake3.fetchAP = async (u) => ({
  id: u, type: 'Note', attributedTo: 'https://m.example/u/booster-source',
  content: '<p>boosted content</p>', published: '2026-07-28T04:00:00Z',
});
await intake3.handle({ type: 'Announce', actor: BOB, object: 'https://m.example/n/boost1' });
check(store2.getStatuses().some(s => s.noteId === 'https://m.example/n/boost1' && s.via === BOB)
  && written.some(w => w.kind === 'timeline'),
  'Announce from followed actor ingests boosted note (mirror + pod write)');
await intake3.handle({ type: 'Announce', actor: 'https://m.example/u/stranger', object: 'https://m.example/n/boost2' });
check(!store2.getStatuses().some(s => s.noteId === 'https://m.example/n/boost2'),
  'Announce from stranger is ignored');

const tf = new TagFeed({
  store: store2, log: () => {},
  intake: { fetchAP: async (u) => ({
    id: u, type: 'Note', attributedTo: 'https://m.example/u/tagger',
    content: '<p>#solid post</p>', published: '2026-07-28T05:00:00Z',
  }) },
  fetcher: async () => ({ status: 200, json: async () => [{ uri: 'https://m.example/n/t1' }, { uri: 'https://m.example/n/t1' }] }),
});
store2.write('tagfeed.json', { instance: 'https://tags.example', tags: ['solid'], intervalMin: 60 });
await tf.sweep();
const afterFirst = store2.getStatuses().filter(s => s.kind === 'tag').length;
await tf.sweep();
const afterSecond = store2.getStatuses().filter(s => s.kind === 'tag').length;
check(afterFirst === 1 && afterSecond === 1, `tag sweep ingests once, dedupes (got ${afterFirst}/${afterSecond})`);

const homeWithTag = await call('/api/v1/timelines/home');
// Boosted content arrives in the boost shape — the carrier on the outside,
// the post itself in `reblog` — so it is found either place.
const uriOf = (s) => [s.uri, s.reblog?.uri];
check(homeWithTag.json.some(s => uriOf(s).includes('https://m.example/n/t1'))
  && homeWithTag.json.some(s => uriOf(s).includes('https://m.example/n/boost1')),
  'home timeline includes tag-feed + boosted content');
const localAgain = await call('/api/v1/timelines/public?local=true');
check(localAgain.json.every(s => s.account.acct.startsWith('jeff@')), 'public?local still own posts only');

// --- 8b. streaming: health, handshake, live broadcast ---
if (up) {
  const health = await fetch(`http://127.0.0.1:${PORT}/api/v1/streaming/health`, { headers: { 'x-dk-token': TOKEN } });
  check(health.status === 200 && (await health.text()) === 'OK', 'streaming health endpoint');
}
{
  const { Streaming } = await import(path.join(root, 'lib/streaming.mjs'));
  const httpMod = await import('node:http');
  const netMod = await import('node:net');
  const cryptoMod = await import('node:crypto');
  const wsServer = httpMod.createServer(() => {});
  const streaming = new Streaming({ masto: masto2, log: () => {} });
  streaming.attach(wsServer);
  await new Promise(r => wsServer.listen(18623, '127.0.0.1', r));
  const wsKey = cryptoMod.randomBytes(16).toString('base64');
  const sock = netMod.connect(18623, '127.0.0.1');
  const frames = [];
  let handshake = '';
  await new Promise((resolve) => {
    sock.on('connect', () => {
      sock.write(`GET /api/v1/streaming?access_token=${bearer}&stream=user HTTP/1.1\r\n`
        + 'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    sock.on('data', (buf) => {
      if (!handshake.includes('\r\n\r\n')) { handshake += buf.toString('latin1'); if (handshake.includes('\r\n\r\n')) resolve(); return; }
      frames.push(buf);
    });
    setTimeout(resolve, 3000);
  });
  check(/101 Switching Protocols/.test(handshake) && /Sec-WebSocket-Accept:/i.test(handshake),
    'streaming websocket handshake');
  // A fresh status through the store should arrive as an update frame.
  store2.onEvent = (type, obj) => {
    if (type === 'status') streaming.broadcast('update', masto2.status(obj));
  };
  store2.addStatus({ noteId: 'https://m.example/n/live1', actor: ALICE, content: '<p>live</p>', published: '2026-07-28T07:00:00Z', kind: 'timeline' });
  await new Promise(r => setTimeout(r, 300));
  const raw = Buffer.concat(frames.length ? frames : [Buffer.alloc(0)]);
  let text = '';
  if (raw.length > 2) {
    const len = raw[1] & 0x7f;
    text = len === 126 ? raw.slice(4).toString() : raw.slice(2).toString();
  }
  check(text.includes('"event":"update"') && text.includes('live1'),
    `streaming broadcasts new status (got ${text.slice(0, 60) || 'no frame'})`);
  sock.destroy();
  wsServer.close();
}

// --- 8b2. AP_GATE_TOKEN must cover websocket upgrades too ---
{
  const { Streaming } = await import(path.join(root, 'lib/streaming.mjs'));
  const gateMod = await import(path.join(root, 'vendor/gate.cjs'));
  const makeGate = gateMod.makeGate || gateMod.default.makeGate;
  const httpMod = await import('node:http');
  const netMod = await import('node:net');
  const cryptoMod = await import('node:crypto');
  const gsrv = httpMod.createServer(() => {});
  new Streaming({ masto: masto2, log: () => {}, gate: makeGate('gate-secret') }).attach(gsrv);
  await new Promise(r => gsrv.listen(18625, '127.0.0.1', r));
  const tryUpgrade = (extra) => new Promise((resolve) => {
    const s = netMod.connect(18625, '127.0.0.1');
    let out = '';
    const done = () => { try { s.destroy(); } catch {} resolve(out); };
    s.on('connect', () => s.write(
      `GET /api/v1/streaming?access_token=${bearer}&stream=user HTTP/1.1\r\n`
      + 'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${cryptoMod.randomBytes(16).toString('base64')}\r\n`
      + 'Sec-WebSocket-Version: 13\r\n' + extra + '\r\n'));
    s.on('data', (b) => { out += b.toString('latin1'); if (out.includes('\r\n\r\n')) done(); });
    s.on('close', () => resolve(out));
    setTimeout(done, 2000);
  });
  const noTok = await tryUpgrade('');
  check(/ 401 /.test(noTok), `a gated agent refuses an upgrade with no token (${noTok.split('\r\n')[0] || 'nothing'})`);
  const withTok = await tryUpgrade('x-dk-token: gate-secret\r\n');
  check(/101 Switching Protocols/.test(withTok), 'the same upgrade succeeds with the gate token');
  gsrv.close();
}

// --- 8b3. reattaching the store to a different tree drops the old cache ---
{
  const st = new PodStore({ log: () => {} });
  attachHttp(st, 'https://a.example/one/ap-state/', async () => new Response('', { status: 404 }));
  st.setConfig({ remotePod: 'https://a.example/', handle: 'a' });
  check(st.getConfig()?.handle === 'a', 'store holds config for the tree it is attached to');
  attachHttp(st, 'https://b.example/two/ap-state/', async () => new Response('', { status: 404 }));
  check(st.getConfig() === null, "a different tree does not inherit the previous tree's cache");
  attachHttp(st, 'https://b.example/two/ap-state/', async () => new Response('', { status: 404 }));
  st.setConfig({ remotePod: 'https://b.example/', handle: 'b' });
  check(st.getConfig()?.handle === 'b', 're-attaching the same tree keeps its cache');
}

// --- 8b4. no password + not this machine = no bearer ---
{
  const { MastoApi } = await import(path.join(root, 'lib/mastoapi.mjs'));
  const { Authorities } = await import(path.join(root, 'lib/guard.mjs'));
  const allowed = new Authorities(8030, 'me');
  const st = new PodStore({ log: () => {} });
  st.setConfig({ remotePod: 'https://p.example/', handle: 'me', name: 'me' });   // no uiPassword
  const api = new MastoApi({
    store: st, agent: { configured: () => true, store: st }, allowed,
    host: 'me.localhost:8030', log: () => {},
  });

  // The socket is part of the request the authorize path now reads: locality is
  // decided by where the connection came from as well as what Host it asked
  // for, so a fixture that models only the header models only half of it.
  const ask = async (host, remoteAddress = '127.0.0.1') => {
    const res = { status: 0, body: null, headers: null,
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
    const req = Readable.from([]);
    req.method = 'GET';
    req.headers = { host };
    req.socket = { remoteAddress };
    await api.handle(req, res, '/oauth/authorize',
      new URL('http://x/oauth/authorize?redirect_uri=urn:ietf:wg:oauth:2.0:oob'));
    return res;
  };

  // Loopback: whoever reaches it IS the user, and the instant path is honest.
  const local = await ask('localhost:8030');
  check(local.status === 200 && /"code"/.test(local.body || ''),
    'on loopback with no password, authorize still mints instantly');
  const named = await ask('me.localhost:8030');
  check(named.status === 200 && /"code"/.test(named.body || ''),
    "and on this identity's own named origin");

  // A tailnet name or reverse-proxy domain added through AP_ALLOWED_HOSTS is a
  // different matter: anyone who reaches it would be handed a 90-day bearer for
  // the whole facade, update_credentials included.
  process.env.AP_ALLOWED_HOSTS = 'agent.tailnet.example';
  allowed.rebuild();
  const remote = await ask('agent.tailnet.example');
  delete process.env.AP_ALLOWED_HOSTS;
  allowed.rebuild();
  check(remote.status === 403 && /passwd/.test(remote.body || ''),
    `an exposed address with no password is refused, and told what to run (${remote.status})`);

  // And the forgery that check used to be worth nothing against: a caller who
  // reaches an exposed agent and simply CLAIMS a loopback Host. The header is
  // the client's to write; the socket is not.
  const forgedHost = await ask('localhost:8030', '10.0.0.4');
  check(forgedHost.status === 403,
    `claiming Host: localhost from off-machine no longer mints (${forgedHost.status})`);

  // The one place the precondition is stated where it can be seen.
  const ra = fs.readFileSync(path.join(root, 'run-agent.mjs'), 'utf8');
  check(/AP_ALLOWED_HOSTS && !config\.uiPassword/.test(ra),
    'and the agent says so at startup, once the config is known');
}

// --- 8c. real OAuth when a UI password is set ---
{
  const { hashPassword } = await import(path.join(root, 'lib/mastoapi.mjs'));
  const cfg = store2.getConfig();
  store2.setConfig({ ...cfg, uiPassword: hashPassword('sesame') });
  const form = await call('/oauth/authorize?client_id=dk-ap-client&redirect_uri=http%3A%2F%2Fx%2Fcb&response_type=code&state=st1');
  check(form.status === 200 && String(form.json) === 'null', 'authorize with password set → login form (html)');
  const bad = await call('/oauth/authorize', { method: 'POST', body: 'password=wrong&redirect_uri=http%3A%2F%2Fx%2Fcb', contentType: 'application/x-www-form-urlencoded' });
  check(bad.status === 401, `wrong password → 401 form (got ${bad.status})`);
  const okRes = { status: 0, headers: null, writeHead(s, h) { this.status = s; this.headers = h; }, end() {} };
  const okReq = Readable.from([Buffer.from('password=sesame&redirect_uri=http%3A%2F%2Fx%2Fcb&state=st1')]);
  okReq.method = 'POST';
  okReq.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  await masto2.handle(okReq, okRes, '/oauth/authorize', new URL('http://x/oauth/authorize'));
  check(okRes.status === 302 && /code=/.test(okRes.headers?.location) && /state=st1/.test(okRes.headers?.location),
    'right password → 302 with code + state');
  store2.setConfig(cfg);   // clear the password for later sections
}

// --- 8d. drain lease: one active, second is viewer, expiry hands over ---
{
  const { Lease } = await import(path.join(root, 'lib/lease.mjs'));
  let doc = null;
  const memFetch = async (u, init = {}) => {
    if (init.method === 'PUT') { doc = JSON.parse(init.body); return { status: 201, text: async () => '' }; }
    return doc ? { status: 200, text: async () => JSON.stringify(doc) } : { status: 404, text: async () => '' };
  };
  const a = new Lease({ url: 'http://x/lease.json', fetchImpl: memFetch, log: () => {} });
  const b = new Lease({ url: 'http://x/lease.json', fetchImpl: memFetch, log: () => {} });
  const aGot = await a.acquire();
  const bGot = await b.acquire();
  check(aGot === true && bGot === false, 'lease: first agent active, second refused');
  doc.expiresAt = Date.now() - 1;
  check(await b.acquire() === true, 'lease: expiry hands over');

  // Takeover: a claims back while b is live; b's next renewal detects the
  // loss, fires onLost, and stops renewing.
  check(await a.takeover() === true, 'lease: takeover claims from live holder');
  let bLost = false;
  b.onLost = () => { bLost = true; };
  const bRenewed = await b.renewOnce();
  check(bRenewed === false && bLost === true && doc.holder === a.id,
    'lease: loser detects takeover at renewal and demotes');
}

// --- 8f. viewer write attempt claims the lease and proceeds ---
{
  fakeAgent.viewer = true;
  let claimed = false;
  fakeAgent.requestTakeover = async () => { claimed = true; fakeAgent.viewer = false; return true; };
  const posted = await call('/api/v1/markers', { method: 'POST', body: JSON.stringify({ home: { last_read_id: 'tk1' } }) });
  check(claimed === true && posted.status === 200, 'viewer write triggers takeover and succeeds');
  delete fakeAgent.requestTakeover;
  fakeAgent.viewer = false;
}

// --- 8e. viewer mode blocks mutations ---
{
  fakeAgent.viewer = true;
  const blocked = await call('/api/v1/statuses', { method: 'POST', body: JSON.stringify({ status: 'nope' }) });
  const allowed = await call('/api/v1/timelines/home');
  check(blocked.status === 503 && allowed.status === 200, 'viewer mode: reads ok, writes 503');
  fakeAgent.viewer = false;
}

// --- 8g. SSRF guard + sanitizer ---
{
  const { assertPublicUrl, isPrivateAddress } = await import(path.join(root, 'lib/safefetch.mjs'));
  const blocked = [];
  for (const u of ['http://127.0.0.1:8030/status', 'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/', 'http://192.168.1.1/', 'file:///etc/passwd', 'http://[::1]:8030/']) {
    blocked.push(await assertPublicUrl(u).then(() => false).catch(() => true));
  }
  check(blocked.every(Boolean), `SSRF guard blocks loopback/private/metadata/file (${blocked.filter(Boolean).length}/6)`);
  check(isPrivateAddress('127.0.0.1') && isPrivateAddress('169.254.169.254')
    && isPrivateAddress('::1') && !isPrivateAddress('93.184.216.34'),
    'address classifier: private vs public');

  // The v4-mapped spelling that actually ARRIVES. The filter matched only the
  // dotted form, which the WHATWG URL parser never produces: it normalises an
  // IPv6 literal to compressed hex, so every private v4 range was reachable by
  // writing it as `[::ffff:7f00:1]`.
  check(new URL('http://[::ffff:127.0.0.1]/x').hostname === '[::ffff:7f00:1]',
    'a v4-mapped literal reaches the filter as compressed hex, never as a dotted quad');
  const mapped = [
    ['::ffff:7f00:1', '127.0.0.1'], ['::ffff:a00:1', '10.0.0.1'],
    ['::ffff:c0a8:1', '192.168.0.1'], ['::ffff:ac10:1', '172.16.0.1'],
    ['::ffff:a9fe:a9fe', '169.254.169.254'],
  ];
  check(mapped.every(([hex]) => isPrivateAddress(hex)),
    `every private v4 range is caught in its mapped-hex spelling too (${mapped.map(m => m[1]).join(', ')})`);
  check(isPrivateAddress('::ffff:127.0.0.1'), 'and the dotted spelling still is');
  check(!isPrivateAddress('::ffff:808:808') && !isPrivateAddress('2606:4700::1111'),
    'while a mapped PUBLIC address, and ordinary v6, still pass');
  check(isPrivateAddress('fe80::1') && isPrivateAddress('fe9f::1')
    && isPrivateAddress('ff02::1') && isPrivateAddress('fec0::1'),
    'fe80::/10 is matched across all four nibbles, and multicast and site-local are refused');
  check(await assertPublicUrl('http://[::ffff:7f00:1]:8030/status').then(() => false).catch(() => true),
    'a URL naming loopback in mapped-hex form is refused');
  const pinned = await assertPublicUrl('https://mastodon.social/api/v1/instance').catch(() => null);
  check(!!pinned?.address && !isPrivateAddress(pinned.address),
    `SSRF guard allows a public host and returns its address to pin (${pinned?.address || 'none'})`);
  const { safeFetch, readCapped, pinnedFor } = await import(path.join(root, 'lib/safefetch.mjs'));
  check(typeof (await pinnedFor('https://mastodon.social/')) === 'object',
    'connection is pinned to the validated address (undici dispatcher)');
  const live = await safeFetch('https://mastodon.social/api/v1/instance').catch(() => null);
  const liveBody = live ? await readCapped(live).catch(() => '') : '';
  check(live?.status === 200 && /"uri"|"domain"/.test(liveBody), 'safeFetch reaches a real public host');
  const capped = await safeFetch('https://mastodon.social/api/v1/instance')
    .then(r => readCapped(r, 10)).then(() => false).catch(e => /exceeded|too large/.test(e.message));
  check(capped, 'response size cap enforced');

  const { sanitizeHtml } = await import(path.join(root, 'lib/wire.mjs'));
  const dirty = '<p>hi <a href="https://ok/x">link</a></p><script>alert(1)</script>'
    + '<img src=x onerror=alert(1)><a href="javascript:evil()">j</a><p onclick="evil()">t</p>';
  const clean = sanitizeHtml(dirty);
  check(!/script|onerror|onclick|javascript:/i.test(clean) && /<p>hi <a href="https:\/\/ok\/x"/.test(clean)
    && /<p>t<\/p>/.test(clean),
    `sanitizer strips scripts/handlers, keeps links (${clean.slice(0, 40)}…)`);
  // A '>' inside a quoted attribute must not end the tag, or markup can be
  // smuggled past the allowlist; comments must be consumed whole.
  const smuggle = sanitizeHtml('<a title="x>y" onload="evil()">s</a>');
  const commented = sanitizeHtml('<!--<script>alert(1)</script>--><p>after</p>');
  const spacedJs = sanitizeHtml('<a href="  javascript:alert(1)">j</a>');
  check(!/onload|evil/.test(smuggle) && !/script|alert/.test(commented)
    && /<p>after<\/p>/.test(commented) && !/javascript/.test(spacedJs),
    'sanitizer resists attribute smuggling, comment tricks, spaced javascript:');
  // Mutation-XSS: payloads that survive naive sanitizers because the
  // browser re-parses them differently. A real parser drops them entirely.
  const mx1 = sanitizeHtml('<svg><animate onbegin=alert(1)>');
  const mx2 = sanitizeHtml('<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>');
  check(!/onbegin|onerror|svg|mglyph|alert/i.test(mx1 + mx2),
    `sanitizer drops mutation-XSS payloads (${JSON.stringify(mx1 + mx2)})`);
}

// --- 8g2. inbox spam policy: strangers are mentions, not timeline ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const written2 = [];
  const spamIntake = new Intake({
    config: {}, urls: urls2, remote: {}, store: store2, deliverer: {}, publisher: {},
    local: { writeNote: async (kind, slug, n) => written2.push({ kind, slug, n }) },
    log: () => {},
  });
  const STRANGER = 'https://m.example/u/stranger';
  spamIntake.fetchAP = async (u) => ({
    id: u, type: 'Note', attributedTo: STRANGER, content: '<p>hello</p>',
    published: '2026-07-28T08:00:00Z', to: [urls2.actor],
  });
  // Addressed to us but from a stranger → mention, notified, NOT in home.
  await spamIntake.handle({ type: 'Create', actor: STRANGER, object: { id: 'https://m.example/n/s1', to: [urls2.actor] } });
  const s1 = store2.getStatuses().find(s => s.noteId === 'https://m.example/n/s1');
  const homeAfter = await call('/api/v1/timelines/home?limit=40');
  const notifs = await call('/api/v1/notifications');
  check(s1?.kind === 'mention' && !written2.length
    && !homeAfter.json.some(s => s.uri === 'https://m.example/n/s1')
    && notifs.json.some(n => n.status?.uri === 'https://m.example/n/s1'),
    'stranger addressed to us → mention (notified, out of home, not written to pod)');
  // Not addressed to us at all → refused before any dereference.
  const reason = await spamIntake.handle({
    type: 'Create', actor: STRANGER, object: { id: 'https://m.example/n/s2', to: ['https://www.w3.org/ns/activitystreams#Public'] },
  });
  check(/not addressed to us/.test(String(reason))
    && !store2.getStatuses().some(s => s.noteId === 'https://m.example/n/s2'),
    `blast-to-inboxes refused (${String(reason).slice(0, 32)})`);
  // A followed actor still lands in the timeline and the pod.
  spamIntake.fetchAP = async (u) => ({
    id: u, type: 'Note', attributedTo: 'https://m.example/u/bob', content: '<p>from bob</p>',
    published: '2026-07-28T09:00:00Z', to: ['https://www.w3.org/ns/activitystreams#Public'],
  });
  await spamIntake.handle({ type: 'Create', actor: 'https://m.example/u/bob', object: { id: 'https://m.example/n/b1' } });
  const b1 = store2.getStatuses().find(s => s.noteId === 'https://m.example/n/b1');
  check(b1?.kind === 'timeline' && written2.some(w => w.kind === 'timeline'),
    'followed actor still reaches the timeline and pod RDF');
}

// --- 8h. token expiry ---
{
  const fresh = masto2.mintToken();
  const recs = store2.read('masto-tokens.json', []);
  recs.unshift({ token: 'stale0000', createdAt: Date.now() - 200 * 24 * 3600 * 1000 });
  store2.write('masto-tokens.json', recs);
  const live = masto2.tokens();
  check(live.includes(fresh) && !live.includes('stale0000'), 'tokens: fresh kept, 200-day-old expired');
}

// --- 8i0. renaming merges into config; setup re-run keeps the password ---
{
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const home = fs.mkdtempSync('/tmp/dk-ap-name-');
  const agent = new Agent({ home, log: () => {} });
  agent.store.setConfig({ remotePod: 'https://pod.example/', handle: 'jeff', name: 'jeff',
    issuer: 'https://idp.example', uiPassword: { saltHex: 'aa', hashHex: 'bb' } });
  // The rename path (run --name) must preserve every other config field.
  const cfg = agent.store.getConfig();
  agent.store.setConfig({ ...cfg, name: 'Jeff Zucker' });
  const after = agent.store.getConfig();
  check(after.name === 'Jeff Zucker' && after.uiPassword?.hashHex === 'bb' && after.handle === 'jeff',
    'rename merges: display name changes, password and handle survive');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 8i1. an agent with no pidfile can still be stopped ---
{
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync('/tmp/dk-ap-kill-');
  const cli = path.join(root, 'bin/fedipod.mjs');
  const child3 = spawn(process.execPath, [cli, 'start', '--port', '18791'], {
    cwd: root, env: { ...process.env, AP_HOME: home }, stdio: 'ignore',
  });
  const listening = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = async () => {
      try { await fetch('http://127.0.0.1:18791/status'); return resolve(true); } catch {}
      if (Date.now() - t0 > 10_000) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
  fs.rmSync(path.join(home, 'agent.pid'), { force: true });     // orphan it
  let out = '';
  try {
    out = execFileSync(process.execPath, [cli, 'stop', '--port', '18791'],
      { env: { ...process.env, AP_HOME: home } }).toString();
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const stopped = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = async () => {
      try { await fetch('http://127.0.0.1:18791/status'); } catch { return resolve(true); }
      if (Date.now() - t0 > 8000) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
  check(listening && stopped && /asked to stop/.test(out),
    'an agent with no pidfile is still stoppable (POST /shutdown)');
  child3.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 8i2. `start` takes over from an agent already on the port ---
{
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync('/tmp/dk-ap-replace-');
  const cli = path.join(root, 'bin/fedipod.mjs');
  const first = spawn(process.execPath, [cli, 'start', '--port', '18796'], {
    cwd: root, env: { ...process.env, AP_HOME: home }, stdio: 'ignore',
  });
  const up1 = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = async () => {
      try { await fetch('http://127.0.0.1:18796/status'); return resolve(true); } catch {}
      if (Date.now() - t0 > 10_000) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
  // Without --replace and without a tty it must refuse rather than crash.
  let refused = '';
  try { execFileSync(process.execPath, [cli, 'start', '--port', '18796'], { env: { ...process.env, AP_HOME: home }, stdio: 'pipe' }); }
  catch (e) { refused = String(e.stderr || ''); }
  // With --replace it stops the incumbent and serves in its place.
  const second = spawn(process.execPath, [cli, 'start', '--port', '18796', '--replace'], {
    cwd: root, env: { ...process.env, AP_HOME: home }, stdio: 'ignore',
  });
  const served = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = async () => {
      const ok = await fetch('http://127.0.0.1:18796/status').then(r => r.ok).catch(() => false);
      if (ok && Date.now() - t0 > 4000) return resolve(true);      // survived the handover
      if (Date.now() - t0 > 15_000) return resolve(ok);
      setTimeout(tick, 400);
    };
    tick();
  });
  check(up1 && /already running/.test(refused) && /--replace/.test(refused) && served,
    'start refuses a busy port, and --replace takes it over');
  try { execFileSync(process.execPath, [cli, 'stop', '--port', '18796'], { env: { ...process.env, AP_HOME: home } }); } catch {}
  first.kill('SIGKILL'); second.kill('SIGKILL');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 8i. the port chosen at setup is remembered by later commands ---
{
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync('/tmp/dk-ap-port-');
  const cli = path.join(root, 'bin/fedipod.mjs');
  const child2 = spawn(process.execPath, [cli, 'start', '--port', '18778'], {
    cwd: root, env: { ...process.env, AP_HOME: home }, stdio: 'ignore', detached: false,
  });
  const upPort = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = async () => {
      try { await fetch('http://127.0.0.1:18778/status'); return resolve(true); } catch {}
      if (Date.now() - t0 > 10_000) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
  const recorded = JSON.parse(fs.readFileSync(path.join(home, 'agent.json'), 'utf8')).port;
  // status with NO --port must still find it, proving the record is used.
  const out = execFileSync(process.execPath, [cli, 'status'], { env: { ...process.env, AP_HOME: home } }).toString();
  check(upPort && recorded === 18778 && /"configured"/.test(out),
    `port persisted at first run and reused without a flag (recorded ${recorded})`);
  try { execFileSync(process.execPath, [cli, 'stop'], { env: { ...process.env, AP_HOME: home } }); } catch {}
  child2.kill('SIGTERM');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- 8j. install-service speaks each platform's own language ---
{
  const { execFileSync } = await import('node:child_process');
  const say = (plat) => execFileSync(process.execPath, ['-e', `
    Object.defineProperty(process, 'platform', { value: '${plat}' });
    process.argv = [process.argv[0], 'bin/fedipod.mjs', 'install-service'];
    await import('${path.join(root, 'bin/fedipod.mjs')}');
  `, '--input-type=module'], { cwd: root }).toString();
  const android = say('android');
  const other = say('freebsd');
  check(/Termux:Boot/.test(android) && /termux-wake-lock/.test(android) && !/Windows|Scheduled Task/.test(android),
    'install-service gives Termux the boot/wake-lock recipe, not Windows advice');
  check(/no service integration for platform "freebsd"/.test(other) && /run-agent\.mjs/.test(other),
    'unknown platforms get a runnable command, not wrong instructions');
}

// --- 9. --new-account flow vs a mock CSS v7 account API ---
const { createAccountWithPod } = await import(path.join(root, 'lib/account.mjs'));
const http = await import('node:http');
const seen9 = [];
// Stateful on purpose: an account with no pod may create one, an account that
// already has one may only reuse it. Both are real states of the same server.
let ownedPods9 = {};
const mockCss = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  seen9.push({ method: req.method, url: req.url, body });
  const send9 = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/.account/login/password/') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{}'); return; }
  if (req.url === '/.account/account/' && req.method === 'POST') return send9({ authorization: 'AUTH1' });
  if (req.url === '/.account/' && req.method === 'GET') {
    return send9({ controls: { password: { create: `http://127.0.0.1:18622/.account/password/` },
      account: { pod: `http://127.0.0.1:18622/.account/pod/` } } });
  }
  if (req.url === '/.account/password/') return send9({ ok: true });
  if (req.url === '/.account/pod/' && req.method === 'POST') {
    if (body.includes('takenpod') || body.includes('subpod')) {
      // What a real CSS says on a re-run after a crashed setup.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"message":"…/profile/card#me is already registered to this account."}'); return;
    }
    return send9({ pod: 'http://127.0.0.1:18622/newpod/', webId: 'http://127.0.0.1:18622/newpod/profile/card#me' });
  }
  if (req.url === '/.account/pod/' && req.method === 'GET') return send9({ pods: ownedPods9 });
  res.writeHead(404); res.end();
});
await new Promise(r => mockCss.listen(18622, '127.0.0.1', r));
const made9 = await createAccountWithPod({
  issuer: 'http://127.0.0.1:18622', email: 'x@example.org', password: 'pw', podName: 'newpod',
});
check(made9.pod === 'http://127.0.0.1:18622/newpod/' && /card#me$/.test(made9.webId),
  '--new-account drives account→password→pod creation');
check(seen9.some(r => r.url === '/.account/password/' && r.body.includes('"pw"'))
  && seen9.some(r => r.url === '/.account/pod/' && r.body.includes('"newpod"')),
  'account API got password + pod name');
// From here the account owns pods — which is what makes the next two a reuse
// rather than a create, and any other name a refusal.
ownedPods9 = {
  'http://127.0.0.1:18622/takenpod/': 'http://127.0.0.1:18622/.account/pod/x',
  'http://subpod.127.0.0.1.nip.io:18622/': 'http://127.0.0.1:18622/.account/pod/y',
};
const reused = await createAccountWithPod({
  issuer: 'http://127.0.0.1:18622', email: 'x@example.org', password: 'pw', podName: 'takenpod',
});
check(reused.pod === 'http://127.0.0.1:18622/takenpod/' && /card#me$/.test(reused.webId),
  'existing own pod is reused, not an error');
// Found live: the subdomain branch matched `https://name.` only, so on an http
// server a re-run after a crashed setup always tried to create again and 400'd.
const reusedSub = await createAccountWithPod({
  issuer: 'http://127.0.0.1:18622', email: 'x@example.org', password: 'pw', podName: 'subpod',
});
check(reusedSub.pod === 'http://subpod.127.0.0.1.nip.io:18622/',
  `an existing SUBDOMAIN pod is reused whatever the scheme (${reusedSub.pod})`);
mockCss.close();

// --- 9. group actor: the Group type, and members-only amplification ---
// (Intake is already imported for section 8.)

const gUrls = wire.apUrls('https://grp.example/');
const gOutbox = [];   // what the group's stub publisher recorded
check(wire.actorDoc({ urls: gUrls, handle: 'g', publicKeyPem: 'K' }).type === 'Person'
  && wire.actorDoc({ urls: gUrls, handle: 'g', publicKeyPem: 'K', kind: 'person' }).type === 'Person'
  && wire.actorDoc({ urls: gUrls, handle: 'g', publicKeyPem: 'K', kind: 'group' }).type === 'Group',
  'actorDoc publishes Group only when the kind says so');

const MEM_A = 'https://a.example/u/ann';
const MEM_B = 'https://b.example/u/bo';
const MEM_C = 'https://b.example/u/cy';        // shares b.example's shared inbox with bo
const STRANGER = 'https://s.example/u/sam';
const B_SHARED = 'https://b.example/inbox';

function groupIntake({ kind = 'group', following = [] } = {}) {
  const st = new PodStore({ log: () => {} });
  st.setConfig({ remotePod: 'https://grp.example/', handle: 'grp', name: 'grp', kind });
  st.setContacts({
    followers: [
      { actor: MEM_A, inbox: MEM_A + '/inbox' },
      { actor: MEM_B, inbox: MEM_B + '/inbox', sharedInbox: B_SHARED },
      { actor: MEM_C, inbox: MEM_C + '/inbox', sharedInbox: B_SHARED },
    ],
    following,
  });
  const sent = [];
  const notes = {};
  const intake = new Intake({
    config: st.getConfig(), urls: gUrls, store: st, log: () => {},
    remote: { getJson: async () => null },
    local: { writeNote: async () => {} },
    deliverer: {
      deliver: async (inbox, a) => sent.push({ inboxes: [inbox], a }),
      deliverToAll: async (inboxes, a) => sent.push({ inboxes, a }),
    },
    publisher: { urls: gUrls, publishCollections: async () => {},
      recordOutbox: async (i) => { gOutbox.unshift(i); },
      unrecordOutbox: async (m) => {
        for (let k = gOutbox.length - 1; k >= 0; k--) if (m(gOutbox[k])) gOutbox.splice(k, 1);
      } },
  });
  intake.fetchAP = async (u) => notes[u] || null;
  return { st, intake, sent, notes };
}
const gPost = (id, author) => ({
  id, type: 'Note', attributedTo: author, content: '<p>hi</p>',
  published: '2026-07-29T10:00:00Z', to: [wire.PUBLIC], cc: [gUrls.actor],
});
const gCreate = (note) => ({ id: note.id + '#create', type: 'Create', actor: note.attributedTo, object: note });
const announces = (sent) => sent.filter(x => x.a.type === 'Announce');

{
  const { st, intake, sent, notes } = groupIntake();
  const n = gPost(MEM_A + '/n/1', MEM_A);
  notes[n.id] = n;
  const r = await intake.onCreate(gCreate(n), MEM_A);
  const ann = announces(sent)[0];
  check(!r && ann && ann.a.actor === gUrls.actor && ann.a.object?.type === 'Create'
  && ann.a.object.object?.id === n.id,
    `a member's post is carried as a wrapped Create, per FEP-1b12 (rejected: ${r || 'no'})`);
  check(JSON.stringify(ann.a.object) === JSON.stringify(gCreate(n)),
    'the wrapped activity is preserved exactly as delivered');
  check(ann && ann.inboxes.length === 1 && ann.inboxes[0] === B_SHARED,
    `the author's own solo inbox is dropped (${JSON.stringify(ann?.inboxes)})`);
  check(!!st.getStatuses().find(s => s.noteId === n.id)?.announcedAt,
    'the announcement is recorded on the status');
  check(st.getStatuses().find(s => s.noteId === n.id)?.kind === 'timeline'
    && !st.getNotifications().length,
    "a member's post is the group's timeline, not a stranger's mention");
  await intake.amplify(n.id);
  check(announces(sent).length === 1, 're-delivery of the same Create announces once');
  // What a group carries is the whole of what it says, so its outbox is the
  // only public record of the community's feed.
  check(gOutbox.some(i => i?.type === 'Announce'),
    "the group's carry is recorded in its outbox");
}
{
  // The author shares b.example's inbox with another member, so that target must
  // survive — dropping it would deprive the co-tenant.
  const { intake, sent, notes } = groupIntake();
  const n = gPost(MEM_B + '/n/1', MEM_B);
  notes[n.id] = n;
  await intake.onCreate(gCreate(n), MEM_B);
  const ann = announces(sent)[0];
  check(ann && ann.inboxes.length === 2 && ann.inboxes.includes(B_SHARED)
    && ann.inboxes.includes(MEM_A + '/inbox'),
    `a shared inbox is kept even when the author is on it (${JSON.stringify(ann?.inboxes)})`);
}
{
  const { st, intake, sent, notes } = groupIntake();
  const n = gPost(STRANGER + '/n/1', STRANGER);
  notes[n.id] = n;
  const r = await intake.onCreate(gCreate(n), STRANGER);
  check(!r && !announces(sent).length && !!st.getStatuses().find(s => s.noteId === n.id),
    'a non-member post is ingested but never announced');
  check(st.getStatuses().find(s => s.noteId === n.id)?.kind === 'mention'
    && st.getNotifications().some(x => x.type === 'mention' && x.actor === STRANGER),
    'a stranger posting at the group is still a mention the operator sees');
}
{
  const { st, intake, sent, notes } = groupIntake();
  st.setMuted({ actors: [MEM_A] });
  const n = gPost(MEM_A + '/n/2', MEM_A);
  notes[n.id] = n;
  await intake.onCreate(gCreate(n), MEM_A);
  check(!announces(sent).length, 'a muted member is ingested but not amplified');
}
{
  // A member DMing the group addressed it to the group alone; a followers-only
  // post it received addressed the author's followers. Neither is public, and
  // carrying either would widen the author's audience for them.
  const { st, intake, sent, notes } = groupIntake();
  const dm = { ...gPost(MEM_A + '/n/3', MEM_A), to: [gUrls.actor], cc: [] };
  notes[dm.id] = dm;
  await intake.onCreate(gCreate(dm), MEM_A);
  check(!announces(sent).length && !!st.getStatuses().find(s => s.noteId === dm.id),
    'a DM to the group is kept but never announced');
  const fo = { ...gPost(MEM_A + '/n/4', MEM_A), to: [MEM_A + '/followers'], cc: [gUrls.actor] };
  notes[fo.id] = fo;
  await intake.onCreate(gCreate(fo), MEM_A);
  check(!announces(sent).length,
    'a followers-only post the group received is never announced either');
}
{
  // An inbound Announce must not re-enter the fan-out. The group follows MEM_A
  // here only so onAnnounce gets past its own followed-actor gate.
  const { intake, sent, notes } = groupIntake({
    following: [{ actor: MEM_A, inbox: MEM_A + '/inbox', accepted: true }],
  });
  const n = gPost(STRANGER + '/n/9', STRANGER);
  notes[n.id] = n;
  await intake.onAnnounce({ id: MEM_A + '#a1', type: 'Announce', object: n.id }, MEM_A, n.id);
  check(!announces(sent).length, 'an inbound Announce is not re-announced');
}
{
  const { intake, sent, notes } = groupIntake({ kind: 'person' });
  const n = gPost(MEM_A + '/n/3', MEM_A);
  notes[n.id] = n;
  await intake.onCreate(gCreate(n), MEM_A);
  check(!announces(sent).length, 'a person never amplifies, only a group does');
}

// --- 9b. eject, retract, hold for review ---
const { ejectFollower, retractAnnouncement } = await import(path.join(root, 'lib/social.mjs'));
const groupAgent = ({ st, intake, sent }) => ({
  store: st, intake, publisher: { urls: gUrls, publishCollections: async () => {},
      recordOutbox: async (i) => { gOutbox.unshift(i); },
      unrecordOutbox: async (m) => {
        for (let k = gOutbox.length - 1; k >= 0; k--) if (m(gOutbox[k])) gOutbox.splice(k, 1);
      } },
  deliverer: {
    deliver: async (inbox, a) => sent.push({ inboxes: [inbox], a }),
    deliverToAll: async (inboxes, a) => sent.push({ inboxes, a }),
  },
});
{
  const g = groupIntake();
  g.st.setContacts({
    followers: g.st.getContacts().followers.map(f =>
      (f.actor === MEM_A ? { ...f, followId: MEM_A + '#follow-1' } : f)),
    following: [],
  });
  const r = await ejectFollower(groupAgent(g), MEM_A);
  const rej = g.sent.find(x => x.a.type === 'Reject');
  check(r.ok && rej && rej.a.object.id === MEM_A + '#follow-1' && rej.a.object.type === 'Follow'
    && rej.inboxes[0] === MEM_A + '/inbox',
    'eject sends a Reject naming their Follow, to their own inbox');
  check(!g.st.getContacts().followers.some(f => f.actor === MEM_A)
    && g.st.getMuted().actors.includes(MEM_A),
    'eject drops them from followers and mutes them so a re-follow carries nothing');
  let threw = null;
  await ejectFollower(groupAgent(g), MEM_A).catch(e => { threw = e.message; });
  check(threw === 'not a member', `ejecting a non-member is refused (${threw})`);
}
{
  const g = groupIntake();
  const n = gPost(MEM_B + '/n/7', MEM_B);
  g.notes[n.id] = n;
  await g.intake.onCreate(gCreate(n), MEM_B);
  const announced = announces(g.sent)[0];
  const r = await retractAnnouncement(groupAgent(g), n.id);
  const undo = g.sent.find(x => x.a.type === 'Undo');
  check(r.ok && undo && undo.a.object.type === 'Announce'
  && undo.a.object.object?.object?.id === n.id,
    'retract sends an Undo of the original Announce');
  check(JSON.stringify(undo.inboxes) === JSON.stringify(announced.inboxes),
    `the Undo reaches exactly who the Announce did (${JSON.stringify(undo.inboxes)})`);
  const after = g.st.getStatuses().find(s => s.noteId === n.id);
  check(!after.announcedAt && !!after.retractedAt, 'the status records the retraction');
  let threw = null;
  await retractAnnouncement(groupAgent(g), n.id).catch(e => { threw = e.message; });
  check(threw === 'that post was never carried', `retracting twice is refused (${threw})`);
}
{
  const g = groupIntake();
  g.st.setConfig({ ...g.st.getConfig(), review: true });
  g.intake.config = g.st.getConfig();
  const n = gPost(MEM_A + '/n/8', MEM_A);
  g.notes[n.id] = n;
  await g.intake.onCreate(gCreate(n), MEM_A);
  check(!announces(g.sent).length && g.st.getPending().some(p => p.noteId === n.id),
    'a reviewed group holds a member post instead of carrying it');
  await g.intake.onCreate(gCreate(n), MEM_A);
  check(g.st.getPending().filter(p => p.noteId === n.id).length === 1,
    'a re-delivered Create is held once, not twice');
  await g.intake.amplify(n.id, { approved: true });
  check(announces(g.sent).length === 1 && !g.st.getPending().length,
    'approving carries it and clears the queue');
}
{
  // Full REFUSES the newest; it used to unshift and slice, so one member
  // posting 500 notes silently discarded everything the operator was still
  // deciding about — never carried, never refused, no record they arrived.
  const g = groupIntake();
  g.st.setConfig({ ...g.st.getConfig(), review: true });
  g.intake.config = g.st.getConfig();
  const oldest = 'https://member.example/n/OLDEST';
  g.st.setPending([{ noteId: oldest, actor: MEM_A, at: '2026-01-01T00:00:00Z' },
    ...Array.from({ length: 499 }, (_, i) => ({ noteId: `https://member.example/n/${i}`, actor: MEM_A }))]);
  const n = gPost(MEM_A + '/n/flood', MEM_A);
  g.notes[n.id] = n;
  await g.intake.onCreate(gCreate(n), MEM_A);
  const pend = g.st.getPending();
  check(pend.length === 500 && pend.some(p => p.noteId === oldest),
    `a full review queue keeps what the operator was deciding about (${pend.length})`);
  check(!pend.some(p => p.noteId === n.id) && !announces(g.sent).length,
    'and the post that would have pushed it out is refused, not carried');
}
{
  const g = groupIntake();
  g.st.setConfig({ ...g.st.getConfig(), review: true });
  g.intake.config = g.st.getConfig();
  const n = gPost(STRANGER + '/n/8', STRANGER);
  g.notes[n.id] = n;
  await g.intake.onCreate(gCreate(n), STRANGER);
  check(!g.st.getPending().length,
    'review does not queue non-members — they were never going to be carried');
}

// --- 9b2. upstream Delete and Update, verified at the origin ---
function personIntake({ statuses = [], followers = [], origin = {} } = {}) {
  const st = new PodStore({ log: () => {} });
  st.setConfig({ remotePod: 'https://grp.example/', handle: 'me', name: 'me' });
  st.setContacts({ followers, following: [] });
  st.write('statuses.json', statuses);
  const sent = [];
  const wrote = [];
  const intake = new Intake({
    config: st.getConfig(), urls: gUrls, store: st, log: () => {},
    remote: { getJson: async () => null },
    local: {
      fedi: gUrls.fediverse,
      writeNote: async (k, slug, rec) => wrote.push({ k, slug, rec }),
      delete: async (u) => wrote.push({ deleted: u }),
    },
    deliverer: {
      deliver: async (i, a) => sent.push({ inboxes: [i], a }),
      deliverToAll: async (i, a) => sent.push({ inboxes: i, a }),
      // `origin` maps url → {status, body}; anything unlisted is unreachable.
      signedFetch: async (u) => {
        const r = origin[u];
        if (!r) throw new Error('unreachable');
        return { status: r.status, text: async () => JSON.stringify(r.body || {}),
          headers: new Map(), body: null, json: async () => r.body };
      },
    },
    publisher: { urls: gUrls, publishCollections: async () => {},
      recordOutbox: async (i) => { gOutbox.unshift(i); },
      unrecordOutbox: async (m) => {
        for (let k = gOutbox.length - 1; k >= 0; k--) if (m(gOutbox[k])) gOutbox.splice(k, 1);
      } },
  });
  return { st, intake, sent, wrote };
}
const NOTE = 'https://a.example/u/ann/n/1';
{
  const p = personIntake({
    statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline', slug: 'd1' }],
    origin: { [NOTE]: { status: 410 } },
  });
  const r = await p.intake.onDelete({ type: 'Delete', object: NOTE }, MEM_A);
  check(!r && !p.st.getStatuses().length && p.wrote.some(w => w.deleted?.endsWith('timeline/d1')),
    'a confirmed upstream Delete drops the post and its pod-RDF copy');
}
{
  const p = personIntake({
    statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline' }],
    origin: { [NOTE]: { status: 200, body: { id: NOTE, type: 'Note', content: 'still here' } } },
  });
  const r = await p.intake.onDelete({ type: 'Delete', object: NOTE }, MEM_A);
  check(/still published/.test(r || '') && p.st.getStatuses().length === 1,
    `a Delete for something still live is refused (${r})`);
}
{
  const p = personIntake({ statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline' }] });
  let threw = null;
  await p.intake.onDelete({ type: 'Delete', object: NOTE }, MEM_A).catch(e => { threw = e.message; });
  check(/will retry/.test(threw || '') && p.st.getStatuses().length === 1,
    'an origin we cannot reach is a retry, never a deletion');
}
{
  const p = personIntake({
    statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline' }],
    origin: { [NOTE]: { status: 410 } },
  });
  const r = await p.intake.onDelete({ type: 'Delete', object: NOTE }, STRANGER);
  check(/crosses origins/.test(r || '') && p.st.getStatuses().length === 1,
    `a forged Delete from another origin is refused (${r})`);
}
{
  // A group that carried the post unsays its own Announce rather than
  // forwarding a Delete it cannot sign for.
  const p = personIntake({
    statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline',
      announcedAt: 'x', announceActivity: { type: 'Announce', object: { id: NOTE } } }],
    followers: [{ actor: MEM_B, inbox: MEM_B + '/inbox' }],
    origin: { [NOTE]: { status: 404 } },
  });
  await p.intake.onDelete({ type: 'Delete', object: NOTE }, MEM_A);
  check(p.sent.some(x => x.a.type === 'Undo' && x.a.object.type === 'Announce'),
    'a group retracts its Announce when the author deletes the post');
}
{
  const p = personIntake({
    followers: [{ actor: MEM_A, inbox: MEM_A + '/inbox' }],
    statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline' }],
    origin: { [MEM_A]: { status: 410 } },
  });
  await p.intake.onDelete({ type: 'Delete', object: MEM_A }, MEM_A);
  check(!p.st.getContacts().followers.length && !p.st.getStatuses().length,
    'a deleted account is dropped from followers along with its posts');
}
{
  // Seen live: Mastodon broadcasts account deletions constantly. Treating
  // `object === actor` as "known" meant a signed dereference to a stranger's
  // server for every one of them.
  const STRANGER_ACCT = 'https://mastodon.social/ap/users/116689105238854754';
  let asked = 0;
  const p = personIntake({ origin: { [STRANGER_ACCT]: { status: 410 } } });
  const realFetch = p.intake.deliverer.signedFetch;
  p.intake.deliverer.signedFetch = async (u) => { asked++; return realFetch(u); };
  const r = await p.intake.onDelete({ type: 'Delete', object: STRANGER_ACCT }, STRANGER_ACCT);
  check(!r && asked === 0,
    `an account-delete for someone we never knew costs no request (asked ${asked})`);
}
{
  const edited = { id: NOTE, type: 'Note', content: '<p>edited</p>', published: '2026-07-30T00:00:00Z' };
  const p = personIntake({
    statuses: [{ noteId: NOTE, actor: MEM_A, kind: 'timeline', slug: 'e1', content: '<p>old</p>' }],
    origin: { [NOTE]: { status: 200, body: edited } },
  });
  await p.intake.onUpdate({ type: 'Update', object: { id: NOTE } }, MEM_A);
  const s = p.st.getStatuses()[0];
  check(s.content === '<p>edited</p>' && !!s.editedAt
    && p.wrote.some(w => w.slug === 'e1' && w.rec?.content === '<p>edited</p>'),
    'an upstream edit is refetched at the origin and rewritten locally');
}
{
  // A follower, because that is the only way an Update{Person} for them
  // legitimately arrives — and, since onUpdate gained onDelete's known-actor
  // guard, the only way it is acted on rather than dropped unread.
  const p = personIntake({
    followers: [{ actor: MEM_A, inbox: MEM_A + '/inbox' }],
    origin: { [MEM_A]: { status: 200, body: { id: MEM_A, type: 'Person', preferredUsername: 'ann', name: 'Ann Renamed' } } },
  });
  await p.intake.onUpdate({ type: 'Update', object: { id: MEM_A } }, MEM_A);
  check(p.st.getActors()[MEM_A]?.name === 'Ann Renamed',
    'Update{Person} refreshes the cached profile instead of going stale forever');
}
{
  // The same activity from someone we have never heard of. Mastodon broadcasts
  // a great many Updates, and anyone at all can Append one naming any host.
  let asked = 0;
  const p = personIntake({
    origin: { [MEM_A]: { status: 200, body: { id: MEM_A, type: 'Person', name: 'Whoever' } } },
  });
  const realFetch = p.intake.deliverer.signedFetch;
  p.intake.deliverer.signedFetch = async (u) => { asked++; return realFetch(u); };
  await p.intake.onUpdate({ type: 'Update', object: { id: MEM_A } }, MEM_A);
  check(asked === 0 && !p.st.getActors()[MEM_A],
    `an Update{Person} for someone we never knew costs no request (asked ${asked})`);
}
{
  const parent = gUrls.notes + 'p1';
  const reply = {
    id: 'https://a.example/u/mei/n/5', type: 'Note', attributedTo: MEM_A,
    content: 'nice one', published: '2026-07-30T00:00:00Z', inReplyTo: parent,
  };
  const p = personIntake({ origin: { [reply.id]: { status: 200, body: reply } } });
  const puts = {};
  p.intake.remote = { getJson: async (u) => puts[u] || null, putJson: async (u, b) => { puts[u] = b; } };
  // The parent has to be a post we actually made — that is what stops a
  // stranger naming an invented note under our own prefix.
  p.st.addStatus({ noteId: parent, kind: 'post', actor: gUrls.actor });
  await p.intake.ingestNote(reply.id, MEM_A);
  check(puts[parent + '-replies']?.items?.includes(reply.id),
    "a reply to one of our notes lands in that note's replies collection end to end");
}

// --- 9b3. group threads: replies reach the group and keep reaching it ---
const GTAG = { type: 'Mention', href: gUrls.actor, name: '@grp@grp.example' };
{
  // A reply that kept the group's mention is carried, as Mastodon's own
  // reply-prefill behavior makes the common case.
  const g = groupIntake();
  const parent = gPost(MEM_A + '/n/20', MEM_A);
  const reply = {
    ...gPost(MEM_B + '/n/21', MEM_B), inReplyTo: parent.id, tag: [GTAG],
    cc: [gUrls.actor],
  };
  g.notes[parent.id] = parent; g.notes[reply.id] = reply;
  await g.intake.onCreate(gCreate(parent), MEM_A);
  await g.intake.onCreate(gCreate(reply), MEM_B);
  check(announces(g.sent).length === 2, 'a reply that keeps the group mention is carried like any post');
  check(g.st.getStatuses().find(s => s.noteId === reply.id)?.mentions?.[0]?.href === gUrls.actor,
    "the thread's mentions are remembered on the status");
}
{
  // And one that lost it: addressed to nobody the group can see, but replying
  // to something the group carried.
  const g = groupIntake();
  const parent = gPost(MEM_A + '/n/22', MEM_A);
  const stripped = {
    id: MEM_B + '/n/23', type: 'Note', attributedTo: MEM_B, content: '<p>hm</p>',
    published: 'p', inReplyTo: parent.id, to: [wire.PUBLIC], cc: [],
  };
  g.notes[parent.id] = parent; g.notes[stripped.id] = stripped;
  await g.intake.onCreate(gCreate(parent), MEM_A);
  const r = await g.intake.onCreate(gCreate(stripped), MEM_B);
  check(!r && announces(g.sent).length === 2,
    `a reply that lost the mention is still carried, because the group owns the thread (${r || 'ok'})`);
}
{
  // A person must NOT inherit that: replying to anything in my timeline would
  // otherwise be a way into my inbox.
  const g = groupIntake({ kind: 'person' });
  g.st.write('statuses.json', [{ noteId: 'https://x.example/n/1', actor: MEM_A, kind: 'timeline' }]);
  const stray = {
    id: STRANGER + '/n/1', type: 'Note', attributedTo: STRANGER, content: '<p>hi</p>',
    published: 'p', inReplyTo: 'https://x.example/n/1', to: [wire.PUBLIC], cc: [],
  };
  g.notes[stray.id] = stray;
  const r = await g.intake.onCreate(gCreate(stray), STRANGER);
  check(/not addressed to us/.test(r || ''),
    `a person still refuses a reply to someone else's post (${r})`);
}

// --- 9b4. the round trip: what a group sends, a member must be able to read ---
// Found live: amplify's shape and onAnnounce's guard were each tested alone, so
// nobody noticed a member dead-letters every post its own group carries.
{
  const g = groupIntake();
  const n = gPost(MEM_A + '/n/30', MEM_A);
  g.notes[n.id] = n;
  await g.intake.onCreate(gCreate(n), MEM_A);
  const carried = announces(g.sent)[0].a;          // exactly what goes on the wire

  // Now a member receiving it, with the group followed.
  const m = groupIntake({
    kind: 'person',
    following: [{ actor: gUrls.actor, inbox: gUrls.inbox, accepted: true }],
  });
  m.notes[n.id] = n;
  const r = await m.intake.handle({ ...carried, actor: gUrls.actor });
  check(!r && m.st.getStatuses().some(s => s.noteId === n.id),
    `a member ingests the note out of a wrapped Announce (rejected: ${r || 'no'})`);
  check(m.st.getStatuses().find(s => s.noteId === n.id)?.kind === 'timeline',
    'and it lands in their timeline, not as a mention');
}

// --- 9c. request-to-join, optional like post review ---
const { admitRequest, refuseRequest } = await import(path.join(root, 'lib/social.mjs'));
{
  const open = wire.actorDoc({ urls: gUrls, handle: 'g', publicKeyPem: 'K', kind: 'group' });
  const gated = wire.actorDoc({ urls: gUrls, handle: 'g', publicKeyPem: 'K', kind: 'group', approveJoins: true });
  check(open.manuallyApprovesFollowers === undefined
    && !JSON.stringify(open['@context']).includes('manuallyApprovesFollowers'),
    'an open group advertises nothing about approving followers');
  const tPerson = wire.tombstoneDoc(gUrls, 'x');
  const tGroup = wire.tombstoneDoc(gUrls, 'x', 'group');
  check(tPerson.formerType === 'Person' && tGroup.formerType === 'Group',
    `a retired group leaves a Group tombstone, not a Person one (${tGroup.formerType})`);
  check(gated.manuallyApprovesFollowers === true
    && gated['@context'].some(c => c?.manuallyApprovesFollowers === 'as:manuallyApprovesFollowers'),
    'a gated group advertises manuallyApprovesFollowers, declared inline as Mastodon does');
  check(String(gated.featured || '').endsWith('ap/featured')
    && gated['@context'].some(c => c?.toot && c?.featured),
    'the actor names its featured collection, with the term declared');
}
{
  const g = groupIntake();
  g.st.setConfig({ ...g.st.getConfig(), approveJoins: true });
  g.intake.config = g.st.getConfig();
  const NEWBIE = 'https://c.example/u/cass';
  g.intake.fetchAP = async (u) => (u === NEWBIE
    ? { id: NEWBIE, type: 'Person', inbox: NEWBIE + '/inbox' } : g.notes[u] || null);
  const follow = { id: NEWBIE + '#follow-1', type: 'Follow', actor: NEWBIE, object: gUrls.actor };
  await g.intake.onFollow(follow, NEWBIE);
  check(!g.sent.some(x => x.a.type === 'Accept') && !g.sent.some(x => x.a.type === 'Reject'),
    'a gated group answers a Follow with neither Accept nor Reject');
  check(g.st.getRequests().some(r => r.actor === NEWBIE)
    && !g.st.getContacts().followers.some(f => f.actor === NEWBIE),
    'the Follow is queued and they are not a member yet');
  await g.intake.onFollow(follow, NEWBIE);
  check(g.st.getRequests().filter(r => r.actor === NEWBIE).length === 1,
    'a re-delivered Follow queues once');

  await admitRequest(groupAgent(g), NEWBIE);
  const acc = g.sent.find(x => x.a.type === 'Accept');
  check(acc && acc.a.object.id === follow.id && acc.inboxes[0] === NEWBIE + '/inbox'
    && g.st.getContacts().followers.some(f => f.actor === NEWBIE) && !g.st.getRequests().length,
    'admit accepts the original Follow and makes them a member');

  const OTHER = 'https://d.example/u/dee';
  g.intake.fetchAP = async (u) => (u === OTHER
    ? { id: OTHER, type: 'Person', inbox: OTHER + '/inbox' } : null);
  await g.intake.onFollow({ id: OTHER + '#f', type: 'Follow', actor: OTHER, object: gUrls.actor }, OTHER);
  await refuseRequest(groupAgent(g), OTHER);
  check(g.sent.some(x => x.a.type === 'Reject' && x.a.object.id === OTHER + '#f')
    && !g.st.getRequests().length && !g.st.getContacts().followers.some(f => f.actor === OTHER),
    'refuse sends a Reject and leaves them out');

  // Withdrawing before an answer must clear the queue, or it asks forever
  // about someone who left.
  await g.intake.onFollow({ id: OTHER + '#f2', type: 'Follow', actor: OTHER, object: gUrls.actor }, OTHER);
  await g.intake.onUndo({ type: 'Undo', object: { id: OTHER + '#f2', type: 'Follow' } }, OTHER);
  check(!g.st.getRequests().length, 'a withdrawn request drops out of the queue');
}
{
  const g = groupIntake();                       // approveJoins off
  const NEWBIE = 'https://c.example/u/cass';
  g.intake.fetchAP = async () => ({ id: NEWBIE, type: 'Person', inbox: NEWBIE + '/inbox' });
  await g.intake.onFollow({ id: NEWBIE + '#f', type: 'Follow', actor: NEWBIE, object: gUrls.actor }, NEWBIE);
  check(g.sent.some(x => x.a.type === 'Accept') && !g.st.getRequests().length
    && g.st.getContacts().followers.some(f => f.actor === NEWBIE),
    'an open group still admits anyone at once — the gate is opt-in');
}

// --- 10. a group agent serves the group admin API and no client ---
{
  const { startAdmin } = await import(path.join(root, 'lib/admin.mjs'));
  const GPORT = 18624;
  const GHOME = fs.mkdtempSync('/tmp/fedipod-group-');
  // A set-up group: without the credential FILE the bare URL is a trip to
  // setup, which is right and is not what the checks below are about.
  fs.writeFileSync(path.join(GHOME, 'credential.json'),
    JSON.stringify({ remotePod: 'https://grp.example/', id: 'x', secret: 'y' }));
  const gstore = new PodStore({ log: () => {} });
  gstore.setConfig({ remotePod: 'https://grp.example/', handle: 'grp', name: 'grp', kind: 'group' });
  gstore.setContacts({ followers: [{ actor: MEM_A, inbox: MEM_A + '/inbox' }], following: [] });
  gstore.write('statuses.json', [
    { noteId: MEM_A + '/n/1', actor: MEM_A, kind: 'timeline', announcedAt: '2026-07-29T10:00:00Z',
      announceActivity: { type: 'Announce', id: gUrls.actor + '#announce-1', object: MEM_A + '/n/1' } },
    { noteId: STRANGER + '/n/1', actor: STRANGER, kind: 'mention' },
  ]);
  const gsent = [];
  const gagent = {
    home: GHOME, store: gstore, configured: () => true, logLines: () => [],
    status: () => ({ configured: true, mode: 'active', kind: 'group', handle: 'grp' }),
    publisher: {
      urls: gUrls, config: {}, publishCollections: async () => {},
      publishProfile: async () => { gsent.push({ published: true }); return {}; },
      recordOutbox: async (i) => { gOutbox.unshift(i); },
      unrecordOutbox: async (m) => {
        for (let k = gOutbox.length - 1; k >= 0; k--) if (m(gOutbox[k])) gOutbox.splice(k, 1);
      },
    },
    deliverer: {
      deliver: async (inbox, a) => gsent.push({ inboxes: [inbox], a }),
      deliverToAll: async (inboxes, a) => gsent.push({ inboxes, a }),
    },
  };
  gagent.intake = new Intake({
    config: gstore.getConfig(), urls: gUrls, store: gstore, log: () => {},
    remote: { getJson: async () => null }, local: { writeNote: async () => {} },
    deliverer: gagent.deliverer, publisher: gagent.publisher,
  });
  startAdmin({ port: GPORT, gateToken: '', agent: gagent, log: () => {} });
  await new Promise(r => setTimeout(r, 150));
  const g = (p, init) => fetch(`http://localhost:${GPORT}${p}`, init);
  const gjson = (p, init) => g(p, init).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const st = await gjson('/status');
  check(st.status === 200 && st.json.kind === 'group',
    `a group agent still answers /status with its kind (${st.status})`);

  // The client was withheld from a group until 2026-08-01 on the reasoning that
  // it has no timeline a human reads. It has both halves of one — statuses are
  // what it carried, notifications are who joined — and its operator has a bio
  // to edit and a profile to look at the way everyone else sees it.
  const inst = await gjson('/api/v1/instance');
  const oauth = await g('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check(inst.status === 200 && /grp/.test(inst.json?.title || '') && oauth.status !== 404,
    `a group serves /api/* and /oauth/* like anyone else (instance ${inst.status}, token ${oauth.status})`);

  const ui = await g('/manifest.webmanifest');
  check(ui.status === 200, `and mounts the client UI (${ui.status})`);

  const groupRoot = await g('/', { redirect: 'manual' });
  check(groupRoot.status === 200,
    `a group's bare URL is its client, the same as anyone's (${groupRoot.status})`);
  const groupAdmin = await g('/admin/');
  const groupSetup = await g('/admin/setup/');
  check(groupAdmin.status === 200 && groupSetup.status === 200,
    `a group serves its own two pages (${groupAdmin.status}, ${groupSetup.status})`);
  const groupCfg = await gjson('/config');
  check(groupCfg.status === 200 && groupCfg.json.kind === 'group' && groupCfg.json.handle === 'grp',
    'and can read its own record back');
  const groupElse = await g('/whatever');
  check(groupElse.status === 404, `everything else is still refused (${groupElse.status})`);

  // The client wrapper. The iframe DECLARES what it loads and keeps declaring
  // it — client.js only navigates the loaded app to its own login route when the
  // stored account is not this agent's actor, which is the whole fix for a
  // leftover login from another identity showing up on this one's page.
  const wrapper = await g('/admin/client/').then(r => r.text());
  check(/<iframe[^>]+id="client"[^>]+src="\/"/.test(wrapper),
    'the client wrapper names its own source in the markup, not from script');
  check(/<script src="client\.js">/.test(wrapper),
    'and loads the script that pins it to this agent\'s actor');
  // Every button says briefly what it does, and every title starts with three
  // spaces — the tooltip appears under the pointer, so without them the first
  // word sits behind the cursor.
  for (const page of ['/admin/', '/admin/setup/', '/admin/client/']) {
    const html = await g(page).then(r => r.text());
    // Links too: the bar's three destinations ARE navigations, so they are
    // <a href> now, and the client view is nothing but the bar.
    const buttons = [...(html.match(/<button[^>]*>/g) || []),
      ...(html.match(/<a id="bar-[^>]*>/g) || [])];
    const untitled = buttons.filter(b => !/\btitle="/.test(b));
    const unpadded = buttons.filter(b => /\btitle="(?!   )/.test(b));
    check(buttons.length > 0 && !untitled.length,
      `every control on ${page} has a help title (${buttons.length - untitled.length}/${buttons.length})`);
    check(!unpadded.length,
      `and every one of them starts with three spaces, clear of the pointer (${page})`);
  }

  const pin = await g('/admin/client/client.js').then(r => r.text());
  check(/info\?\.uri === status\.actor/.test(pin),
    'which matches on the actor URI — "who logged in at this origin" is a different question');
  check(/location\.hash/.test(pin) && /whenReady/.test(pin),
    'and forwards a deep link from the wrapper into the frame, so a link to an actor\'s page keeps the bar');
  check(/submit=1/.test(pin) && /#\/login\?/.test(pin),
    'and hands the client its instance after the hash, with a non-empty submit — an empty one never fires');

  const mem = await gjson('/members');
  check(mem.status === 200 && mem.json.members.length === 1
    && mem.json.members[0].actor === MEM_A && mem.json.members[0].muted === false,
    'GET /members lists the followers with their muted flag');

  const muted = await gjson('/mute', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: MEM_A }),
  });
  const mem2 = await gjson('/members');
  check(muted.status === 200 && mem2.json.members[0].muted === true
    && gstore.getMuted().actors.includes(MEM_A),
    'POST /mute records the member and /members reflects it');

  const un = await gjson('/unmute', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: MEM_A }),
  });
  check(un.status === 200 && !gstore.getMuted().actors.length, 'POST /unmute undoes it');

  const ann = await gjson('/announced');
  check(ann.status === 200 && ann.json.announced.length === 1
    && ann.json.announced[0].noteId === MEM_A + '/n/1',
    'GET /announced lists only what was carried');

  const bad = await gjson('/mute', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check(bad.status === 400, `POST /mute without an actor is refused (${bad.status})`);

  const gpost = (p, obj) => gjson(p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
  });

  const rev = await gpost('/review', { on: true });
  const pend = await gjson('/pending');
  check(rev.status === 200 && rev.json.review === true && pend.json.review === true,
    'POST /review turns the hold-for-review queue on, and /pending reports it');
  const noHold = await gpost('/approve', { noteId: 'https://nope.example/n/1' });
  check(noHold.status === 404, `approving something not held is refused (${noHold.status})`);
  await gpost('/review', { on: false });

  // The fixture seeds the carried post straight into the store, so mirror it
  // into the outbox the way amplify() would have before undoing it.
  gOutbox.unshift({ type: 'Announce', id: gUrls.actor + '#announce-1', object: MEM_A + '/n/1' });
  const carried = gOutbox.filter(i => i?.type === 'Announce').length;
  const ret = await gpost('/retract', { noteId: MEM_A + '/n/1' });
  check(ret.status === 200 && gsent.some(x => x.a?.type === 'Undo'),
    `POST /retract undoes a carried announcement (${ret.status})`);
  check(gOutbox.filter(i => i?.type === 'Announce').length === carried - 1,
    'and takes the Announce back out of the outbox');
  const retTwice = await gpost('/retract', { noteId: MEM_A + '/n/1' });
  check(retTwice.status === 500 || retTwice.status === 400,
    `retracting it again errors rather than sending a second Undo (${retTwice.status})`);

  const joinsOn = await gpost('/joins', { approve: true });
  check(joinsOn.status === 200 && joinsOn.json.approveJoins === true
    && gsent.some(x => x.published),
    'POST /joins republishes the actor — the flag is on the wire, not just local');
  gstore.setRequests([{ actor: MEM_C, inbox: MEM_C + '/inbox', at: '2026-07-30T09:00:00Z',
    activity: { id: MEM_C + '#f', type: 'Follow', actor: MEM_C, object: gUrls.actor } }]);
  const reqs = await gjson('/requests');
  check(reqs.status === 200 && reqs.json.approveJoins === true
    && reqs.json.requests[0].actor === MEM_C,
    'GET /requests lists who is waiting');
  const admitted = await gpost('/admit', { actor: MEM_C });
  check(admitted.status === 200 && admitted.json.requests === 0
    && gsent.some(x => x.a?.type === 'Accept'),
    `POST /admit accepts and clears the queue (${admitted.status})`);
  const noReq = await gpost('/refuse', { actor: 'https://nobody.example/u/x' });
  check(noReq.status === 500 || noReq.status === 400,
    `refusing a request that does not exist errors (${noReq.status})`);
  await gpost('/joins', { approve: false });

  const ej = await gpost('/eject', { actor: MEM_A });
  check(ej.status === 200 && gsent.some(x => x.a?.type === 'Reject')
    && !gstore.getContacts().followers.some(f => f.actor === MEM_A),
    `POST /eject removes the member and tells their server (${ej.status})`);

  // The same routes must not exist on a person.
  gstore.setConfig({ ...gstore.getConfig(), kind: 'person' });
  const asPerson = await gjson('/members');
  const ejPerson = await gpost('/eject', { actor: MEM_B });
  const pendPerson = await gjson('/pending');
  const joinsPerson = await gpost('/joins', { approve: true });
  check(asPerson.status === 404 && asPerson.json.error === 'not a group'
    && ejPerson.status === 404 && pendPerson.status === 404
    && joinsPerson.status === 404,
    'a person has no /members, /eject, /pending or /joins');
  // /requests, /admit and /refuse ARE a person's now: an inbound Follow cannot
  // be bound to the actor it names, so one waits there — and a queue with no
  // way to read or answer it would be worse than no queue.
  const reqPerson = await gjson('/requests');
  check(reqPerson.status === 200 && Array.isArray(reqPerson.json.requests),
    'but a person does have /requests, because unverifiable follows wait in it');
  const admitPerson = await gpost('/admit', { actor: 'https://nobody.example/u/x' });
  check(admitPerson.status !== 404,
    'and /admit answers for a person rather than 404ing the queue away');
  fs.rmSync(GHOME, { recursive: true, force: true });
}

// --- 11. blocking one actor, not their whole instance ---
{
  const st = new PodStore({ log: () => {} });
  st.setConfig({ remotePod: 'https://pod.example/', handle: 'you', name: 'You' });
  const BAD = 'https://m.example/u/troll';
  const OK = 'https://m.example/u/friend';
  st.setContacts({ followers: [], following: [
    { actor: OK, inbox: OK + '/inbox', accepted: true },
    { actor: BAD, inbox: BAD + '/inbox', accepted: true },
  ] });
  st.setBlocklist({ domains: [], actors: [BAD] });

  check(st.isBlocked(BAD) && !st.isBlocked(OK),
    'an actor block hits that actor and nobody else on their instance');
  check(!st.isBlocked(OK + '/n/1'), "and does not blanket the instance's notes");
  check(st.getBlocklist().domains.length === 0 && st.getBlocklist().actors.length === 1,
    'a blocklist written before actors existed still reads back');

  const pUrls = wire.apUrls('https://pod.example/');
  const notes = {
    [BAD + '/n/1']: { id: BAD + '/n/1', type: 'Note', attributedTo: BAD, content: 'x', published: '2026-07-30T00:00:00Z' },
    [OK + '/n/1']: { id: OK + '/n/1', type: 'Note', attributedTo: OK, content: 'y', published: '2026-07-30T00:00:00Z' },
  };
  const bIntake = new Intake({
    config: st.getConfig(), urls: pUrls, store: st, log: () => {},
    remote: { getJson: async () => null }, local: { writeNote: async () => {} },
    deliverer: { deliver: async () => {}, deliverToAll: async () => {} },
    publisher: { urls: pUrls, publishCollections: async () => {} },
  });
  bIntake.fetchAP = async (u) => notes[u] || null;

  const direct = await bIntake.handle({ type: 'Create', actor: BAD, object: notes[BAD + '/n/1'] });
  check(/blocked/.test(String(direct)), `a blocked actor delivering for themselves is refused (${direct})`);

  // The case a domain-only list could never catch: the author is not the sender,
  // and is only known once the note has been dereferenced at its origin.
  const viaBoost = await bIntake.onAnnounce({ type: 'Announce', actor: OK }, OK, BAD + '/n/1');
  check(/blocked author/.test(String(viaBoost)),
    `a blocked author reached through somebody else's boost is refused (${viaBoost})`);
  check(!st.getStatuses().some(x => x.actor === BAD), 'and nothing of theirs is stored');

  const clean = await bIntake.onAnnounce({ type: 'Announce', actor: OK }, OK, OK + '/n/1');
  check(clean === undefined && st.getStatuses().some(x => x.noteId === OK + '/n/1'),
    `while their instance-mate still comes through (${clean})`);
}

// --- 12. the setup page: served, jailed, and inline-script free ---
{
  const gh = { 'x-dk-token': TOKEN };
  const page = await fetch(`http://127.0.0.1:${PORT}/admin/setup/`, { headers: gh });
  const html = await page.text();
  check(page.status === 200 && /text\/html/.test(page.headers.get('content-type') || ''),
    `/admin/setup/ is served (${page.status})`);
  const csp = page.headers.get('content-security-policy') || '';
  check(/script-src [^;]*'self'/.test(csp) && !/script-src [^;]*'unsafe-inline'/.test(csp),
    'its CSP allows no inline script');
  // The trap this catches before a browser does: script-src is 'self' plus the
  // hashes of Phanpy's own inline bootstrap and nothing else, so a page with
  // an inline <script> is served, looks fine, and does nothing.
  check(/<script src=/.test(html) && !/<script(?![^>]*\ssrc=)/.test(html),
    'and the page has none — every script it loads names its source');

  const noSlash = await fetch(`http://127.0.0.1:${PORT}/admin/setup`, { headers: gh, redirect: 'manual' });
  check(noSlash.status === 302 && noSlash.headers.get('location') === '/admin/setup/',
    `a missing trailing slash is corrected, or relative asset URLs resolve one level up (${noSlash.status})`);

  const st = await fetch(`http://127.0.0.1:${PORT}/setup/state`, { headers: gh }).then(r => r.json());
  check(st.hasCredential === false && st.configured === false && st.resumable === false
    && st.phase === 'idle' && st.port === PORT,
    `/setup/state describes an agent with nothing yet (${st.phase})`);
  check(st.identity === null && !/secret|clientId/i.test(JSON.stringify(st)),
    'and reports no credential material');

  const esc = await fetch(`http://127.0.0.1:${PORT}/admin/..%2f..%2fpackage.json`, { headers: gh });
  check(esc.status === 403 || esc.status === 404, `the page directory is jailed (${esc.status})`);
  const admin = await fetch(`http://127.0.0.1:${PORT}/admin/`, { headers: gh });
  check(admin.status === 200, `/admin/ is served from the same place (${admin.status})`);
}

// --- 12b. the preflight says what the CLI used to print ---
{
  const ask = (body) => fetch(`http://127.0.0.1:${PORT}/setup/check`, {
    method: 'POST', headers: { 'x-dk-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

  const rooted = await ask({ mode: 'existing', pod: 'https://you.example/', handle: 'you', kind: 'person' });
  check(rooted.ok && rooted.address === '@you@you.example' && rooted.resolvable === true
    && !rooted.warnings.length,
    `a pod at its own host root resolves (${rooted.address})`);

  const onPath = await ask({ mode: 'existing', pod: 'https://shared.example/me/', handle: 'you', kind: 'person' });
  check(onPath.ok && onPath.resolvable === false && onPath.warnings.includes('pod-is-a-path'),
    'a pod on a path is a warning a person may accept');

  const grouped = await ask({ mode: 'existing', pod: 'https://shared.example/me/', handle: 'g', kind: 'group' });
  check(grouped.ok === false && grouped.refusal === 'group-needs-host-root',
    'but for a group it is a refusal — nobody could ever find it');

  const fresh = await ask({ mode: 'new', issuer: 'https://solidcommunity.net', podName: 'me', handle: 'you' });
  check(fresh.address === '@you@me.solidcommunity.net' && fresh.resolvable === null
    && !fresh.warnings.length,
    'a pod that does not exist yet previews its address and warns about nothing');

  const nonsense = await ask({ mode: 'existing', pod: 'not a url', handle: 'you' });
  check(nonsense.ok === false && /not a pod address/.test(nonsense.error || ''),
    'and junk is refused rather than previewed');
}

// --- 13. setup runs in the server, outlives the page, and leaks no password ---
{
  const { startAdmin } = await import(path.join(root, 'lib/admin.mjs'));
  const { default: net13 } = await import('node:net');
  const SPORT = 18626;
  const RPORT = 18627;
  const CSS = 18630;
  const CSS_ORIGIN = `http://127.0.0.1:${CSS}`;
  const NEW_POD = `http://wrenpod.127.0.0.1.nip.io:${CSS}/`;   // a string only: never fetched
  const PASSWORD = 'hunter2-not-in-any-log';
  let mintFails = true;
  let mints = 0;

  // A CSS v7 account API, enough of one for createAccountWithPod AND
  // mintCredential — the §9 mock only covers the first.
  const mockCss13 = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.url === '/.well-known/openid-configuration') return send({ token_endpoint: `${CSS_ORIGIN}/.oidc/token` });
    if (req.url === '/.account/') {
      return send({ controls: {
        password: { create: `${CSS_ORIGIN}/.account/password/`, login: `${CSS_ORIGIN}/.account/login/password/` },
        account: {
          pod: `${CSS_ORIGIN}/.account/pod/`,
          clientCredentials: `${CSS_ORIGIN}/.account/cc/`,
          webId: `${CSS_ORIGIN}/.account/webid/`,
        },
      } });
    }
    if (req.url === '/.account/login/password/') {
      if (!body.includes(PASSWORD)) return send({ message: 'bad password' }, 403);
      return send({ authorization: 'AUTH13' });
    }
    if (req.url === '/.account/pod/' && req.method === 'POST') {
      await new Promise(r => setTimeout(r, 250));     // slow enough to catch a second run mid-flight
      return send({ pod: NEW_POD, webId: `${NEW_POD}profile/card#me` });
    }
    if (req.url === '/.account/webid/') return send({ webIdLinks: { [`${NEW_POD}profile/card#me`]: 'x' } });
    if (req.url === '/.account/cc/' && req.method === 'POST') {
      if (mintFails) return send({ message: 'the issuer refused' }, 400);
      mints++;
      return send({ id: 'CID13', secret: 'CSECRET13', resource: `${CSS_ORIGIN}/.account/cc/CID13/` });
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => mockCss13.listen(CSS, '127.0.0.1', r));

  // Everything past the mint needs a pod, so it is faked; the account API and
  // the credential file are the real thing.
  const makeAgent = (home) => {
    const store = new PodStore({ log: () => {} });
    let cfgd = false;
    return {
      home, store, logLines: (n) => slog13.slice(-n),
      configured: () => cfgd,
      status: () => ({ configured: cfgd, mode: cfgd ? 'active' : 'unconfigured' }),
      readCredential() {
        try { return JSON.parse(fs.readFileSync(path.join(home, 'credential.json'), 'utf8')); }
        catch { return null; }
      },
      async bootstrap(o) {
        const cred = this.readCredential();
        store.setConfig({
          ...(store.getConfig() || {}),
          remotePod: cred.remotePod, handle: o.handle, name: o.name || o.handle,
          issuer: cred.issuerOrigin, ...(o.kind ? { kind: o.kind } : {}),
        });
      },
      async connect() { cfgd = true; this.urls = wire.apUrls(store.getConfig().remotePod); return true; },
      publisher: { config: {}, publishProfile: async () => ({ unreachable: [] }) },
    };
  };
  const slog13 = [];
  const SHOME = fs.mkdtempSync('/tmp/fedipod-setup-');
  const sagent = makeAgent(SHOME);
  startAdmin({ port: SPORT, gateToken: '', agent: sagent, log: (...a) => slog13.push(a.join(' ')) });
  await new Promise(r => setTimeout(r, 150));

  const sjson = (p, init) => fetch(`http://localhost:${SPORT}${p}`, init)
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  const spost = (p, body) => sjson(p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      const { json } = await sjson('/setup/progress');
      if (json.phase !== 'running') return json;
      await new Promise(r => setTimeout(r, 50));
    }
    return null;
  };
  const rawHost = (port, host) => new Promise((resolve) => {
    const s = net13.connect(port, '127.0.0.1', () => {
      s.write(`GET /status HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    s.on('data', d => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', () => resolve(''));
  });

  const answers13 = {
    mode: 'new', kind: 'person', issuer: CSS_ORIGIN, email: 'wren@example.org',
    password: PASSWORD, handle: 'wren', name: 'Wren', podName: 'wrenpod',
  };

  const unnamed = await rawHost(SPORT, `wren.localhost:${SPORT}`);
  check(/^HTTP\/1\.1 403/.test(unnamed), 'before setup, the agent does not answer to a handle it has not got');

  // --- the mint fails: nothing is written, and it can be tried again ---
  const failed = await spost('/setup', answers13);
  check(failed.status === 202, `setup starts and answers at once (${failed.status})`);
  const bad = await settle();
  check(bad?.phase === 'error' && /refused/.test(bad.error || ''),
    `a failed mint is reported, not swallowed (${bad?.error})`);
  check(!fs.existsSync(path.join(SHOME, 'credential.json')),
    'and writes no credential file');
  check(bad.steps.find(s => s.key === 'credential').state === 'error'
    && bad.steps.find(s => s.key === 'publish').state === 'waiting',
    'the step that failed is the one marked failed');

  // --- and again, working this time ---
  mintFails = false;
  const started = await spost('/setup', answers13);
  check(started.status === 202, `a failed run does not leave setup wedged (${started.status})`);
  const second = await spost('/setup', answers13);
  check(second.status === 409 && second.json?.phase === 'running',
    `only one setup at a time (${second.status})`);
  const done = await settle();
  check(done?.phase === 'done' && done.result?.address === `@wren@wrenpod.127.0.0.1.nip.io:${CSS}`,
    `setup completes with the address it promised (${done?.result?.address})`);
  check(done.steps.map(s => s.key).join() === 'account,credential,bootstrap,connect,publish,verify',
    'the credential is written before anything is published, not after');

  const credFile = path.join(SHOME, 'credential.json');
  const mode = fs.statSync(credFile).mode & 0o777;
  const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  check(mode === 0o600 && cred.secret === 'CSECRET13' && cred.remotePod === NEW_POD,
    `the credential is on disk, owner-only (mode ${mode.toString(8)})`);

  // Polled over and over by a page that may be left open: a password echoed
  // into a progress report is a password served forever.
  const progressText = JSON.stringify(await sjson('/setup/progress'));
  const logText = JSON.stringify(await sjson('/log'));
  check(!progressText.includes(PASSWORD) && !logText.includes(PASSWORD)
    && !fs.readFileSync(credFile, 'utf8').includes(PASSWORD),
    'the account password reaches neither the progress report, the log, nor the disk');

  const again = await spost('/setup', answers13);
  check(again.status === 409 && /already holds an identity/.test(again.json?.error || ''),
    `a configured home refuses a second setup (${again.status})`);

  const named = await rawHost(SPORT, `wren.localhost:${SPORT}`);
  check(/^HTTP\/1\.1 200/.test(named), 'and the agent now answers at its own name');

  // --- resuming a setup that died after the mint ---
  const RHOME = fs.mkdtempSync('/tmp/fedipod-resume-');
  fs.copyFileSync(credFile, path.join(RHOME, 'credential.json'));
  const mintsBefore = mints;
  const ragent = makeAgent(RHOME);
  startAdmin({ port: RPORT, gateToken: '', agent: ragent, log: () => {} });
  await new Promise(r => setTimeout(r, 150));
  const rstate = await fetch(`http://localhost:${RPORT}/setup/state`).then(r => r.json());
  check(rstate.hasCredential === true && rstate.configured === false && rstate.resumable === true
    && rstate.identity?.pod === NEW_POD,
    'a credential with no actor behind it is reported as resumable');
  const resumed = await fetch(`http://localhost:${RPORT}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: 'wren', name: 'Wren', kind: 'person' }),   // no password, no pod
  }).then(r => r.status);
  let rdone = null;
  for (let i = 0; i < 200 && !rdone; i++) {
    const j = await fetch(`http://localhost:${RPORT}/setup/progress`).then(r => r.json());
    if (j.phase !== 'running') rdone = j;
    else await new Promise(r => setTimeout(r, 50));
  }
  check(resumed === 202 && rdone?.phase === 'done',
    `it finishes without the password being asked for again (${rdone?.phase})`);
  check(mints === mintsBefore
    && rdone.steps.find(s => s.key === 'credential').state === 'skipped',
    'and mints no second credential — the first one cannot be minted twice');

  mockCss13.close();
  fs.rmSync(SHOME, { recursive: true, force: true });
  fs.rmSync(RHOME, { recursive: true, force: true });
}

// --- 14. the record can be read back and edited, and a merge stays a merge ---
{
  const { startAdmin } = await import(path.join(root, 'lib/admin.mjs'));
  const CPORT = 18628;
  const CHOME = fs.mkdtempSync('/tmp/fedipod-config-');
  // CHOME is the ROOT; the identity itself is a profile under it. /new-actor
  // builds sibling directories as rootOf(agent.home)/profiles/<handle>, so the
  // root has to stay the root or those refusals stop being about anything.
  const CSELF = path.join(CHOME, 'profiles', 'solo');
  fs.mkdirSync(CSELF, { recursive: true });
  // A configured PERSON: the credential file is what `/` keys on.
  fs.writeFileSync(path.join(CSELF, 'credential.json'),
    JSON.stringify({ remotePod: 'https://solo.example/', webId: 'https://solo.example/profile/card#me',
      issuerOrigin: 'https://example', clientId: 'CID', secret: 'SECRET-NOT-FOR-THE-PAGE' }));
  const cstore = new PodStore({ log: () => {} });
  cstore.setConfig({
    remotePod: 'https://solo.example/', handle: 'solo', name: 'solo', issuer: 'https://example',
    kind: 'person', summary: 'birds, mostly', uiPassword: { saltHex: 'aa', hashHex: 'bb' },
  });
  const curls = wire.apUrls('https://solo.example/');
  const republished = [];
  const lifecycle = [];
  let blocklist = { domains: [], actors: [] };
  const cagent = {
    home: CSELF, store: cstore, urls: curls, configured: () => true, logLines: () => [],
    // `actor` is in the real /status (run-agent.mjs) and is what the fediverse
    // address is assembled from — the handle, at the pod host its actor sits on.
    status: () => ({ configured: true, mode: 'active', kind: 'person', handle: 'solo', actor: curls.actor }),
    readCredential() { return JSON.parse(fs.readFileSync(path.join(CSELF, 'credential.json'), 'utf8')); },
    requestTakeover: async () => { lifecycle.push('takeover'); return true; },
    // Both destructive; the checks below assert they are never reached without
    // the lease, so reaching them at all is the failure.
    intake: {
      drain: async () => { lifecycle.push('drain'); },
      prune: async () => { lifecycle.push('prune'); return { applied: 0, dropped: 0, discarded: 0 }; },
    },
    park: async () => { lifecycle.push('park'); return { quiescedAt: 'T', unfollowed: 2, following: 3 }; },
    revive: async () => { lifecycle.push('revive'); return { refollowed: 2, of: 3 }; },
    rotateKey: async () => { lifecycle.push('rotate'); return { changed: true }; },
    moveTo: async (target) => { lifecycle.push('move'); return { target, inboxes: 1, unfollowed: 2, following: 2 }; },
    publisher: {
      urls: curls, config: {},
      publishProfile: async () => { republished.push(1); return { unreachable: [] }; },
      retireActor: async () => { lifecycle.push('retire'); return { inboxes: 1, deletedAt: 'T' }; },
      rebuildStatuses: async (o) => { lifecycle.push('rebuild'); return { indexed: 1, recovered: 1, ...o }; },
    },
  };
  startAdmin({ port: CPORT, gateToken: '', agent: cagent, handle: 'solo', log: () => {} });
  await new Promise(r => setTimeout(r, 150));
  const cjson = (p, init) => fetch(`http://localhost:${CPORT}${p}`, init)
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  const cpost = (body) => cjson('/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const got = await cjson('/config');
  check(got.status === 200 && got.json.handle === 'solo' && got.json.address === '@solo@solo.example'
    && got.json.hasUiPassword === true && got.json.uiPassword === undefined,
    'GET /config reports that a UI password is set, never the record itself');
  check(!/SECRET-NOT-FOR-THE-PAGE/.test(JSON.stringify(got.json)),
    'and never the pod credential');

  const partial = await cpost({ summary: 'finches, actually' });
  check(partial.status === 200 && cstore.getConfig().uiPassword?.saltHex === 'aa'
    && cstore.getConfig().handle === 'solo' && cstore.getConfig().summary === 'finches, actually',
    'an edit that never mentions the password keeps it — a write is a merge');

  const before = JSON.stringify(cstore.getConfig());
  const fixed = await cpost({ handle: 'someone-else' });
  check(fixed.status === 400 && /cannot be changed/.test(fixed.json?.error || '')
    && JSON.stringify(cstore.getConfig()) === before,
    `the identity itself is refused, and nothing is written (${fixed.status})`);

  const beforeRename = republished.length;
  const renamed = await cpost({ name: 'Solo' });
  check(renamed.status === 200 && renamed.json.published === true
    && republished.length === beforeRename + 1 && cagent.publisher.config.name === 'Solo',
    'a display name is on the wire, so saving it republishes the actor');
  check(renamed.json.unreachable === undefined,
    'and a publish strangers can read says nothing about reachability');

  // Saving IS the republish control, so the readability report has to ride back
  // on it; there is no second button to carry it.
  cagent.publisher.publishProfile = async () => {
    republished.push(1);
    return { unreachable: ['webfinger', 'actor'] };
  };
  const invisible = await cpost({ name: 'Solo' });
  check(invisible.status === 200 && invisible.json.published === true
    && JSON.stringify(invisible.json.unreachable) === '["webfinger","actor"]',
    'a publish no stranger can read is reported on the save that caused it');
  cagent.publisher.publishProfile = async () => { republished.push(1); return { unreachable: [] }; };

  const groupOnly = await cpost({ review: true });
  check(groupOnly.status === 404 && /not a group/.test(groupOnly.json?.error || ''),
    'a person has no review queue to switch on');

  const beforePw = republished.length;
  const pw = await cpost({ password: 'a new one' });
  check(pw.status === 200 && pw.json.published === false && republished.length === beforePw
    && cstore.getConfig().uiPassword.saltHex !== 'aa'
    && !JSON.stringify(pw.json).includes('a new one'),
    'a password change is local: hashed, not echoed, and not republished');

  const cleared = await cpost({ password: '' });
  check(cleared.status === 200 && !cstore.getConfig().uiPassword, 'and an empty one removes it');

  // ---- lifecycle, the page's version of park | revive | rotate-key | retire ----
  const lpost = (p, body = {}) => cjson(p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const takeoversBefore = lifecycle.filter(x => x === 'takeover').length;   // /config claims it too
  // A viewer may not drain or prune: both DELETE from the pod inbox, which is
  // what the lease is for. The facade has always refused viewer writes; these
  // two routes were missed, and the admin page could make a read-only agent do
  // the one destructive thing single-writer safety exists to prevent.
  cagent.requestTakeover = async () => false;
  const viewerDrain = await lpost('/drain');
  const viewerPrune = await lpost('/inbox/prune', { before: '2026-01-01T00:00:00Z' });
  // Same rule for the rebuild: it writes the statuses store, and two agents
  // writing it is exactly what the lease exists to stop.
  const viewerRebuild = await lpost('/rebuild');
  check(viewerDrain.status === 503 && /another agent is active/.test(viewerDrain.json?.error || ''),
    'a viewer that cannot claim the lease is refused the drain');
  check(viewerPrune.status === 503 && /another agent is active/.test(viewerPrune.json?.error || ''),
    'and refused the prune, which deletes far more');
  check(viewerRebuild.status === 503 && /another agent is active/.test(viewerRebuild.json?.error || ''),
    'and refused the rebuild, which writes the statuses store');
  check(!lifecycle.includes('drain') && !lifecycle.includes('prune') && !lifecycle.includes('rebuild'),
    'and none of the three touched anything on the way to being refused');
  cagent.requestTakeover = async () => { lifecycle.push('takeover'); return true; };

  const parked = await lpost('/park');
  check(parked.status === 200 && parked.json.quiescedAt === 'T' && parked.json.unfollowed === 2
    && lifecycle.includes('park'), 'the page can park, and gets back what the CLI prints');
  const revived = await lpost('/revive');
  check(revived.status === 200 && revived.json.refollowed === 2 && revived.json.of === 3,
    'and revive, which is a request to re-follow rather than a restoration');
  const rotated = await lpost('/rotate-key');
  check(rotated.status === 200 && rotated.json.changed === true && lifecycle.includes('rotate'),
    'and rotate the signing key');
  check(lifecycle.filter(x => x === 'takeover').length - takeoversBefore === 3,
    'each one claims the lease first — a person here outranks an idle agent elsewhere');

  // Move is the other irreversible, federated one, and it was CLI-only — the
  // retire warning pointed at a command line. Same typed-handle interlock as
  // retire, plus a target, and both are checked before anything leaves.
  const moveNoTarget = await lpost('/move', { confirm: 'solo' });
  check(moveNoTarget.status === 400 && /target required/.test(moveNoTarget.json?.error || ''),
    'a move with no destination is refused');
  const moveNoConfirm = await lpost('/move', { target: 'https://elsewhere.example/u/me' });
  check(moveNoConfirm.status === 400 && /type the handle/.test(moveNoConfirm.json?.error || ''),
    'and one with no typed handle is refused — a stray click cannot produce it');
  const moveWrong = await lpost('/move', { target: 'https://elsewhere.example/u/me', confirm: 'not-solo' });
  check(moveWrong.status === 400 && !lifecycle.includes('move'),
    'a wrong handle is refused, and nothing federated on the way to being refused');
  const moved = await lpost('/move', { target: 'https://elsewhere.example/u/me', confirm: 'solo' });
  check(moved.status === 200 && lifecycle.includes('move') && moved.json.target === 'https://elsewhere.example/u/me',
    `with the handle typed it moves, carrying the target through (${moved.status})`);

  // Counted after that, because the three above IGNORE the takeover result and
  // this one refuses on it — the same call, a different rule.
  const rebuilt = await lpost('/rebuild', { fromNotes: true });
  check(rebuilt.status === 200 && rebuilt.json.recovered === 1 && rebuilt.json.fromNotes === true,
    'with the lease the rebuild runs, and the wider search is passed through rather than dropped');

  // The interlock, which is the whole reason retire is safe to put on a page.
  const noConfirm = await lpost('/retire');
  check(noConfirm.status === 400 && !lifecycle.includes('retire'),
    'retire without the typed handle is refused, and nothing is delivered');
  const wrongConfirm = await lpost('/retire', { confirm: 'sol' });
  check(wrongConfirm.status === 400 && !lifecycle.includes('retire'),
    'and a near-miss is still a miss — no Delete goes out');
  const retired = await lpost('/retire', { confirm: 'solo' });
  check(retired.status === 200 && retired.json.inboxes === 1 && lifecycle.includes('retire'),
    'the handle typed in full is what actually retires it');

  // ---- the other identities on this machine, as links for the page ----
  // agent.json is the only file this may read. The sibling's credential is made
  // unreadable on purpose: if anything here ever opens one, these fail rather
  // than quietly widening what an agent touches.
  fs.writeFileSync(path.join(CSELF, 'agent.json'), JSON.stringify({ port: CPORT, handle: 'solo' }));
  fs.writeFileSync(path.join(CHOME, 'root.json'), JSON.stringify({ default: 'solo' }));
  const sib = path.join(CHOME, 'profiles', 'other');
  fs.mkdirSync(sib, { recursive: true });
  fs.writeFileSync(path.join(sib, 'agent.json'), JSON.stringify({ port: 18999, handle: 'other' }));
  const sibCred = path.join(sib, 'credential.json');
  fs.writeFileSync(sibCred, JSON.stringify({ secret: 'NEVER-READ' }));
  fs.chmodSync(sibCred, 0o000);

  const others = await cjson('/profiles');
  const byName = Object.fromEntries((others.json?.identities || []).map(i => [i.name, i]));
  // Both rows, asserted explicitly: with the current identity re-keyed from the
  // invented '(default)' to its own name, a payload that lost it entirely would
  // still satisfy every sibling check below.
  check((others.json?.identities || []).length === 2,
    `both identities are listed (${(others.json?.identities || []).length})`);
  check(others.status === 200 && byName.solo?.current === true
    && byName.solo.admin === `http://solo.localhost:${CPORT}/admin/`,
    'the page is told which identity it is already looking at, so it can leave it out');
  check(byName.solo?.lastUsed === true && byName.other?.lastUsed === false,
    'and which one a plain command means, which is a different question from which page you are on');
  // Named, not the bare loopback. A browser keys storage per ORIGIN, so a row
  // of identities all linked at localhost:<port> files them in one bucket —
  // which is how a client ends up holding one actor's login on another's page.
  check(byName.other?.current === false && byName.other.port === 18999
    && byName.other.admin === 'http://other.localhost:18999/admin/'
    && byName.other.app === 'http://other.localhost:18999/' && byName.other.mode === null,
    'a sibling carries both addresses — the record and the client — and reports it is not running');
  check(byName.other.handle === 'other',
    'a STOPPED sibling is still named, from the handle agent.json records — it never answers to be asked');
  // The address is the actor as everyone else sees it, and the only form that
  // stays distinct: two identities can share a handle, never a handle AND a pod.
  check(byName.solo.address === 'solo@solo.example',
    `a running identity reports its fediverse address (${byName.solo.address})`);
  check(byName.other.address === null,
    'and a stopped one reports none rather than guessing a pod it never named');
  check(!JSON.stringify(others.json).includes('NEVER-READ'),
    "and a sibling's credential is never opened — agent.json is the whole of it");
  fs.chmodSync(sibCred, 0o600);

  // ---- creating a second actor from the page ----
  // The refusals only: actually spawning an agent belongs to the live run, but
  // a bad name or an existing one must never get as far as making a directory.
  const badName = await lpost('/new-actor', { handle: 'not a handle' });
  check(badName.status === 400 && /letters, digits, hyphens and underscores/.test(badName.json?.error || ''),
    'a new actor is refused a name that cannot also be a directory');
  // The form says underscores are allowed, so they have to be: a handle the
  // page invites and the server refuses is worse than either rule alone.
  const scored = await lpost('/new-actor', { handle: 'jeff_zucker', kind: 'person', mode: 'new' });
  check(scored.status === 400 && /identity provider|email|password/.test(scored.json?.error || ''),
    'an underscore is a legal handle — it gets past the name check to the real questions');
  const climb = await lpost('/new-actor', { handle: '../escape' });
  check(climb.status === 400 && !fs.existsSync(path.join(CHOME, 'profiles', '..', 'escape')),
    'and a name that would climb out of profiles/ never becomes a path');
  const taken = await lpost('/new-actor', { handle: 'other' });
  check(taken.status === 409 && /already exists/.test(taken.json?.error || ''),
    'a handle that already has a home is refused rather than started twice');
  // Nothing may be created for answers setup would reject anyway.
  const thin = await lpost('/new-actor', { handle: 'fresh', kind: 'person', mode: 'new' });
  check(thin.status === 400 && /identity provider|email|password/.test(thin.json?.error || '')
    && !fs.existsSync(path.join(CHOME, 'profiles', 'fresh')),
    'and a form missing what setup needs is refused before a home or a process exists');
  // Neither form asks where the private half goes any more: runSetup puts it
  // beside the credential, which is what makes every new actor relay by
  // default rather than starting on the pod and moving off later.
  const asksPrivate = (f) => /privateRoot|privateWhere/.test(fs.readFileSync(path.join(root, f), 'utf8'));
  check(!asksPrivate('web/admin/index.html') && !asksPrivate('web/admin/setup/index.html'),
    'neither form asks where the private half goes');

  // And the behaviour behind that: a run with no privateRoot writes one anyway.
  {
    const { runSetup, newRun } = await import(path.join(root, 'lib/setup.mjs'));
    const shome = fs.mkdtempSync('/tmp/dk-ap-relay-default-');
    const fake = {
      urls: { actor: 'https://x.example/ap/actor' },
      store: { getConfig: () => ({}), setConfig: () => {}, flush: async () => {} },
      publisher: { publishProfile: async () => ({ unreachable: [] }) },
      bootstrap: async () => {}, connect: async () => {},
    };
    const run = await runSetup({
      home: shome, agent: fake, run: newRun(), log: () => {},
      answers: { mode: 'new', issuer: 'https://i.example', email: 'a@b.c', password: 'pw',
        handle: 'nobody', kind: 'person' },
      deps: {
        createAccountWithPod: async () => ({ pod: 'https://nobody.i.example/' }),
        mintCredential: async () => ({ clientId: 'C', secret: 'S', webId: 'https://w.example/#me' }),
      },
    });
    const cred = JSON.parse(fs.readFileSync(path.join(shome, 'credential.json'), 'utf8'));
    check(run.phase === 'done' && cred.privateRoot === pathToFileURL(path.join(shome, 'private')).href + '/',
      'a setup that was asked nothing still puts the private half beside the credential');
    fs.rmSync(shome, { recursive: true, force: true });
  }

  // ---- a group is an actor too ----
  // fetchAP cached only type Person, so a Group was fetched, used and thrown
  // away. With nothing cached the facade fell back to the last path segment of
  // the actor URL — which for every actor here is the literal word `actor`, so
  // a group searched for by name came back as @actor@host with no name.
  {
    const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
    const { MastoApi } = await import(path.join(root, 'lib/mastoapi.mjs'));
    const gurls = (await import(path.join(root, 'lib/wire.mjs'))).apUrls('https://me.example/');
    const gs = new PodStore({ log: () => {} });
    gs.setConfig({ handle: 'me', remotePod: 'https://me.example/' });
    const actorUrl = 'https://activitypub.example/activitypods-js/ap/actor';

    const api = new MastoApi({
      agent: { store: gs, publisher: { urls: gurls }, configured: () => true }, log: () => {},
    });
    const bare = api.account(actorUrl);
    check(bare.username === 'actor',
      'with nothing cached a client is told the actor is called "actor" — the old bug');

    gs.cacheActor(actorUrl, {
      id: actorUrl, type: 'Group', preferredUsername: 'group', name: 'group',
      followers: actorUrl + '/followers',
    });
    const named = api.account(actorUrl);
    check(named.username === 'group' && named.acct === 'group@activitypub.example',
      'a cached Group renders under its own name');
    check(named.group === true, 'and is flagged as a group, so a client can say so');
    check(named.followers_count === 0, 'counts stay 0 until something has asked the collection');

    const withCounts = gs.getActors();
    withCounts[actorUrl].counts = { followers: 1, following: null };
    gs.write('actors.json', withCounts);
    check(api.account(actorUrl).followers_count === 1,
      'and report what the collection said once it has been asked');
  }

  // ---- unblock, and reconcile-on-restore ----
  {
    const { PodStore, dropFollower } = await import(path.join(root, 'lib/store.mjs'));
    const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));

    // Blocking without unblocking is a trap: the only way out was editing
    // blocklist.json by hand.
    await lpost('/block', { domain: 'spam.example' });
    await lpost('/block', { actor: 'https://x.example/u' });
    const listed = await cjson('/blocks');
    check(listed.status === 200 && listed.json.domains.includes('spam.example')
      && listed.json.actors.includes('https://x.example/u'),
      'blocks are listable, both granularities');
    const un = await lpost('/unblock', { domain: 'spam.example' });
    check(un.status === 200 && un.json.removed === 1 && !un.json.domains.includes('spam.example')
      && un.json.actors.includes('https://x.example/u'),
      'unblocking a domain leaves the actor block alone');
    const noop = await lpost('/unblock', { domain: 'never.blocked' });
    check(noop.status === 200 && noop.json.removed === 0,
      'and unblocking something that was not blocked says so rather than pretending');

    // The tombstone is the whole reason a reconcile is safe.
    const c = { followers: [{ actor: 'https://a.example/u' }, { actor: 'https://b.example/u' }] };
    dropFollower(c, 'https://b.example/u', 'ejected');
    check(c.followers.length === 1 && c.removedFollowers[0].actor === 'https://b.example/u'
      && c.removedFollowers[0].why === 'ejected',
      'removing a follower records WHY, so a reconcile cannot undo the decision');
    dropFollower(c, 'https://b.example/u', 'undo-follow');
    check(c.removedFollowers.length === 1, 'and leaving twice is still one entry');

    // A local half that is behind the pod: one follower it never heard of, one
    // it deliberately removed. Only the first comes back.
    const rstore = new PodStore({ log: () => {} });
    rstore.write('contacts.json', {
      followers: [{ actor: 'https://a.example/u', inbox: 'https://a.example/in' }],
      following: [],
      removedFollowers: [{ actor: 'https://gone.example/u', why: 'ejected', at: 'T' }],
    });
    const pub = new Publisher({
      config: { remotePod: 'https://me.example/', handle: 'me' },
      store: rstore, log: () => {},
      remote: {
        // reconcileFollowers now reads the collection through readPublishedFollowers
        // (getJson, walking pages) — this flat head stands in for a small one.
        getJson: async () => ({ orderedItems: [
          'https://a.example/u', 'https://back.example/u', 'https://gone.example/u',
        ] }),
      },
      deliverer: {
        signedFetch: async (u) => ({ ok: true, json: async () => ({ id: u, inbox: u + '/inbox' }) }),
      },
    });
    const contacts = rstore.getContacts();
    const n = await pub.reconcileFollowers(contacts);
    const back = contacts.followers.map(f => f.actor);
    check(n === 1 && back.includes('https://back.example/u'),
      'a follower the pod knows and this machine does not is recovered, with its inbox');
    check(!back.includes('https://gone.example/u'),
      'and one that was deliberately removed stays removed');
    check(contacts.followers.find(f => f.actor === 'https://back.example/u')?.inbox
      === 'https://back.example/u/inbox',
      'the inbox comes with them — recovering the name alone would not restore delivery');
  }

  // ---- rebuilding own posts from the pod's public face ----
  // The other half of reconcile-on-restore. Followers came back; the posts did
  // not, and the pod was serving every one of them the whole time.
  {
    const { PodStore } = await import(path.join(root, 'lib/store.mjs'));
    const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
    const POD = 'https://me.example/';
    const N = POD + 'activitypods-js/ap/notes/';
    const ACTOR = POD + 'activitypods-js/ap/actor';
    const note = (slug, extra = {}) => ({
      id: N + slug, type: 'Note', attributedTo: ACTOR,
      content: `<p>${slug}</p>`, published: `2026-07-${slug.slice(-2)}T00:00:00.000Z`, ...extra,
    });
    const docs = {
      [POD + 'activitypods-js/ap/outbox']: {
        type: 'OrderedCollection',
        orderedItems: [N + 'a-01', N + 'a-02', { type: 'Announce', id: ACTOR + '#announce-9', object: N + 'a-01' }],
      },
      [N + 'a-01']: note('a-01'),
      [N + 'a-02']: note('a-02', { inReplyTo: 'https://far.example/n/7', tag: [{ type: 'Mention', href: 'https://far.example/u', name: '@them@far.example' }] }),
      [N + 'a-03']: note('a-03'),                   // published, but NOT in the outbox
    };
    const written = [];
    const mkPub = (store) => new Publisher({
      config: { remotePod: POD, handle: 'me' }, store, log: () => {},
      remote: {
        getJson: async (u) => docs[u] ?? null,
        listContainer: async () => [
          { url: N + 'a-01' }, { url: N + 'a-01-create' }, { url: N + 'a-01-replies' },
          { url: N + 'a-02' }, { url: N + 'a-03' }, { url: N + '.keep' },
        ],
      },
      local: { writeNote: async (kind, slug) => { written.push(`${kind}/${slug}`); } },
    });

    // A machine that lost everything.
    const empty = new PodStore({ log: () => {} });
    const r1 = await mkPub(empty).rebuildStatuses();
    const got = empty.getStatuses();
    check(r1.recovered === 2 && got.length === 2,
      `the outbox is the index: both posts it names come back (${r1.recovered})`);
    check(!got.some(s => s.noteId === N + 'a-03'),
      'and a note the outbox does not name is left alone — the outbox is what a delete rewrites');
    check(got[0].noteId === N + 'a-02' && got[0].inReplyTo === 'https://far.example/n/7'
      && got[0].mentions?.[0]?.name === '@them@far.example' && got[0].kind === 'post'
      && got[0].slug === 'a-02',
      'a recovered post carries its reply target, its mentions, its kind and its slug');
    check(got.find(s => s.noteId === N + 'a-01')?.reblogged === true,
      'an Announce in the outbox marks its own post boosted, with the activity an Undo would need');
    check(written.includes('posts/a-01') && written.includes('posts/a-02'),
      'and the RDF mirror is written back too, which is what a later backfill reads');

    // --from-notes looks past the outbox, and says what it costs.
    const wider = new PodStore({ log: () => {} });
    const r2 = await mkPub(wider).rebuildStatuses({ fromNotes: true });
    check(r2.recovered === 3 && wider.getStatuses().some(s => s.noteId === N + 'a-03'),
      `--from-notes finds the note the outbox missed (${r2.recovered})`);
    check(!wider.getStatuses().some(s => /-(create|replies)$/.test(s.noteId)),
      'and the -create and -replies published beside each note are not mistaken for posts');

    // Merge, never replace: local facts survive.
    const held = new PodStore({ log: () => {} });
    held.write('statuses.json', [{ noteId: N + 'a-01', content: 'MINE', favourited: true, kind: 'post' }]);
    const r3 = await mkPub(held).rebuildStatuses();
    const mine = held.getStatuses().find(s => s.noteId === N + 'a-01');
    check(mine.content === 'MINE' && mine.favourited === true,
      'a post this machine already holds keeps its own copy and its local facts');
    check(r3.recovered === 1, `and only the genuinely missing one is added (${r3.recovered})`);

    // A post deliberately deleted must not come back.
    const deleted = new PodStore({ log: () => {} });
    deleted.write('outbox-removed.json', [{ id: N + 'a-01', at: 'T' }]);
    const r4 = await mkPub(deleted).rebuildStatuses({ fromNotes: true });
    check(!deleted.getStatuses().some(s => s.noteId === N + 'a-01'),
      'a post whose removal was recorded stays gone, even walking the container');
    check(r4.recovered === 2, `the rest still come back (${r4.recovered})`);

    // The pod that will not answer says so rather than reporting success.
    const mute = new PodStore({ log: () => {} });
    const silent = new Publisher({
      config: { remotePod: POD, handle: 'me' }, store: mute, log: () => {},
      remote: { getJson: async () => null, listContainer: async () => [] },
      local: { writeNote: async () => {} },
    });
    const r5 = await silent.rebuildStatuses();
    check(r5.recovered === 0 && !!r5.why,
      'an unreadable outbox is reported, not reported as "nothing was missing"');

    // The outbox is the index, so republishing from a machine that is behind
    // must not erase it — that would destroy the recovery source first.
    const behind = new PodStore({ log: () => {} });
    behind.write('outbox.json', [N + 'a-02']);
    behind.write('outbox-removed.json', [{ id: N + 'a-01', at: 'T' }]);
    const ob = behind.read('outbox.json', []);
    const n2 = await mkPub(behind).reconcileOutbox(ob);
    check(n2 === 1 && ob.some(i => i?.type === 'Announce'),
      `the pod's outbox entries this machine never had are merged back (${n2})`);
    check(!ob.includes(N + 'a-01'),
      'and one whose removal was recorded is not resurrected by the merge');
  }

  // ---- one account, one pod, refused before anything is made ----
  // A second pod on the same account is what produced a credential bound to the
  // wrong WebID. The refusal has to come BEFORE the create call, or the pod
  // exists and the account is left in the state that caused it.
  {
    const { createAccountWithPod } = await import(path.join(root, 'lib/account.mjs'));
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push(`${init.method || 'GET'} ${u}`);
      const j = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/login/password/')) return j({ authorization: 'A' });
      if (u.endsWith('/.account/')) return j({ controls: { account: { pod: 'https://i.example/.account/pod/' } } });
      if (u.endsWith('/.account/pod/') && (init.method || 'GET') === 'GET') {
        return j({ pods: { 'https://taken.i.example/': { webId: 'https://taken.i.example/profile/card#me' } } });
      }
      return j({ pod: 'https://made.i.example/' });
    };
    let err = null;
    try {
      await createAccountWithPod({ issuer: 'https://i.example', email: 'a@b.c', password: 'pw', podName: 'second' });
    } catch (e) { err = e.message; }
    globalThis.fetch = realFetch;
    check(/already has a pod/.test(err || '') && /one account, one pod/.test(err || ''),
      'a second pod on the same account is refused, naming the one it already has');
    check(!calls.some(c => c.startsWith('POST https://i.example/.account/pod/')),
      'and refused BEFORE the create call — nothing is left behind on the server');
  }

  // ---- the credential must be bound to the pod it is for ----
  // An account with two pods has two WebIDs. Minting against the first one
  // authenticates fine and then 403s every write to the second — which reads as
  // a broken server rather than a mis-bound token, and cost a real setup.
  {
    const { runSetup, newRun } = await import(path.join(root, 'lib/setup.mjs'));
    const whome = fs.mkdtempSync('/tmp/dk-ap-webid-');
    let minted = null;
    const fakeAgent = {
      urls: { actor: 'https://x.example/ap/actor' },
      store: { getConfig: () => ({}), setConfig: () => {}, flush: async () => {} },
      publisher: { publishProfile: async () => ({ unreachable: [] }) },
      bootstrap: async () => {}, connect: async () => {},
    };
    await runSetup({
      home: whome, agent: fakeAgent, run: newRun(), log: () => {},
      answers: { mode: 'new', issuer: 'https://i.example', email: 'a@b.c', password: 'pw',
        handle: 'group', podName: 'activitypub', kind: 'person' },
      deps: {
        createAccountWithPod: async () => ({
          pod: 'https://activitypub.i.example/',
          webId: 'https://activitypub.i.example/profile/card#me',
        }),
        mintCredential: async (o) => {
          minted = o;
          return { clientId: 'C', secret: 'S', webId: o.webId };
        },
      },
    });
    check(minted?.webId === 'https://activitypub.i.example/profile/card#me',
      'the credential is minted for the WebID of the pod just created, not the account default');
    check(minted?.podUrl === 'https://activitypub.i.example/',
      'and the pod goes along too, so an existing-pod run can pick the matching WebID');
    fs.rmSync(whome, { recursive: true, force: true });
  }

  // ---- the profile editor, as a Mastodon client drives it ----
  // Everything Phanpy's modal sends: both text fields, both pictures as file
  // uploads, and the extra-field rows. The pictures must end up in the pod's
  // media container, because the actor document carries a URL, not bytes.
  {
    const { MastoApi } = await import(path.join(root, 'lib/mastoapi.mjs'));
    const wire2 = await import(path.join(root, 'lib/wire.mjs'));
    const purls = wire2.apUrls('https://solo.example/');
    let pcfg = { handle: 'solo', name: 'solo', kind: 'person' };
    const uploaded = [];
    let republished = 0;
    const pstore = {
      getConfig: () => pcfg, setConfig: (c) => { pcfg = c; }, flush: async () => {},
      getActors: () => ({}), getContacts: () => ({ followers: [], following: [] }),
      getStatuses: () => [], idFor: () => 'id', getMedia: () => ({}), setMedia: () => {},
      read: (n, d) => (n === 'masto-tokens.json' ? [{ token: 'TKN', createdAt: Date.now() }] : d),
    getBlocklist: () => blocklist, setBlocklist: (b) => { blocklist = b; },
    };
    const papi = new MastoApi({
      agent: {
        configured: () => true, viewer: false, store: pstore, urls: purls,
        publisher: { urls: purls, config: {}, ensureMediaContainer: async () => {},
          publishProfile: async () => { republished++; } },
        remote: { put: async (u, d, ct) => uploaded.push({ u, ct }) },
      },
      log: () => {},
    });
    const psrv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (!await papi.handle(req, res, u.pathname, u)) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise(r => psrv.listen(0, '127.0.0.1', r));
    const pbase = `http://127.0.0.1:${psrv.address().port}`;
    const B = '----x';
    const part = (n, v, f, ct) => `--${B}\r\nContent-Disposition: form-data; name="${n}"`
      + (f ? `; filename="${f}"\r\nContent-Type: ${ct}\r\n` : '\r\n') + `\r\n${v}\r\n`;
    const sent = part('display_name', 'Solo Actor') + part('note', 'plays records')
      + part('fields_attributes[0][name]', 'Web') + part('fields_attributes[0][value]', 'https://example.org')
      + part('fields_attributes[1][name]', '') + part('fields_attributes[1][value]', 'dropped')
      + part('avatar', 'PNG', 'a.png', 'image/png') + part('header', 'JPG', 'h.jpg', 'image/jpeg')
      + `--${B}--\r\n`;
    const saved = await fetch(pbase + '/api/v1/accounts/update_credentials', {
      method: 'PATCH', body: sent,
      headers: { 'content-type': `multipart/form-data; boundary=${B}`, authorization: 'Bearer TKN' },
    });
    const acct = await saved.json();

    check(saved.status === 200 && pcfg.name === 'Solo Actor' && pcfg.summary === 'plays records'
      && republished === 1,
      'a client can set the display name and bio, and the actor is republished');
    check(uploaded.length === 2 && String(pcfg.icon).startsWith(purls.media)
      && String(pcfg.image).startsWith(purls.media),
      'both pictures are uploaded to the pod and the actor carries their URLs');
    check(JSON.stringify(pcfg.fields) === JSON.stringify([{ name: 'Web', value: 'https://example.org' }]),
      'extra fields survive, and a row with no name is a deletion rather than a blank');
    check(acct.display_name === 'Solo Actor' && acct.note === 'plays records'
      && acct.fields?.[0]?.name === 'Web' && acct.header !== acct.avatar,
      'and the client gets the saved profile back, not an empty one');

    const vc = await (await fetch(pbase + '/api/v1/accounts/verify_credentials',
      { headers: { authorization: 'Bearer TKN' } })).json();
    check(vc.source?.note === 'plays records' && vc.source?.fields?.[0]?.value === 'https://example.org',
      'and `source` gives the editor the raw text to reopen with, not rendered HTML');

    const pdoc = wire2.actorDoc({ urls: purls, handle: 'solo', name: pcfg.name, publicKeyPem: 'P',
      summary: pcfg.summary, icon: pcfg.icon, image: pcfg.image, fields: pcfg.fields });
    check(pdoc.image?.type === 'Image' && pdoc.attachment?.[0]?.type === 'PropertyValue'
      && pdoc.attachment[0].value === 'https://example.org'
      && JSON.stringify(pdoc['@context']).includes('PropertyValue'),
      'the actor publishes image and attachment, with PropertyValue declared in the context');
    psrv.close();
  }

  const bare = await fetch(`http://localhost:${CPORT}/`, { redirect: 'manual' });
  check(bare.status === 200, `a configured person still gets the client at / (${bare.status})`);

  // A tailnet name or reverse-proxy domain may carry the fediverse side. It may
  // not create accounts or edit the record.
  const { default: net14 } = await import('node:net');
  const XPORT = CPORT + 1;
  process.env.AP_ALLOWED_HOSTS = `box.tailnet.example:${XPORT}`;
  startAdmin({ port: XPORT, gateToken: '', agent: cagent, handle: 'solo', log: () => {} });
  delete process.env.AP_ALLOWED_HOSTS;
  await new Promise(r => setTimeout(r, 150));
  const rawPost = (host, p, body) => new Promise((resolve) => {
    const s = net14.connect(XPORT, '127.0.0.1', () => {
      s.write(`POST ${p} HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\n`
        + `content-length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    let buf = '';
    s.on('data', d => { buf += d; });
    s.on('end', () => resolve(buf));
    s.on('error', () => resolve(''));
  });
  const exposedEdit = await rawPost(`box.tailnet.example:${XPORT}`, '/config', '{}');
  const exposedSetup = await rawPost(`box.tailnet.example:${XPORT}`, '/setup', '{"handle":"x"}');
  const localEdit = await rawPost(`localhost:${XPORT}`, '/config', '{}');
  check(/^HTTP\/1\.1 403/.test(exposedEdit) && /^HTTP\/1\.1 403/.test(exposedSetup)
    && /^HTTP\/1\.1 200/.test(localEdit),
    'an agent exposed under another name serves the fediverse there, not its own setup');

  fs.rmSync(CHOME, { recursive: true, force: true });
}

// --- 14b. migration aliases: alsoKnownAs carries them, and the /alias route ---
{
  // The wire half: the WebID first, then every alias, and the term declared
  // whenever either is present.
  const au = wire.apUrls('https://you.example/');
  const both = wire.actorDoc({
    urls: au, handle: 'you', publicKeyPem: 'K',
    webId: 'https://you.example/profile/card#me', aliases: ['https://old.example/users/you'],
  });
  check(JSON.stringify(both.alsoKnownAs)
    === JSON.stringify(['https://you.example/profile/card#me', 'https://old.example/users/you']),
    'alsoKnownAs lists the WebID first, then the alias');
  const aliasOnly = wire.actorDoc({
    urls: au, handle: 'you', publicKeyPem: 'K', aliases: ['https://old.example/users/you'],
  });
  check(JSON.stringify(aliasOnly.alsoKnownAs) === JSON.stringify(['https://old.example/users/you'])
    && aliasOnly['@context'].some(c => typeof c === 'object' && c.alsoKnownAs),
    'an alias with no WebID still declares and carries alsoKnownAs');
  const neither = wire.actorDoc({ urls: au, handle: 'you', publicKeyPem: 'K' });
  check(neither.alsoKnownAs === undefined
    && !neither['@context'].some(c => typeof c === 'object' && c.alsoKnownAs),
    'no WebID and no aliases → no alsoKnownAs and no stray term declaration');

  // publishMove builds its own actor doc, so an alias has to survive the move.
  const { Publisher: PubM } = await import(path.join(root, 'lib/publisher.mjs'));
  const putDocs = {};
  const mpub = new PubM({
    config: { remotePod: 'https://you.example/', handle: 'you', name: 'You',
      aliases: ['https://old.example/users/you'] },
    remote: {
      webId: 'https://you.example/profile/card#me',
      putJson: async (u, doc) => { putDocs[u] = doc; },
      setAcl: async () => {},
    },
    local: {},
    store: {
      getContacts: () => ({ followers: [{ actor: 'https://a.example/u/x', inbox: 'https://a.example/i' }], following: [] }),
      getConfig: () => ({}), setConfig: () => {}, flush: async () => true,
    },
    deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'K', log: () => {},
  });
  await mpub.publishMove('https://new.example/users/you');
  const movedActor = putDocs[mpub.urls.actor];
  check(movedActor?.movedTo === 'https://new.example/users/you'
    && movedActor.alsoKnownAs?.includes('https://old.example/users/you'),
    'publishMove keeps the aliases on the actor it leaves behind');

  // The route half: resolve to the canonical id, dedup, republish; removal
  // asks first; a pod nobody can WebFinger is refused as a Move target.
  const { startAdmin: startAdminA } = await import(path.join(root, 'lib/admin.mjs'));
  const APORT = 18661;
  const astore = new PodStore({ log: () => {} });
  astore.setConfig({ remotePod: 'https://solo.example/', handle: 'solo', name: 'solo',
    issuer: 'https://example', kind: 'person' });
  const aurls = wire.apUrls('https://solo.example/');
  const republishedA = [];
  const aagent = {
    home: '/tmp/nowhere-aliases', store: astore, urls: aurls,
    configured: () => true, logLines: () => [],
    status: () => ({ configured: true, mode: 'active', kind: 'person', handle: 'solo', actor: aurls.actor }),
    readCredential: () => ({ webId: 'https://solo.example/profile/card#me' }),
    requestTakeover: async () => true,
    intake: {
      // The profile URL answers with the canonical id, and the canonical id
      // vouches for itself — the second fetch the route makes before storing.
      fetchAP: async (u) => (
        u === 'https://old.example/@you' ? { id: 'https://old.example/users/you', type: 'Person' }
        : u === 'https://old.example/users/you' ? { id: 'https://old.example/users/you', type: 'Person' }
        : u === aurls.actor ? { id: aurls.actor, type: 'Person' }
        : null),
    },
    publisher: {
      urls: aurls, config: {},
      publishProfile: async () => { republishedA.push(1); return { unreachable: [] }; },
    },
  };
  startAdminA({ port: APORT, gateToken: '', agent: aagent, handle: 'solo', log: () => {} });
  await new Promise(r => setTimeout(r, 150));
  const apost = (body) => fetch(`http://localhost:${APORT}/alias`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const added = await apost({ add: 'https://old.example/@you' });
  check(added.status === 200
    && JSON.stringify(added.json?.aliases) === JSON.stringify(['https://old.example/users/you'])
    && astore.getConfig().aliases?.[0] === 'https://old.example/users/you'
    && aagent.publisher.config.aliases?.[0] === 'https://old.example/users/you'
    && republishedA.length === 1,
    'adding an alias stores the canonical id, patches the live config, and republishes');

  const again = await apost({ add: 'https://old.example/@you' });
  check(again.status === 200 && again.json?.aliases.length === 1,
    'adding the same account twice keeps one entry');

  const unresolved = await apost({ add: 'https://gone.example/users/x' });
  check(unresolved.status === 400 && /could not fetch/.test(unresolved.json?.error || ''),
    'an old account that does not answer is refused, never stored as typed');

  // A URL whose answer names an id that does not vouch for itself is refused:
  // the stub answers the liar's URL but the claimed id dereferences to nothing.
  aagent.intake.fetchAP = ((orig) => async (u) => (
    u === 'https://liar.example/thing' ? { id: 'https://victim.example/users/x', type: 'Person' } : orig(u)
  ))(aagent.intake.fetchAP);
  const liar = await apost({ add: 'https://liar.example/thing' });
  check(liar.status === 400 && astore.getConfig().aliases.length === 1,
    'an id one host claims for another is not stored until it vouches for itself');

  const self = await apost({ add: aurls.actor });
  check(self.status === 400 && /this account/.test(self.json?.error || ''),
    'the actor cannot be its own alias');

  const rmAsk = await apost({ remove: 'https://old.example/users/you' });
  check(rmAsk.status === 409 && astore.getConfig().aliases.length === 1,
    'removal without confirm is a warning, and nothing changes');
  const rmYes = await apost({ remove: 'https://old.example/users/you', confirm: true });
  check(rmYes.status === 200 && rmYes.json?.aliases.length === 0
    && astore.getConfig().aliases.length === 0,
    'confirmed removal takes the alias off and republishes');

  aagent.publisher.urls = wire.apUrls('https://shared.example/people/solo/');
  const dark = await apost({ add: 'https://old.example/@you' });
  check(dark.status === 400 && /WebFinger/.test(dark.json?.error || ''),
    'a path-hosted pod is refused as a Move target, and told why');
  aagent.publisher.urls = aurls;

  const cfgGet = await fetch(`http://localhost:${APORT}/config`).then(r => r.json());
  check(Array.isArray(cfgGet.aliases), 'GET /config reports the aliases list for the page');

  // ---- the follower landing pad: auto-accept is a setting, the queue answers as one ----
  const cpostA = (path2, body) => fetch(`http://localhost:${APORT}${path2}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const auto = await cpostA('/config', { autoAcceptFollows: true });
  check(auto.status === 200 && auto.json.published === false
    && astore.getConfig().autoAcceptFollows === true
    && aagent.publisher.config.autoAcceptFollows === true
    && auto.json.config.autoAcceptFollows === true,
    'autoAcceptFollows is a setting: stored, patched into the LIVE config, not republished');

  const delivered = [];
  const published = [];
  astore.setRequests([
    { actor: 'https://a.example/u/1', inbox: 'https://a.example/i1', activity: { id: 'f1' }, at: 'T' },
    { actor: 'https://a.example/u/2', inbox: 'https://a.example/i2', activity: { id: 'f2' }, at: 'T' },
    { actor: 'https://b.example/u/3', inbox: 'https://b.example/i3', activity: { id: 'f3' }, at: 'T' },
  ]);
  aagent.deliverer = { deliver: async (inbox, act) => { delivered.push([inbox, act.type]); } };
  aagent.publisher.publishCollections = async (which) => { published.push(which); };
  const bulk = await cpostA('/admit', { all: true });
  check(bulk.status === 200 && bulk.json.admitted === 3 && bulk.json.requests === 0
    && astore.getContacts().followers.length === 3,
    'admit --all answers the whole queue and every follower lands in contacts');
  check(delivered.length === 3 && delivered.every(([, t]) => t === 'Accept'),
    'each of them still gets its own Accept');
  check(published.length === 1 && published[0].followers === true && published[0].pending === true,
    'and the collections republish exactly once for the lot');
}

// --- 14c. CSV import: parsing, staging, and the paced worker ---
{
  const { parseCsv, normalizeImport, ImportWorker, IMPORT_STATE_DOC } =
    await import(path.join(root, 'lib/import.mjs'));

  // ---- parsing ----
  check(JSON.stringify(parseCsv('a,"b,c",d\r\n"say ""hi""",x\n'))
    === JSON.stringify([['a', 'b,c', 'd'], ['say "hi"', 'x']]),
    'CSV parsing survives quoted commas, doubled quotes and CRLF');

  const fol = normalizeImport('follow',
    'Account address,Show boosts,Notify on new posts,Languages\n'
    + 'mei@a.example,true,false,\n@kofi@b.example,true,,\nnot-a-handle\n');
  check(JSON.stringify(fol.values) === JSON.stringify(['mei@a.example', 'kofi@b.example'])
    && fol.invalid.length === 1,
    'a following export: header dropped, extra columns ignored, @ stripped, junk counted');

  const lst = normalizeImport('list', 'Birds,mei@a.example\n"Close, personal",kofi@b.example\n');
  check(JSON.stringify(lst.values) === JSON.stringify([
    { value: 'mei@a.example', list: 'Birds' }, { value: 'kofi@b.example', list: 'Close, personal' },
  ]), 'a lists export keeps the list title, commas and all');

  const dom = normalizeImport('domain', 'spam.example\nSub.Bad.example\nnot a domain\n');
  check(JSON.stringify(dom.values) === JSON.stringify(['spam.example', 'sub.bad.example'])
    && dom.invalid.length === 1,
    'a domain export lowercases and keeps only real domains');

  const hashList = normalizeImport('list', '#birds,mei@a.example\n');
  check(hashList.values.length === 1 && hashList.values[0].list === '#birds',
    'a list titled with # is a title, not a comment');

  // ---- the worker, offline: a fake agent and a stubbed resolve ----
  const events = [];
  const iurls = wire.apUrls('https://you.example/');
  const istore = new PodStore({ log: () => {} });
  istore.setContacts({ followers: [], following: [{ actor: 'https://a.example/u/old', inbox: 'https://a.example/i', handle: 'old@a.example', accepted: true }] });
  const iagent = {
    store: istore,
    urls: iurls,
    publisher: { urls: iurls, publishCollections: async (w) => { events.push(['publish', w]); } },
    deliverer: { deliver: async (inbox, act) => { events.push(['deliver', act.type, inbox]); } },
    intake: { fetchAP: async () => null },
    remote: { pausedUntil: 0 },
    lease: { stillHeld: () => true },
  };
  const w = new ImportWorker({ agent: iagent, log: () => {} });

  const staged = w.stage('follow', ['mei@a.example', 'mei@a.example', 'old@a.example']);
  w.stop();                                   // driven by hand below
  check(staged.staged === 1 && staged.duplicate === 1 && staged.already === 1,
    'staging dedupes: one new row, one duplicate, one already followed');

  w.resolve = async (h) => ({ id: `https://a.example/u/${h.split('@')[0]}`, inbox: 'https://a.example/inbox' });
  istore.write = ((orig) => function (doc, val) {   // watch the contact write order
    if (doc === 'contacts.json') events.push(['contacts', val.following.length]);
    return orig.call(this, doc, val);
  })(istore.write);
  await w.tick();
  const deliverAt = events.findIndex(e => e[0] === 'deliver');
  const contactsAt = events.findIndex(e => e[0] === 'contacts' && e[1] === 2);
  check(deliverAt > -1 && contactsAt > -1 && contactsAt < deliverAt,
    'a follow records the contact BEFORE the Follow leaves, so its Accept can land');
  check(istore.getContacts().following.find(f => f.handle === 'mei@a.example')?.accepted === false,
    'the imported follow waits as unaccepted, like any other');
  check(!events.some(e => e[0] === 'publish'),
    'no per-row collections republish');

  await w.tick();                             // nothing pending → finish
  const st1 = istore.read(IMPORT_STATE_DOC, null);
  check(st1.completedAt && events.filter(e => e[0] === 'publish').length === 1
    && events.find(e => e[0] === 'publish')[1].following === true,
    'the run closes with ONE collections republish for all the follows');

  // blocks: domain rows land in one tick; handle rows resolve then apply
  const w2 = new ImportWorker({ agent: iagent, log: () => {} });
  w2.resolve = async () => ({ id: 'https://bad.example/u/troll' });
  w2.stage('domain', ['spam.example', 'worse.example']);
  w2.stop();
  await w2.tick();
  check(JSON.stringify(istore.getBlocklist().domains) === JSON.stringify(['spam.example', 'worse.example']),
    'domain rows are free and land as one batch');
  w2.stage('block', ['troll@bad.example']);
  w2.stop();
  await w2.tick();
  check(istore.getBlocklist().actors.includes('https://bad.example/u/troll'),
    'a blocked handle resolves to its actor before it can match anything');
  w2.stage('mute', ['troll@bad.example']);
  w2.stop();
  await w2.tick();
  check(istore.getMuted().actors.includes('https://bad.example/u/troll'), 'mutes the same way');
  // The list row keeps the REAL resolve: a handle already in contacts answers
  // from the record, so this passes with a fetchAP that returns nothing.
  const w2b = new ImportWorker({ agent: iagent, log: () => {} });
  w2b.stage('list', [{ value: 'old@a.example', list: 'Birds' }]);
  w2b.stop();
  await w2b.tick();
  const list1 = istore.getLists().find(l => l.title === 'Birds');
  check(list1?.members?.[0] === 'https://a.example/u/old',
    'a list row reuses the contact record — no network for a handle we follow');

  // pauses: the pod's backoff and a lost lease both hold the row, unjudged
  const w3 = new ImportWorker({ agent: iagent, log: () => {} });
  w3.resolve = async () => { throw new Error('unreachable'); };
  w3.stage('follow', ['gone@dead.example']);
  w3.stop();
  iagent.remote.pausedUntil = Date.now() + 60_000;
  await w3.tick();
  check(istore.read(IMPORT_STATE_DOC, null).rows.find(r => r.value === 'gone@dead.example').status === 'pending',
    'the pod asking for quiet pauses the run — no row is failed for it');
  iagent.remote.pausedUntil = 0;
  iagent.lease = { stillHeld: () => false };
  await w3.tick();
  check(istore.read(IMPORT_STATE_DOC, null).rows.find(r => r.value === 'gone@dead.example').status === 'pending',
    'a lost lease holds the run for whoever took over');
  iagent.lease = { stillHeld: () => true };
  w3.lastFollowAt = 0;
  await w3.tick();
  check(istore.read(IMPORT_STATE_DOC, null).rows.find(r => r.value === 'gone@dead.example').status === 'failed',
    'a host that really is dead fails its row and the run moves on');

  await w3.tick();                            // nothing pending → the run closes
  check(istore.read(IMPORT_STATE_DOC, null).completedAt
    && events.some(e => e[0] === 'publish' && e[1].blocked === true),
    'closing a run that blocked anyone republishes the blocked collection once');

  // resume: an unclosed run re-arms; a closed one stays closed
  const w4 = new ImportWorker({ agent: iagent, log: () => {} });
  w4.resume();
  check(w4.timer === null, 'a completed run does not restart the worker');

  // ---- the race the review caught: rows staged or cleared while a row is
  // in flight survive it — verdicts commit against a FRESH read ----
  let releaseRow;
  const w5 = new ImportWorker({ agent: iagent, log: () => {} });
  w5.resolve = () => new Promise(r => {
    releaseRow = () => r({ id: 'https://x.example/u/slow', inbox: 'https://x.example/i' });
  });
  w5.stage('follow', ['slow@x.example']);
  w5.stop();
  const inFlight = w5.tick();                 // holds at the resolve await
  await new Promise(r => setTimeout(r, 10));
  w5.stage('follow', ['late@y.example']);     // lands while the row travels
  w5.stop();
  releaseRow();
  await inFlight;
  const stR = istore.read(IMPORT_STATE_DOC, null);
  check(stR.rows.find(r => r.value === 'slow@x.example')?.status === 'done'
    && stR.rows.find(r => r.value === 'late@y.example')?.status === 'pending',
    'a batch staged while a row is in flight survives the row landing');

  let releaseRow2;
  const w6 = new ImportWorker({ agent: iagent, log: () => {} });
  w6.resolve = () => new Promise(r => {
    releaseRow2 = () => r({ id: 'https://z.example/u/a', inbox: 'https://z.example/i' });
  });
  w6.stage('follow', ['a@z.example']);
  w6.stop();
  const inFlight2 = w6.tick();
  await new Promise(r => setTimeout(r, 10));
  w6.clear();                                 // cancel while the row travels
  releaseRow2();
  await inFlight2;
  check(istore.read(IMPORT_STATE_DOC, null).rows.length === 0,
    'clear() during an in-flight row stays cleared — nothing resurrects');

  // ---- the route: CSV text in, staged counts out, progress readable ----
  const { startAdmin: startAdminI } = await import(path.join(root, 'lib/admin.mjs'));
  const IPORT = 18662;
  const rstore = new PodStore({ log: () => {} });
  rstore.setConfig({ remotePod: 'https://imp.example/', handle: 'imp', name: 'imp',
    issuer: 'https://example', kind: 'person' });
  const ragent2 = {
    home: '/tmp/nowhere-import', store: rstore, urls: wire.apUrls('https://imp.example/'),
    configured: () => true, logLines: () => [],
    status: () => ({ configured: true, mode: 'active', kind: 'person', handle: 'imp' }),
    readCredential: () => ({ webId: 'https://imp.example/profile/card#me' }),
    requestTakeover: async () => true,
    publisher: { urls: wire.apUrls('https://imp.example/'), config: {} },
  };
  ragent2.importer = new ImportWorker({ agent: ragent2, log: () => {} });
  startAdminI({ port: IPORT, gateToken: '', agent: ragent2, handle: 'imp', log: () => {} });
  await new Promise(r => setTimeout(r, 150));
  const ipost = (body) => fetch(`http://localhost:${IPORT}/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const badKind = await ipost({ kind: 'bookmarks', text: 'x' });
  check(badKind.status === 400 && /kind must be/.test(badKind.json?.error || ''),
    'an unknown kind is refused with the list of real ones');
  const stagedD = await ipost({ kind: 'domain', text: 'spam.example\nnot a domain\n' });
  check(stagedD.status === 200 && stagedD.json.staged === 1 && stagedD.json.invalid === 1
    && stagedD.json.invalidSample?.[0] === 'not a domain',
    'staging over HTTP counts what it took and quotes what it could not read');
  ragent2.importer.stop();                    // hand-drive the applier
  await ragent2.importer.tick();
  const prog = await fetch(`http://localhost:${IPORT}/import`).then(r => r.json());
  check(prog.done === 1 && prog.pending === 0
    && rstore.getBlocklist().domains.includes('spam.example'),
    'GET /import shows the progress the worker made');
  const cleared = await ipost({ clear: true });
  check(cleared.status === 200 && cleared.json.cleared === true
    && (await fetch(`http://localhost:${IPORT}/import`).then(r => r.json())).rows === 0,
    'clear drops the record');

  ragent2.requestTakeover = async () => false;
  const refusedT = await ipost({ kind: 'domain', text: 'x.example\n' });
  check(refusedT.status === 503 && /another device/.test(refusedT.json?.error || ''),
    'a device that cannot take the lease is refused — no second worker runs');
}

// --- 15. the private half in a pod of its own, and the drain that respects it ---
{
  const PPORT = 18631;
  // Just enough LDP for PodStore: PUT stores, GET returns, GET on a container
  // lists its children as Turtle. `refuse` turns the pod read-only.
  const docs = new Map();
  let refuse = false;
  const privatePod = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'PUT') {
      if (refuse) { res.writeHead(403); res.end(); return; }
      docs.set(p, body); res.writeHead(201); res.end(); return;
    }
    if (req.method === 'DELETE') { docs.delete(p); res.writeHead(205); res.end(); return; }
    if (p.endsWith('/')) {
      const names = [...docs.keys()].filter(k => k.startsWith(p) && k !== p);
      if (!names.length) { res.writeHead(404); res.end(); return; }   // not created yet
      res.writeHead(200, { 'content-type': 'text/turtle' });
      // What a real LDP container says, so the parser has something true to read.
      res.end('<> <http://www.w3.org/ns/ldp#contains> '
        + names.map(n => `<${n.slice(p.length)}>`).join(', ') + ' .\n');
      return;
    }
    if (!docs.has(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(docs.get(p));
  });
  await new Promise(r => privatePod.listen(PPORT, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${PPORT}/private/ap-state/`;
  const plainFetch = (u, i) => fetch(u, i);

  const st = new PodStore({ log: () => {} });
  attachHttp(st, BASE, plainFetch);
  st.setConfig({ handle: 'x' });
  check(await st.commit() === true && docs.has('/private/ap-state/config.json'),
    'commit() says the write landed, and it really is in the pod');

  refuse = true;
  st.setConfig({ handle: 'y' });
  check(await st.commit() === false,
    'a refused write is reported as NOT landed — flush() used to swallow this');
  refuse = false;

  const st2 = new PodStore({ log: () => {} });
  attachHttp(st2, BASE, plainFetch);
  await st2.load();
  check(st2.getConfig()?.handle === 'x', 'a second store reads it back out of the container');

  const mem = new PodStore({ log: () => {} });
  mem.setConfig({ handle: 'z' });
  check(await mem.commit() === true, 'a store with no pod behind it counts as written');

  // --- the drain must not delete what it could not write down ---
  const INBOX = 'https://remote.example/ap/inbox/';
  const item = INBOX + 'a1';
  const deleted = [];
  const iStore = new PodStore({ log: () => {} });
  attachHttp(iStore, BASE, plainFetch);
  const intake15 = new Intake({
    config: { handle: 'x' },
    urls: { inbox: INBOX, actor: 'https://remote.example/ap/actor', notes: 'https://remote.example/ap/notes/' },
    store: iStore,
    log: () => {},
    remote: {
      listContainer: async () => [{ url: item, size: 420, modified: "2026-07-30T00:00:00.000Z" }],
      // Unparsable on purpose: a guaranteed rejection, so the item's only
      // record is the dead letter the store is about to be asked to keep.
      fetch: async () => ({ status: 200, text: async () => 'not json' }),
      delete: async (u) => { deleted.push(u); return true; },
      getJson: async () => null,
    },
    local: { writeNote: async () => {} },
    deliverer: { deliver: async () => {}, deliverToAll: async () => {} },
    publisher: { urls: {}, config: {} },
  });
  check(intake15.strictCommit === undefined
    && !/strictCommit/.test(fs.readFileSync(path.join(root, 'lib/intake.mjs'), 'utf8')),
    'the drain commits before it deletes unconditionally — no same-origin exemption');

  refuse = true;
  await intake15.drain();
  check(deleted.length === 0,
    `nothing is deleted while the state pod refuses writes (${deleted.length} deleted)`);
  check(iStore.getDeadLetters().length === 1,
    'the dead letter is held in memory, waiting for a pod that will take it');

  refuse = false;
  intake15.drainCooldownUntil = 0;
  await intake15.drain();
  check(deleted.includes(item) && docs.has('/private/ap-state/deadletter.json'),
    'and the item is deleted only once the write has landed');

  // --- privateRoot moves both private trees, and never the lease ---
  const { Agent } = await import(path.join(root, 'run-agent.mjs'));
  const a15 = new Agent({ home: '/tmp/fedipod-private-probe', log: () => {} });
  a15.urls = wire.apUrls('https://pod.example/');
  const onPod = a15.privateUrls({ remotePod: 'https://pod.example/' });
  check(onPod.state === a15.urls.state && onPod.fediverse === a15.urls.fediverse
    && onPod.elsewhere === false,
    'without privateRoot the private half stays on the pod, exactly as before');
  const off = a15.privateUrls({ remotePod: 'https://pod.example/', privateRoot: 'http://localhost:8000/dk-pod/ap' });
  check(off.state === 'http://localhost:8000/dk-pod/ap/ap-state/'
    && off.fediverse === 'http://localhost:8000/dk-pod/ap/fediverse/' && off.elsewhere === true,
    'privateRoot moves both trees together, laid out as on the pod');
  check(a15.urls.state.startsWith('https://pod.example/'),
    'and urls.state — which is where the lease is built — is untouched by it');
  const podFetch = a15.privateUrls.call({ urls: a15.urls }, { remotePod: 'https://pod.example/' });
  check(podFetch.elsewhere === false, 'the default configuration is unchanged');

  // --- the same store over a directory: no server, no round-trip ---
  const FDIR = fs.mkdtempSync('/tmp/fedipod-files-');
  const fstore = new PodStore({ log: () => {} });
  fstore.attach(new FileStorage(FDIR + '/ap-state/'));
  fstore.setConfig({ handle: 'onfiles', name: 'On Files' });
  fstore.setBlocklist({ domains: ['bad.example'], actors: [] });
  check(await fstore.commit() === true && fs.existsSync(path.join(FDIR, 'ap-state/config.json')),
    'a file-backed store writes real files');
  check(!fs.readdirSync(path.join(FDIR, 'ap-state')).some(n => n.endsWith('.tmp')),
    'and leaves no temp file behind — a write is rename-into-place, so nothing reads half of one');
  check((fs.statSync(path.join(FDIR, 'ap-state/config.json')).mode & 0o777) === 0o600,
    'owner-only, like the credential beside it');

  const fstore2 = new PodStore({ log: () => {} });
  fstore2.attach(new FileStorage(FDIR + '/ap-state/'));
  await fstore2.load();
  check(fstore2.getConfig()?.handle === 'onfiles' && fstore2.getBlocklist().domains[0] === 'bad.example',
    'and reads them back with no container document anywhere in sight');

  const missingDir = new PodStore({ log: () => {} });
  missingDir.attach(new FileStorage(FDIR + '/never-made/'));
  await missingDir.load();
  check(missingDir.getConfig() === null, 'a directory that is not there yet is "nothing", not an error');

  await fstore2.remove('blocklist.json');
  check(!fs.existsSync(path.join(FDIR, 'ap-state/blocklist.json')), 'remove() removes it');

  const frdf = new PodRdf({ storage: new FileStorage(FDIR + '/fediverse/') });
  await frdf.writeNote('posts', 'p1', {
    noteId: 'https://m.example/n/9', actor: 'https://m.example/u/a',
    published: '2026-07-31T00:00:00Z', content: 'on\tdisk "quoted"',
  });
  const fnotes = await frdf.listNotes('posts');
  const fback = await frdf.readNote(fnotes[0]);
  check(fnotes.length === 1 && fback.content === 'on\tdisk "quoted"'
    && fback.noteId === 'https://m.example/n/9',
    `notes round-trip on files too (${fnotes.length} listed)`);

  let escaped = null;
  try { await new FileStorage(FDIR + '/ap-state/').read('../../etc/passwd'); }
  catch (e) { escaped = e.message; }
  check(/escapes the container/.test(escaped || ''),
    `a path may not climb out of its container (${escaped})`);
  fs.rmSync(FDIR, { recursive: true, force: true });

  // --- `fedipod state --to` copies and verifies before it repoints ---
  const SHOME15 = fs.mkdtempSync('/tmp/fedipod-move-');
  const SRC = `http://127.0.0.1:${PPORT}/moveA/`;
  const DST = `http://127.0.0.1:${PPORT}/moveB/`;
  fs.writeFileSync(path.join(SHOME15, 'credential.json'), JSON.stringify({
    remotePod: 'https://pod.example/', privateRoot: SRC,
    clientId: 'c', secret: 's', webId: 'https://pod.example/profile/card#me',
    tokenEndpoint: 'https://pod.example/.oidc/token', issuerOrigin: 'https://pod.example',
  }, null, 2));
  const seed = new PodStore({ log: () => {} });
  attachHttp(seed, SRC + 'ap-state/', plainFetch);
  seed.setConfig({ remotePod: 'https://pod.example/', handle: 'mover', name: 'Mover' });
  seed.setBlocklist({ domains: ['bad.example'], actors: [] });
  await seed.commit();
  await fetch(SRC + 'fediverse/posts/n1', { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<> a as:Note .\n' });

  // ASYNC, deliberately: the CLI talks to the pod being served by THIS
  // process, so a synchronous exec would deadlock waiting on itself.
  const { execFile } = await import('node:child_process');
  const runCli = (args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'bin/fedipod.mjs'), ...args],
      { env: { ...process.env, AP_HOME: SHOME15, AP_PORT: '18632' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout) + String(stderr) }));
  });

  const shown = await runCli(['state']);
  check(shown.ok && shown.out.includes(SRC), `state reports where the private half is (${shown.ok})`);

  refuse = true;
  const blocked = await runCli(['state', '--to', DST]);
  const credAfterFail = JSON.parse(fs.readFileSync(path.join(SHOME15, 'credential.json'), 'utf8'));
  check(!blocked.ok && credAfterFail.privateRoot === SRC,
    'a copy that does not land leaves the pointer where it was');
  refuse = false;

  const moved = await runCli(['state', '--to', DST]);
  const credAfter = JSON.parse(fs.readFileSync(path.join(SHOME15, 'credential.json'), 'utf8'));
  check(moved.ok && credAfter.privateRoot === DST + '',
    `and a copy that lands repoints it (${moved.ok ? credAfter.privateRoot : moved.out.slice(-120)})`);
  check(docs.has('/moveB/ap-state/config.json') && docs.has('/moveB/ap-state/blocklist.json')
    && docs.has('/moveB/fediverse/posts/n1'),
    'state documents AND the RDF notes both came across');
  check(docs.has('/moveA/ap-state/config.json'),
    'and the old copy is left behind rather than deleted');

  // `state` PRINTS the path form, so it has to take the path form back — a
  // command that shows you one thing and accepts another is a trap.
  const asPath = path.join(SHOME15, 'by-path');
  const byPath = await runCli(['state', '--to', asPath]);
  const credByPath = JSON.parse(fs.readFileSync(path.join(SHOME15, 'credential.json'), 'utf8'));
  check(byPath.ok && credByPath.privateRoot === pathToFileURL(asPath).href + '/',
    `--to takes a bare path and records it as a file: URL (${byPath.ok ? credByPath.privateRoot : byPath.out.slice(-140)})`);
  check(fs.existsSync(path.join(asPath, 'ap-state', 'config.json')),
    'and the documents really are on disk there');

  const shownPath = await runCli(['state']);
  check(shownPath.out.includes('by-path') && !shownPath.out.includes('file://'),
    `state shows the path rather than the file: URL (${shownPath.out.split('\n')[0]})`);

  // The refusal has to come BEFORE the copy. It used to be the last thing the
  // command did: a typo'd `http://` destination got every state document —
  // masto-tokens.json included — and every RDF note, in the clear, and was then
  // told the address was unacceptable. "nothing was repointed, nothing was
  // deleted" was true, and read as nothing having happened.
  const clear = await runCli(['state', '--to', 'http://nas.local/private/']);
  check(!clear.ok && /unencrypted private-data address/.test(clear.out),
    'a plaintext destination off this machine is refused');
  check(!/moving the private half|copied \d+ state document/.test(clear.out),
    'and refused before a single document is sent, not after they all are');
  // Loopback still crosses no wire, which is what the existing moves rely on.
  const loop = await runCli(['state', '--to', `http://127.0.0.1:${PPORT}/moveC/`]);
  check(loop.ok, `a loopback http destination is still allowed (${loop.ok ? 'ok' : loop.out.slice(-140)})`);

  let CURRENT_LAYOUT = null;
  // --- moving EVERY identity, and knowing which ones are behind ---
  //
  // bbba587 fixed the default and nothing else: `privateRoot` absent still means
  // "on the pod", so every identity set up before it kept the old layout with
  // nothing to show for it. A new default only fixes installs that do not exist
  // yet, which is why this is a numbered step with a runner rather than a note.
  {
    const mig = await import(path.join(root, 'lib/migrate.mjs'));
    CURRENT_LAYOUT = mig.CURRENT_LAYOUT;
    check(mig.layoutOf({}) === 0 && mig.layoutOf({ layout: 1 }) === 1,
      'an unstamped install reads as layout 0 rather than as an error');
    check(mig.needsStateMove({}) && !mig.needsStateMove({ privateRoot: 'file:///x/' }),
      'the private half being absent is what "behind" means');
    check(!mig.needsStateMove({ privateRoot: 'https://pod.example/mine/' }),
      'and an operator who pointed it somewhere deliberately is left alone');
    check(mig.isCurrent({ privateRoot: 'file:///x/' }) && !mig.isCurrent({}),
      'isCurrent is decided by the shape, not by the stamp');

    const base = 'https://pod.example/activitypods-js/ap-state/';
    const { drop, keep } = mig.classifyRemoteState([
      base + 'config.json', base + 'contacts.json', base + 'masto-tokens.json',
      base + 'lease.json', base + '.keep', base + 'something-else.json',
    ], base);
    check(drop.length === 3 && drop.every(d => mig.MOVED_STATE_DOCS.has(d.name)),
      `only the documents the move copied are dropped (${drop.map(d => d.name).join(', ')})`);
    check(keep.some(k => k.name === 'lease.json') && keep.some(k => k.name === '.keep')
      && keep.some(k => k.name === 'something-else.json'),
      'the lease, the container marker and anything not ours are kept');

    // The backstop under all of it: the lease is on the pod BECAUSE the private
    // half need not be, so a migration must never be able to take it.
    const { protectedFromDeletion } = await import(path.join(root, 'lib/remote.mjs'));
    let refused = false;
    try { protectedFromDeletion(base + 'lease.json'); } catch { refused = true; }
    check(refused, 'and RemotePod.delete refuses the lease outright, wherever the call came from');
  }

  {
    // A scratch ROOT, so the sweep has more than one identity to walk.
    const RHOME = fs.mkdtempSync('/tmp/fedipod-root-');
    const profiles = path.join(RHOME, '.fedipod', 'profiles');
    const mkIdentity = (name, cred, agentJson = null) => {
      const dir = path.join(profiles, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'credential.json'), JSON.stringify(cred));
      if (agentJson) fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agentJson));
      return dir;
    };
    const POD = { remotePod: 'https://pod.example/', clientId: 'c', secret: 's' };
    const oldDir = mkIdentity('old', { ...POD });                        // on the pod
    mkIdentity('new', { ...POD, privateRoot: 'file:///tmp/newprivate/' });   // already right

    const runRoot = (args) => new Promise((resolve) => {
      execFile(process.execPath, [path.join(root, 'bin/fedipod.mjs'), ...args],
        { env: { ...process.env, HOME: RHOME, AP_HOME: '', AP_PROFILE: '' } },
        (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout) + String(stderr) }));
    });

    const up = await runRoot(['upgrade']);
    check(up.out.includes('old: layout 0 of 1') && /state-off-pod/.test(up.out),
      'upgrade names the identity that is behind, and the step it is behind on');
    check(/new: layout 0 of 1 — current/.test(up.out) && up.out.includes('stamped as current'),
      'an install that is already the right shape is stamped rather than migrated');
    const newCred = JSON.parse(fs.readFileSync(path.join(profiles, 'new', 'credential.json'), 'utf8'));
    check(newCred.layout === CURRENT_LAYOUT, 'and the stamp lands in its credential');

    const dry = await runRoot(['state', '--all']);
    check(dry.out.includes('ON THE POD') && dry.out.includes('would move to'),
      'the sweep leads with the inventory, not with a mutation');
    check(dry.out.includes('new: already current') && !dry.out.includes('would move to /tmp/newprivate'),
      'and does not offer to move one that is already where it should be');
    const stillOld = JSON.parse(fs.readFileSync(path.join(oldDir, 'credential.json'), 'utf8'));
    check(!stillOld.privateRoot && !stillOld.layout, 'a dry run writes nothing at all');

    // A running agent holds its state write-through, so a copy taken underneath
    // it is overwritten by its next write. The suite's own agent is answering,
    // so pointing an identity at that port is a real live one.
    fs.writeFileSync(path.join(oldDir, 'agent.json'), JSON.stringify({ port: PORT }));
    const busy = await runRoot(['state', '--all', '--apply']);
    check(!busy.ok && /still answering/.test(busy.out),
      `the sweep refuses while any identity is running (${busy.out.split('\n')[0]})`);
    const afterBusy = JSON.parse(fs.readFileSync(path.join(oldDir, 'credential.json'), 'utf8'));
    check(!afterBusy.privateRoot, 'and refusing means refusing all of them, not the ones after it');
    fs.rmSync(path.join(oldDir, 'agent.json'), { force: true });

    // The move itself is `state --to`, tested above. What matters here is that a
    // failure is per-identity and leaves the credential alone rather than half
    // repointed — pod.example does not resolve, so this one cannot succeed.
    const applied = await runRoot(['state', '--all', '--apply']);
    check(/old: FAILED/.test(applied.out),
      `an identity that cannot be moved is reported, not skipped silently (${/old: (\w+)/.exec(applied.out)?.[1]})`);
    const afterFail = JSON.parse(fs.readFileSync(path.join(oldDir, 'credential.json'), 'utf8'));
    check(!afterFail.privateRoot && !afterFail.layout,
      'and its credential still points where it did');

    fs.rmSync(RHOME, { recursive: true, force: true });
  }

  fs.rmSync(SHOME15, { recursive: true, force: true });
  privatePod.close();
}

// --- 16. `npm start`: find a port that binds, detach, open the right page ---
{
  const { execFile } = await import('node:child_process');
  const { default: net16 } = await import('node:net');
  const homes = [];
  const mkHome = (tag) => { const h = fs.mkdtempSync(`/tmp/fedipod-up-${tag}-`); homes.push(h); return h; };
  const run = (home, args) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(root, 'bin/fedipod.mjs'), ...args],
      { env: { ...process.env, AP_HOME: home } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout) + String(stderr) }));
  });

  try {
    const UHOME = mkHome('fresh');
    const up1 = await run(UHOME, ['up', '--no-open', '--port', '18801']);
    check(up1.ok && /admin\/setup\//.test(up1.out) && /port 18801/.test(up1.out),
      'with no identity yet, it opens the setup page');
    check(JSON.parse(fs.readFileSync(path.join(UHOME, 'agent.json'), 'utf8')).port === 18801
      && fs.existsSync(path.join(UHOME, 'agent.pid')),
      'records the port it settled on, and is detached but findable by pidfile');

    const up2 = await run(UHOME, ['up', '--no-open', '--port', '18801']);
    check(up2.ok && /already running/.test(up2.out), 'running it again starts nothing second');

    // A squatter that holds the port and speaks no HTTP — the case a
    // GET /status probe reads as free, after which the agent dies on EADDRINUSE.
    const squatter = net16.createServer(s => s.destroy());
    await new Promise(r => squatter.listen(18803, '127.0.0.1', r));
    const up3 = await run(mkHome('taken'), ['up', '--no-open', '--port', '18803']);
    squatter.close();
    check(up3.ok && /moved to 18804/.test(up3.out),
      `an occupied port is walked past, whatever is holding it (${up3.out.split('\n').find(l => /moved|port/.test(l)) || up3.out.slice(0, 60)})`);

    const CHOME = mkHome('configured');
    fs.writeFileSync(path.join(CHOME, 'credential.json'), JSON.stringify({
      remotePod: 'https://x.example/', clientId: 'c', secret: 's', issuerOrigin: 'https://x.example',
    }));
    fs.writeFileSync(path.join(CHOME, 'agent.json'), JSON.stringify({ port: 18805, handle: 'wren' }));
    const up4 = await run(CHOME, ['up', '--no-open']);
    // The client pinned to the actor, not the bare root — root is vendored
    // Phanpy with no account bound. The old `${origin}/` also matched the
    // origin regex alone, so the path is asserted explicitly.
    check(up4.ok && /http:\/\/wren\.localhost:18805\/admin\/client\//.test(up4.out) && !/admin\/setup/.test(up4.out),
      'an agent that has an identity opens its own client, not bare Phanpy or the form');
  } finally {
    for (const h of homes) await run(h, ['stop']);
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  }
}

// --- 17. the backlog: measured, drained oldest-first, pruned on request ---
{
  const INBOX = 'https://remote.example/ap/inbox/';
  const old = (n) => `2026-07-01T00:00:0${n}.000Z`;
  const recent = new Date().toISOString();
  // A listing as CSS gives it: url, size and modified, deliberately out of order.
  const listing = [
    { url: INBOX + 'big-old', size: 4096, modified: old(2) },
    { url: INBOX + 'small-old', size: 300, modified: old(1) },
    { url: INBOX + 'recent', size: 4096, modified: recent },
    { url: INBOX + '.keep', size: 13, modified: old(0) },
  ];
  const fetched = [];
  const deleted = [];
  const store17 = new PodStore({ log: () => {} });
  const intake17 = new Intake({
    config: { handle: 'x' },
    urls: { inbox: INBOX, actor: 'https://remote.example/ap/actor' },
    store: store17,
    log: () => {},
    remote: {
      listContainer: async () => listing,
      fetch: async (u) => { fetched.push(u); return { status: 200, json: async () => ({ type: 'Follow', actor: 'https://m.example/u/a' }) }; },
      delete: async (u) => { deleted.push(u); return true; },
      getJson: async () => null,
    },
    local: { writeNote: async () => {} },
    deliverer: { deliver: async () => {}, deliverToAll: async () => {} },
    publisher: { urls: {}, config: {} },
  });
  const applied = [];
  intake17.handle = async (a) => { applied.push(a.type); return null; };   // routing is what is under test

  const out = await intake17.prune({ before: '2026-07-02T00:00:00.000Z' });

  check(out.considered === 2, `.keep and anything recent are not candidates (${out.considered})`);
  check(deleted.includes(INBOX + 'big-old') && !fetched.includes(INBOX + 'big-old'),
    'a large old item is deleted UNREAD — one request, and at that size it is content');
  check(fetched.includes(INBOX + 'small-old') && applied.includes('Follow'),
    'a small one is read and APPLIED — the follow graph survives a discard');
  check(!deleted.includes(INBOX + 'recent') && !deleted.includes(INBOX + '.keep'),
    'nothing newer than the cutoff is touched');
  check(out.applied === 1 && out.discarded === 1 && out.dropped === 0,
    `and it says what it did (applied ${out.applied}, discarded ${out.discarded})`);

  // A Create inside the small set is content too: read, classified, dropped.
  const dropped = [];
  intake17.handle = async (a) => { dropped.push(a.type); return null; };
  intake17.remote.fetch = async (u) => { fetched.push(u); return { status: 200, json: async () => ({ type: 'Create' }) }; };
  const out2 = await intake17.prune({ before: '2026-07-02T00:00:00.000Z' });
  check(out2.dropped === 1 && !dropped.includes('Create'),
    'a small Create is read, recognised as content and dropped rather than applied');

  // The listing itself: metadata carried, oldest first, auxiliaries excluded.
  const ttl = `<${INBOX}> a <http://www.w3.org/ns/ldp#Container> ;`
    + ` <http://www.w3.org/ns/ldp#contains> <${INBOX}b>, <${INBOX}a>.`
    + ` <${INBOX}b> <http://purl.org/dc/terms/modified> "2026-07-09T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;`
    + ` <http://www.w3.org/ns/posix/stat#size> 900.`
    + ` <${INBOX}a> <http://purl.org/dc/terms/modified> "2026-07-02T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;`
    + ` <http://www.w3.org/ns/posix/stat#size> 100.`;
  const { RemotePod: RP17 } = await import(path.join(root, 'lib/remote.mjs'));
  const pod17 = Object.create(RP17.prototype);
  pod17.pausedUntil = 0;
  pod17.log = () => {};
  pod17.session = { fetch: async () => ({
    status: 200, headers: { get: (h) => (h === 'etag' ? '"v"' : null) }, text: async () => ttl,
  }) };
  const listed = await pod17.listContainer(INBOX);
  check(listed.length === 2 && listed[0].url.endsWith('a') && listed[1].url.endsWith('b'),
    'listContainer sorts oldest-first — an LDP listing is a set, so nothing else would');
  check(listed[0].size === 100 && listed[0].modified === '2026-07-02T00:00:00.000Z',
    'and carries size and modified from the same response, at no extra cost');
}

// --- 18. copyPrivateHalf between directories, and the page's /state-move route ---
{
  const { copyPrivateHalf, CURRENT_LAYOUT } = await import(path.join(root, 'lib/migrate.mjs'));
  const MDIR = fs.mkdtempSync('/tmp/fedipod-statemove-');
  const SRC18 = path.join(MDIR, 'src');
  const DST18 = path.join(MDIR, 'dst');

  const seed18 = new PodStore({ log: () => {} });
  seed18.attach(new FileStorage(SRC18 + '/ap-state/'));
  seed18.setConfig({ handle: 'mover18', name: 'Mover' });
  seed18.setBlocklist({ domains: ['bad.example'], actors: [] });
  await seed18.commit();
  const srcRdf = new PodRdf({ storage: new FileStorage(SRC18 + '/fediverse/') });
  await srcRdf.put(srcRdf.fedi + 'settings', '<> a <http://www.w3.org/2002/07/owl#Thing> .\n');
  await srcRdf.writeNote('posts', 'p1', {
    noteId: 'https://m.example/n/1', actor: 'https://m.example/u/a',
    published: '2026-08-01T00:00:00Z', content: 'carried\t"across"',
  });
  await srcRdf.writeNote('timeline', 't1', {
    noteId: 'https://m.example/n/2', actor: 'https://m.example/u/b',
    published: '2026-08-02T00:00:00Z', content: 'seen, not written',
  });

  const copied = await copyPrivateHalf({
    from: { state: new FileStorage(SRC18 + '/ap-state/'), fediverse: new FileStorage(SRC18 + '/fediverse/') },
    to: { state: new FileStorage(DST18 + '/ap-state/'), fediverse: new FileStorage(DST18 + '/fediverse/') },
  });
  check(copied.docs === 2 && copied.notes === 2,
    `copyPrivateHalf counts what it moved (${copied.docs} docs, ${copied.notes} notes)`);

  const dstStore = new PodStore({ log: () => {} });
  dstStore.attach(new FileStorage(DST18 + '/ap-state/'));
  await dstStore.load();
  check(dstStore.getConfig()?.handle === 'mover18' && dstStore.getBlocklist().domains[0] === 'bad.example',
    'the state documents read back intact at the destination');
  const dstRdf = new PodRdf({ storage: new FileStorage(DST18 + '/fediverse/') });
  const dstPost = await dstRdf.readNote((await dstRdf.listNotes('posts'))[0]);
  const dstSeen = await dstRdf.readNote((await dstRdf.listNotes('timeline'))[0]);
  check(dstPost.content === 'carried\t"across"' && dstPost.noteId === 'https://m.example/n/1'
    && dstSeen.content === 'seen, not written',
    'and the RDF notes survive the trip, escaping and all');
  check(/owl#Thing/.test(await dstRdf.get(dstRdf.fedi + 'settings')),
    'settings came across too — contacts being absent was tolerated, not fatal');
  check(fs.existsSync(path.join(SRC18, 'ap-state', 'config.json'))
    && fs.existsSync(path.join(SRC18, 'fediverse', 'posts', 'p1')),
    'the source is copy-only: every document is still where it was');

  // The route the record page calls, over a real Agent whose private half is
  // the directory seeded above. No pod behind it: connect is stubbed, because
  // what is under test is quiesce → copy → repoint → reconnect, not the pod.
  const { startAdmin: startAdmin18 } = await import(path.join(root, 'lib/admin.mjs'));
  const { Agent: Agent18 } = await import(path.join(root, 'run-agent.mjs'));
  const AHOME18 = path.join(MDIR, 'home');
  fs.mkdirSync(AHOME18, { recursive: true });
  const srcRoot = pathToFileURL(SRC18).href + '/';
  fs.writeFileSync(path.join(AHOME18, 'credential.json'), JSON.stringify({
    remotePod: 'https://pod.example/', clientId: 'c', secret: 's', privateRoot: srcRoot,
  }));
  const magent = new Agent18({ home: AHOME18, log: () => {} });
  magent.urls = wire.apUrls('https://pod.example/');
  magent.configured = () => true;
  magent.requestTakeover = async () => true;
  let reconnects = 0;
  magent.connect = async () => { reconnects++; };
  magent.store.attach(magent.privateStorage(magent.readCredential(), 'state'));
  await magent.store.load();

  const MPORT = 18641;
  startAdmin18({ port: MPORT, gateToken: '', agent: magent, handle: 'mover18', log: () => {} });
  await new Promise(r => setTimeout(r, 150));
  const mpost = (body) => fetch(`http://localhost:${MPORT}/state-move`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));

  const noTarget = await mpost({});
  check(noTarget.status === 400 && /say where/.test(noTarget.json?.error || ''),
    `a move with no destination is refused (${noTarget.status})`);
  check(JSON.parse(fs.readFileSync(path.join(AHOME18, 'credential.json'), 'utf8')).privateRoot === srcRoot,
    'and being refused wrote nothing — the credential still points at the source');

  const MOVED18 = path.join(MDIR, 'moved');
  const ok18 = await mpost({ to: MOVED18 });
  check(ok18.status === 200 && ok18.json?.ok === true && ok18.json.docs === 2 && ok18.json.notes === 2,
    `a directory target moves the data (${ok18.status}: ${JSON.stringify(ok18.json).slice(0, 100)})`);
  const credMoved = JSON.parse(fs.readFileSync(path.join(AHOME18, 'credential.json'), 'utf8'));
  check(credMoved.privateRoot === pathToFileURL(MOVED18).href + '/' && credMoved.layout === CURRENT_LAYOUT,
    'the credential is repointed to the directory as a file: URL, and stamped current');
  check(fs.existsSync(path.join(MOVED18, 'ap-state', 'config.json'))
    && fs.existsSync(path.join(MOVED18, 'fediverse', 'posts', 'p1')),
    'the documents and notes really are at the new location');
  check(fs.existsSync(path.join(SRC18, 'ap-state', 'config.json')),
    'and the old copy is left behind, exactly as the CLI move leaves it');
  check(reconnects === 1 && magent.store.storage.base === pathToFileURL(MOVED18).href + '/ap-state/',
    'the running agent reattached its store to the new location and reconnected');

  fs.rmSync(MDIR, { recursive: true, force: true });
}

// --- 19. bluesky connection: session, stamped guard, refresh, re-login, cooldown ---
{
  const { Atproto } = await import('../../lib/atproto.mjs');
  const http19 = await import('node:http');
  const BDIR = fs.mkdtempSync('/tmp/dk-ap-bsky-');
  const seen19 = [];
  let refreshMode = 'ok';        // ok | dead
  let expireNext = false;
  let rate = false;
  let sessions = 0;
  const srv19 = http19.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen19.push({ url: req.url, auth: req.headers.authorization || null, body });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', ...(code === 429 ? { 'retry-after': '2' } : {}) }); res.end(JSON.stringify(obj)); };
      if (rate) return send(429, { error: 'RateLimitExceeded' });
      if (req.url === '/xrpc/com.atproto.server.createSession') {
        sessions++;
        if (body?.password !== 'app-pass') return send(401, { error: 'AuthenticationRequired', message: 'bad password' });
        return send(200, { did: 'did:plc:test19', handle: 'wren.test', accessJwt: `at-${sessions}`, refreshJwt: `rt-${sessions}` });
      }
      if (req.url === '/xrpc/com.atproto.server.refreshSession') {
        if (refreshMode === 'dead') return send(400, { error: 'ExpiredToken', message: 'refresh token expired' });
        return send(200, { did: 'did:plc:test19', handle: 'wren.test', accessJwt: `at-r${sessions}`, refreshJwt: `rt-r${sessions}` });
      }
      if (req.url === '/xrpc/com.atproto.server.deleteSession') return send(200, {});
      if (req.url.startsWith('/xrpc/app.bsky.actor.getProfile')) {
        if (expireNext) { expireNext = false; return send(400, { error: 'ExpiredToken', message: 'stale' }); }
        return send(200, { did: 'did:plc:test19', handle: 'wren.test', token: req.headers.authorization });
      }
      send(404, { error: 'MethodNotImplemented' });
    });
  });
  await new Promise(r => srv19.listen(18643, '127.0.0.1', r));

  const bsky = new Atproto({ localDir: BDIR, actorId: 'https://p.example/ap/actor', log: () => {}, fetcher: (u, i) => fetch(u, i) });
  await bsky.connect({ service: 'http://127.0.0.1:18643', identifier: 'wren.test', appPassword: 'app-pass' });
  const rec19 = JSON.parse(fs.readFileSync(path.join(BDIR, 'atproto.json'), 'utf8'));
  check(rec19.did === 'did:plc:test19' && rec19.mintedFor === 'https://p.example/ap/actor'
    && rec19.appPassword === 'app-pass',
    'connect stores the session stamped for this actor, app password kept for re-login');
  check((fs.statSync(path.join(BDIR, 'atproto.json')).mode & 0o777) === 0o600,
    'the credential file is 0600 — same rules as the signing key');
  check(bsky.status().connected && bsky.status().handle === 'wren.test',
    'status reads connected from the credential, not from memory');

  const other = new Atproto({ localDir: BDIR, actorId: 'https://q.example/ap/actor', log: () => {}, fetcher: (u, i) => fetch(u, i) });
  check(!other.connected(), 'a credential minted for another actor is treated as absent, never adopted');

  const p1 = await bsky.xrpc('app.bsky.actor.getProfile', { params: { actor: 'did:plc:test19' } });
  check(p1.token === 'Bearer at-1', 'xrpc carries the access token');

  expireNext = true;
  const p2 = await bsky.xrpc('app.bsky.actor.getProfile', { params: { actor: 'did:plc:test19' } });
  check(p2.token === 'Bearer at-r1' && bsky.read().refreshJwt === 'rt-r1',
    'an expired access token refreshes once and the call retries with the new one');

  refreshMode = 'dead';
  expireNext = true;
  const p3 = await bsky.xrpc('app.bsky.actor.getProfile', { params: { actor: 'did:plc:test19' } });
  check(p3.token === 'Bearer at-2' && sessions === 2,
    'a dead refresh token re-logins with the stored app password instead of failing');

  rate = true;
  const failed = await bsky.xrpc('app.bsky.actor.getProfile', { params: { actor: 'x' } }).catch(e => e);
  check(failed instanceof Error && bsky.pausedUntil > Date.now(),
    'a 429 arms the cooldown, Retry-After honored');
  const while19 = seen19.length;
  const fast = await bsky.xrpc('app.bsky.actor.getProfile', { params: { actor: 'x' } }).catch(e => e);
  check(fast instanceof Error && /back off/.test(fast.message) && seen19.length === while19,
    'while cooling down, calls fail fast without opening a socket');
  rate = false;
  bsky.pausedUntil = 0;

  await bsky.disconnect();
  check(!fs.existsSync(path.join(BDIR, 'atproto.json')) && !bsky.connected(),
    'disconnect tears the session down and removes the credential');

  srv19.close();
  fs.rmSync(BDIR, { recursive: true, force: true });
}

// --- 20. bluesky cross-posting: conversion, the public-only gate, delete propagation ---
{
  const { Atproto, bskyText } = await import('../../lib/atproto.mjs');
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const social20 = await import(path.join(root, 'lib/social.mjs'));
  const http20 = await import('node:http');

  // Conversion. Byte offsets, not code units: the é before the URL is 2 bytes.
  const t1 = bskyText('héllo https://x.example/p and #Solid too', 'https://pod.example/n/1');
  const link1 = t1.facets.find(f => f.features[0].$type === 'app.bsky.richtext.facet#link');
  const tag1 = t1.facets.find(f => f.features[0].$type === 'app.bsky.richtext.facet#tag');
  check(!t1.truncated && link1.index.byteStart === 7 && link1.features[0].uri === 'https://x.example/p',
    'a link facet counts UTF-8 bytes, not characters');
  check(tag1 && tag1.features[0].tag === 'Solid'
    && t1.text.startsWith('héllo '),
    'a #tag becomes a tag facet and the text is untouched');

  const NOTE_URL = 'https://pod.example/ap/notes/2026-08-05-abcd1234';
  const long = 'word '.repeat(120).trim();               // 599 graphemes
  const t2 = bskyText(long, NOTE_URL);
  const segCount = (s) => { let n = 0; for (const _ of new Intl.Segmenter().segment(s)) n++; return n; };
  const tail2 = t2.facets.at(-1);
  check(t2.truncated && segCount(t2.text) <= 300 && t2.text.endsWith(NOTE_URL)
    && tail2.features[0].uri === NOTE_URL,
    'over 300 graphemes truncates and links back to the pod note');

  // A live mock PDS for the record/blob traffic.
  const BDIR20 = fs.mkdtempSync('/tmp/dk-ap-bsky20-');
  const records = [];
  const deletes = [];
  let blobs = 0;
  const srv20 = http20.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/xrpc/com.atproto.server.createSession') {
        return send(200, { did: 'did:plc:m2', handle: 'you.test', accessJwt: 'a', refreshJwt: 'r' });
      }
      if (req.url === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(64, 7)); }
      if (req.url === '/xrpc/com.atproto.repo.uploadBlob') {
        blobs++;
        return send(200, { blob: { $type: 'blob', ref: { $link: `bafy${blobs}` }, mimeType: req.headers['content-type'], size: raw.length } });
      }
      if (req.url === '/xrpc/com.atproto.repo.createRecord') {
        const body = JSON.parse(raw.toString());
        records.push(body);
        return send(200, { uri: `at://${body.repo}/${body.collection}/rkey${records.length}`, cid: `cid${records.length}` });
      }
      if (req.url === '/xrpc/com.atproto.repo.deleteRecord') {
        deletes.push(JSON.parse(raw.toString()));
        return send(200, {});
      }
      send(404, { error: 'MethodNotImplemented' });
    });
  });
  await new Promise(r => srv20.listen(18644, '127.0.0.1', r));

  const bsky20 = new Atproto({ localDir: BDIR20, actorId: 'https://p.example/ap/actor', log: () => {}, fetcher: (u, i) => fetch(u, i) });
  await bsky20.connect({ service: 'http://127.0.0.1:18644', identifier: 'you.test', appPassword: 'x' });

  const mirror = await bsky20.crossPost({
    text: 'a picture #art', published: '2026-08-05T00:00:00.000Z',
    attachments: [{ url: 'http://127.0.0.1:18644/img.png', mediaType: 'image/png', description: 'a red square' }],
  }, { noteUrl: NOTE_URL });
  const rec20 = records[0];
  check(mirror.uri === 'at://did:plc:m2/app.bsky.feed.post/rkey1' && rec20.record.text === 'a picture #art'
    && rec20.record.createdAt === '2026-08-05T00:00:00.000Z',
    'crossPost writes an app.bsky.feed.post with the note text and stamp');
  check(blobs === 1 && rec20.record.embed?.images?.[0]?.alt === 'a red square',
    'an image rides as a blob with its description as alt text');

  // The gate, through the real publishNote: public mirrors, anything else must not.
  const statuses = [];
  const patched = [];
  const calls = [];
  const mkStore = () => ({
    read: () => ({}), write: () => {}, getStatuses: () => statuses,
    addStatus: (s) => statuses.push(s),
    updateStatus: (id, patch) => patched.push([id, patch]),
    getContacts: () => ({ followers: [], following: [] }),
    getConfig: () => ({ atproto: { crossPost: true } }),
  });
  const pub20 = new Publisher({
    config: { remotePod: 'https://pod.example/', handle: 'you', name: 'You' },
    remote: { putJson: async () => {}, setAcl: async () => {}, getJson: async () => null, fetch: async () => ({ ok: false }) },
    local: { writeNote: async () => {} },
    store: mkStore(),
    deliverer: { deliverToAll: async () => {} },
    publicKeyPem: 'x', log: () => {},
  });
  pub20.recordOutbox = async () => {};
  pub20.privateReady = async () => true;
  pub20.atproto = {
    connected: () => true,
    crossPost: async (post, o) => { calls.push([post, o]); return { uri: 'at://d/c/r1', cid: 'c1' }; },
  };
  await pub20.publishNote('hello world', {});
  check(calls.length === 1 && patched.at(-1)[1].atproto.uri === 'at://d/c/r1',
    'a public post mirrors and the status records the at:// uri');
  await pub20.publishNote('quiet one', { visibility: 'unlisted' });
  await pub20.publishNote('secret', { visibility: 'direct' });
  check(calls.length === 1, 'unlisted and direct posts NEVER reach the mirror');

  pub20.atproto.crossPost = async () => { throw new Error('pds down'); };
  const note20 = await pub20.publishNote('resilient', {});
  check(!!note20?.id && patched.at(-1)[1].atproto.error === 'pds down',
    'a mirror failure never fails the post, and is recorded on the status');

  // Delete propagation, through the real deleteNote.
  const removed = [];
  const tombs = [];
  const agent20 = {
    publisher: Object.assign(pub20, { unrecordOutbox: async () => {} }),
    deliverer: { deliverToAll: async () => {} },
    remote: { delete: async () => true, putJson: async (u, doc) => tombs.push([u, doc]), setAcl: async () => {} },
    local: { fedi: 'x/', delete: async () => {} },
    store: { getContacts: () => ({ followers: [], following: [] }), removeStatus: (id) => removed.push(id) },
    atproto: bsky20,
    log: () => {},
  };
  const del = await social20.deleteNote(agent20, {
    noteId: 'https://pod.example/ap/notes/x', atproto: { uri: 'at://did:plc:m2/app.bsky.feed.post/rkey1' },
  });
  check(del.ok && deletes.length === 1 && deletes[0].rkey === 'rkey1',
    'deleting the post deletes its Bluesky mirror too');
  const tomb20 = tombs.find(([u]) => u === 'https://pod.example/ap/notes/x')?.[1];
  check(tomb20?.type === 'Tombstone' && tomb20.formerType === 'Note'
    && tomb20.id === 'https://pod.example/ap/notes/x' && !!tomb20.deleted,
    'a deleted note is left as a Tombstone at its own url, not a bare 404 (§7.4)');

  srv20.close();
  fs.rmSync(BDIR20, { recursive: true, force: true });
}

// --- 21. bluesky feed mixing: mirror, notifications, and the read-only guards ---
{
  const { BskyFeed, postUrl } = await import('../../lib/bskyfeed.mjs');
  const { MastoApi } = await import(path.join(root, 'lib/mastoapi.mjs'));
  const wire21 = await import(path.join(root, 'lib/wire.mjs'));

  const statuses21 = [{
    noteId: 'https://pod.example/ap/notes/mine', actor: 'https://pod.example/ap/actor',
    kind: 'post', published: '2026-08-01T00:00:00.000Z',
    atproto: { uri: 'at://did:plc:me/app.bsky.feed.post/mine1' },
  }];
  const actors21 = {};
  const notifications21 = [];
  const hookCalls = [];
  const store21 = {
    read: (n, d) => d, write: () => {},
    getStatuses: () => statuses21,
    addStatus: (s) => statuses21.unshift(s),
    getActors: () => actors21,
    cacheActor: (u, doc) => { actors21[u] = { ...doc, preferredUsername: doc.preferredUsername }; },
    isBlocked: () => false,
    addNotification: (n) => notifications21.push(n),
  };
  const AUTHOR = { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice', avatar: 'https://cdn.test/a.jpg' };
  const feedFixture = {
    feed: [
      // Our own cross-post (its uri is a known mirror) versus our own
      // native-on-Bluesky reply: the first must not echo, the second must show.
      { post: { uri: 'at://did:plc:me/app.bsky.feed.post/mine1', author: { did: 'did:plc:me', handle: 'me' }, record: { text: 'echo', createdAt: '2026-08-05T01:00:00.000Z' } } },
      { post: { uri: 'at://did:plc:me/app.bsky.feed.post/own', author: { did: 'did:plc:me', handle: 'me' }, record: { text: 'my native reply', createdAt: '2026-08-05T01:00:00.000Z' } } },
      { post: { uri: 'at://did:plc:alice/app.bsky.feed.post/p1', author: AUTHOR,
        record: { text: '<script>hi</script> from bsky', createdAt: '2026-08-05T02:00:00.000Z' },
        embed: { images: [{ fullsize: 'https://cdn.test/full.jpg', alt: 'a cat' }] } } },
      { post: { uri: 'at://did:plc:alice/app.bsky.feed.post/p2', author: AUTHOR, record: { text: 'boosted', createdAt: '2026-08-05T03:00:00.000Z' } },
        reason: { $type: 'app.bsky.feed.defs#reasonRepost', by: { did: 'did:plc:bob', handle: 'bob.test' } } },
    ],
  };
  const notsFixture = {
    notifications: [
      { author: AUTHOR, reason: 'like', reasonSubject: 'at://did:plc:me/app.bsky.feed.post/mine1' },
      { author: AUTHOR, reason: 'follow' },
      { author: AUTHOR, reason: 'mention', uri: 'at://did:plc:alice/app.bsky.feed.post/m1',
        record: { text: 'hey @you', createdAt: '2026-08-05T04:00:00.000Z' }, indexedAt: '2026-08-05T04:00:01.000Z' },
    ],
  };
  const feed21 = new BskyFeed({
    store: store21,
    atproto: {
      connected: () => true, read: () => ({ did: 'did:plc:me' }),
      xrpc: async (nsid) => (nsid === 'app.bsky.feed.getTimeline' ? feedFixture : notsFixture),
    },
    log: () => {},
    onNotification: async (n, { actor }) => hookCalls.push([n.reason, actor]),
  });
  await feed21.sweep();

  const mirrored = statuses21.filter(s => s.kind === 'bsky');
  check(mirrored.length === 4 && !statuses21.some(s => s.noteId.endsWith('/mine1'))
    && statuses21.some(s => s.noteId.endsWith('/own')),
    'our cross-posts never echo back, but our native Bluesky replies DO show');
  const p1 = statuses21.find(s => s.noteId.endsWith('/p1'));
  check(p1.content.includes('&lt;script&gt;') && p1.link === 'https://bsky.app/profile/did:plc:alice/post/p1'
    && p1.attachments?.[0]?.description === 'a cat',
    'mirrored text is escaped, linked to its Bluesky page, images carried with alt');
  const p2 = statuses21.find(s => s.noteId.endsWith('/p2'));
  check(p2.via === 'https://bsky.app/profile/did:plc:bob'
    && actors21['https://bsky.app/profile/did:plc:alice']?.preferredUsername === 'alice.test',
    'a repost carries who boosted it, and authors land in the actor cache');
  const fav = notifications21.find(n => n.type === 'favourite');
  check(fav && fav.noteId === 'https://pod.example/ap/notes/mine',
    'a like on the mirror notifies against the POD post it mirrors');
  check(notifications21.some(n => n.type === 'follow') && notifications21.some(n => n.type === 'mention')
    && statuses21.some(s => s.noteId.endsWith('/m1')),
    'follows and mentions notify, and the mention text itself is mirrored');
  check(JSON.stringify(hookCalls.map(h => h[0]).sort()) === JSON.stringify(['follow', 'mention']),
    'the group hook hears follows and mentions, nothing else');

  const before21 = statuses21.length;
  await feed21.sweep();
  check(statuses21.length === before21, 'a second sweep adds nothing new');

  // The facade guards, through the real routes.
  const bskyNote = statuses21.find(s => s.noteId.endsWith('/p1'));
  const ids21 = new Map([['b1', bskyNote.noteId]]);
  const purls21 = wire21.apUrls('https://pod.example/');
  const docs21 = {};
  const gapi = new MastoApi({
    agent: {
      configured: () => true, viewer: false, urls: purls21,
      publisher: { urls: purls21, config: {}, privateReady: async () => true },
      store: {
        getConfig: () => ({ handle: 'you' }), getStatuses: () => statuses21,
        getActors: () => actors21, getContacts: () => ({ followers: [], following: [] }),
        // Mints on first sight, like the real store — the carry envelope asks
        // for an id that has never been seen before.
        idFor: (u) => {
          const held = [...ids21.entries()].find(([, v]) => v === u)?.[0];
          if (held) return held;
          // Hex, like the real store — the status routes match [a-f0-9] only.
          const made = 'ab' + ids21.size.toString(16).padStart(2, '0');
          ids21.set(made, u);
          return made;
        },
        urlFor: (id) => ids21.get(id) || null,
        addStatus: (s) => statuses21.unshift(s),
        updateStatus: (id, patch) => {
          const i = statuses21.findIndex(x => x.noteId === id);
          if (i < 0) return null;
          statuses21[i] = { ...statuses21[i], ...patch };
          return statuses21[i];
        },
        cacheActor: (u, doc) => { actors21[u] = doc; },
        getMedia: () => ({}), getMuted: () => ({ actors: [] }),
        read: (n, d) => (n === 'masto-tokens.json' ? [{ token: 'T21', createdAt: Date.now() }] : (docs21[n] ?? d)),
        write: (n, v) => { docs21[n] = v; },        // the instance doc mints a VAPID key
      },
      log: () => {},
    },
    log: () => {},
  });
  const gsrv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!await gapi.handle(req, res, u.pathname, u)) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(r => gsrv.listen(0, '127.0.0.1', r));
  const gbase = `http://127.0.0.1:${gsrv.address().port}`;
  const ghdr = { authorization: 'Bearer T21', 'content-type': 'application/json' };

  const gfav = await fetch(`${gbase}/api/v1/statuses/b1/favourite`, { method: 'POST', headers: ghdr, body: '{}' });
  check(gfav.status === 422 && /Bluesky/.test((await gfav.json()).error),
    'favouriting a mirrored Bluesky post with no account connected answers 422, not a broken Like');
  const grep = await fetch(`${gbase}/api/v1/statuses`, {
    method: 'POST', headers: ghdr, body: JSON.stringify({ status: 'hi', in_reply_to_id: 'b1' }),
  });
  check(grep.status === 422 && /Bluesky/.test((await grep.json()).error),
    'replying to one with no account connected answers 422 the same way');

  // With an account connected, the same taps become native Bluesky records.
  const minted21 = [];
  gapi.agent.atproto = {
    connected: () => true,
    read: () => ({ did: 'did:plc:me', handle: 'me.test' }),
    like: async (uri, cid) => { minted21.push(['like', uri, cid]); return { uri: 'at://did:plc:me/app.bsky.feed.like/l1' }; },
    repost: async (uri, cid) => { minted21.push(['repost', uri, cid]); return { uri: 'at://did:plc:me/app.bsky.feed.repost/r1' }; },
    reply: async (text, parentUri) => { minted21.push(['reply', text, parentUri]); return { uri: 'at://did:plc:me/app.bsky.feed.post/re1', cid: 'cidre1' }; },
    deleteCrossPost: async (uri) => { minted21.push(['delete', uri]); },
  };
  const gfav2 = await (await fetch(`${gbase}/api/v1/statuses/b1/favourite`, { method: 'POST', headers: ghdr, body: '{}' })).json();
  check(gfav2.favourited === true && minted21.some(m => m[0] === 'like' && m[1] === bskyNote.noteId),
    'with an account connected, favourite writes a native like and the row remembers it');
  const gunfav = await (await fetch(`${gbase}/api/v1/statuses/b1/unfavourite`, { method: 'POST', headers: ghdr, body: '{}' })).json();
  check(gunfav.favourited === false && minted21.some(m => m[0] === 'delete' && m[1] === 'at://did:plc:me/app.bsky.feed.like/l1'),
    'unfavourite deletes the very like it minted');
  const greb = await (await fetch(`${gbase}/api/v1/statuses/b1/reblog`, { method: 'POST', headers: ghdr, body: '{}' })).json();
  check(greb.reblogged === true && minted21.some(m => m[0] === 'repost' && m[1] === bskyNote.noteId),
    'reblog writes a native repost');
  const gunreb = await (await fetch(`${gbase}/api/v1/statuses/b1/unreblog`, { method: 'POST', headers: ghdr, body: '{}' })).json();
  check(gunreb.reblogged === false && minted21.some(m => m[0] === 'delete' && m[1] === 'at://did:plc:me/app.bsky.feed.repost/r1'),
    'unreblog deletes the repost');
  const grep2res = await fetch(`${gbase}/api/v1/statuses`, {
    method: 'POST', headers: ghdr, body: JSON.stringify({ status: 'hi <from> fp', in_reply_to_id: 'b1' }),
  });
  const grep2 = await grep2res.json();
  check(grep2res.status === 200 && grep2.in_reply_to_id === 'b1'
    && minted21.some(m => m[0] === 'reply' && m[1] === 'hi <from> fp' && m[2] === bskyNote.noteId),
    'a reply to a Bluesky post goes out as a native Bluesky reply');
  const replyRow = statuses21.find(s => s.noteId.endsWith('/re1'));
  check(replyRow && replyRow.inReplyTo === bskyNote.noteId && replyRow.kind === 'bsky'
    && replyRow.content.includes('&lt;from&gt;')
    && replyRow.actor === 'https://bsky.app/profile/did:plc:me'
    && replyRow.link === 'https://bsky.app/profile/did:plc:me/post/re1',
    'the reply mirrors locally: threaded under the parent, escaped, as our Bluesky self');
  const gpriv = await fetch(`${gbase}/api/v1/statuses`, {
    method: 'POST', headers: ghdr,
    body: JSON.stringify({ status: 'secret', in_reply_to_id: 'b1', visibility: 'private' }),
  });
  check(gpriv.status === 422 && /public/.test((await gpriv.json()).error),
    'a followers-only reply to a Bluesky post is refused with the reason');
  const ghome = await (await fetch(`${gbase}/api/v1/timelines/home`, { headers: ghdr })).json();
  const gentry = ghome.find(x => x.uri === bskyNote.noteId);
  check(gentry && gentry.url === bskyNote.link && gentry.account.username === 'alice.test',
    'the home timeline serves the mirror with its Bluesky page as the link');
  const gboost = ghome.find(x => x.reblog?.uri?.endsWith('/p2'));
  check(gboost && gboost.account.username === 'bob.test' && gboost.reblog.account.username === 'alice.test'
    && gboost.content === '',
    'a carried post renders as the carrier boosting the inner post');
  // The envelope's own id must resolve — a 404 here makes a client drop the row.
  const gby = await fetch(`${gbase}/api/v1/statuses/${gboost.id}`, { headers: ghdr });
  const gbyJson = await gby.json();
  check(gby.status === 200 && gbyJson.reblog?.uri === gboost.reblog.uri,
    'fetching a carried row by its id returns the carry, not a 404');
  const gctx = await fetch(`${gbase}/api/v1/statuses/${gboost.id}/context`, { headers: ghdr });
  check(gctx.status === 200, 'and its thread resolves too');

  // The live feed's address, in both spellings clients read — an empty one
  // costs live updates, and some clients read it without a guard and throw.
  const gi2 = await (await fetch(`${gbase}/api/v2/instance`, { headers: ghdr })).json();
  const gi1 = await (await fetch(`${gbase}/api/v1/instance`, { headers: ghdr })).json();
  const wsHost = new URL(gbase).host;
  check(gi2.configuration?.urls?.streaming === `ws://${wsHost}/api/v1/streaming`
    && gi2.urls?.streaming_api === `ws://${wsHost}/api/v1/streaming`,
    'v2 instance names the streaming endpoint at THIS agent, both spellings');
  check(gi1.urls?.streaming_api === `ws://${wsHost}/api/v1/streaming`,
    'v1 instance names it too');

  // A mentioned group must arrive as a mention ENTITY, so the client opens its
  // profile in-app instead of navigating to the raw actor document.
  statuses21.unshift({
    noteId: 'https://f.example/notes/withmention', actor: 'https://pod.example/ap/actor',
    kind: 'timeline', published: '2026-08-06T00:00:00.000Z',
    content: '<p>hello <a href="https://activitypub.example/ap/actor">@group</a></p>',
    mentions: [{ href: 'https://activitypub.example/ap/actor', name: '@group' }],
  });
  const ghome2 = await (await fetch(`${gbase}/api/v1/timelines/home`, { headers: ghdr })).json();
  const gm = ghome2.find(x => x.uri.endsWith('/withmention'))?.mentions?.[0];
  check(gm && gm.url === 'https://activitypub.example/ap/actor'
    && gm.username === 'group' && gm.acct === 'group@activitypub.example',
    'a stored mention serves as a Mastodon mention entity with username and acct');
  gsrv.close();
}

// --- 21b. the Atproto records behind those taps: like, repost, threaded reply ---
{
  const { Atproto } = await import(path.join(root, 'lib/atproto.mjs'));
  const dir21b = fs.mkdtempSync('/tmp/fedipod-bsky-actions-');
  const PARENT = 'at://did:plc:alice/app.bsky.feed.post/p9';
  const ROOT21B = { uri: 'at://did:plc:root/app.bsky.feed.post/r0', cid: 'cidRoot' };
  const calls21b = [];
  const jres = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const at21b = new Atproto({
    localDir: dir21b, log: () => {},
    fetcher: async (url, init) => {
      calls21b.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      if (url.includes('app.bsky.feed.getPosts')) {
        return jres(200, { posts: [{ uri: PARENT, cid: 'cidP', record: { reply: { root: ROOT21B } } }] });
      }
      if (url.includes('createRecord')) return jres(200, { uri: 'at://did:plc:me/x/rk1', cid: 'cidNew' });
      return jres(404, {});
    },
  });
  at21b.write({ service: 'https://pds.test', did: 'did:plc:me', handle: 'me.test', accessJwt: 'A', refreshJwt: 'R' });

  await at21b.like(PARENT, 'cidP');
  const likeCall = calls21b.find(c => c.body?.collection === 'app.bsky.feed.like');
  check(likeCall && likeCall.body.record.subject.uri === PARENT && likeCall.body.record.subject.cid === 'cidP'
    && !calls21b.some(c => c.url.includes('getPosts')),
    'a like with a stored cid writes the record without asking Bluesky anything first');

  await at21b.repost(PARENT);
  const repostCall = calls21b.find(c => c.body?.collection === 'app.bsky.feed.repost');
  check(repostCall && repostCall.body.record.subject.cid === 'cidP'
    && calls21b.some(c => c.url.includes('getPosts')),
    'a repost with no stored cid fetches the post once to get it');

  await at21b.reply('hello up there', PARENT);
  const replyCall = calls21b.find(c => c.body?.collection === 'app.bsky.feed.post');
  check(replyCall && replyCall.body.record.reply.parent.uri === PARENT
    && replyCall.body.record.reply.root.uri === ROOT21B.uri,
    'a reply to a mid-thread post threads at the ROOT the parent hangs from, not at the parent');

  let refused21b = null;
  await at21b.reply('x'.repeat(301), PARENT).catch(e => { refused21b = e.message; });
  check(/300/.test(refused21b || ''), 'a reply over 300 characters is refused with the limit named');

  fs.rmSync(dir21b, { recursive: true, force: true });
}

// --- 21c. drained mail keeps its original bytes; export emits the paged-collection layout ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const { storageFor } = await import(path.join(root, 'lib/storage.mjs'));
  const { exportCollections, DIR_BASE } = await import(path.join(root, 'lib/export-collections.mjs'));
  const { createHash } = await import('node:crypto');
  const $rdf21c = await import('rdflib');
  const AS21C = 'https://www.w3.org/ns/activitystreams#';

  const RAW = JSON.stringify({
    id: 'https://f.example/act/1', type: 'Create', actor: 'https://f.example/u/alice',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    published: '2026-08-01T00:00:00.000Z',
    object: { id: 'https://f.example/notes/1', type: 'Note', content: 'hi there',
      attributedTo: 'https://f.example/u/alice', published: '2026-08-01T00:00:00.000Z' },
  });
  const HASH = createHash('sha256').update(RAW).digest('hex').slice(0, 16);

  const mkDrain = (archive, cfg = {}) => {
    const deleted = [];
    const state = {};
    const store = {
      read: (n, d) => (n in state ? JSON.parse(JSON.stringify(state[n])) : d),
      write: (n, v) => { state[n] = v; },
      commit: async () => true,
      addDeadLetter: (e) => { (state.dead ||= []).push(e); },
      getDeadLetters: () => state.dead || [],
      getConfig: () => cfg,
    };
    const intake = new Intake({
      config: {}, urls: { inbox: 'https://p.example/in/', base: 'https://p.example/' },
      remote: {
        listContainer: async () => [{ url: 'https://p.example/in/m1', size: RAW.length, modified: '2026-08-01' }],
        fetch: async () => new Response(RAW, { status: 200 }),
        delete: async (u) => { deleted.push(u); return true; },
      },
      local: {}, store, deliverer: {}, publisher: {}, log: () => {}, archive,
    });
    intake.handle = async () => null;   // accepted — verification has its own tests
    return { intake, deleted };
  };

  const ARCH = fs.mkdtempSync('/tmp/fedipod-inbox-archive-');
  const on = mkDrain(storageFor(ARCH));
  await on.intake.drain();
  const monthDir = path.join(ARCH, '2026-08');
  const archived = fs.existsSync(monthDir) ? fs.readdirSync(monthDir) : [];
  check(on.deleted.length === 1 && archived.length === 1 && archived[0] === `${HASH}.json`,
    'a drained item leaves its original bytes behind, named by their own hash, and is still deleted');
  const rec = JSON.parse(fs.readFileSync(path.join(monthDir, archived[0]), 'utf8'));
  check(rec.raw === RAW && rec.actor === 'https://f.example/u/alice'
    && rec.source === 'https://p.example/in/m1' && !!rec.receivedAt,
    'the record holds the raw bytes untouched, plus who, whence and when');

  // The same file is JSON-LD: an RDF reader gets the receipt as a graph.
  const recIri = 'https://archive.example/2026-08/item.json';
  const recG = $rdf21c.graph();
  await new Promise((resolve, reject) => $rdf21c.parse(
    fs.readFileSync(path.join(monthDir, archived[0]), 'utf8'), recG, recIri,
    'application/ld+json', (e) => (e ? reject(e) : resolve())));
  const recSym = $rdf21c.sym(recIri);
  check(recG.any(recSym, $rdf21c.sym('http://www.w3.org/2011/content#chars'))?.value === RAW
    && recG.any(recSym, $rdf21c.sym('http://www.w3.org/ns/prov#generatedAtTime'))?.value === rec.receivedAt
    && recG.any(recSym, $rdf21c.sym('http://www.w3.org/ns/prov#wasDerivedFrom'))?.value === 'https://p.example/in/m1'
    && recG.any(recSym, $rdf21c.sym(AS21C + 'actor'))?.value === 'https://f.example/u/alice',
    'and the same file parses as RDF: cnt:chars, prov:generatedAtTime, prov:wasDerivedFrom, as:actor');

  await on.intake.drain();   // the same delivery again
  check(fs.readdirSync(monthDir).length === 1, 're-delivery lands on the same file — no duplicates');

  const OFFDIR = fs.mkdtempSync('/tmp/fedipod-archive-off-');
  const off = mkDrain(storageFor(OFFDIR), { archiveInbox: false });
  await off.intake.drain();
  check(off.deleted.length === 1 && fs.readdirSync(OFFDIR).length === 0,
    'with the archive off, mail drains exactly as before and nothing is written');

  const broken = mkDrain({ write: async () => ({ ok: false, why: 'disk says no' }) });
  await broken.intake.drain();
  check(broken.deleted.length === 1, 'an archive that cannot be written never stalls the mail');

  // --- the export: their layout, traversable, from plain inputs ---
  const acts = Array.from({ length: 45 }, (_, i) => ({
    id: `https://pod.example/ap/outbox-acts/${i}`, type: 'Create', actor: 'https://pod.example/ap/actor',
    published: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    object: { id: `https://pod.example/ap/notes/${i}`, type: 'Note', content: `post ${i}`,
      attributedTo: 'https://pod.example/ap/actor', published: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() },
  }));
  const EXP = fs.mkdtempSync('/tmp/fedipod-collections-export-');
  const out = await exportCollections({
    outboxItems: acts,
    followers: ['https://f.example/u/alice', 'https://f.example/u/bob'],
    inboxEntries: [{ receivedAt: rec.receivedAt, raw: RAW }],
    storage: storageFor(EXP), base: DIR_BASE, log: () => {},
  });
  check(out.outbox.items === 45 && out.outbox.pages === 3 && out.followers.items === 2 && out.inbox.items === 1,
    `export counts what it carried (${JSON.stringify({ o: out.outbox, f: out.followers, i: out.inbox })})`);

  // Traverse it the way a reader would: head → as:first → as:next chain.
  const loadDoc = (iri) => {
    const g = $rdf21c.graph();
    const file = path.join(EXP, iri.slice(DIR_BASE.length));
    $rdf21c.parse(fs.readFileSync(file, 'utf8'), g, iri, 'text/turtle');
    return g;
  };
  const headIri = `${DIR_BASE}outbox/collection.ttl`;
  const hg = loadDoc(headIri);
  const first = hg.any($rdf21c.sym(headIri), $rdf21c.sym(AS21C + 'first'))?.value;
  check(!!first, 'the outbox head names as:first');
  let cursor = first, pages21c = 0, items21c = 0, sawTriples = false;
  while (cursor && pages21c < 10) {
    const g = loadDoc(cursor);
    const page = $rdf21c.sym(cursor);
    const ids = g.each(page, $rdf21c.sym(AS21C + 'items'));
    items21c += ids.length;
    if (ids.length && g.any(ids[0], $rdf21c.sym(AS21C + 'actor'))) sawTriples = true;
    pages21c++;
    cursor = g.any(page, $rdf21c.sym(AS21C + 'next'))?.value || null;
  }
  check(pages21c === 3 && items21c === 45 && sawTriples,
    'the as:next chain walks 3 pages, 45 items, with the activities’ own triples beside them');
  const fg = loadDoc(`${DIR_BASE}followers/collection.ttl`);
  const fFirst = fg.any($rdf21c.sym(`${DIR_BASE}followers/collection.ttl`), $rdf21c.sym(AS21C + 'first'))?.value;
  const fPage = loadDoc(fFirst);
  const fItems = fPage.each($rdf21c.sym(fFirst), $rdf21c.sym(AS21C + 'items')).map(n => n.value).sort();
  check(fItems.join(',') === 'https://f.example/u/alice,https://f.example/u/bob',
    'the followers page lists exactly the actors it was given');

  // A published outbox may name bare note IRIs; a resolver embeds their triples.
  const RES = fs.mkdtempSync('/tmp/fedipod-collections-resolve-');
  await exportCollections({
    outboxItems: ['https://pod.example/ap/notes/solo'],
    storage: storageFor(RES), base: DIR_BASE, log: () => {},
    resolve: async (u) => ({ id: u, type: 'Note', content: 'resolved body',
      attributedTo: 'https://pod.example/ap/actor', published: '2026-08-07T00:00:00.000Z' }),
  });
  const rg = $rdf21c.graph();
  const rPagePath = path.join(RES, 'outbox/pages');
  const rPageFile = fs.readdirSync(rPagePath)[0];
  const rIri = `${DIR_BASE}outbox/pages/${rPageFile}`;
  $rdf21c.parse(fs.readFileSync(path.join(rPagePath, rPageFile), 'utf8'), rg, rIri, 'text/turtle');
  const solo = $rdf21c.sym('https://pod.example/ap/notes/solo');
  check(rg.any(solo, $rdf21c.sym(AS21C + 'content'))?.value === 'resolved body'
    && rg.holds($rdf21c.sym(rIri), $rdf21c.sym(AS21C + 'items'), solo),
    'a bare note IRI in the outbox is resolved and its triples travel in the page');

  let refused21c = null;
  await exportCollections({ outboxItems: acts.slice(0, 1), storage: { write: async () => ({ ok: false, why: 'refused' }) }, log: () => {} })
    .catch(e => { refused21c = e.message; });
  check(/refused/.test(refused21c || ''), 'a target that will not take the writes fails loudly, not half-written');
}

// --- 22. bluesky members in a group: bridged-first, degrade to unbridged ---
{
  const { BskyGroup } = await import('../../lib/bskygroup.mjs');
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const social22 = await import(path.join(root, 'lib/social.mjs'));

  const mkStore = (cfg = {}) => {
    const docs = {};
    const state = {
      statuses: [], contacts: { followers: [], following: [] }, requests: [],
      pending: [], muted: { actors: [] }, notifications: [], config: { kind: 'group', ...cfg },
    };
    return {
      state,
      read: (n, d) => (n in docs ? docs[n] : d), write: (n, v) => { docs[n] = v; },
      getConfig: () => state.config,
      getStatuses: () => state.statuses,
      addStatus: (s) => state.statuses.unshift(s),
      updateStatus: (id, patch) => {
        const s = state.statuses.find(x => x.noteId === id);
        if (s) Object.assign(s, patch);
        return s;
      },
      getContacts: () => state.contacts, setContacts: (c) => { state.contacts = c; },
      getRequests: () => state.requests, setRequests: (r) => { state.requests = r; },
      getPending: () => state.pending, setPending: (p) => { state.pending = p; },
      getMuted: () => state.muted, setMuted: (m) => { state.muted = m; },
      addNotification: (n) => state.notifications.push(n),
      isBlocked: () => false,
      getActors: () => ({}), cacheActor: () => {},
      handleOf: (u) => (u.includes('alice') ? '@alice.test@bsky.app' : '@m@f.example'),
    };
  };
  const mkAtproto = () => {
    const wrote = [];
    return {
      wrote,
      connected: () => true,
      read: () => ({ did: 'did:plc:group' }),
      xrpc: async (nsid, opts) => {
        wrote.push([nsid, opts?.body]);
        if (nsid === 'com.atproto.repo.createRecord') return { uri: `at://did:plc:group/${opts.body.collection}/rk${wrote.length}`, cid: 'c' };
        return {};
      },
      deleteCrossPost: async (uri) => { wrote.push(['delete', uri]); },
    };
  };
  const ALICE = { did: 'did:plc:alice', handle: 'alice.test' };

  // Open joins, unbridged: member lands, nudged exactly once.
  {
    const store = mkStore({ approveJoins: false });
    const ap = mkAtproto();
    const g = new BskyGroup({ store, atproto: ap, intake: null, log: () => {}, fetcher: async () => ({ status: 404 }) });
    await g.onFollow(ALICE);
    await g.onFollow(ALICE);                       // a second follow event changes nothing
    const member = store.state.contacts.followers[0];
    const nudges = ap.wrote.filter(([n, b]) => n === 'com.atproto.repo.createRecord' && b.collection === 'app.bsky.feed.post');
    check(store.state.contacts.followers.length === 1 && member.bsky.did === ALICE.did && !!member.nudgedAt,
      'an unbridged native follow becomes a Bluesky-only member');
    check(nudges.length === 1 && nudges[0][1].record.facets[0].features[0].did === ALICE.did
      && /ap\.brid\.gy/.test(nudges[0][1].record.text),
      'the bridge nudge goes out exactly once, mentioning them properly');
  }

  // Bridged: the native follow is left to the AP path.
  {
    const store = mkStore({});
    const ap = mkAtproto();
    const g = new BskyGroup({ store, atproto: ap, intake: null, log: () => {}, fetcher: async () => ({ status: 200 }) });
    await g.onFollow(ALICE);
    check(store.state.contacts.followers.length === 0 && ap.wrote.length === 0,
      'a bridged follower is not made a Bluesky-only member — their join arrives over AP');
  }

  // Moderated joins: the same queue, admit and refuse both work.
  {
    const store = mkStore({ approveJoins: true });
    const ap = mkAtproto();
    const g = new BskyGroup({ store, atproto: ap, intake: null, log: () => {}, fetcher: async () => ({ status: 404 }) });
    await g.onFollow(ALICE);
    await g.onFollow({ did: 'did:plc:carol', handle: 'carol.test' });
    check(store.state.requests.length === 2 && store.state.contacts.followers.length === 0,
      'with approveJoins on, native follows wait in the requests queue');
    const agent22 = {
      store, bskygroup: g, log: () => {},
      publisher: { publishCollections: async () => {}, urls: { actor: 'https://g.example/ap/actor' } },
      deliverer: { deliver: async () => { throw new Error('nothing deliverable to a bsky member'); } },
    };
    const adm = await social22.admitRequest(agent22, 'https://bsky.app/profile/did:plc:alice');
    check(adm.ok && store.state.contacts.followers[0]?.bsky?.did === ALICE.did
      && !!store.state.contacts.followers[0].nudgedAt,
      'admit seats the member with no Accept to deliver, and nudges');
    await social22.refuseRequest(agent22, 'https://bsky.app/profile/did:plc:carol');
    const blocks = ap.wrote.filter(([n, b]) => n === 'com.atproto.repo.createRecord' && b.collection === 'app.bsky.graph.block');
    check(store.state.requests.length === 0 && blocks.length === 1 && blocks[0][1].record.subject === 'did:plc:carol',
      'refuse clears the request and blocks the DID, the only refusal that can stick');
  }

  // Submission through the real amplify: review holds, approval reposts, retract deletes.
  {
    const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
    const store = mkStore({});
    const ap = mkAtproto();
    const announced = [];
    const intake22 = new Intake({
      config: { handle: 'g', review: true },
      urls: { actor: 'https://g.example/ap/actor', inbox: 'https://g.example/ap/inbox/' },
      store, log: () => {},
      remote: {}, local: { writeNote: async () => {} },
      deliverer: { deliverToAll: async (t, a) => announced.push(a) },
      publisher: { recordOutbox: async () => {}, urls: { actor: 'https://g.example/ap/actor' } },
    });
    const g = new BskyGroup({ store, atproto: ap, intake: intake22, log: () => {}, fetcher: async () => ({ status: 404 }) });
    intake22.bskyGroup = g;
    store.state.contacts.followers.push({ actor: 'https://bsky.app/profile/did:plc:alice', bsky: ALICE });
    store.state.statuses.push({
      noteId: 'at://did:plc:alice/app.bsky.feed.post/s1', cid: 'cid-s1',
      actor: 'https://bsky.app/profile/did:plc:alice', kind: 'bsky',
    });

    await g.onMention({ uri: 'at://did:plc:alice/app.bsky.feed.post/s1', author: ALICE });
    check(store.state.pending.length === 1 && ap.wrote.length === 0,
      'a member mention waits in the review queue, nothing carried yet');
    await g.onMention({ uri: 'at://did:plc:nobody/app.bsky.feed.post/x', author: { did: 'did:plc:nobody', handle: 'n' } });
    check(store.state.pending.length === 1, 'a non-member mention is ignored outright');

    await intake22.amplify('at://did:plc:alice/app.bsky.feed.post/s1', { approved: true });
    const reposts = ap.wrote.filter(([n, b]) => n === 'com.atproto.repo.createRecord' && b.collection === 'app.bsky.feed.repost');
    const s22 = store.state.statuses.find(s => s.noteId.endsWith('/s1'));
    check(reposts.length === 1 && reposts[0][1].record.subject.cid === 'cid-s1'
      && !!s22.repostUri && store.state.pending.length === 0 && announced.length === 0,
      'approval carries by native repost — and provably does NOT Announce to AP');

    const ret = await intake22.retract('at://did:plc:alice/app.bsky.feed.post/s1');
    check(ret.ok && ap.wrote.some(([n, u]) => n === 'delete' && String(u).includes('app.bsky.feed.repost'))
      && !s22.repostUri,
      'retract deletes the repost and clears the carry');

    // An AP member's post: Announce as ever, plus the native mirror for
    // Bluesky-side followers.
    store.state.config.atproto = { crossPost: true };
    store.state.contacts.followers.push({ actor: 'https://f.example/u/m', inbox: 'https://f.example/inbox' });
    store.state.statuses.push({
      noteId: 'https://f.example/notes/n1', actor: 'https://f.example/u/m',
      kind: 'timeline', content: '<p>hello from the fediverse</p>',
    });
    intake22.config.review = false;
    await intake22.amplify('https://f.example/notes/n1', {});
    const mirrors = ap.wrote.filter(([n, b]) => n === 'com.atproto.repo.createRecord'
      && b.collection === 'app.bsky.feed.post' && /via @m@f\.example/.test(b.record.text));
    check(announced.length === 1 && mirrors.length === 1 && /hello from the fediverse/.test(mirrors[0][1].record.text),
      'an AP member post is Announced AND mirrored natively with attribution');
  }

  // Eject blocks the DID; the published followers collection never lists bsky members.
  {
    const store = mkStore({});
    const ap = mkAtproto();
    const g = new BskyGroup({ store, atproto: ap, intake: null, log: () => {}, fetcher: async () => ({ status: 404 }) });
    store.state.contacts.followers.push(
      { actor: 'https://bsky.app/profile/did:plc:alice', bsky: ALICE },
      { actor: 'https://f.example/u/m', inbox: 'https://f.example/inbox' },
    );
    const puts = [];
    const agent22b = {
      store, bskygroup: g, log: () => {},
      publisher: {
        urls: { actor: 'https://g.example/ap/actor' },
        publishCollections: async () => {},
      },
      deliverer: { deliver: async () => {} },
    };
    const ej = await social22.ejectFollower(agent22b, 'https://bsky.app/profile/did:plc:alice');
    check(ej.ok && ap.wrote.some(([n, b]) => n === 'com.atproto.repo.createRecord' && b.collection === 'app.bsky.graph.block')
      && store.state.muted.actors.includes('https://bsky.app/profile/did:plc:alice'),
      'eject drops the member, mutes them, and blocks the DID');

    const pub22 = new Publisher({
      config: { remotePod: 'https://g.example/', handle: 'g' },
      remote: {
        putJson: async (u, doc) => puts.push([u, doc]),
        setAcl: async () => {}, fetch: async () => ({ ok: false }), getJson: async () => null,
      },
      local: { writeContacts: async () => {} },
      store, deliverer: {}, publicKeyPem: 'x', log: () => {},
    });
    store.state.contacts.followers.push({ actor: 'https://bsky.app/profile/did:plc:zed', bsky: { did: 'did:plc:zed', handle: 'z' } });
    await pub22.publishCollections({ followers: true });
    // Paged now: the actors live on the page, the head only counts and points.
    const fpage = puts.find(([u]) => /ap\/followers-\d+$/.test(u))?.[1];
    check(fpage && fpage.orderedItems.includes('https://f.example/u/m')
      && !puts.some(([, doc]) => JSON.stringify(doc).includes('bsky.app')),
      'the published AP followers collection lists only dereferenceable actors');
  }
}

// --- 21f. inbox forwarding (§7.1.2): a reply into our thread reaches followers ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const OURS = 'https://me.example/ap/notes/';
  const FOLLOWERS = 'https://me.example/ap/followers';
  const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
  const mkFwd = (followers) => {
    const state = {};
    const sent = [];
    const it = new Intake({
      config: { handle: 'me', kind: 'person' },
      urls: { actor: 'https://me.example/ap/actor', inbox: 'https://me.example/ap/inbox/',
        notes: OURS, followers: FOLLOWERS },
      store: {
        read: (n, d) => (n in state ? state[n] : d), write: (n, v) => { state[n] = v; },
        getContacts: () => ({ followers, following: [] }),
        getStatuses: () => [],
      },
      deliverer: { deliverToAll: async (inboxes, act) => sent.push({ inboxes, act }) },
      remote: {}, local: {}, publisher: {}, log: () => {},
    });
    return { it, sent };
  };
  const followers = [
    { actor: 'https://c.example/u/a', inbox: 'https://c.example/inbox' },
    { actor: 'https://d.example/u/b', sharedInbox: 'https://d.example/shared' },
    { actor: 'https://bsky.app/profile/did:x', bsky: { did: 'x' }, inbox: 'https://ignore' },
  ];
  const reply = (audience, parent) => ({
    id: 'https://c.example/act/1', type: 'Create', actor: 'https://c.example/u/a',
    to: audience, object: { type: 'Note', inReplyTo: parent, content: 'hi' },
  });

  // Public reply into our thread, addressed to our followers → forwarded to
  // real follower inboxes (shared inbox coalesced, Bluesky member skipped).
  {
    const { it, sent } = mkFwd(followers);
    await it._maybeForward(reply([PUBLIC, FOLLOWERS], OURS + 'x'));
    check(sent.length === 1 && sent[0].inboxes.length === 2
      && sent[0].inboxes.includes('https://c.example/inbox')
      && sent[0].inboxes.includes('https://d.example/shared'),
      'a reply into our thread addressed to our followers is forwarded to their inboxes');
    await it._maybeForward(reply([PUBLIC, FOLLOWERS], OURS + 'x'));
    check(sent.length === 1, 'and forwarding the same activity again is a no-op');
  }
  // A direct message (addressed to a person, not the collection) is never carried.
  {
    const { it, sent } = mkFwd(followers);
    await it._maybeForward(reply(['https://me.example/ap/actor'], OURS + 'x'));
    check(sent.length === 0, 'a direct message is never rebroadcast');
  }
  // Addressed to our followers, but replying to someone else's note → not ours.
  {
    const { it, sent } = mkFwd(followers);
    await it._maybeForward(reply([PUBLIC, FOLLOWERS], 'https://elsewhere.example/n/9'));
    check(sent.length === 0, 'a reply that is not into one of our threads is not forwarded');
  }
  // Into our thread, but not addressed to our followers → §7.1.2 does not trigger.
  {
    const { it, sent } = mkFwd(followers);
    await it._maybeForward(reply([PUBLIC], OURS + 'x'));
    check(sent.length === 0, 'a reply not addressed to our followers is not forwarded');
  }
}

// --- 21g. Add/Remove are acknowledged, never dead-lettered (§7.6/§7.9) ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const it = new Intake({
    config: { handle: 'me', kind: 'person' },
    urls: { actor: 'https://me.example/ap/actor', inbox: 'https://me.example/ap/inbox/',
      followers: 'https://me.example/ap/followers', featured: 'https://me.example/ap/featured' },
    store: { isBlocked: () => false },
    remote: {}, local: {}, deliverer: {}, publisher: {}, log: () => {},
  });
  const add = { type: 'Add', actor: 'https://c.example/u/a', object: 'https://x/1',
    target: 'https://me.example/ap/featured' };            // one of our own collections
  const rem = { type: 'Remove', actor: 'https://c.example/u/a', object: 'https://x/1',
    target: 'https://c.example/their/collection' };        // not ours
  const rAdd = await it.handle(add);
  const rRem = await it.handle(rem);
  check(!rAdd && !rRem,
    'an inbound Add or Remove is acknowledged, not dead-lettered — no remote may modify our collections');
}

// --- 22a. a co-member of a group we are in is not a stranger ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const GROUP = 'https://g.example/ap/actor';
  const MEMBER = 'https://f.example/users/vincent';
  const docs = {};
  let fetches = 0;
  const mkIntake = (following, actors) => {
    const it = new Intake({
      config: { handle: 'me', kind: 'person' },
      urls: { actor: 'https://me.example/ap/actor', inbox: 'https://me.example/ap/inbox/' },
      store: {
        read: (n, d) => (n in docs ? docs[n] : d), write: (n, v) => { docs[n] = v; },
        getContacts: () => ({ followers: [], following }),
        getActors: () => actors,
      },
      remote: {}, local: {}, deliverer: {}, publisher: {}, log: () => {},
    });
    it.fetchAP = async (u) => {
      fetches++;
      if (u === GROUP) return { id: GROUP, type: 'Group', followers: GROUP + '/followers' };
      if (u === GROUP + '/followers') return { orderedItems: [MEMBER, 'https://f.example/users/other'] };
      return null;
    };
    return it;
  };
  const followingGroup = [{ actor: GROUP, accepted: true }];
  const asGroupActor = { [GROUP]: { type: 'Group' } };

  const it22a = mkIntake(followingGroup, asGroupActor);
  check(await it22a.isCoMember(MEMBER) === true,
    'someone listed in a followed group’s membership counts as known');
  check(await it22a.isCoMember('https://f.example/users/stranger') === false,
    'someone not in it does not');
  const spent = fetches;
  await it22a.isCoMember(MEMBER);
  check(fetches === spent, 'the membership is cached — arriving mail does not re-read it');

  // Only GROUP actors, and only when we follow them.
  const it22aP = mkIntake([{ actor: 'https://f.example/users/person', accepted: true }], {});
  check(await it22aP.isCoMember(MEMBER) === false,
    'following a person opens no such door');
  // A group whose list cannot be read keeps the members we already had.
  const it22aFail = mkIntake(followingGroup, asGroupActor);
  it22aFail.fetchAP = async () => null;
  docs['comembers.json'] = { [GROUP]: { at: '2020-01-01T00:00:00.000Z', members: [MEMBER] } };
  check(await it22aFail.isCoMember(MEMBER) === true,
    'a failed refresh keeps the last known membership rather than demoting everyone');
}

// --- 22b. a group's carry promotes a note we only held as a mention ---
{
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const GROUP = 'https://g.example/ap/actor';
  const NOTE = 'https://f.example/users/v/statuses/1';
  const st = [{ noteId: NOTE, actor: 'https://f.example/users/v', kind: 'mention' }];
  const intake22b = new Intake({
    config: { handle: 'me' },
    urls: { actor: 'https://me.example/ap/actor', inbox: 'https://me.example/ap/inbox/', notes: 'https://me.example/ap/notes/' },
    store: {
      getStatuses: () => st,
      updateStatus: (id, patch) => Object.assign(st.find(s => s.noteId === id), patch),
      getContacts: () => ({ followers: [], following: [{ actor: GROUP, accepted: true }] }),
      isBlocked: () => false,
    },
    remote: {}, local: {}, deliverer: {}, publisher: {}, log: () => {},
  });
  await intake22b.onAnnounce({ type: 'Announce', object: NOTE }, GROUP, NOTE);
  check(st[0].kind === 'timeline' && st[0].via === GROUP,
    'a followed group carrying a mention-only note promotes it into the timeline');
  st[0].kind = 'post';
  await intake22b.onAnnounce({ type: 'Announce', object: NOTE }, GROUP, NOTE);
  check(st[0].kind === 'post', 'our own post is never demoted by a carry');
}

// --- 23. the human profile page: published beside the actor, escaped, followable ---
{
  const wire23 = await import(path.join(root, 'lib/wire.mjs'));
  const page = wire23.profilePageHtml({
    name: 'Solid <script>alert(1)</script> Group',
    address: '@group@activitypub.example',
    summary: '<p>a group about pods</p>',
    icon: 'https://pod.example/ap/media/icon.png',
    kind: 'group',
  });
  check(!page.includes('<script>alert') && page.includes('&lt;script&gt;'),
    'the display name is escaped, not interpreted');
  check(page.includes('@group@activitypub.example') && page.includes('authorize_interaction')
    && page.includes('a group on the fediverse'),
    'the page shows the address, says what it is, and carries the remote-follow control');

  // The actor advertises the page as its url, and mention ANCHORS point at the
  // mentioned actor's page — the tag keeps the id, which servers match on.
  const actor23 = wire23.actorDoc({
    urls: wire23.apUrls('https://p.example/'), handle: 'p', name: 'P', publicKeyPem: 'K',
  });
  check(actor23.url === 'https://p.example/activitypods-js/ap/profile.html',
    'the actor url is the human page, not machine data');
  const html23 = wire23.contentHtml('hi @friend', [
    { handle: 'friend', actor: 'https://m.example/users/friend', page: 'https://m.example/@friend' }]);
  check(html23.includes('href="https://m.example/@friend"') && !html23.includes('users/friend"'),
    'a mention anchor sends people to the page; without one it falls back to the id');
}

// --- 24. C2S (ActivityPub §6): auth, dispatch, addressing — offline, stub verifier ---
{
  const { C2S } = await import(path.join(root, 'lib/c2s.mjs'));
  const { makeC2sAuth } = await import(path.join(root, 'lib/oidc-auth.mjs'));
  const { PodStore: PodStore24 } = await import(path.join(root, 'lib/store.mjs'));
  const wire24 = await import(path.join(root, 'lib/wire.mjs'));

  const OWNER = 'https://pod.example/profile/card#me';
  const urls24 = wire24.apUrls('https://pod.example/');
  const ALICE24 = 'https://m.example/u/alice';
  const THEIRS = 'https://m.example/n/r9';
  const OURS = urls24.notes + 'p9';
  const st24 = new PodStore24({ log: () => {} });
  st24.setConfig({ remotePod: 'https://pod.example/', handle: 'jeff' });
  st24.write('statuses.json', [
    { noteId: THEIRS, actor: ALICE24, content: '<p>theirs</p>', published: '2026-08-09T01:00:00Z', kind: 'timeline' },
    { noteId: OURS, actor: urls24.actor, content: '<p>ours</p>', published: '2026-08-09T02:00:00Z', kind: 'post', slug: 'p9' },
  ]);

  const delivered24 = [];
  const published24 = [];
  let featured24 = 0;
  const agent24 = {
    store: st24,
    configured: () => true,
    viewer: false,
    remote: { webId: OWNER, putJson: async () => {}, setAcl: async () => {}, delete: async () => true },
    local: { fedi: urls24.fediverse, delete: async () => {}, writeNote: async () => {} },
    deliverer: {
      deliver: async (inbox, a) => delivered24.push({ inbox, a }),
      deliverToAll: async (inboxes, a) => delivered24.push({ inboxes, a }),
    },
    intake: { fetchAP: async (u) => ({ id: u, type: 'Person', inbox: u + '/inbox' }) },
    publisher: {
      urls: urls24,
      publishNote: async (content, opts) => {
        published24.push({ content, ...opts });
        return { id: urls24.notes + 'c2s-' + published24.length };
      },
      updateNote: async (s, opts) => ({ ...s, ...opts }),
      publishFeatured: async () => { featured24++; },
      publishProfile: async () => {},
      publishCollections: async () => {},
      recordOutbox: async () => {},
      unrecordOutbox: async () => {},
    },
    log: () => {},
  };

  const okAuth = async () => ({ ok: true, webid: OWNER, via: 'stub' });
  const api24 = new C2S({ agent: agent24, log: () => {}, auth: okAuth });
  const ask24 = async (api, body, { method = 'POST', pathname = '/ap/outbox', headers = {} } = {}) => {
    const res = { status: 0, headers: null, body: null,
      writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b; } };
    const req = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = { host: `localhost:${PORT}`, ...headers };
    await api.handle(req, res, pathname, new URL('http://localhost' + pathname));
    let json = null;
    try { json = res.body ? JSON.parse(res.body) : null; } catch { /* redirects have no body */ }
    return { status: res.status, headers: res.headers || {}, json };
  };

  // The auth path, through the real wrapper with an injected verifier.
  const authReal = makeC2sAuth({
    agent: agent24,
    masto: { authed: (req) => req.headers.authorization === 'Bearer smoke-ok' },
    verifier: async (authz) => {
      if (authz === 'DPoP good') return { webid: OWNER };
      if (authz === 'DPoP other') return { webid: 'https://other.example/profile#me' };
      throw new Error('bad token');
    },
  });
  const apiAuth = new C2S({ agent: agent24, log: () => {}, auth: authReal });
  const blockBody = { type: 'Block', object: 'https://bad.example/u/troll' };
  const noAuth = await ask24(apiAuth, blockBody);
  check(noAuth.status === 401, `no credentials → 401 (got ${noAuth.status})`);
  const wrongWho = await ask24(apiAuth, blockBody, { headers: { authorization: 'DPoP other' } });
  check(wrongWho.status === 403, `a valid token for a DIFFERENT WebID → 403, not a post (got ${wrongWho.status})`);
  const badTok = await ask24(apiAuth, blockBody, { headers: { authorization: 'DPoP junk' } });
  check(badTok.status === 401, `an unverifiable token → 401 (got ${badTok.status})`);
  const asOwner = await ask24(apiAuth, blockBody, { headers: { authorization: 'DPoP good' } });
  check(asOwner.status === 200, `the owner's own WebID → acts (got ${asOwner.status})`);
  const asBearer = await ask24(apiAuth, { type: 'Block', object: 'https://bad.example/u/troll2' },
    { headers: { authorization: 'Bearer smoke-ok' } });
  check(asBearer.status === 200, `the facade bearer drives C2S too (got ${asBearer.status})`);
  const b24 = st24.getBlocklist();
  check(b24.actors.includes('https://bad.example/u/troll') && b24.actors.includes('https://bad.example/u/troll2'),
    'both blocks landed in the blocklist');
  check(!delivered24.some(d => d.a?.type === 'Block'),
    'and nothing was DELIVERED for a Block — the blocked party is not notified');

  // A bare Note is wrapped in a Create (§6.2.1); the response is 201 with the
  // new activity's dereferenceable id in Location.
  const bare = await ask24(api24, { type: 'Note', content: 'hello c2s', to: [wire24.PUBLIC] });
  check(bare.status === 201 && String(bare.headers.location || '').endsWith('-create'),
    `a bare Note → 201 + Location of the -create doc (got ${bare.status} ${bare.headers.location})`);
  check(published24[0]?.content === 'hello c2s' && published24[0]?.visibility === 'public',
    'the wrap kept the text and read as:Public as public');

  // The addressing table, inverted: each shape lands the facade visibility.
  await ask24(api24, { type: 'Create', object: { type: 'Note', content: 'u' },
    to: [urls24.followers], cc: [wire24.PUBLIC] });
  await ask24(api24, { type: 'Create', object: { type: 'Note', content: 'p' }, to: [urls24.followers] });
  await ask24(api24, { type: 'Create', object: { type: 'Note', content: 'd' }, to: [ALICE24] });
  check(published24.map(x => x.visibility).join(',') === 'public,unlisted,private,direct',
    `four addressings → the four visibilities (got ${published24.map(x => x.visibility).join(',')})`);
  const unaddressed = await ask24(api24, { type: 'Create', object: { type: 'Note', content: 'x' } });
  check(unaddressed.status === 400, `a post with NO stated audience is refused, not guessed (got ${unaddressed.status})`);
  const cw = await ask24(api24, { type: 'Create',
    object: { type: 'Note', content: 'spoiled', summary: 'CW: test' }, to: [wire24.PUBLIC] });
  check(cw.status === 201 && published24.at(-1)?.spoilerText === 'CW: test',
    'summary rides through as the content warning');

  // Someone else's note is not ours to edit or delete.
  const foreignEdit = await ask24(api24, { type: 'Update', object: { id: THEIRS, content: 'hijack' } });
  check(foreignEdit.status === 403, `editing someone else's note → 403 (got ${foreignEdit.status})`);
  const foreignDel = await ask24(api24, { type: 'Delete', object: THEIRS });
  check(foreignDel.status === 403, `deleting someone else's note → 403 (got ${foreignDel.status})`);
  const ownEdit = await ask24(api24, { type: 'Update', object: { id: OURS, content: 'edited' } });
  check(ownEdit.status === 200, `editing our own → 200 (got ${ownEdit.status})`);

  // Like, then Undo by the stored activity's id.
  const like = await ask24(api24, { type: 'Like', object: THEIRS });
  const likeId = like.json?.id;
  check(like.status === 201 && /#like-/.test(likeId || ''),
    `Like → 201 naming the like activity (got ${like.status} ${likeId})`);
  check(st24.getStatuses().find(s => s.noteId === THEIRS)?.favourited === true, 'the status is favourited');
  const unlike = await ask24(api24, { type: 'Undo', object: likeId });
  check(unlike.status === 200 && st24.getStatuses().find(s => s.noteId === THEIRS)?.favourited === false,
    'Undo by the like id unfavourites');

  // Announce, then Undo by re-stating the inner activity instead of its id.
  const boost = await ask24(api24, { type: 'Announce', object: THEIRS });
  check(boost.status === 201 && st24.getStatuses().find(s => s.noteId === THEIRS)?.reblogged === true,
    `Announce → 201 and the status is boosted (got ${boost.status})`);
  const unboost = await ask24(api24, { type: 'Undo', object: { type: 'Announce', object: THEIRS } });
  check(unboost.status === 200 && st24.getStatuses().find(s => s.noteId === THEIRS)?.reblogged === false,
    'Undo restating Announce+object unboosts');

  // Follow an actor by IRI; the response names the Follow a later Undo needs.
  const follow = await ask24(api24, { type: 'Follow', object: 'https://m.example/u/zed' });
  check(follow.status === 201 && /#follow-/.test(follow.json?.id || ''),
    `Follow → 201 naming the follow activity (got ${follow.status})`);
  check(st24.getContacts().following.some(f => f.actor === 'https://m.example/u/zed'),
    'the following record exists');
  const unfollow = await ask24(api24, { type: 'Undo', object: { type: 'Follow', object: 'https://m.example/u/zed' } });
  check(unfollow.status === 200 && !st24.getContacts().following.some(f => f.actor === 'https://m.example/u/zed'),
    'Undo of the Follow unfollows');

  // Pinning is Add/Remove on the featured collection, and only that collection.
  const pin = await ask24(api24, { type: 'Add', object: OURS, target: urls24.featured });
  check(pin.status === 200 && pin.json?.pinned === true && featured24 > 0,
    `Add to featured pins and republishes the collection (got ${pin.status})`);
  const unpin = await ask24(api24, { type: 'Remove', object: OURS, target: urls24.featured });
  check(unpin.status === 200 && unpin.json?.pinned === false, 'Remove unpins');
  const wrongTarget = await ask24(api24, { type: 'Add', object: OURS, target: urls24.outbox });
  check(wrongTarget.status === 422, `Add to any OTHER collection → 422 (got ${wrongTarget.status})`);

  // The deliberate exclusions and the unknowns.
  const move = await ask24(api24, { type: 'Move', object: urls24.actor });
  check(move.status === 422, `Move → 422, pointed at the admin surface (got ${move.status})`);
  const retire = await ask24(api24, { type: 'Delete', object: urls24.actor });
  check(retire.status === 422, `Delete of the actor → 422, same (got ${retire.status})`);
  const poll = await ask24(api24, { type: 'Question', content: 'which?' });
  check(poll.status === 422, `a non-Note object → 422 (got ${poll.status})`);
  const badBody = await ask24(api24, null);
  check(badBody.status === 400, `an empty body → 400 (got ${badBody.status})`);

  // GETs redirect to the pod's canonical documents.
  const getOutbox = await ask24(api24, null, { method: 'GET' });
  check(getOutbox.status === 303 && getOutbox.headers.location === urls24.outbox,
    `GET outbox → 303 to the pod copy (got ${getOutbox.status} ${getOutbox.headers.location})`);
  const getActor = await ask24(api24, null, { method: 'GET', pathname: '/ap/actor' });
  check(getActor.status === 303 && getActor.headers.location === urls24.actor,
    'GET actor → 303 to the pod copy');

  // Unconfigured and viewer-mode agents refuse rather than half-act.
  const apiUnconf = new C2S({ agent: { ...agent24, configured: () => false }, log: () => {}, auth: okAuth });
  const unconf = await ask24(apiUnconf, blockBody);
  check(unconf.status === 409, `unconfigured → 409 (got ${unconf.status})`);
  const apiViewer = new C2S({
    agent: { ...agent24, viewer: true, requestTakeover: async () => false },
    log: () => {}, auth: okAuth,
  });
  const viewer = await ask24(apiViewer, blockBody);
  check(viewer.status === 503, `a viewer that cannot take the lease → 503 (got ${viewer.status})`);
}

// --- 25. FEP conformance: moderators (1b12), pending (4ccd), blocked (c648), audience, announced Delete ---
{
  const wire25 = await import(path.join(root, 'lib/wire.mjs'));
  const urls25 = wire25.apUrls('https://pod.example/');

  // The actor advertises the collections only when they are real.
  const plain = wire25.actorDoc({ urls: urls25, handle: 'p', name: 'P', publicKeyPem: 'K' });
  check(!plain.attributedTo && !plain.pendingFollowers && !plain.blocked,
    'an actor with none of the FEP collections advertises none of them');
  const full = wire25.actorDoc({
    urls: urls25, handle: 'p', name: 'P', publicKeyPem: 'K',
    moderators: urls25.moderators,
    pendingFollowers: urls25.pendingFollowers, pendingFollowing: urls25.pendingFollowing,
    blocked: urls25.blocked,
  });
  check(full.attributedTo === urls25.moderators
    && full.pendingFollowers === urls25.pendingFollowers
    && full.pendingFollowing === urls25.pendingFollowing
    && full.blocked === urls25.blocked,
    'moderators ride as attributedTo; the FEP collections ride under their own names');
  const ctx = JSON.stringify(full['@context']);
  check(ctx.includes('https://purl.archive.org/socialweb/pending#')
    && ctx.includes('https://purl.archive.org/socialweb/blocked#'),
    "the FEP terms are declared with the FEPs' own IRIs")
  check(!JSON.stringify(plain['@context']).includes('socialweb/pending'),
    'and not declared when nothing uses them');

  // A group's carry names the group as its audience (FEP-1b12).
  const carry = wire25.announceActivity({ urls: urls25, object: 'https://m.example/n/1', serial: 1,
    audience: urls25.actor });
  check(carry.audience === urls25.actor, "the group's Announce carries audience");
  const boost = wire25.announceActivity({ urls: urls25, object: 'https://m.example/n/1', serial: 2 });
  check(!('audience' in boost), 'a personal boost carries none');

  // Pending + blocked collections publish only where owner-only is REAL.
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const mkPub = (probeStatus) => {
    const puts = [];
    const pub = new Publisher({
      config: { remotePod: 'https://pod.example/', handle: 'p' },
      remote: { putJson: async (u, doc) => puts.push({ u, doc }), setAcl: async () => {} },
      local: {},
      store: {
        getRequests: () => [
          { actor: 'https://m.example/u/a', activity: { id: 'f-a', type: 'Follow' } },
          { actor: 'https://m.example/u/b', bsky: { did: 'x' } },   // no AP Follow to list
        ],
        getContacts: () => ({
          followers: [],
          following: [
            { actor: 'https://m.example/u/c', accepted: false, followActivity: { id: 'f-c', type: 'Follow' } },
            { actor: 'https://m.example/u/d', accepted: true, followActivity: { id: 'f-d', type: 'Follow' } },
          ],
        }),
        getBlocklist: () => ({ domains: ['bad.example'], actors: ['https://m.example/u/troll'] }),
        getStatuses: () => [], read: () => ({}),
      },
      deliverer: {}, publicKeyPem: 'K', log: () => {},
      probeFetch: async () => ({ status: probeStatus }),
    });
    return { pub, puts };
  };
  const enforcing = mkPub(401);
  await enforcing.pub.publishPending();
  await enforcing.pub.publishBlocked();
  const pf = enforcing.puts.find(p => p.u === enforcing.pub.urls.pendingFollowers);
  const pg = enforcing.puts.find(p => p.u === enforcing.pub.urls.pendingFollowing);
  const bl = enforcing.puts.find(p => p.u === enforcing.pub.urls.blocked);
  check(pf?.doc.orderedItems.length === 1 && pf.doc.orderedItems[0].id === 'f-a',
    'pendingFollowers holds the held Follow activities — and no Bluesky ghost');
  check(pg?.doc.orderedItems.length === 1 && pg.doc.orderedItems[0].id === 'f-c',
    'pendingFollowing holds only the unanswered outgoing Follow');
  check(bl?.doc.orderedItems.length === 1 && bl.doc.orderedItems[0] === 'https://m.example/u/troll',
    'blocked lists actor IRIs only — domain blocks stay ours');
  const leaky = mkPub(200);
  await leaky.pub.publishPending();
  await leaky.pub.publishBlocked();
  const fepUrls = [leaky.pub.urls.pendingFollowers, leaky.pub.urls.pendingFollowing, leaky.pub.urls.blocked];
  check(leaky.puts.filter(p => fepUrls.includes(p.u)).length === 0,
    'a pod that serves private documents to strangers gets NO pending/blocked collections');

  // A followed group announcing a Delete moderates away only what it carried.
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const GROUP25 = 'https://g.example/u/group';
  const removed = [];
  const st25 = {
    getContacts: () => ({ followers: [], following: [{ actor: GROUP25, accepted: true }] }),
    getStatuses: () => [
      { noteId: 'https://m.example/n/carried', kind: 'timeline', via: GROUP25, slug: 'c1' },
      { noteId: 'https://m.example/n/elsewhere', kind: 'timeline', via: 'https://other.example/u/x', slug: 'c2' },
      { noteId: 'https://pod.example/activitypods-js/ap/notes/mine', kind: 'post', via: GROUP25 },
    ],
    removeStatus: (id) => removed.push(id),
    isBlocked: () => false,
  };
  const intake25 = new Intake({
    config: { remotePod: 'https://pod.example/', handle: 'p' },
    urls: urls25, remote: {}, store: st25, deliverer: {}, publisher: {},
    local: { fedi: 'x/', delete: async () => {} }, log: () => {},
  });
  await intake25.onAnnouncedDelete(GROUP25, { type: 'Delete', object: 'https://m.example/n/carried' });
  check(removed.length === 1 && removed[0] === 'https://m.example/n/carried',
    'the group moderates away the post it carried to us');
  await intake25.onAnnouncedDelete(GROUP25, { type: 'Delete', object: 'https://m.example/n/elsewhere' });
  check(removed.length === 1, "a post another carrier brought is not the group's to remove");
  await intake25.onAnnouncedDelete(GROUP25, { type: 'Delete', object: 'https://pod.example/activitypods-js/ap/notes/mine' });
  check(removed.length === 1, 'our own post is never removed by moderation');
  await intake25.onAnnouncedDelete('https://stranger.example/u/s', { type: 'Delete', object: 'https://m.example/n/carried' });
  check(removed.length === 1, "a stranger's announced Delete is nothing to us");
}

// --- 26. FEP-1b12 moderation: announced bans, the moderator ask queue, apply ---
{
  const wire26 = await import(path.join(root, 'lib/wire.mjs'));
  const social26 = await import(path.join(root, 'lib/social.mjs'));
  const { PodStore: PodStore26 } = await import(path.join(root, 'lib/store.mjs'));
  const { Intake } = await import(path.join(root, 'lib/intake.mjs'));
  const urls26 = wire26.apUrls('https://pod.example/');
  const MOD = 'https://m.example/u/mod';
  const MEMBER = 'https://m.example/u/member';

  const block = wire26.blockActivity({ urls: urls26, targetActor: MEMBER, serial: 7 });
  check(block.type === 'Block' && block.actor === urls26.actor && block.object === MEMBER,
    'a ban is a Block by the group on the member');
  const add = wire26.addRemoveActivity({ urls: urls26, type: 'Add', object: MOD,
    target: urls26.moderators, serial: 8 });
  check(add.type === 'Add' && add.object === MOD && add.target === urls26.moderators,
    'a roster change is an Add/Remove targeting the moderators collection');

  const mkGroup = () => {
    const st = new PodStore26({ log: () => {} });
    st.setConfig({ remotePod: 'https://pod.example/', handle: 'g', kind: 'group', moderators: [MOD] });
    st.setContacts({
      followers: [
        { actor: MEMBER, inbox: MEMBER + '/inbox', followId: 'f-m' },
        { actor: 'https://m.example/u/other', inbox: 'https://m.example/u/other/inbox', followId: 'f-o' },
      ],
      following: [],
    });
    const delivered = [];
    const outbox = [];
    return {
      st, delivered, outbox,
      agent: {
        store: st,
        publisher: {
          urls: urls26, publishCollections: async () => {}, publishProfile: async () => ({ unreachable: [] }),
          recordOutbox: async (a) => outbox.push(a), config: {},
        },
        deliverer: {
          deliver: async (inbox, a) => delivered.push({ inbox, a }),
          deliverToAll: async (inboxes, a) => delivered.push({ inboxes, a }),
        },
        intake: { retract: async (id) => { delivered.push({ retracted: id }); return { ok: true }; } },
        log: () => {},
      },
    };
  };

  // Ejecting a member broadcasts the ban to the membership — and only a group does.
  const g = mkGroup();
  await social26.ejectFollower(g.agent, MEMBER);
  const announce = g.delivered.find(d => d.a?.type === 'Announce' && d.a.object?.type === 'Block');
  check(!!announce && announce.a.object.object === MEMBER && announce.a.audience === urls26.actor,
    'an ejection announces the Block to the members, audience-stamped');
  check(g.outbox.some(a => a.type === 'Announce' && a.object?.type === 'Block'),
    'and the ban is on the public record');
  check(!g.delivered.some(d => d.inbox === MEMBER + '/inbox' && d.a?.type === 'Announce'),
    'the ejected member gets the Reject, never the ban broadcast');

  const person = mkGroup();
  person.st.setConfig({ remotePod: 'https://pod.example/', handle: 'p', kind: 'person' });
  await social26.blockActor(person.agent, 'https://m.example/u/troll');
  check(!person.delivered.some(d => d.a?.type === 'Announce'),
    "a PERSON's block never goes on the wire");

  // A listed moderator's ask is queued, not run; a stranger's is not queued.
  const q = mkGroup();
  const intake26 = new Intake({
    config: q.st.getConfig(), urls: urls26, remote: {}, store: q.st,
    deliverer: q.agent.deliverer, publisher: q.agent.publisher, local: {}, log: () => {},
  });
  await intake26.handle({ type: 'Block', actor: MOD, object: MEMBER });
  let queue = q.st.read('modqueue.json', []);
  check(queue.length === 1 && queue[0].type === 'Block' && queue[0].moderator === MOD,
    "a listed moderator's Block waits in the queue");
  check(q.st.getContacts().followers.some(f => f.actor === MEMBER),
    'and nothing has been applied yet');
  await intake26.handle({ type: 'Block', actor: MOD, object: MEMBER });
  check(q.st.read('modqueue.json', []).length === 1, 'the same ask is not queued twice');
  await intake26.handle({ type: 'Block', actor: 'https://m.example/u/rando', object: MEMBER });
  check(q.st.read('modqueue.json', []).length === 1, "a stranger's Block is not moderation");
  check(intake26.isModerationAsk({ type: 'Create', object: { type: 'Note' } }) === false,
    "a moderator's ordinary post is not a moderation ask");
  check(intake26.isModerationAsk({ type: 'Add', object: MOD, target: urls26.moderators }) === true
    && intake26.isModerationAsk({ type: 'Add', object: MOD, target: urls26.featured }) === false,
    'Add is an ask only when it names the moderators collection');

  // Applying the queued Block ejects the member and broadcasts the ban.
  queue = q.st.read('modqueue.json', []);
  await social26.applyModeration(q.agent, queue[0]);
  check(!q.st.getContacts().followers.some(f => f.actor === MEMBER)
    && q.delivered.some(d => d.a?.type === 'Announce' && d.a.object?.type === 'Block'),
    'applying the queued Block ejects and announces');

  // A queued Delete of a carried post applies as the retract.
  await social26.applyModeration(q.agent, {
    type: 'Delete', activity: { type: 'Delete', object: 'https://m.example/n/carried' },
  });
  check(q.delivered.some(d => d.retracted === 'https://m.example/n/carried'),
    'a queued Delete unsays the carry');

  // A queued Add grows the roster, republishes, and announces the change.
  await social26.applyModeration(q.agent, {
    type: 'Add', activity: { type: 'Add', object: 'https://m.example/u/mod2', target: urls26.moderators },
  });
  check((q.st.getConfig().moderators || []).includes('https://m.example/u/mod2'),
    'a queued Add seats the new moderator');
  check(q.delivered.some(d => d.a?.type === 'Announce' && d.a.object?.type === 'Add'
    && d.a.object.object === 'https://m.example/u/mod2'),
    'and the seating is announced');
}

// --- 27. httpsig: door verification, SSRF-safe key fetch, HMAC receipt ---
{
  const { signRequest: sign27 } = await import(req.resolve('@fedify/fedify/sig'));
  const httpsig = await import(path.join(root, 'lib/httpsig.mjs'));
  const KID = 'https://pod.example/activitypods-js/ap/actor#main-key';
  const AID = 'https://pod.example/activitypods-js/ap/actor';
  const actorDoc27 = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id: AID, type: 'Person', publicKey: { id: KID, owner: AID, publicKeyPem: keys.rsaPublicPem },
  };
  const mkReq = (body = '{"type":"Follow"}') => new Request('https://gw.example/u/me/inbox', {
    method: 'POST', headers: { 'content-type': 'application/activity+json' }, body,
  });
  const loaderFor = (doc) => async (url) => ({ document: doc, documentUrl: url, contextUrl: null });

  const good = await httpsig.verifyHttpSignature(await sign27(mkReq(), keys.rsaPrivate, new URL(KID)),
    { documentLoader: loaderFor(actorDoc27) });
  check(good.verified === true && good.method === 'draft-cavage' && good.keyId === KID && good.actor === AID,
    'a correctly-signed delivery verifies at the door and names the actor');

  // Tamper the body after signing → the Digest no longer matches.
  const signedGood = await sign27(mkReq(), keys.rsaPrivate, new URL(KID));
  const tampered = new Request(signedGood.url, { method: 'POST', headers: signedGood.headers, body: '{"type":"Delete"}' });
  const bad = await httpsig.verifyHttpSignature(tampered, { documentLoader: loaderFor(actorDoc27) });
  check(bad.verified === false && bad.reason === 'bad-signature-or-key-unfetchable',
    'a body swapped after signing fails, and says why (a forgery, dropped at the edge)');

  // No signature at all → unverified, distinguished as such.
  const none = await httpsig.verifyHttpSignature(mkReq(), { documentLoader: loaderFor(actorDoc27) });
  check(none.verified === false && none.reason === 'no-signature',
    'an unsigned delivery is unverified with reason no-signature (buffered, not dropped)');

  // The wrong key → fails; the right key on a second try → passes (rotation).
  const nodeCrypto = await import('node:crypto');
  const otherPub = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    .publicKey.export({ type: 'spki', format: 'pem' });
  const wrongDoc = { ...actorDoc27, publicKey: { ...actorDoc27.publicKey, publicKeyPem: otherPub } };
  const missed = await httpsig.verifyHttpSignature(
    await sign27(mkReq(), keys.rsaPrivate, new URL(KID)), { documentLoader: loaderFor(wrongDoc) });
  check(missed.verified === false, 'a signature checked against a rotated-away key fails');
  const refetched = await httpsig.verifyHttpSignature(
    await sign27(mkReq(), keys.rsaPrivate, new URL(KID)), { documentLoader: loaderFor(actorDoc27) });
  check(refetched.verified === true, 'and the same signature verifies once the current key is loaded');

  // The SSRF-safe loader refuses a private-address keyId before any fetch.
  process.env.AP_ALLOW_PRIVATE_TARGETS = '';
  const loader = httpsig.makeSafeLoader({});
  let threw = false;
  try { await loader('http://169.254.169.254/latest/meta-data/'); } catch { threw = true; }
  check(threw, 'the key loader refuses a cloud-metadata address before fetching it');
  const cached = httpsig.makeSafeLoader({ getActors: () => ({ [AID]: actorDoc27 }) });
  const hit = await cached(AID);
  check(hit.document?.id === AID, 'a cached actor short-circuits the network entirely');

  // The receipt: HMAC makes it tamper-evident with the shared secret.
  const SECRET = 'gateway-hmac-secret';
  const receipt = httpsig.signReceipt(httpsig.makeReceipt(good, { gateway: 'https://gw.example/#me' }), SECRET);
  check(httpsig.verifyReceipt(receipt, SECRET) === true, 'a receipt verifies under its shared secret');
  check(httpsig.verifyReceipt(receipt, 'wrong-secret') === false, 'and not under any other');
  check(httpsig.verifyReceipt({ ...receipt, verified: false }, SECRET) === false,
    'flipping verified after signing breaks the HMAC — a forged receipt is rejected');
  check(httpsig.verifyReceipt(good, SECRET) === false, 'an unsigned receipt is not trusted');
}

// --- 28. gateway-core edge decisions + drain trusts a receipt only in trust mode ---
{
  const { signRequest: sign28 } = await import(req.resolve('@fedify/fedify/sig'));
  const gw = await import(path.join(root, 'lib/gateway-core.mjs'));
  const httpsig28 = await import(path.join(root, 'lib/httpsig.mjs'));
  const KID = 'https://pod.example/activitypods-js/ap/actor#main-key';
  const AID = 'https://pod.example/activitypods-js/ap/actor';
  const actorDoc28 = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
    id: AID, type: 'Person', publicKey: { id: KID, owner: AID, publicKeyPem: keys.rsaPublicPem },
  };
  const ident = {
    inboxUrl: 'https://pod.example/activitypods-js/ap/inbox/',
    actorUrl: 'https://me.example/actor', followersUrl: 'https://me.example/followers',
    notesPrefix: 'https://me.example/notes/', following: ['https://friend.example/actor'],
    blocklist: { domains: ['spam.example'], actors: [] }, kind: 'person',
    gatewayWebId: 'https://gw.example/#me', hmacSecret: 'shhh',
  };
  const mkPut = () => { const puts = []; return { puts, put: async (u, b) => { puts.push({ u, b }); return true; } }; }; // eslint-disable-line
  // The signer's own actor doc satisfies the door's key fetch via the loader —
  // but handleDelivery builds its OWN loader, so we let key fetches fail
  // (verified:false, buffered) and instead assert the EDGE decisions, which do
  // not depend on a reachable key. Signature-verify itself is covered in §27.
  process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
  const mkReq28 = (body) => new Request('https://gw.example/u/me/inbox', {
    method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(body),
  });

  const blocked = mkPut();
  let r = await gw.handleDelivery(mkReq28({ type: 'Create', actor: 'https://spam.example/u/x', object: {} }),
    ident, { podPut: blocked.put });
  check(r.status === 202 && blocked.puts.length === 0, 'a blocked-domain delivery is dropped at the edge, no pod write');

  const unrelated = mkPut();
  r = await gw.handleDelivery(mkReq28({ type: 'Create', actor: 'https://stranger.example/u/y',
    object: { type: 'Note', to: ['https://elsewhere.example/actor'] } }), ident, { podPut: unrelated.put });
  check(r.status === 202 && unrelated.puts.length === 0, 'content that does not concern us never reaches the pod');

  const control = mkPut();
  r = await gw.handleDelivery(mkReq28({ type: 'Follow', actor: 'https://stranger.example/u/y', object: ident.actorUrl }),
    ident, { podPut: control.put });
  check(r.status === 202 && control.puts.length === 2,
    'a Follow from a stranger always passes (two puts: activity + receipt)');
  const rcpt = JSON.parse(control.puts.find(p => p.u.endsWith('.receipt.json')).b);
  check(httpsig28.verifyReceipt(rcpt, ident.hmacSecret) === true && rcpt.verified === false,
    'the receipt is HMAC-valid and honestly records unverified (no reachable key here)');

  const failPod = { put: async () => false };
  r = await gw.handleDelivery(mkReq28({ type: 'Follow', actor: 'https://s.example/u', object: ident.actorUrl }),
    ident, { podPut: failPod.put });
  check(r.status === 502, 'a pod-write failure returns 5xx so the sender retries — the buffer is preserved');
  delete process.env.AP_ALLOW_PRIVATE_TARGETS;

  // The drain acts on a receipt ONLY in trust mode.
  const { PodStore: PS28 } = await import(path.join(root, 'lib/store.mjs'));
  const { Intake: IK28 } = await import(path.join(root, 'lib/intake.mjs'));
  const wire28 = await import(path.join(root, 'lib/wire.mjs'));
  const urls28 = wire28.apUrls('https://pod.example/');
  const FOLLOWER = 'https://m.example/u/joiner';
  const mkIntake = (mode) => {
    const st = new PS28({ log: () => {} });
    st.setConfig({ remotePod: 'https://pod.example/', handle: 'p', kind: 'person',
      ...(mode ? { gateway: { url: 'https://gw.example/in', webId: 'https://gw.example/#me', hmacSecret: 's', mode } } : {}) });
    const accepts = [];
    const ik = new IK28({ config: st.getConfig(), urls: urls28, remote: {}, store: st,
      deliverer: { deliver: async (i, a) => accepts.push(a), deliverToAll: async () => {} },
      publisher: { urls: urls28, publishCollections: async () => {}, publishProfile: async () => {} },
      local: {}, log: () => {} });
    ik.fetchAP = async (u) => ({ id: u, type: 'Person', inbox: u + '/inbox' });
    ik.republish = async () => {};
    return { st, ik, accepts };
  };
  const follow = { type: 'Follow', id: 'https://m.example/f/1', actor: FOLLOWER, object: urls28.actor };

  const shadow = mkIntake('shadow');
  await shadow.ik.handle(follow, { verified: true });
  check(shadow.st.getRequests().some(rq => rq.actor === FOLLOWER)
    && !shadow.st.getContacts().followers.some(f => f.actor === FOLLOWER),
    'in SHADOW mode a verified Follow still only QUEUES — receipts are measured, not trusted');

  const trust = mkIntake('trust');
  await trust.ik.handle(follow, { verified: true });
  check(trust.st.getContacts().followers.some(f => f.actor === FOLLOWER)
    && !trust.st.getRequests().some(rq => rq.actor === FOLLOWER)
    && trust.accepts.some(a => a.type === 'Accept'),
    'in TRUST mode a verified Follow auto-accepts — no queue, Accept sent');

  const trustUnverified = mkIntake('trust');
  await trustUnverified.ik.handle(follow, { verified: false });
  check(trustUnverified.st.getRequests().some(rq => rq.actor === FOLLOWER),
    'an UNVERIFIED follow in trust mode still queues (nothing proved the sender)');

  // A gateway-verified Undo is honored without the followId match an
  // unverified one needs.
  const u = mkIntake('trust');
  u.st.setContacts({ followers: [{ actor: FOLLOWER, inbox: FOLLOWER + '/inbox' /* no followId */ }], following: [] });
  await u.ik.handle({ type: 'Undo', actor: FOLLOWER, object: { type: 'Follow', actor: FOLLOWER, object: urls28.actor } },
    { verified: true });
  check(!u.st.getContacts().followers.some(f => f.actor === FOLLOWER),
    'a verified Undo drops the follower even with no stored follow id');
}

// --- 29. multi-user front: WebFinger, per-user actor rewrite, inbox routing ---
{
  const front = await import(path.join(root, 'lib/front-core.mjs'));
  const HOST = 'fedipod.net';
  const ORIGIN = 'https://fedipod.net';
  // Two users, each on their own pod, fronted under one domain.
  const dir = {
    me: { handle: 'me', podHome: 'https://alice.pod/solid/',
      actorUrl: 'https://fedipod.net/u/me/ap/actor', kind: 'person',
      gatewayWebId: 'https://fedipod.net/gw#me', hmacSecret: 'secret-me' },
    you: { handle: 'you', podHome: 'https://bob.pod/s/',
      actorUrl: 'https://fedipod.net/u/you/ap/actor', kind: 'person',
      gatewayWebId: 'https://fedipod.net/gw#me', hmacSecret: 'secret-you' },
  };
  // A fake pod: the actor doc served from alice.pod, ids on alice.pod.
  const podActor = JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://alice.pod/solid/ap/actor', type: 'Person', preferredUsername: 'alice',
    inbox: 'https://alice.pod/solid/ap/inbox/', outbox: 'https://alice.pod/solid/ap/outbox',
    followers: 'https://alice.pod/solid/ap/followers',
    publicKey: { id: 'https://alice.pod/solid/ap/actor#main-key',
      owner: 'https://alice.pod/solid/ap/actor', publicKeyPem: keys.rsaPublicPem },
  });
  const podGet = async (u) => u === 'https://alice.pod/solid/ap/actor'
    ? { status: 200, text: async () => podActor, headers: { get: () => null } }
    : { status: 404, text: async () => '', headers: { get: () => null } };
  const puts = [];
  const ctx = {
    host: HOST, frontOrigin: ORIGIN, lookup: (h) => dir[h] || null, podGet,
    podPut: async (h, u, b) => { puts.push({ h, u }); return true; },
  };
  const R = (method, p, body) => new Request(ORIGIN + p, body !== undefined
    ? { method, headers: { 'content-type': 'application/activity+json' }, body }
    : { method });

  // WebFinger resolves each handle to its fronted actor.
  const wf = await front.routeFront(R('GET', '/.well-known/webfinger?resource=acct:me@fedipod.net'), ctx);
  const wfDoc = JSON.parse(wf.body);
  check(wf.status === 200 && wfDoc.subject === 'acct:me@fedipod.net'
    && wfDoc.links[0].href === 'https://fedipod.net/u/me/ap/actor',
    'WebFinger maps @me@fedipod.net to the fronted actor');
  const wfMiss = await front.routeFront(R('GET', '/.well-known/webfinger?resource=acct:nobody@fedipod.net'), ctx);
  check(wfMiss.status === 404, 'an unknown handle 404s');
  const wfWrong = await front.routeFront(R('GET', '/.well-known/webfinger?resource=acct:me@other.net'), ctx);
  check(wfWrong.status === 404, 'a handle on another host is not ours to answer');

  // The fronted actor: id and all ids rewritten to the front, handle and inbox
  // fixed so a consumer cross-checks it consistently — the key is unchanged.
  const actorRes = await front.routeFront(R('GET', '/u/me/ap/actor'), ctx);
  const actor = JSON.parse(actorRes.body);
  check(actor.id === 'https://fedipod.net/u/me/ap/actor'
    && actor.outbox === 'https://fedipod.net/u/me/ap/outbox'
    && actor.followers === 'https://fedipod.net/u/me/ap/followers',
    'the fronted actor and every id under it live on the shared domain');
  check(actor.preferredUsername === 'me'
    && actor.inbox === 'https://fedipod.net/u/me/ap/inbox/'
    && actor.endpoints.sharedInbox === 'https://fedipod.net/u/me/ap/inbox/',
    'its handle is the fronted one and its inbox is the front (so deliveries are verified)');
  check(actor.publicKey.id === 'https://fedipod.net/u/me/ap/actor#main-key'
    && actor.publicKey.publicKeyPem === keys.rsaPublicPem,
    "the key id moves to the front but the key itself is the user's own");

  // A delivery to a user's fronted inbox is verified and forwarded to THAT
  // user's pod inbox — not the other user's.
  process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
  const del = await front.routeFront(
    R('POST', '/u/me/ap/inbox/', JSON.stringify({ type: 'Follow', actor: 'https://x.example/u/a', object: dir.me.actorUrl })),
    ctx);
  delete process.env.AP_ALLOW_PRIVATE_TARGETS;
  check(del.status === 202 && puts.every(p => p.h === 'me' && p.u.startsWith('https://alice.pod/solid/ap/inbox/')),
    "a Follow to @me is forwarded to alice's pod inbox, addressed by her handle");
  check(puts.length === 2, 'the activity and its receipt both land');

  // Routing is per-user: nothing about @me leaks into @you.
  const youActor = await front.routeFront(R('GET', '/u/you/ap/actor'), ctx);
  check(youActor.status === 404, "a user whose pod GET 404s the actor is simply not served (bob's pod is a stub here)");
  const unknownUser = await front.routeFront(R('GET', '/u/ghost/ap/actor'), ctx);
  check(unknownUser.status === 404, 'a handle not in the directory has no front presence');

  // The new-account page + handle-availability API.
  const ctx2 = { ...ctx, signupPage: '<!doctype html><title>join</title>', offersPods: true };
  const page = await front.routeFront(R('GET', '/'), ctx2);
  check(page.status === 200 && /text\/html/.test(page.headers['content-type']) && page.body.includes('join'),
    'the front root serves the new-account page');
  const signup = await front.routeFront(R('GET', '/signup'), ctx2);
  check(signup.status === 200, '/signup serves it too');
  const noPage = await front.routeFront(R('GET', '/'), ctx);
  check(noPage.status === 404, 'a front with no page configured 404s the root rather than inventing one');

  const free = JSON.parse((await front.routeFront(R('GET', '/api/handle?handle=alice'), ctx2)).body);
  check(free.available === true && free.offersPods === true,
    'a free, valid handle is available and the page learns the host offers pods');
  const taken = JSON.parse((await front.routeFront(R('GET', '/api/handle?handle=me'), ctx2)).body);
  check(taken.available === false && /taken/.test(taken.reason),
    'a handle already in the directory is not available');
  const bad = JSON.parse((await front.routeFront(R('GET', '/api/handle?handle=Bad_Name'), ctx2)).body);
  check(bad.available === false && /letters/.test(bad.reason), 'an ill-formed handle is rejected with the rule');
  const reserved = JSON.parse((await front.routeFront(R('GET', '/api/handle?handle=admin'), ctx2)).body);
  check(reserved.available === false && /reserved/.test(reserved.reason),
    'a reserved route name cannot be taken as a handle');
  const noPods = JSON.parse((await front.routeFront(R('GET', '/api/handle?handle=alice'), ctx)).body);
  check(noPods.offersPods === false, 'a host that does not offer pods says so, so the page hides that option');

  // Attach: prove the pod with a Solid-OIDC token, get a directory row.
  const written = {};
  const mutableDir = { ...dir };
  const attachCtx = {
    host: HOST, frontOrigin: ORIGIN, gatewayWebId: 'https://fedipod.net/gw#me',
    lookup: (h) => mutableDir[h] || null,
    putDirectory: (h, rec) => { mutableDir[h] = rec; written[h] = rec; },
    // Stub verifier: the token string IS the webid it proves (test shorthand).
    verifier: async (authz) => ({ webid: authz.replace(/^DPoP /, '') }),
    podGet, podPut: async () => true,
  };
  const attach = (body, webid) => {
    const req = new Request(ORIGIN + '/api/attach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(webid ? { authorization: 'DPoP ' + webid, dpop: 'x' } : {}) },
      body: JSON.stringify(body),
    });
    return front.routeFront(req, attachCtx);
  };

  const noTok = await attach({ handle: 'alice', podHome: 'https://alice.pod/solid/' });
  check(noTok.status === 401, 'attach with no Solid-OIDC token is refused');
  const wrongPod = await attach({ handle: 'alice', podHome: 'https://alice.pod/solid/' },
    'https://mallory.pod/profile#me');
  check(wrongPod.status === 403, 'a token proving a DIFFERENT pod than the one listed is refused');
  const ok = await attach({ handle: 'alice', podHome: 'https://alice.pod/solid/' },
    'https://alice.pod/profile/card#me');
  const okDoc = JSON.parse(ok.body);
  check(ok.status === 201 && okDoc.frontActor === 'https://fedipod.net/u/alice/ap/actor'
    && okDoc.address === '@alice@fedipod.net' && typeof okDoc.hmacSecret === 'string',
    'a valid token proving the pod creates the account and returns the fronted actor + a secret');
  check(okDoc.command === `fedipod front https://fedipod.net/u/alice/ap/actor --secret ${okDoc.hmacSecret}`,
    'and the one command the user runs to point their agent at the front');
  check(written.alice?.podHome === 'https://alice.pod/solid/' && written.alice?.webId === 'https://alice.pod/profile/card#me',
    'the directory row records the pod and the proven WebID');
  const dup = await attach({ handle: 'alice', podHome: 'https://alice.pod/solid/' },
    'https://alice.pod/profile/card#me');
  check(dup.status === 409, 'the name cannot be attached twice');
  const badName = await attach({ handle: 'Bad Name', podHome: 'https://alice.pod/solid/' },
    'https://alice.pod/profile/card#me');
  check(badName.status === 400, 'attach rejects an ill-formed handle');
  const noSignup = await front.routeFront(
    new Request(ORIGIN + '/api/attach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ctx2);
  check(noSignup.status === 501, 'a front with no writable directory answers 501 — signups are off, by design');
}

// --- 30. fronted identity: apUrls publicBase split + agent publishes under it ---
{
  const wire30 = await import(path.join(root, 'lib/wire.mjs'));
  const POD = 'https://alice.pod/solid/';
  const FRONT = 'https://fedipod.net/u/me/';

  // Regression pin: with no publicBase the object is exactly as before.
  const plain = wire30.apUrls('https://alice.pod/solid/');
  check(plain.actor === 'https://alice.pod/solid/activitypods-js/ap/actor'
    && plain.toPod === undefined && plain.publicHome === undefined,
    'apUrls with no publicBase is byte-identical to before (no map, pod-native ids)');

  const u = wire30.apUrls(POD, 'activitypods-js/', { publicBase: FRONT });
  check(u.actor === 'https://fedipod.net/u/me/ap/actor'
    && u.outbox === 'https://fedipod.net/u/me/ap/outbox'
    && u.notes === 'https://fedipod.net/u/me/ap/notes/'
    && u.followers === 'https://fedipod.net/u/me/ap/followers',
    'a fronted identity advertises actor and every collection on the shared domain');
  check(u.media === 'https://alice.pod/solid/activitypods-js/ap/media/'
    && u.state === 'https://alice.pod/solid/activitypods-js/ap-state/'
    && u.fediverse === 'https://alice.pod/solid/activitypods-js/fediverse/',
    'but media, state and the fediverse tree stay on the pod');
  check(u.toPod('https://fedipod.net/u/me/ap/notes/x') === 'https://alice.pod/solid/activitypods-js/ap/notes/x'
    && u.toPublic('https://alice.pod/solid/activitypods-js/ap/actor') === 'https://fedipod.net/u/me/ap/actor'
    && u.toPod('https://elsewhere.example/z') === 'https://elsewhere.example/z',
    'toPod/toPublic round-trip advertised↔pod ids and leave foreign ids alone');

  // RemotePod applies the map at its one choke point, so a write built from an
  // advertised id lands on the pod.
  const { RemotePod } = await import(path.join(root, 'lib/remote.mjs'));
  const seen = [];
  const rp = Object.create(RemotePod.prototype);
  rp.pausedUntil = 0; rp.session = { fetch: async (url) => { seen.push(url); return { status: 201 }; } };
  rp.toPod = null;
  await rp.fetch('https://fedipod.net/u/me/ap/notes/n1');
  check(seen[0] === 'https://fedipod.net/u/me/ap/notes/n1', 'with no map RemotePod writes the url as given');
  rp.setUrlMap(u.toPod);
  await rp.fetch('https://fedipod.net/u/me/ap/notes/n1');
  check(seen[1] === 'https://alice.pod/solid/activitypods-js/ap/notes/n1',
    'with the map installed the same advertised url is written to the pod');

  // A Publisher built for a fronted identity: its urls are fronted, it installs
  // the map on its remote, and a published note gets a fronted id.
  const { Publisher } = await import(path.join(root, 'lib/publisher.mjs'));
  const podWrites = [];
  let mapInstalled = null;
  const remote30 = {
    setUrlMap: (fn) => { mapInstalled = fn; },
    putJson: async (url) => { podWrites.push(url); },
    setAcl: async () => {}, delete: async () => true,
    probe: async () => ({ status: 401 }),
  };
  const pub = new Publisher({
    config: { remotePod: POD, handle: 'me', name: 'Me',
      gateway: { frontActor: 'https://fedipod.net/u/me/ap/actor', mode: 'trust' } },
    remote: remote30, local: { writeNote: async () => {} },
    store: {
      getStatuses: () => [], getContacts: () => ({ followers: [], following: [] }),
      addStatus: () => {}, read: (n, d) => (d !== undefined ? d : {}), write: () => {},
      getConfig: () => ({ handle: 'me' }),
    },
    deliverer: { deliverToAll: async () => {} }, publicKeyPem: 'K', log: () => {},
  });
  check(pub.urls.actor === 'https://fedipod.net/u/me/ap/actor' && typeof mapInstalled === 'function',
    'the Publisher advertises the fronted actor and installs the pod map on its remote');
  check(mapInstalled('https://fedipod.net/u/me/ap/notes/x') === 'https://alice.pod/solid/activitypods-js/ap/notes/x',
    'and the installed map is the fronted→pod one');
  const note = await pub.publishNote('hello from the fronted identity', { visibility: 'public' });
  check(note.id.startsWith('https://fedipod.net/u/me/ap/notes/') && note.attributedTo === 'https://fedipod.net/u/me/ap/actor',
    'a published note carries a fronted id and a fronted author');
  check(podWrites.some(w => w.startsWith('https://fedipod.net/u/me/ap/notes/')),
    'the note is PUT under its advertised id — RemotePod maps it to the pod at write time');
}

// The CSS-gateway component (packages/css-gateway) is a TypeScript package with
// its own toolchain (tsc + componentsjs-generator) and its own tests — `npm
// test` there, and `test/live-css.mjs` against a real CSS. It is deliberately
// NOT exercised from this offline suite.

child.kill('SIGTERM');
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green');
if (failures) console.log('--- agent log ---\n' + bootLog);
process.exit(failures ? 1 : 0);
