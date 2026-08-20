// front-hard-test.mjs — the multi-user front, run for real.
//
// Not a unit test: this stands the ACTUAL routeFront behind an HTTP server on
// a local port, puts a fake pod behind it, and drives the paths a person and a
// remote server actually take — WebFinger, the signup page, the name check,
// attach with a proven pod, and a signed delivery through the door. It is what
// a deploy of fedipod.net would answer, minus Netlify's own plumbing.
//
//   node claude/smoke-tests/front-hard-test.mjs
//
// Exits non-zero on the first failure, and says which.

import http from 'node:http';
import crypto from 'node:crypto';
import { routeFront } from '../../lib/front-core.mjs';

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

const FRONT_PORT = 4931;
const POD_PORT = 4932;
const HOST = `localhost:${FRONT_PORT}`;
const ORIGIN = `http://${HOST}`;
const POD = `http://localhost:${POD_PORT}/`;

// ---- the pod behind the door ------------------------------------------------
// Publishes what a real one does: an actor, a gateway policy naming who this
// person follows and who they block, and an inbox that accepts appends.
const inboxWrites = [];
let policyServed = 0;
const pod = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url === '/ap/actor') {
    res.writeHead(200, { 'content-type': 'application/activity+json' });
    return res.end(JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: POD + 'ap/actor', type: 'Person', preferredUsername: 'alice',
      inbox: POD + 'ap/inbox/', outbox: POD + 'ap/outbox',
    }));
  }
  if (url === '/ap/gateway-policy.json') {
    policyServed++;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      v: 1, kind: 'person',
      actorUrl: POD + 'ap/actor', followersUrl: POD + 'ap/followers',
      inboxUrl: POD + 'ap/inbox/', notesPrefix: POD + 'ap/notes/',
      following: ['https://m.example/u/friend'],
      blocklist: { domains: ['spam.example'], actors: [] },
    }));
  }
  if (req.method === 'PUT' && url.startsWith('/ap/inbox/')) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      inboxWrites.push({ url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(201).end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise(r => pod.listen(POD_PORT, '127.0.0.1', r));

// ---- the front --------------------------------------------------------------
const directory = {
  alice: {
    handle: 'alice', podHome: POD, actorUrl: POD + 'ap/actor',
    kind: 'person', inboxOnly: true,
    gatewayWebId: ORIGIN + '/gw#it', hmacSecret: 'shared-secret',
  },
};
const attached = {};
const front = http.createServer(async (req, res) => {
  const body = await new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
  });
  // Only the headers the front reads. Forwarding content-length and the
  // hop-by-hop ones makes the Request disagree with the body handed to it,
  // and the delivery arrives empty.
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['content-length', 'connection', 'transfer-encoding', 'host'].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }
  const request = new Request(ORIGIN + req.url, { method: req.method, headers, body });
  const out = await routeFront(request, {
    host: HOST, frontOrigin: ORIGIN,
    signupPage: '<!doctype html><title>sign up</title>',
    runPage: '<!doctype html><title>run</title>',
    authBundle: '/* auth */', installScript: '#!/bin/sh\necho install\n',
    offersPods: false, gatewayWebId: ORIGIN + '/gw#it',
    lookup: (h) => directory[h] || attached[h] || null,
    putDirectory: async (h, rec) => { attached[h] = rec; },
    podPut: async (_h, url, b, ct) => {
      const r = await fetch(url, { method: 'PUT', headers: { 'content-type': ct }, body: b })
        .catch(() => null);
      return !!r && r.status < 400;
    },
    // The pod token check is the one thing a local run cannot do for real.
    verifier: async () => ({ webid: 'https://wren.example/profile/card#me' }),
  }).catch(e => ({ status: 500, headers: {}, body: String(e && e.stack || e) }));
  res.writeHead(out.status, out.headers || {});
  res.end(out.body ?? '');
});
await new Promise(r => front.listen(FRONT_PORT, '127.0.0.1', r));

const get = (p, opts) => fetch(ORIGIN + p, opts);

