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
import { routeFront } from '../../lib/gateway/front-core.mjs';

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
  // A pod on a path of this host: everything under /pods/wren/fedipod/. Its
  // documents name themselves by that path, as a suffix-mode CSS pod's do.
  const PP = POD + 'pods/wren/fedipod/';
  if (url === '/pods/wren/fedipod/ap/actor') {
    res.writeHead(200, { 'content-type': 'application/activity+json' });
    return res.end(JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: PP + 'ap/actor', type: 'Person', preferredUsername: 'wren',
      inbox: PP + 'ap/inbox/', outbox: PP + 'ap/outbox',
      icon: { type: 'Image', url: PP + 'ap/media/face.png' },
    }));
  }
  if (url === '/pods/wren/fedipod/ap/media/face.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  // A forum on this pod: one category, a group whose door is the forum's.
  const FB = POD + 'fedipod-bb/';
  if (url === '/fedipod-bb/c/gardening/ap/actor') {
    res.writeHead(200, { 'content-type': 'application/activity+json' });
    return res.end(JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: FB + 'c/gardening/ap/actor', type: 'Group', preferredUsername: 'gardening',
      inbox: FB + 'ap/inbox/', outbox: FB + 'c/gardening/ap/outbox',
      attributedTo: FB + 'c/gardening/ap/moderators',
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
  if (req.method === 'PUT' && url.includes('/ap/inbox/')) {
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
    adminPage: '<!doctype html><title>roster</title>',
    authBundle: '/* auth */', installScript: '#!/bin/sh\necho install\n',
    offersPods: false, gatewayWebId: ORIGIN + '/gw#it',
    adminWebId: 'https://wren.example/profile/card#me',
    lookup: (h) => directory[h] || attached[h] || null,
    listDirectory: async () => ({ ...directory, ...attached }),
    putDirectory: async (h, rec) => { attached[h] = rec; },
    // Mirrors the adapter: only attach-created rows can go; seeds survive.
    removeDirectory: async (h) => { delete attached[h]; return !directory[h]; },
    podPut: async (_h, url, b, ct) => {
      const r = await fetch(url, { method: 'PUT', headers: { 'content-type': ct }, body: b })
        .catch(() => null);
      return !!r && r.status < 400;
    },
    // The pod token check is the one thing a local run cannot do for real.
    // The token value picks the proven WebID, so tests can be someone else.
    verifier: async (authz) => ({
      webid: authz === 'Bearer someone-else'
        ? 'https://eve.example/profile/card#me'
        : authz === 'Bearer path-owner'
          ? POD + 'pods/wren/profile/card#me'
          : 'https://wren.example/profile/card#me',
    }),
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
  const bundle = await get('/solid-oidc-client.js');
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
  check(wf.headers.get('access-control-allow-origin') === '*',
    'and the JRD may be read from any origin');
  check(jrd.links.some((l) => l.rel === 'http://webfinger.net/rel/profile-page' && l.href === POD + 'ap/profile.html'),
    `and it links the profile page on the pod (${JSON.stringify(jrd.links)})`);
  const at = await get('/@alice', { redirect: 'manual' });
  check(at.status === 302 && at.headers.get('location') === POD + 'ap/profile.html',
    `https://<front>/@alice sends a person to that page (${at.status} ${at.headers.get('location')})`);
  check((await get('/@nobody', { redirect: 'manual' })).status === 404, 'and 404s a handle nobody holds');
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
    headers: { 'content-type': 'application/json', authorization: 'Bearer pretend', dpop: 'proof' },
    // A real pod is https, and the route rightly insists — attach only records
    // the row, so this one is never fetched.
    body: JSON.stringify({ handle: 'wren', podHome: 'https://wren.example/' }),
  });
  const attBody = await att.json();
  check(att.status === 201 && attBody.doorInbox === `${ORIGIN}/u/${encodeURIComponent('wren@wren.example')}/ap/inbox/`
    && attBody.address === '@wren@wren.example' && typeof attBody.hmacSecret === 'string',
    'attaching a proven pod returns a full-address door and a secret');
  check(/^fedipod gateway /.test(attBody.command || ''),
    `and the command it hands over is one an DeviceAgent has (${(attBody.command || '').slice(0, 24)}…)`);
  check(attached['wren@wren.example']?.inboxOnly === true && attached['wren@wren.example'].actorUrl === 'https://wren.example/ap/actor',
    'the row it writes is keyed by full address and keeps the identity on their own pod');

  // The same account on the same pod may correct where its tree lives: a
  // row made by an older sign-up named the pod root, and every delivery to
  // it was written where nothing reads (2026-09-14, @fp1). A different pod
  // is still "taken".
  const secretBefore = attached['wren@wren.example'].hmacSecret;
  const fixRow = await get('/api/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer pretend', dpop: 'proof' },
    body: JSON.stringify({ handle: 'wren', podHome: 'https://wren.example/fedipod/', actorUrl: 'https://wren.example/fedipod/ap/actor' }),
  });
  check(fixRow.status === 201 && attached['wren@wren.example'].podHome === 'https://wren.example/fedipod/'
    && attached['wren@wren.example'].actorUrl === 'https://wren.example/fedipod/ap/actor'
    && attached['wren@wren.example'].hmacSecret === secretBefore,
    'the same account on the same pod corrects its row and keeps its secret');
  const atRemote = await get('/@wren@wren.example', { redirect: 'manual' });
  check(atRemote.status === 302 && atRemote.headers.get('location') === 'https://wren.example/fedipod/ap/profile.html',
    `https://<front>/@wren@wren.example sends a person to the profile page on wren's pod (${atRemote.status} ${atRemote.headers.get('location')})`);
  check((await get(`/@alice@${HOST}`, { redirect: 'manual' })).status === 302
    && (await get('/@wren@elsewhere.example', { redirect: 'manual' })).status === 404,
    'the front\'s own host is the bare handle, and a host nobody attached from is 404');
  const stealRow = await get('/api/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer pretend', dpop: 'proof' },
    body: JSON.stringify({ handle: 'wren', podHome: 'https://other.example/fedipod/' }),
  });
  check(stealRow.status >= 400 && attached['wren@wren.example'].podHome === 'https://wren.example/fedipod/',
    `while a different pod is still refused (${stealRow.status})`);

  // ---- the roster the host reads --------------------------------------------
  const finch = await get('/api/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer pretend', dpop: 'proof' },
    body: JSON.stringify({ handle: 'finch', podHome: 'https://wren.example/', fronted: true }),
  });
  check(finch.status === 201, 'a fronted attach also lands (for the roster below)');
  const adminPage = await get('/roster');
  check(adminPage.status === 200 && /roster/.test(await adminPage.text()),
    'the roster page is served at /roster');
  check((await get('/api/roster')).status === 401, 'the roster refuses an unproven reader');
  check((await get('/api/roster', { headers: { authorization: 'Bearer someone-else', dpop: 'proof' } })).status === 403,
    'and a proven WebID that is not the admin');
  const rosterRes = await get('/api/roster', { headers: { authorization: 'Bearer pretend', dpop: 'proof' } });
  const roster = await rosterRes.json();
  const byHandle = Object.fromEntries((roster.accounts || []).map(a => [a.handle, a]));
  check(rosterRes.status === 200 && byHandle.alice && byHandle.wren && byHandle.finch,
    `the admin sees every account, attached ones included (${Object.keys(byHandle).join(', ')})`);
  check(byHandle.wren.fronted === false && byHandle.finch.fronted === true,
    'each row says whether the identity lives here or only gateways here');
  check(!/hmacSecret|shared-secret/.test(JSON.stringify(roster)),
    'and no row carries a secret');

  // ---- revoking an account ---------------------------------------------------
  const revoke = (handle, authz) => get('/api/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authz ? { authorization: authz, dpop: 'proof' } : {}) },
    body: JSON.stringify({ handle }),
  });
  check((await revoke('finch')).status === 401, 'revoking needs a proven reader');
  check((await revoke('finch', 'Bearer someone-else')).status === 403, 'who is the admin');
  check((await revoke('nobody', 'Bearer pretend')).status === 404, 'and an account that exists');
  const gone = await (await revoke('finch', 'Bearer pretend')).json();
  const after = await (await get('/api/roster', { headers: { authorization: 'Bearer pretend', dpop: 'proof' } })).json();
  check(gone.removed === true && !after.accounts.some(a => a.handle === 'finch'),
    'a removed account leaves the roster');
  check((await get(`/.well-known/webfinger?resource=acct:finch@${HOST}`)).status === 404,
    'and its name stops resolving');
  const seeded = await (await revoke('alice', 'Bearer pretend')).json();
  check(seeded.removed === false && /environment/.test(seeded.reason || '')
    && (await get(`/.well-known/webfinger?resource=acct:alice@${HOST}`)).status === 200,
    'an env-seeded row stays, and the answer says where to remove it');

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

  // ---- a pod on a suffix-based host, fronted (issue #7) ----------------
  // Nothing answers WebFinger at that host's root for it, so its address lives
  // here: attach fronted, and the front answers the name, serves the actor with
  // every id rewritten onto itself, and sends media back to the pod.
  const pathHome = POD + 'pods/wren/fedipod/';
  const pathAtt = await get('/api/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer path-owner', dpop: 'proof' },
    body: JSON.stringify({ handle: 'pwren', podHome: pathHome, actorUrl: pathHome + 'ap/actor', fronted: true }),
  });
  const pathBody = await pathAtt.json();
  check(pathAtt.status === 201 && pathBody.address === `@pwren@${HOST}` && pathBody.frontActor === `${ORIGIN}/u/pwren/ap/actor`,
    `a pod on a suffix-based host attaches fronted and gets its address here (${pathAtt.status} ${pathBody.address})`);
  const pathWf = await get(`/.well-known/webfinger?resource=acct:pwren@${HOST}`);
  const pathJrd = pathWf.status === 200 ? await pathWf.json() : {};
  check(pathWf.status === 200 && (pathJrd.links || []).some(l => l.rel === 'self' && l.href === `${ORIGIN}/u/pwren/ap/actor`)
    && (pathJrd.aliases || []).includes(pathHome + 'ap/actor'),
    'the front answers WebFinger for it, naming the pod actor as an alias');
  const inboxOnlyWf = await (await get(`/.well-known/webfinger?resource=acct:alice@${HOST}`)).json().catch(() => ({}));
  check(!('aliases' in inboxOnlyWf), 'while a mail-door row, whose actor is the pod\'s already, carries no alias');
  const pathActorRes = await get('/u/pwren/ap/actor', { headers: { accept: 'application/activity+json' } });
  const pathActor = pathActorRes.status === 200 ? await pathActorRes.json() : {};
  check(pathActorRes.status === 200 && pathActor.id === `${ORIGIN}/u/pwren/ap/actor`
    && pathActor.inbox === `${ORIGIN}/u/pwren/ap/inbox/` && pathActor.preferredUsername === 'pwren'
    && !JSON.stringify(pathActor).includes(pathHome),
    'the actor is served from the path with every id rewritten onto the front');
  const pathMedia = await fetch(`${ORIGIN}/u/pwren/ap/media/face.png`, { redirect: 'manual' });
  check(pathMedia.status === 302 && pathMedia.headers.get('location') === pathHome + 'ap/media/face.png',
    'a picture under the fronted identity is answered by pointing at the pod, not proxied as JSON');
  const pathFollowed = await fetch(`${ORIGIN}/u/pwren/ap/media/face.png`);
  check(pathFollowed.status === 200 && (pathFollowed.headers.get('content-type') || '').startsWith('image/png'),
    'and following it lands on the image');

  // ---- what must NOT be answered -------------------------------------------
  check((await get('/some/pod/document')).status === 404,
    'a path the front does not own falls through');

  // ---- who the pod's own server says owns it -------------------------------
  // Opting in is proved by a token. Which token counts was decided by where
  // the WebID sat in relation to the pod's URL; where a pod server names its
  // owner outright, that is the answer instead.
  {
    const OWNER = 'https://wren.example/profile/card#me';
    const OWNER_REL = 'http://www.w3.org/ns/solid/terms#owner';
    const optIn = ({ link = null, webid = OWNER, podBase = POD }) => routeFront(
      new Request(ORIGIN + '/api/agent', {
        method: 'POST',
        headers: { authorization: 'Bearer x', dpop: 'proof', 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'opt-in', podBase }),
      }), {
        host: HOST, frontOrigin: ORIGIN,
        lookup: async () => null,
        putDirectory: async () => {},
        podPut: async () => true,
        podGet: async () => ({ status: 404, text: async () => '' }),
        verifier: async () => ({ webid }),
        fetchImpl: async () => new Response(null, { headers: link ? { link } : {} }),
        agentControl: {
          optIn: async () => ({ httpStatus: 201, ok: true }),
          optOut: async () => ({ httpStatus: 200, ok: true }),
        },
      });

    check((await optIn({ link: `<${OWNER}>; rel="${OWNER_REL}"` })).status === 201,
      'a pod naming this person as its owner lets them opt in');
    check((await optIn({ link: `<https://someone.else/card#me>; rel="${OWNER_REL}"` })).status === 403,
      'and one naming somebody else refuses them, wherever their own WebID lives');
    check((await optIn({})).status === 403,
      'a pod naming no owner leaves where the WebID lives as the only evidence');
    check((await optIn({ webid: POD + 'profile/card#me' })).status === 201,
      'and there, a WebID under the pod is still proof enough');
  }

  // ---- the outbox door: the owner's own post, from another client ----------
  // dokieli's request, as it sends it: a preflight, then a bare Web Annotation
  // with a Slug and the owner's pod token, from its own origin.
  {
    const outbox = '/u/pwren/ap/outbox';
    const count = () => inboxWrites.filter(w => w.url.includes('/pods/wren/fedipod/ap/inbox/') && !w.url.endsWith('.receipt.json')).length;
    const pre = await get(outbox, { method: 'OPTIONS', headers: { origin: 'https://dokie.li' } });
    check(pre.status === 204 && pre.headers.get('accept-post') === 'application/ld+json, application/activity+json'
      && /Slug/.test(pre.headers.get('access-control-allow-headers') || '') && pre.headers.get('access-control-allow-origin') === '*',
      'the door answers a preflight: JSON only in Accept-Post, and the headers a browser client sends');
    const annotation = JSON.stringify({ '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'Annotation', id: '',
      motivation: 'commenting', bodyValue: 'well said', target: 'https://doc.example/paper#p2' });
    const post = (headers, body = annotation) => get(outbox, { method: 'POST', body,
      headers: { 'content-type': 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"', slug: 'anno-42', origin: 'https://dokie.li', ...headers } });
    check((await post({})).status === 401, 'no token → 401');
    check((await post({ authorization: 'Bearer someone-else', dpop: 'proof' })).status === 403, "someone else's token → 403, not a post");
    const before = count();
    const ok = await post({ authorization: 'Bearer path-owner', dpop: 'proof' });
    const okBody = await ok.json().catch(() => ({}));
    check(ok.status === 202 && ok.headers.get('location') === `${ORIGIN}/u/pwren/ap/notes/anno-42`
      && okBody.object === `${ORIGIN}/u/pwren/ap/notes/anno-42`,
      `the owner's post is accepted with the address it will have (${ok.status} ${ok.headers.get('location')})`);
    check(ok.headers.get('access-control-allow-origin') === '*', 'and the answer carries CORS, so the client can read it');
    const item = inboxWrites.filter(w => w.url.includes('/pods/wren/fedipod/ap/inbox/') && !w.url.endsWith('.receipt.json')).at(-1);
    check(count() === before + 1 && item && item.body === annotation, 'the bytes as sent land in the pod inbox');
    const rcpt = JSON.parse(inboxWrites.find(w => w.url === item.url + '.receipt.json')?.body || 'null');
    const { verifyReceipt } = await import('../../lib/gateway/httpsig.mjs');
    const secret = attached.pwren?.hmacSecret;      // a fronted row is keyed by its bare handle
    check(rcpt?.method === 'c2s' && rcpt.actor === `${ORIGIN}/u/pwren/ap/actor` && rcpt.slug === 'anno-42'
      && rcpt.keyId === POD + 'pods/wren/profile/card#me' && !!secret && verifyReceipt(rcpt, secret),
      'with a receipt beside it stamped c2s for this actor under the account secret, carrying the slug');
    check((await post({ authorization: 'Bearer path-owner', dpop: 'proof' }, 'not json')).status === 400, 'a body that is not JSON → 400');
    check((await post({ authorization: 'Bearer path-owner', dpop: 'proof', slug: '../up' })).status === 202
      && !inboxWrites.at(-1).body.includes('../'), 'an unsafe Slug is dropped, and the post still lands');
    const doorRead = await fetch(`${ORIGIN}/u/alice/ap/outbox`, { redirect: 'manual' });
    check(doorRead.status === 303 && doorRead.headers.get('location') === POD + 'ap/outbox',
      "a read of a mail-door account's outbox is sent to the pod document");
  }

  // ---- a forum: one row per category, one inbox behind them ----------------
  {
    const attachRow = (body) => get('/api/attach', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer path-owner', dpop: 'proof' },
      body: JSON.stringify({ ...body, fronted: true, inboxUrl: POD + 'fedipod-bb/ap/inbox/' }),
    });
    const site = await attachRow({ handle: 'forum', podHome: POD + 'fedipod-bb/', actorUrl: POD + 'fedipod-bb/ap/actor', kind: 'application' });
    const gard = await attachRow({ handle: 'gardening', podHome: POD + 'fedipod-bb/c/gardening/', actorUrl: POD + 'fedipod-bb/c/gardening/ap/actor', kind: 'group' });
    const comp = await attachRow({ handle: 'compost', podHome: POD + 'fedipod-bb/c/compost/', actorUrl: POD + 'fedipod-bb/c/compost/ap/actor', kind: 'group' });
    check(site.status === 201 && gard.status === 201 && comp.status === 201,
      `a forum attaches its site and each category as rows of their own (${site.status} ${gard.status} ${comp.status})`);
    check(attached.gardening?.inboxUrl === POD + 'fedipod-bb/ap/inbox/' && attached.gardening.kind === 'group'
      && attached.gardening.podHome === POD + 'fedipod-bb/c/gardening/',
      'a category row names its own tree and the forum\'s inbox');
    const badInbox = await get('/api/attach', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer path-owner', dpop: 'proof' },
      body: JSON.stringify({ handle: 'weeds', podHome: POD + 'fedipod-bb/c/weeds/', fronted: true, inboxUrl: 'https://elsewhere.example/inbox/' }),
    });
    check(badInbox.status === 400, 'an inbox on another host is refused');
    const wf = async (h) => (await get(`/.well-known/webfinger?resource=acct:${h}@${HOST}`)).json();
    const wfG = await wf('gardening');
    const wfC = await wf('compost');
    const self = (j) => j.links?.find(l => l.rel === 'self')?.href;
    check(self(wfG) === `${ORIGIN}/u/gardening/ap/actor` && self(wfC) === `${ORIGIN}/u/compost/ap/actor`,
      'two category handles resolve to two actors on one pod');
    check((wfG.aliases || []).includes(POD + 'fedipod-bb/c/gardening/ap/actor'), 'each naming its pod actor as an alias');
    const face = await (await get('/u/gardening/ap/actor')).json();
    check(face.id === `${ORIGIN}/u/gardening/ap/actor` && face.type === 'Group'
      && face.inbox === `${ORIGIN}/u/gardening/ap/inbox/` && face.attributedTo === `${ORIGIN}/u/gardening/ap/moderators`,
      'the category actor is served under its front id, with its door and roster on the front');
    const faceRes = await get('/u/gardening/ap/actor');
    const pre = await get('/u/gardening/ap/actor', { method: 'OPTIONS', headers: { origin: 'https://bb.example', 'access-control-request-method': 'GET' } });
    check(faceRes.headers.get('access-control-allow-origin') === '*' && pre.status === 204
      && pre.headers.get('access-control-allow-origin') === '*',
      'a fronted document is read from any origin, and a preflight is answered (the forum page at its own host)');
    const before = inboxWrites.filter(w => w.url.includes('/fedipod-bb/ap/inbox/') && !w.url.endsWith('.receipt.json')).length;
    const r = await fetch(`${ORIGIN}/u/gardening/ap/inbox/`, {
      method: 'POST', headers: { 'content-type': 'application/activity+json' },
      body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', id: 'https://m.example/f/9', type: 'Follow',
        actor: 'https://m.example/u/mei', object: `${ORIGIN}/u/gardening/ap/actor` }),
    });
    const after = inboxWrites.filter(w => w.url.includes('/fedipod-bb/ap/inbox/') && !w.url.endsWith('.receipt.json')).length;
    check(r.status === 202 && after === before + 1,
      `a delivery through a category's door is written into the forum's one inbox (${r.status})`);
    check(!inboxWrites.some(w => w.url.includes('/fedipod-bb/c/gardening/ap/inbox/')), 'and never into the category\'s own');
    check(inboxWrites.some(w => w.url.includes('/fedipod-bb/ap/inbox/') && w.url.endsWith('.receipt.json')),
      'with a receipt beside it, signed with that row\'s secret');
  }

} finally {
  front.close(); pod.close();
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
