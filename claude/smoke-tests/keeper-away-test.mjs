// keeper-away-test.mjs — fedipod.net working for a person while FediPod is
// closed (lib/gateway/keeper.mjs over account-agent.mjs and pod-mail.mjs): a
// follow held at the door is accepted, the Accept goes to the follower, the
// copy records the follower, the pod is never written, and what changed is
// handed to the pod inbox as one stamped item. Other held mail goes to the pod
// inbox in a batch, for FediPod.
// Run from the project root: node claude/smoke-tests/keeper-away-test.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import { memoryKv } from '../../lib/gateway/copy.mjs';
import { keepOnce } from '../../lib/gateway/keeper.mjs';
import { verifyReceipt } from '../../lib/gateway/httpsig.mjs';

process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

// A follower on another server, and the pod: one local server for both.
const delivered = [];
const podWrites = [];
const server = http.createServer((q, s) => {
  const chunks = [];
  q.on('data', (c) => chunks.push(c));
  q.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    if (q.url.startsWith('/pod/') && q.method !== 'GET' && q.method !== 'HEAD') podWrites.push([q.method, q.url]);
    if (q.url === '/ama') {
      s.writeHead(200, { 'content-type': 'application/activity+json' });
      return s.end(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${base}/ama`, type: 'Person',
        preferredUsername: 'ama', inbox: `${base}/ama/inbox`, publicKey: { id: `${base}/ama#key`, owner: `${base}/ama`, publicKeyPem: '' } }));
    }
    if (q.url === '/ama/inbox' && q.method === 'POST') { delivered.push(JSON.parse(body)); s.writeHead(202); return s.end(); }
    s.writeHead(404); s.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const POD = `${base}/pod/`;
const HOME = `${POD}fedipod/`;
const ACTOR = `${HOME}ap/actor`;
const SECRET = 'door-secret-for-the-test';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const kv = memoryKv();
const put = (name, obj) => kv.set(`nia/d/${name}`, JSON.stringify(obj));
await put('config-public.json', { handle: 'nia', name: 'Nia', root: 'fedipod/', remotePod: POD, kind: 'person', inboxUrl: `${HOME}ap/inbox/`,
  gateway: { url: `${base}/u/nia/ap/inbox/`, hmacSecret: SECRET, mode: 'trust' } });
await put('contacts.json', { followers: [], following: [] });
await put('queue.json', []);
await kv.set('nia/meta', JSON.stringify({ v: 2, full: false, filledAt: Date.now(), podOnly: ['keys.json'] }));

const held = new Map();
const follow = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${base}/ama/follows/1`, type: 'Follow', actor: `${base}/ama`, object: ACTOR };
const note = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${base}/ama/creates/1`, type: 'Create', actor: `${base}/ama`,
  object: { id: `${base}/ama/notes/1`, type: 'Note', attributedTo: `${base}/ama`, content: 'hello', to: ['https://www.w3.org/ns/activitystreams#Public'] } };
held.set('nia/f1', JSON.stringify(follow));
held.set('nia/n1', JSON.stringify(note));
const appended = [];
const keyAsked = [];
const rec = { handle: 'nia', kind: 'person', webId: `${POD}profile/card#me`, podHome: HOME, actorUrl: ACTOR, hmacSecret: SECRET,
  openedAt: new Date().toISOString(), keeper: { webId: 'https://reader.example/#me' } };
const ctx = {
  copyKv: kv, keeperWebId: 'https://reader.example/#me',
  listHeld: async (h) => [...held.keys()].filter((k) => k.startsWith(`${h}/`)).map((k) => k.slice(h.length + 1)),
  readHeld: async (h, n) => held.get(`${h}/${n}`) ?? null,
  dropHeld: async (h, n) => { held.delete(`${h}/${n}`); },
  podPut: async (h, url, body, ct) => { appended.push({ url, body, ct }); return true; },
};
// The key reader's session: the signing key and nothing else.
const session = { fetch: async (url) => {
  keyAsked.push(String(url));
  if (String(url) === `${HOME}ap-state/keys.json`) {
    return new Response(JSON.stringify({ rsa: { privatePem: privateKey, publicPem: publicKey } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('', { status: 403 });
} };

try {
  const out = await keepOnce(ctx, 'nia', rec, { session, log: () => {} });
  check(!out.skipped, `the run went ahead (${out.skipped || 'ok'})`);
  check(delivered.some((a) => a.type === 'Accept' && (a.object?.id || a.object) === follow.id), 'the follow is accepted and the follower told');
  const contacts = JSON.parse((await kv.get('nia/d/contacts.json')).text);
  check(contacts.followers.some((f) => f.actor === `${base}/ama`), 'the copy records the new follower');
  check(keyAsked.every((u) => u === `${HOME}ap-state/keys.json`), 'the only thing read with the key reader is the key');
  check(!podWrites.length, `nothing is written to the pod (${podWrites.map((w) => w.join(' ')).join(', ')})`);
  const items = appended.filter((a) => /\/gw-\d{10}-[0-9a-f]+\.json$/.test(a.url));
  const receipts = appended.filter((a) => /\/gw-\d{10}-[0-9a-f]+\.json\.receipt\.json$/.test(a.url));
  const item = items[0] ? JSON.parse(items[0].body) : null;
  check(items.length === 1 && verifyReceipt(JSON.parse(receipts[0]?.body || '{}'), SECRET), 'what changed is handed to the pod inbox as one stamped item');
  check(!!item?.deltas?.['contacts.json'] && (item.writes || []).some((w) => /\/ap\/followers/.test(w.url)),
    'with the new follower and the public list of followers in it');
  const batch = appended.find((a) => /\/batch-[^/]*\.json$/.test(a.url));
  check(!!batch && JSON.parse(batch.body).batch.some((e) => e.name === 'n1') && !JSON.parse(batch.body).batch.some((e) => e.name === 'f1'),
    'the other mail goes to the pod inbox for FediPod, and the follow does not go twice');
  check(!held.size, 'nothing is left held at the gateway');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }
server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
