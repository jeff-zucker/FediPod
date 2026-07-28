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
check(accSelf.status === 200 && accSelf.json.some(a => a.acct === 'jeff'),
  'accounts/search finds self by handle');
const accContact = await call('/api/v2/search?type=accounts&q=alice');
check(accContact.status === 200 && accContact.json.accounts.some(a => a.url === ALICE),
  'v2 accounts search finds contact');

const local = await call('/api/v1/timelines/public?local=true');
const fed = await call('/api/v1/timelines/public');
const trend = await call('/api/v1/trends/statuses');
check(local.json.every(s => s.account.acct === 'jeff') && local.json.length >= 1,
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
check(localAgain.json.every(s => s.account.acct === 'jeff'), 'public?local still own posts only');

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
    return send9({ pod: 'http://127.0.0.1:18622/newpod/', webId: 'http://127.0.0.1:18622/newpod/profile/card#me' });
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
mockCss.close();

child.kill('SIGTERM');
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall green');
if (failures) console.log('--- agent log ---\n' + bootLog);
process.exit(failures ? 1 : 0);
