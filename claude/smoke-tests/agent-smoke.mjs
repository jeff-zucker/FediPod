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
const { ensureKeys } = await import(path.join(root, 'lib/keys.mjs'));
const store = new PodStore({ log: () => {} });
const keys = await ensureKeys(store);
check(/^-----BEGIN PUBLIC KEY-----/.test(keys.rsaPublicPem), 'RSA public PEM present');
check(store.has('keys.json'), 'keys persisted through PodStore');

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

// --- 8i. the port chosen at setup is remembered by later commands ---
{
  const { execFileSync } = await import('node:child_process');
  const home = fs.mkdtempSync('/tmp/dk-ap-port-');
  const cli = path.join(root, 'bin/activitypod.mjs');
  const child2 = spawn(process.execPath, [cli, 'run', '--port', '18778'], {
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
