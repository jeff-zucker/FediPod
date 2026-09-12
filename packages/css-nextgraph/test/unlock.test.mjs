// unlock.test.mjs — the page a host pastes the master key into. No CSS and no
// socket: the handler is driven with the request and response shapes CSS hands
// it, so what is asserted is what a person gets back.
//
//   node --test   (from packages/css-nextgraph, after npm run build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { MasterKey, newKey, parseKey } from '../dist/masterkey.js';
import { UnlockHandler } from '../dist/unlock.js';

const BASE = 'https://pods.example/';
const PATH = '/nextgraph/unlock';

const request = (method, url, body = null) => Object.assign(
  Readable.from(body === null ? [] : [Buffer.from(body)]),
  { method, url, headers: { host: 'pods.example' } },
);

function collect() {
  const out = { status: 0, headers: {}, body: '' };
  return {
    out,
    response: {
      writeHead(status, headers) { out.status = status; out.headers = headers ?? {}; },
      end(body) { out.body = body ?? ''; },
    },
  };
}

/** A stand-in accessor: says which keys open its records and counts the pods it opened. */
const fakeAccessor = (right) => ({
  opened: 0,
  opensWith(key) { return key.equals(parseKey(right)); },
  async openAll() { this.opened += 1; return 3; },
});

const handlerFor = (right, master = new MasterKey()) => {
  const accessor = fakeAccessor(right);
  return { accessor, master, handler: new UnlockHandler({ baseUrl: BASE, masterKey: master, accessor }) };
};

test('it claims its own path on the base URL and nothing else', async () => {
  const { handler } = handlerFor(newKey());
  await handler.canHandle({ request: request('GET', PATH) });
  await assert.rejects(handler.canHandle({ request: request('GET', '/profile/card') }));
  await assert.rejects(handler.canHandle({ request: request('DELETE', PATH) }));
  // A pod's own origin never offers it.
  const onPod = request('GET', PATH);
  onPod.headers.host = 'alice.pods.example';
  await assert.rejects(handler.canHandle({ request: onPod }));
});

test('a locked server offers the field and says what it is for', async () => {
  const { handler } = handlerFor(newKey());
  const { out, response } = collect();
  await handler.handle({ request: request('GET', PATH), response });
  assert.equal(out.status, 200);
  assert.match(out.body, /This server is locked/u);
  assert.match(out.body, /<form method="post" action="\/nextgraph\/unlock">/u);
  assert.equal(out.headers['cache-control'], 'no-store');
});

test('the right key opens the pods and the page says how many', async () => {
  const right = newKey();
  const { handler, accessor, master } = handlerFor(right);
  const { out, response } = collect();
  await handler.handle({ request: request('POST', PATH, `key=${encodeURIComponent(right)}`), response });
  assert.equal(out.status, 200);
  assert.match(out.body, /3 pods open and answering/u);
  assert.equal(master.present, true);
  assert.equal(master.source, 'unlock');
  assert.equal(accessor.opened, 1, 'the pods are opened, not left for the next request');
});

test('a wrong key is refused and nothing is opened', async () => {
  const { handler, accessor, master } = handlerFor(newKey());
  const { out, response } = collect();
  await handler.handle({ request: request('POST', PATH, `key=${encodeURIComponent(newKey())}`), response });
  assert.equal(out.status, 400);
  assert.match(out.body, /did not open this server/u);
  assert.equal(master.present, false);
  assert.equal(accessor.opened, 0);
  assert.match(out.body, /<form/u, 'and the field is still there to try again');
});

test('the key never comes back in the page', async () => {
  const { handler } = handlerFor(newKey());
  const wrong = newKey();
  const { out, response } = collect();
  await handler.handle({ request: request('POST', PATH, `key=${encodeURIComponent(wrong)}`), response });
  assert.ok(!out.body.includes(wrong), 'a refusal does not echo what was typed');
});

test('wrong keys in a row stop the page answering for a while', async () => {
  const { handler } = handlerFor(newKey());
  for (let i = 0; i < 5; i += 1) {
    const { response } = collect();
    await handler.handle({ request: request('POST', PATH, `key=${encodeURIComponent(newKey())}`), response });
  }
  const { out, response } = collect();
  await handler.handle({ request: request('POST', PATH, `key=${encodeURIComponent(newKey())}`), response });
  assert.equal(out.status, 429);
  assert.match(out.body, /Too many wrong keys/u);
});

test('an unlocked server says so and offers no field', async () => {
  const right = newKey();
  const master = new MasterKey();
  master.supply(right);
  const { handler } = handlerFor(right, master);
  const { out, response } = collect();
  await handler.handle({ request: request('GET', PATH), response });
  assert.equal(out.status, 200);
  assert.match(out.body, /This server is unlocked/u);
  assert.ok(!/<form/u.test(out.body), 'nothing to type into once it is open');
});

test('a body that is not the form is refused without a stack trace', async () => {
  const { handler } = handlerFor(newKey());
  const { out, response } = collect();
  await handler.handle({ request: request('POST', PATH, 'x'.repeat(5000)), response });
  assert.equal(out.status, 400);
});
