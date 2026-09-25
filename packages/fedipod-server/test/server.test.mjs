// Unit tests for the CSS-free pieces: route claiming, the Node<->WHATWG
// adapter, and the store-backed directory/podPut. The CSS-coupled shell
// (handler.mjs, store-css.mjs) is verified against a running CSS instance, not
// here — importing it needs @solid/community-server.
//
//   node --test   (from packages/css-gateway)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { claims, agentClaims } from '../dist/claims.js';
import { nodeToWhatwg, applyToNode } from '../dist/adapt.js';
import { makeDirectory, makeStorePodPut, makeAgentRegistry, agentKey, frontRow } from '../dist/directory.js';

test('claims only the front host, only its routes', () => {
  const F = 'fedipod.net';
  assert.equal(claims({ host: 'fedipod.net', pathname: '/.well-known/webfinger' }, F), true);
  // Signing up is the pod server's own business — the root and the signup
  // pages are left alone. What is FediPod's is opting an existing pod in.
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/' }, F), false, 'the root is the pod server\'s');
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/signup' }, F), false, 'and so is signing up');
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/new-account' }, F), false);
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/.fediverse-account' }, F), true,
    'opting a pod in is FediPod\'s, at the path it answers on');
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/run' }, F), false, 'and only at that one');
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/joining' }, F, '/joining'), true,
    'an operator may name it something else');
  assert.equal(claims({ host: 'fedipod.net', pathname: '/u/alice/ap/actor' }, F), true);
  assert.equal(claims({ host: 'fedipod.net', pathname: '/@alice' }, F), true, 'the short profile address is the front\'s');
  assert.equal(claims({ host: 'fedipod.net', pathname: '/some/pod/doc' }, F), false, 'a non-front path falls through');
  assert.equal(claims({ host: 'alice.fedipod.net', pathname: '/.well-known/webfinger' }, F), false,
    'a pod subdomain is never claimed');
  assert.equal(claims({ host: '', pathname: '/' }, F), false);
});

test('claims every route the front core serves, pages and the files they load', () => {
  const F = 'fedipod.net';
  // Each page is useless without what it loads, so the assets are claims too:
  // an unclaimed one falls through to the pod and 404s.
  for (const pathname of ['/.fediverse-account', '/roster',
    '/.well-known/webfinger', '/api/handle', '/api/attach', '/api/agent',
    '/api/roster', '/api/revoke',
    '/solid-oidc-client.js', '/install', '/new-account.js', '/run.js', '/admin.js']) {
    assert.equal(claims({ host: 'fedipod.net', pathname }, F), true, pathname);
  }
});

// The path here is already relative to the identity's mount: the handler
// matches host and mount to one identity and strips the mount before asking
// this, so a host-root pod's `/ap/actor` and a suffix pod's `/aisha/ap/actor`
// both arrive as `/ap/actor`. See the handler's resolveClaim/stripMount and the
// suffix e2e for the host+mount resolution itself.
test('an identity claims its protocol routes and its door, and nothing else', () => {
  const owns = (pathname, method) => agentClaims({ pathname, method });
  assert.equal(owns('/api/v1/instance'), true);
  assert.equal(owns('/oauth/authorize'), true);
  assert.equal(owns('/ap/actor'), true);
  assert.equal(owns('/ap/outbox'), true);
  assert.equal(owns('/.well-known/nodeinfo'), true);
  assert.equal(owns('/nodeinfo/2.0'), true);
  assert.equal(owns('/fp/'), true, 'the door');
  assert.equal(owns('/fedipod/ap/actor'), false, 'the identity\'s own documents under /fedipod/ are the pod\'s');
  assert.equal(owns('/fp'), true, 'and the door without its slash');
  assert.equal(owns('/app/'), false, 'a name the owner may want is theirs');
  assert.equal(owns('/profile/card'), false, 'a pod resource is the pod\'s');
  assert.equal(owns('/ap/inbox/x.json'), false, 'inbox items are pod resources, read and written as such');
  const inbox = '/fedipod/ap/inbox/';
  assert.equal(agentClaims({ pathname: inbox, method: 'POST' }), true,
    'a delivery POSTed to the inbox is verified at the door');
  assert.equal(agentClaims({ pathname: inbox, method: 'GET' }), false,
    'reading the container is the pod\'s');
  assert.equal(agentClaims({ pathname: inbox, method: 'PUT' }), false,
    'and so is a write by name — an outside door forwards that way');
  assert.equal(agentClaims({ pathname: inbox + 'item.json', method: 'POST' }), false,
    'only the container itself takes deliveries');
  assert.equal(agentClaims({ pathname: '/fp/' }, ''), false,
    'with no door configured there are no pages to claim');
});

