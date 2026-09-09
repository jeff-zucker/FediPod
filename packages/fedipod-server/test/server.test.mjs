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
import { makeDirectory, makeStorePodPut, makeAgentRegistry, frontRow } from '../dist/directory.js';

test('claims only the front host, only its routes', () => {
  const F = 'fedipod.net';
  assert.equal(claims({ host: 'fedipod.net', pathname: '/.well-known/webfinger' }, F), true);
  assert.equal(claims({ host: 'fedipod.net:443', pathname: '/' }, F), true);
  assert.equal(claims({ host: 'fedipod.net', pathname: '/u/alice/ap/actor' }, F), true);
  assert.equal(claims({ host: 'fedipod.net', pathname: '/some/pod/doc' }, F), false, 'a non-front path falls through');
  assert.equal(claims({ host: 'alice.fedipod.net', pathname: '/.well-known/webfinger' }, F), false,
    'a pod subdomain is never claimed');
  assert.equal(claims({ host: '', pathname: '/' }, F), false);
});

test('claims every route the front core serves, pages and the files they load', () => {
  const F = 'fedipod.net';
  // Each page is useless without what it loads, so the assets are claims too:
  // an unclaimed one falls through to the pod and 404s.
  for (const pathname of ['/', '/signup', '/new-account', '/run', '/roster',
    '/.well-known/webfinger', '/api/handle', '/api/attach', '/api/agent',
    '/api/roster', '/api/revoke',
    '/solid-oidc-client.js', '/install']) {
    assert.equal(claims({ host: 'fedipod.net', pathname }, F), true, pathname);
  }
});

test('an identity claims its protocol routes and its door, and nothing else', () => {
  const hosts = new Set(['alice.example.org']);
  const owns = (pathname, host = 'alice.example.org') => agentClaims({ host, pathname }, hosts);
  assert.equal(owns('/api/v1/instance'), true);
  assert.equal(owns('/oauth/authorize'), true);
  assert.equal(owns('/ap/actor'), true);
  assert.equal(owns('/ap/outbox'), true);
  assert.equal(owns('/.well-known/nodeinfo'), true);
  assert.equal(owns('/nodeinfo/2.0'), true);
  assert.equal(owns('/fedipod/'), true, 'the door');
  assert.equal(owns('/fedipod'), true, 'and the door without its slash');
  assert.equal(owns('/app/'), false, 'a name the owner may want is theirs');
  assert.equal(owns('/profile/card'), false, 'a pod resource is the pod\'s');
  assert.equal(owns('/ap/inbox/x.json'), false, 'inbox items are pod resources, read and written as such');
  assert.equal(owns('/api/v1/instance', 'carol.example.org'), false, 'another host is not this identity');
  assert.equal(agentClaims({ host: 'alice.example.org', pathname: '/fedipod/' }, hosts, ''), false,
    'with no door configured there are no pages to claim');
  assert.equal(agentClaims({ host: 'alice.example.org', pathname: '/api/' }, new Set()), false,
    'and with no identities nothing is claimed at all');
});

test('a claim set is live — a host added at runtime claims from that instant', () => {
  const hosts = new Set();
  const ask = () => agentClaims({ host: 'dana.example.org', pathname: '/api/v1/instance' }, hosts);
  assert.equal(ask(), false);
  hosts.add('dana.example.org');
  assert.equal(ask(), true, 'opt-in claims with no new handler');
  hosts.delete('dana.example.org');
  assert.equal(ask(), false, 'opt-out un-claims the same way');
});

test('the opt-in registry keeps rows and an index, and forgets cleanly', async () => {
  const disk = new Map();
  const io = {
    read: async (u) => disk.get(u) ?? null,
    write: async (u, b) => { disk.set(u, b); },
    remove: async (u) => { disk.delete(u); },
  };
  const reg = makeAgentRegistry(io, 'http://s/agents/');
  assert.deepEqual(await reg.listHosts(), [], 'empty registry lists nothing');
  await reg.add({ podBase: 'http://mei.s/', handle: 'mei', host: 'mei.s', webId: 'http://mei.s/profile/card#me', optedInAt: 't' });
  assert.deepEqual(await reg.listHosts(), [ 'mei.s' ]);
  assert.equal((await reg.get('mei.s'))?.handle, 'mei');
  await reg.add({ podBase: 'http://mei.s/', handle: 'mei', host: 'mei.s', webId: 'http://mei.s/profile/card#me', optedInAt: 't2' });
  assert.deepEqual(await reg.listHosts(), [ 'mei.s' ], 're-adding does not duplicate the index');
  await reg.remove('mei.s');
  assert.deepEqual(await reg.listHosts(), []);
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