try {
  // ---- the pages a person lands on -----------------------------------------
  const home = await get('/');
  check(home.status === 200 && /sign up/.test(await home.text()), 'the signup page is served at /');
  check((await get('/signup')).status === 200 && (await get('/new-account')).status === 200,
    'and at its two other names');
  const run = await get('/run');
  check(run.status === 200 && /run/.test(await run.text()), 'the opt-in page is served at /run');
  const bundle = await get('/solid-client-authn.bundle.js');
  check(bundle.status === 200 && /auth/.test(await bundle.text()),
    'the sign-in library those pages load is served');
  const inst = await get('/install');
  check(inst.status === 200 && /^#!/.test(await inst.text()), 'the installer is served at /install');

  // ---- a remote server looking someone up ----------------------------------
  const wf = await get(`/.well-known/webfinger?resource=acct:alice@${HOST}`);
  const jrd = await wf.json();
  check(wf.status === 200 && jrd.subject === `acct:alice@${HOST}`
    && jrd.links?.[0]?.href === POD + 'ap/actor',
    'WebFinger resolves the handle to the actor on their own pod');
  check((await get('/.well-known/webfinger?resource=acct:nobody@' + HOST)).status === 404,
    'and 404s a handle nobody holds');

  // ---- the name check the signup page makes --------------------------------
  const taken = await (await get('/api/handle?handle=alice')).json();
  check(taken.available === false && /taken/.test(taken.reason || ''), 'a taken name is refused');
  const free = await (await get('/api/handle?handle=wren')).json();
  check(free.available === true, 'a free one is offered');
  const bad = await (await get('/api/handle?handle=Wren!')).json();
  check(bad.available === false && /letters/.test(bad.reason || ''), 'and an impossible one says why');

  // ---- attaching a pod ------------------------------------------------------
  const att = await get('/api/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer pretend' },
    // A real pod is https, and the route rightly insists — attach only records
    // the row, so this one is never fetched.
    body: JSON.stringify({ handle: 'wren', podHome: 'https://wren.example/' }),
  });
  const attBody = await att.json();
  check(att.status === 201 && attBody.doorInbox === `${ORIGIN}/u/wren/ap/inbox/`
    && typeof attBody.hmacSecret === 'string',
    'attaching a proven pod returns a door and a secret');
  check(/^fedipod gateway /.test(attBody.command || ''),
    `and the command it hands over is one an installed agent has (${(attBody.command || '').slice(0, 24)}…)`);
  check(attached.wren?.inboxOnly === true && attached.wren.actorUrl === 'https://wren.example/ap/actor',
    'the row it writes keeps the identity on their own pod');

  // ---- a delivery through the door -----------------------------------------
  const deliver = async (activity) => {
    const r = await get('/u/alice/ap/inbox/', {
      method: 'POST',
      headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify(activity),
    });
    return r.status;
  };
  // A forwarded delivery writes the item AND its verification receipt beside
  // it, so count items rather than writes.
  const items = () => inboxWrites.filter(w => !w.url.endsWith('.receipt.json')).length;
  const receipts = () => inboxWrites.filter(w => w.url.endsWith('.receipt.json')).length;
  const before = items();
  const wanted = await deliver({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://m.example/a/1', type: 'Create', actor: 'https://m.example/u/friend',
    to: [POD + 'ap/followers'],
    object: { id: 'https://m.example/n/1', type: 'Note', content: 'hello', to: [POD + 'ap/followers'] },
  });
  check(wanted === 202 && items() === before + 1,
    `a post from someone they follow is forwarded into the pod inbox (${wanted})`);
  check(receipts() === 1, 'with a verification receipt beside it, stamped with the shared secret');
  check(policyServed > 0, 'and the door read their published policy to decide it');

  const blocked = await deliver({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://spam.example/a/9', type: 'Create', actor: 'https://spam.example/u/bot',
    to: [POD + 'ap/followers'],
    object: { id: 'https://spam.example/n/9', type: 'Note', content: 'buy', to: [POD + 'ap/followers'] },
  });
  check(blocked === 202 && items() === before + 1,
    'a post from a blocked domain is dropped at the door, never reaching the pod');

  const stranger = await deliver({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://m.example/a/2', type: 'Create', actor: 'https://m.example/u/stranger',
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: { id: 'https://m.example/n/2', type: 'Note', content: 'broadcast',
      to: ['https://www.w3.org/ns/activitystreams#Public'] },
  });
  check(stranger === 202 && items() === before + 1,
    'and so is broadcast noise that does not concern them');

  const follow = await deliver({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://m.example/f/1', type: 'Follow',
    actor: 'https://m.example/u/anyone', object: POD + 'ap/actor',
  });
  check(follow === 202 && items() === before + 2,
    'a Follow from a stranger still gets through — control mail is the message');

  const cached = policyServed;
  await deliver({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: 'https://m.example/a/3', type: 'Create', actor: 'https://m.example/u/friend',
    to: [POD + 'ap/followers'],
    object: { id: 'https://m.example/n/3', type: 'Note', content: 'again', to: [POD + 'ap/followers'] },
  });
  check(policyServed === cached,
    `the policy is cached, so a flood is not a read per delivery on their pod (${policyServed} reads)`);

  // ---- the public face ------------------------------------------------------
  const face = await get('/u/alice/ap/actor');
  check(face.status === 200, 'the fronted actor is served');

  // ---- what must NOT be answered -------------------------------------------
  check((await get('/some/pod/document')).status === 404,
    'a path the front does not own falls through');
} finally {
  front.close(); pod.close();
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
