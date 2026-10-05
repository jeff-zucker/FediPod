// door-verify.test.mjs — the door verifies a delivery as the sender signed it,
// whatever an edge did to the Host header or the URL's host on the way in;
// and a signature that does not verify is passed on unverified, not dropped.
// Keys are served from this process, so the address guard is told to allow
// that for this process only.
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
const { signRequest } = await import('@fedify/fedify/sig');
const { handleDelivery } = await import('../../lib/gateway/gateway-core.mjs');
const { verifyReceipt } = await import('../../lib/gateway/httpsig.mjs');

const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64').match(/.{1,64}/g).join('\n');
const pem = `-----BEGIN PUBLIC KEY-----\n${spki}\n-----END PUBLIC KEY-----\n`;
let ORIGIN = '', ACTOR = '';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/activity+json' });
  res.end(JSON.stringify({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'], id: ACTOR, type: 'Person',
    preferredUsername: 'mei', inbox: ORIGIN + '/users/mei/inbox', publicKey: { id: ACTOR + '#main-key', owner: ACTOR, publicKeyPem: pem } }));
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
ORIGIN = `http://127.0.0.1:${srv.address().port}`; ACTOR = ORIGIN + '/users/mei';
test.after(() => srv.close());

const DOOR = 'https://fedipod.example';
const ident = () => ({ inboxUrl: ORIGIN + '/pod/fedipod/ap/inbox/', actorUrl: DOOR + '/u/jeff/ap/actor', followersUrl: DOOR + '/u/jeff/ap/followers',
  notesPrefix: DOOR + '/u/jeff/ap/notes/', following: [ACTOR], blocklist: {}, kind: 'person', gatewayWebId: DOOR + '/gw#it', hmacSecret: 'secret' });
const body = () => JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: ACTOR + '/s/' + crypto.randomUUID() + '/activity', type: 'Create', actor: ACTOR,
  to: ['https://www.w3.org/ns/activitystreams#Public'], cc: [ACTOR + '/followers'], object: { id: ACTOR + '/s/1', type: 'Note', attributedTo: ACTOR, content: '<p>hi</p>' } });
const signed = (spec, b = body()) => signRequest(new Request(DOOR + '/u/jeff/ap/inbox/', { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: b }),
  pair.privateKey, new URL(ACTOR + '#main-key'), spec ? { spec } : {});
// What an edge can do on the way in: another Host header, another URL host.
const throughEdge = async (req) => {
  const h = new Headers(req.headers); h.set('host', 'fedipod-example.netlify.app');
  return new Request('https://fedipod-example.netlify.app/u/jeff/ap/inbox/', { method: 'POST', headers: h, body: await req.text() });
};
const pod = () => { const puts = []; return { puts, put: async (u, b) => { puts.push({ u, b }); return true; } }; };

