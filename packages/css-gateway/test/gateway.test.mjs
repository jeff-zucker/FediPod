// Unit tests for the CSS-free pieces: route claiming, the Node<->WHATWG
// adapter, and the store-backed directory/podPut. The CSS-coupled shell
// (handler.mjs, store-css.mjs) is verified against a running CSS instance, not
// here — importing it needs @solid/community-server.
//
//   node --test   (from packages/css-gateway)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { claims } from '../dist/claims.js';
import { nodeToWhatwg, applyToNode } from '../dist/adapt.js';
import { makeDirectory, makeStorePodPut } from '../dist/directory.js';

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
