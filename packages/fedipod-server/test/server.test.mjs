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
import { makeDirectory, makeStorePodPut, makeAgentRegistry } from '../dist/directory.js';

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

test('an identity claims its protocol routes and its door, and nothing else', () => {
  const hosts = new Set(['alice.example.org']);
  const owns = (pathname, host = 'alice.example.org') => agentClaims({ host, pathname }, hosts);
  assert.equal(owns('/api/v1/instance'), true);
  assert.equal(owns('/oauth/authorize'), true);
  assert.equal(owns('/ap/actor'), true);
  assert.equal(owns('/ap/outbox'), true);
  assert.equal(owns('/.well-known/nodeinfo'), true);
  assert.equal(owns('/nodeinfo/2.0'), true);
  assert.equal(owns('/app/'), true, 'the door');
  assert.equal(owns('/app'), true, 'and the door without its slash');
  assert.equal(owns('/profile/card'), false, 'a pod resource is the pod\'s');
  assert.equal(owns('/ap/inbox/x.json'), false, 'inbox items are pod resources, read and written as such');
  assert.equal(owns('/api/v1/instance', 'carol.example.org'), false, 'another host is not this identity');
  assert.equal(agentClaims({ host: 'alice.example.org', pathname: '/app/' }, hosts, ''), false,
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