for (const spec of [undefined, 'rfc9421']) {
  const tag = spec || 'draft-cavage';
  test(`${tag}: a delivery rewritten by the edge still verifies, because the door checks it as the sender signed it`, async () => {
    const p = pod();
    const r = await handleDelivery(await throughEdge(await signed(spec)), ident(), { podPut: p.put, fetchImpl: fetch, origin: DOOR });
    assert.equal(r.status, 202); assert.equal(r.reason, 'verified');
    const rcpt = JSON.parse(p.puts.find((x) => x.u.endsWith('.receipt.json')).b);
    assert.equal(rcpt.verified, true); assert.equal(rcpt.method, tag);
  });
  test(`${tag}: without the door's origin, the same rewritten delivery reads as unverified and is still passed on`, async () => {
    const p = pod();
    const r = await handleDelivery(await throughEdge(await signed(spec)), ident(), { podPut: p.put, fetchImpl: fetch });
    assert.equal(r.status, 202);
    assert.match(r.reason, new RegExp(`^buffered-unverified: signature invalidSignature \\(${tag}\\); host fedipod-example\\.netlify\\.app, date yes, digest yes; ${spec ? 'sig' : 'keyId='}`, 'u'));
    assert.doesNotMatch(r.reason, /signature="[A-Za-z0-9+/=]{20}/u, 'the signature value itself is not logged');
    assert.equal(p.puts.length, 2, 'the item and its receipt reach the pod');
    const rcpt = JSON.parse(p.puts.find((x) => x.u.endsWith('.receipt.json')).b);
    assert.equal(verifyReceipt(rcpt, 'secret'), true); assert.equal(rcpt.verified, false); assert.equal(rcpt.reason, 'bad-signature');
  });
}

test('a tampered body is passed on unverified with the reason in the answer, not dropped', async () => {
  const p = pod();
  const req = await signed();
  const tampered = new Request(req.url, { method: 'POST', headers: req.headers, body: (await req.text()) + ' ' });
  const r = await handleDelivery(tampered, ident(), { podPut: p.put, fetchImpl: fetch, origin: DOOR });
  assert.equal(r.status, 202); assert.match(r.reason, /^buffered-unverified: signature invalidSignature/u);
  assert.equal(p.puts.length, 2);
});

test('an unsigned delivery reads as before', async () => {
  const p = pod();
  const r = await handleDelivery(new Request(DOOR + '/u/jeff/ap/inbox/', { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: body() }),
    ident(), { podPut: p.put, fetchImpl: fetch, origin: DOOR });
  assert.equal(r.reason, 'buffered-unverified'); assert.equal(p.puts.length, 2);
});

// A signed read of a private post: the reader is the key's owner only when the
// key sits on the owner's own server. Anyone can publish a key document naming
// somebody else as its owner.
const { signedReader } = await import('../../lib/gateway/private-read.mjs');
const forger = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const forgedPem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey('spki', forger.publicKey)).toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
let FORGED_KEY = '';
const elsewhere = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/activity+json' });
  res.end(JSON.stringify({ '@context': 'https://w3id.org/security/v1', id: FORGED_KEY, type: 'CryptographicKey', owner: ACTOR, publicKeyPem: forgedPem }));
});
await new Promise((r) => elsewhere.listen(0, '127.0.0.1', r));
FORGED_KEY = `http://127.0.0.1:${elsewhere.address().port}/keys/1`;
test.after(() => elsewhere.close());

const privateGet = (key, keyId) => signRequest(new Request(DOOR + '/u/jeff/ap/private/2026-10-05-abcd1234', { method: 'GET', headers: { accept: 'application/activity+json' } }),
  key, new URL(keyId));

test('a signed read names the follower whose own server holds the key', async () => {
  const r = await signedReader(await privateGet(pair.privateKey, ACTOR + '#main-key'), { fetchImpl: fetch, origin: DOOR });
  assert.equal(r.actor, ACTOR);
});

test('a key published on another server naming a follower as its owner reads as nobody', async () => {
  const r = await signedReader(await privateGet(forger.privateKey, FORGED_KEY), { fetchImpl: fetch, origin: DOOR });
  assert.equal(r.actor, null);
  assert.equal(r.reason, 'key-not-on-signer-origin');
});

test('an inbox with no room for unchecked mail turns it away unwritten, and still takes signed mail', async () => {
  const roomFor = (verified) => verified;
  const p = pod();
  const unsigned = await handleDelivery(new Request(DOOR + '/u/jeff/ap/inbox/', { method: 'POST', headers: { 'content-type': 'application/activity+json' }, body: body() }),
    ident(), { podPut: p.put, fetchImpl: fetch, origin: DOOR, admit: roomFor });
  assert.equal(unsigned.status, 503); assert.equal(p.puts.length, 0);
  const signedOne = await handleDelivery(await signed(), ident(), { podPut: p.put, fetchImpl: fetch, origin: DOOR, admit: roomFor });
  assert.equal(signedOne.status, 202); assert.equal(signedOne.reason, 'verified'); assert.equal(p.puts.length, 2);
});