test('the registry key is host+path, so several pods can share a host', () => {
  // A host-root pod's key is just its host — the shape rows had before suffix
  // pods, so old rows still resolve. A suffix pod folds its path in.
  assert.equal(agentKey('mei.example.org', 'https://mei.example.org/'), 'mei.example.org');
  assert.equal(agentKey('server.example', 'https://server.example/aisha/'), 'server.example/aisha');
  assert.notEqual(
    agentKey('server.example', 'https://server.example/aisha/'),
    agentKey('server.example', 'https://server.example/tamara/'),
    'two suffix pods on one host get distinct keys');
});

test('the opt-in registry keeps rows and an index, and forgets cleanly', async () => {
  const disk = new Map();
  const io = {
    read: async (u) => disk.get(u) ?? null,
    write: async (u, b) => { disk.set(u, b); },
    remove: async (u) => { disk.delete(u); },
  };
  const reg = makeAgentRegistry(io, 'http://s/agents/');
  assert.deepEqual(await reg.listKeys(), [], 'empty registry lists nothing');
  await reg.add({ podBase: 'http://mei.s/', handle: 'mei', host: 'mei.s', webId: 'http://mei.s/profile/card#me', optedInAt: 't' });
  assert.deepEqual(await reg.listKeys(), [ 'mei.s' ], 'a host-root pod keys by its host');
  assert.equal((await reg.get('mei.s'))?.handle, 'mei');
  await reg.add({ podBase: 'http://mei.s/', handle: 'mei', host: 'mei.s', webId: 'http://mei.s/profile/card#me', optedInAt: 't2' });
  assert.deepEqual(await reg.listKeys(), [ 'mei.s' ], 're-adding does not duplicate the index');
  // A suffix pod on the same host keys by host+path, so it sits beside, not over.
  await reg.add({ podBase: 'http://mei.s/aisha/', handle: 'aisha', host: 'mei.s', webId: 'http://mei.s/aisha/profile/card#me', optedInAt: 't3' });
  assert.deepEqual(await reg.listKeys(), [ 'mei.s', 'mei.s/aisha' ], 'a suffix pod is a distinct key on the shared host');
  assert.equal((await reg.get('mei.s/aisha'))?.handle, 'aisha');
  assert.equal((await reg.get('mei.s'))?.handle, 'mei', 'and does not disturb the host-root row');
  await reg.remove('mei.s/aisha');
  await reg.remove('mei.s');
  assert.deepEqual(await reg.listKeys(), []);
  assert.equal(await reg.get('mei.s'), null);
  await reg.remove('mei.s');   // absence is not an error
});

test('nodeToWhatwg carries method, absolute url, headers and body', async () => {
  const req = Readable.from([Buffer.from('{"type":"Follow"}')]);
  req.method = 'POST';
  req.url = '/u/alice/ap/inbox/';
  req.headers = { host: 'fedipod.net', 'content-type': 'application/activity+json', signature: 'sig' };
  const w = await nodeToWhatwg(req, 'https://fedipod.net');
  assert.equal(w.method, 'POST');
  assert.equal(w.url, 'https://fedipod.net/u/alice/ap/inbox/');
  assert.equal(w.headers.get('signature'), 'sig');
  assert.equal(await w.text(), '{"type":"Follow"}');
});

test('nodeToWhatwg refuses a body over the cap with a 413-marked error', async () => {
  const chunk = Buffer.alloc(600 * 1024);
  const req = Readable.from([ chunk, chunk ]);   // 1.2 MB in two chunks
  req.method = 'POST';
  req.url = '/api/attach';
  req.headers = { host: 'fedipod.net' };
  await assert.rejects(nodeToWhatwg(req, 'https://fedipod.net'),
    (e) => e.statusCode === 413);
});

test('nodeToWhatwg reads no body for GET', async () => {
  const req = Readable.from([]);
  req.method = 'GET'; req.url = '/'; req.headers = { host: 'fedipod.net' };
  const w = await nodeToWhatwg(req, 'https://fedipod.net');
  assert.equal(w.method, 'GET');
});

