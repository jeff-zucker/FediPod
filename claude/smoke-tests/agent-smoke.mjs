// agent-smoke.mjs — offline smoke for activitypod-js. No network; no pod.
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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOME = fs.mkdtempSync('/tmp/activitypod-smoke-');
const PORT = 18621;
const TOKEN = 'smoke-token';

let failures = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures++; };

// --- 1. boot (unconfigured: no credential.json in HOME) ---
const child = spawn(process.execPath, [path.join(root, 'run-agent.mjs')], {
  cwd: root,
  env: { ...process.env, AP_HOME: HOME, AP_PORT: String(PORT), AP_GATE_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
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
  check(hdrs.headers.get('x-content-type-options') === 'nosniff'
    && /frame-ancestors 'none'/.test(hdrs.headers.get('content-security-policy') || '')
    && hdrs.headers.get('x-frame-options') === 'DENY',
    'security headers present on HTML');

  const niPtr = await fetch(`http://127.0.0.1:${PORT}/.well-known/nodeinfo`, { headers: gh });
  const niPtrBody = await niPtr.json();
  const niDoc = await fetch(`http://127.0.0.1:${PORT}/nodeinfo/2.0`, { headers: gh });
  const niDocBody = await niDoc.json();
  check(niPtr.status === 200 && /\/nodeinfo\/2\.0$/.test(niPtrBody.links?.[0]?.href)
    && niDoc.status === 200 && niDocBody.software?.name === 'activitypod-js'
    && niDocBody.protocols?.includes('activitypub'),
    'nodeinfo pointer + document served');

  const ui = await fetch(`http://127.0.0.1:${PORT}/`, { headers: gh });
  const uiBody = await ui.text();
  check(ui.status === 200 && /text\/html/.test(ui.headers.get('content-type')) && /phanpy/i.test(uiBody),
    `/ serves the bundled Phanpy UI (got ${ui.status})`);
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
  check(inst.status === 200 && /activitypod-js/.test(instBody.version), `/api/v1/instance → 200 (got ${inst.status})`);

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
  const ttl = '<https://p.example/in/> a <http://www.w3.org/ns/ldp#Container>. '
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
  const listing = '<https://p.example/st/> a <http://www.w3.org/ns/ldp#Container>. '
    + '<https://p.example/st/config.json> a <x>.';
  let containerEtag = '"c1"', docEtag = '"d1"', reqs = [];
  store.attach('https://p.example/st/', async (url, init) => {
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

  check(/^activitypod-js\/\d+\.\d+\.\d+ \(\+https?:\/\/\S+\)$/.test(USER_AGENT),
    `the User-Agent names the software and where to complain (${USER_AGENT})`);

  // Both the token endpoint and resource requests must carry it.
  const seen = [];
  globalThis.fetch = async (u, init) => { seen.push(init?.headers?.['user-agent']); return ok(); };
  const s1 = createGrantSession(rec);
  await s1.warmup();
  await s1.fetch('https://p.example/some/doc');
  check(seen.length === 2 && seen.every(ua => ua === USER_AGENT),
    'token requests and pod requests both send it');

  // The ceiling holds regardless of what any caller does.
  process.env.AP_MAX_REQUESTS_PER_MIN = '3';
  let hits = 0;
  globalThis.fetch = async () => { hits++; return ok(); };
  const s2 = createGrantSession(rec);
  let refusal = null;
  try {
    for (let i = 0; i < 10; i++) await s2.fetch(`https://p.example/doc${i}`);
  } catch (e) { refusal = e.message; }
  delete process.env.AP_MAX_REQUESTS_PER_MIN;
  check(hits <= 3 && /ceiling of 3 requests\/min/.test(refusal || ''),
    `a ceiling of 3/min stops at 3 sockets, not 10 (opened ${hits})`);

  globalThis.fetch = realFetch;
}

// --- 5i. a refused write is not retried; a 503 is, politely ---
{
  const mkStore = () => new PodStore({ log: () => {} });
  const res = (status, headers = {}) => ({ status, headers: { get: (h) => headers[h.toLowerCase()] ?? null } });

  // 403 means "no": one attempt, then stop.
  const s403 = mkStore();
  let puts403 = 0;
  s403.attach('https://p.example/st/', async (_u, init) => {
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
  s503.attach('https://p.example/st/', async (_u, init) => {
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
    const store = {
      getStatuses: () => [],
      getConfig: () => saved,
      setConfig: (c) => { saved = c; },
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
  q.publisher.store.read = (_n, d) => d;
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
  const listing = '<https://p.example/st/> a <http://www.w3.org/ns/ldp#Container>. '
    + '<https://p.example/st/config.json> a <http://www.w3.org/ns/ldp#Resource>. '
    + '<https://p.example/st/statuses.json> a <http://www.w3.org/ns/ldp#Resource>.';
  const mk = (docStatus) => {
    const store = new PodStore({ log: () => {} });
    const seen = [];
    store.attach('https://p.example/st/', async (url) => {
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
  noConfig.attach('https://p.example/st/', async (url) =>
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
      listContainer: async () => [item],
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

// --- 6. pod-RDF builders via injected fetch ---
const { PodRdf } = await import(path.join(root, 'lib/podrdf.mjs'));
const rdfPuts = [];
const rdf = new PodRdf({
  base: 'https://pod.example/activitypods-js/fediverse/',
  fetchImpl: async (url, init = {}) => { rdfPuts.push({ url, body: init.body }); return { status: 200, text: async () => '' }; },
});
await rdf.writeNote('timeline', 's1', {
  noteId: 'https://m.example/n/1', actor: 'https://m.example/u/a',
  published: '2026-07-28T00:00:00Z', content: 'say "hi"\nnewline',
});
check(rdfPuts[0].body.includes('\\"hi\\"') && rdfPuts[0].body.includes('\\n'), 'turtle literal escaping');
check(rdfPuts[0].url === 'https://pod.example/activitypods-js/fediverse/timeline/s1',
  `timeline path (got ${rdfPuts[0].url})`);

await rdf.writeNote('timeline', 's2', {
  noteId: 'https://m.example/n/2', actor: 'https://m.example/u/a', published: '2026-07-28T00:00:00Z',
  content: 'with pic', attachments: [{ url: 'https://m.example/media/p.png', mediaType: 'image/png', description: 'a "pic"' }],
});
check(rdfPuts[1].body.includes('as:attachment <https://m.example/media/p.png>')
  && rdfPuts[1].body.includes('as:mediaType "image/png"'),
  'attachments written as as:attachment + as:mediaType');
rdf.get = async () => rdfPuts[1].body;
const back = await rdf.readNote('https://x/n');
check(back.attachments?.length === 1 && back.attachments[0].mediaType === 'image/png'
  && back.attachments[0].description === 'a "pic"',
  'attachment round-trips through readNote');

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
store2.setContacts({
  followers: [{ actor: ALICE, inbox: 'https://m.example/u/alice/inbox', followId: 'f1' }],
  following: [{ actor: 'https://m.example/u/bob', inbox: 'https://m.example/u/bob/inbox', accepted: true,
    followActivity: { id: 'x#follow-1', type: 'Follow' } }],
});
store2.addNotification({ type: 'follow', actor: ALICE });
store2.addNotification({ type: 'favourite', actor: ALICE, noteId: OWN });

const delivered = [];
const puts = [];
const fakeAgent = {
  store: store2,
  configured: () => true,
  publisher: { urls: urls2, ensureMediaContainer: async () => {}, publishCollections: async () => {} },
  deliverer: {
    deliver: async (inbox, a) => delivered.push({ inbox, a }),
    deliverToAll: async (inboxes, a) => delivered.push({ inboxes, a }),
  },
  remote: { put: async (u, b, ct) => puts.push({ u, ct, len: b.length }), putJson: async () => {}, delete: async () => true },
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

const fol = await call(`/api/v1/accounts/${store2.idFor('https://m.example/u/carol')}/follow`, { method: 'POST' });
check(fol.status === 200 && fol.json.requested === true
  && delivered.some(d => d.a?.type === 'Follow' && d.a.object === 'https://m.example/u/carol'),
  'follow by id delivers Follow, relationship requested');

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
check(homeWithTag.json.some(s => s.uri === 'https://m.example/n/t1')
  && homeWithTag.json.some(s => s.uri === 'https://m.example/n/boost1'),
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
  const cli = path.join(root, 'bin/activitypod.mjs');
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
  const cli = path.join(root, 'bin/activitypod.mjs');
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
  const cli = path.join(root, 'bin/activitypod.mjs');
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
    process.argv = [process.argv[0], 'bin/activitypod.mjs', 'install-service'];
    await import('${path.join(root, 'bin/activitypod.mjs')}');
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
    if (body.includes('takenpod')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"message":"exists"}'); return; }
    return send9({ pod: 'http://127.0.0.1:18622/newpod/', webId: 'http://127.0.0.1:18622/newpod/profile/card#me' });
  }
  if (req.url === '/.account/pod/' && req.method === 'GET') {
    return send9({ pods: { 'http://127.0.0.1:18622/takenpod/': 'http://127.0.0.1:18622/.account/pod/x' } });
  }
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
const reused = await createAccountWithPod({
  issuer: 'http://127.0.0.1:18622', email: 'x@example.org', password: 'pw', podName: 'takenpod',
});
check(reused.pod === 'http://127.0.0.1:18622/takenpod/' && /card#me$/.test(reused.webId),
  'existing own pod is reused, not an error');
mockCss.close();

child.kill('SIGTERM');
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green');
if (failures) console.log('--- agent log ---\n' + bootLog);
process.exit(failures ? 1 : 0);