test('applyToNode writes a plain {status,headers,body} result', async () => {
  const res = { s: 0, h: null, b: null, writeHead(s, h) { this.s = s; this.h = h; }, end(b) { this.b = b; } };
  await applyToNode(res, { status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
  assert.equal(res.s, 201);
  assert.equal(res.h['content-type'], 'application/json');
  assert.equal(res.b, '{"ok":true}');
});

test('applyToNode writes a WHATWG Response', async () => {
  const res = { s: 0, h: null, b: null, writeHead(s, h) { this.s = s; this.h = h; }, end(b) { this.b = b; } };
  await applyToNode(res, new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } }));
  assert.equal(res.s, 200);
  assert.equal(res.b, 'hi');
});

test('the store-backed directory round-trips and podPut writes through the store', async () => {
  const disk = new Map();
  const io = {
    read: async (u) => (disk.has(u) ? disk.get(u) : null),
    write: async (u, b) => { disk.set(u, b); },
  };
  const dir = makeDirectory(io, 'http://localhost:3000/.internal/fedipod/directory/');
  assert.equal(await dir.lookup('alice'), null, 'unknown handle is null');
  await dir.putDirectory('alice', { handle: 'alice', podHome: 'https://alice.pod/' });
  const back = await dir.lookup('alice');
  assert.equal(back.podHome, 'https://alice.pod/');
  assert.equal(disk.size, 1);
  assert.match([...disk.keys()][0], /\/alice\.json$/, 'one JSON resource per handle');

  const podPut = makeStorePodPut(io);
  const ok = await podPut('https://alice.pod/ap/inbox/abc', '{}', 'application/activity+json');
  assert.equal(ok, true);
  assert.equal(disk.get('https://alice.pod/ap/inbox/abc'), '{}');
});

test("the door's record of an identity this server runs names the identity's own tree", () => {
  const POD = 'https://mei.example.org/';
  const HOME = `${POD}activitypods-js/`;
  const next = {
    handle: 'mei', podHome: HOME, actorUrl: `${HOME}ap/actor`, kind: 'person',
    gatewayWebId: null, hmacSecret: 'fresh', inboxOnly: true,
  };

  assert.deepEqual(frontRow(null, next, POD), next, 'with no record, the new one stands');

  // The record this server used to write named the pod root, so the door wrote
  // deliveries where nothing was watching. Correct it, and keep the secret so a
  // gateway holding it goes on working.
  const stale = {
    handle: 'mei', podHome: POD, actorUrl: `${POD}ap/actor`, kind: 'person',
    gatewayWebId: null, hmacSecret: 'in-use-somewhere', inboxOnly: true,
  };
  const fixed = frontRow(stale, next, POD);
  assert.equal(fixed.podHome, HOME, "a record this server wrote is pointed at the identity's tree");
  assert.equal(fixed.actorUrl, `${HOME}ap/actor`);
  assert.equal(fixed.hmacSecret, 'in-use-somewhere', 'and keeps the secret already in use');

  assert.equal(frontRow(fixed, next, POD), null, 'a record already right is left alone');

  // An owner who attached their own pod owns that record. Never touch it, even
  // when it names a pod this server happens to run.
  const attached = {
    handle: 'mei', podHome: POD, actorUrl: 'https://fedipod.net/u/mei/ap/actor',
    kind: 'person', hmacSecret: 'theirs',
  };
  assert.equal(frontRow(attached, next, POD), null, 'an attached record belongs to its owner');

  const elsewhere = { ...stale, podHome: 'https://someone-else.example/' };
  assert.equal(frontRow(elsewhere, next, POD), null, "another pod's record is not ours to rewrite");
});

test('the pod answers the ActivityStreams profile form too: activity+json and ld+json read the same document', async () => {
  const { readFileSync } = await import('node:fs');
  const cfg = JSON.parse(readFileSync(new URL('../config/server.json', import.meta.url), 'utf8'));
  const replacer = cfg['@graph'].find((n) => n['@id'] === 'urn:fedipod:server:ActivityStreamsReplacer');
  const pairs = (replacer?.replacements || []).map((r) => [r['ContentTypeReplacer:_replacements_key'], r['ContentTypeReplacer:_replacements_value']]);
  assert.deepEqual(pairs, [['application/activity+json', 'application/ld+json'], ['application/ld+json', 'application/activity+json']]);
  const inserted = cfg['@graph'].some((n) => n.overrideInstance?.['@id'] === 'urn:solid-server:default:ChainedConverter'
    && n.overrideSteps?.[0]?.overrideValue?.['@id'] === 'urn:fedipod:server:ActivityStreamsReplacer');
  assert.ok(inserted, 'the replacer is placed in the converter chain');
});
