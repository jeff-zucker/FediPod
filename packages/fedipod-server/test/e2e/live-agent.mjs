// End-to-end: boot a real Community Solid Server with this component's config
// and two identities configured, then use one of them the way a phone app would
// — sign in, post, watch the live feed — while the other proves that identities
// on one server stay separate. No agent process exists anywhere in this test.
//
//   npm run test:e2e     (from packages/css-gateway)
//
// Deliberately outside the `node --test test/*.mjs` glob: it starts a server
// and takes a while. Everything it asserts is read back over plain HTTP, the
// way another server or a client would see it.
//
// FEDIPOD_E2E_LOG=info shows the server's log, the agent's own messages included.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppRunner } from '@solid/community-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '../..');

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

// Components.js loads a component by package name, so the package has to be
// resolvable as one — the same link `npm install fedipod-css-gateway` would
// leave behind. Made here so this test runs straight after a plain install.
const selfLink = path.join(pkg, 'node_modules', 'fedipod-css-gateway');
if (!fs.existsSync(selfLink)) fs.symlinkSync(pkg, selfLink, 'dir');

// Subdomain pods: the Mastodon client API is rooted at an origin, so an
// identity that serves clients needs one of its own.
const PORT = 4791;
const BASE = `http://localhost:${PORT}/`;
const ALICE = `alice.localhost:${PORT}`;
const POD = `http://${ALICE}/`;
const POD2 = `http://carol.localhost:${PORT}/`;
const PASSWORD = 'correct horse battery staple';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-e2e-'));
const dataDir = path.join(tmp, 'agent');
const seedPath = path.join(tmp, 'seed.json');
fs.writeFileSync(seedPath, JSON.stringify([
  { email: 'alice@example.com', password: 'sekrit', pods: [{ name: 'alice' }] },
  { email: 'carol@example.com', password: 'sekrit', pods: [{ name: 'carol' }] },
  { email: 'dana@example.com', password: 'sekrit', pods: [{ name: 'dana' }] },
]));

// Deliveries in this test go to a mock instance on the loopback address.
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';

const config = path.join(tmp, 'agent-e2e.json');
fs.writeFileSync(config, JSON.stringify({
  '@context': [
    'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld',
    'https://linkedsoftwaredependencies.org/bundles/npm/fedipod-css-gateway/^0.0.0/components/context.jsonld',
  ],
  import: [ 'css:config/memory-subdomains.json', 'fpg:config/gateway.json' ],
  '@graph': [
    {
      comment: 'The front answers on the server root here, so /api/agent is reachable in the test.',
      '@type': 'Override',
      overrideInstance: { '@id': 'urn:fedipod:gateway:Handler' },
      overrideParameters: {
        '@type': 'FediPodGatewayHandler',
        args_resourceStore: { '@id': 'urn:solid-server:default:ResourceStore' },
        args_clusterManager: { '@id': 'urn:solid-server:default:ClusterManager' },
        args_frontHost: 'localhost',
        args_frontOrigin: BASE.replace(/\/$/, ''),
        args_directoryContainer: '/.internal/fedipod/directory/',
        args_agentRegistryContainer: '/.internal/fedipod/agents/',
        args_agentRuntimeOptIn: true,
        args_agentAutoFront: true,
        args_agentPods: [ POD, POD2 ],
        args_agentDataDir: dataDir,
        args_agentPollSeconds: 2,
      },
    },
  ],
}, null, 2));

// A stand-in for another fediverse server: it answers for one actor and keeps
// whatever is delivered to them.
const REMOTE_PORT = 4792;
const REMOTE = `http://127.0.0.1:${REMOTE_PORT}/`;
const delivered = [];
const remote = http.createServer((req, res) => {
  if (req.url === '/u/bob') {
    res.writeHead(200, { 'content-type': 'application/activity+json' });
    res.end(JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${REMOTE}u/bob`, type: 'Person', preferredUsername: 'bob',
      inbox: `${REMOTE}u/bob/inbox`, outbox: `${REMOTE}u/bob/outbox`,
    }));
    return;
  }
  if (req.url === '/u/bob/inbox' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { delivered.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { /* not ours */ }
      res.writeHead(202).end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => remote.listen(REMOTE_PORT, '127.0.0.1', r));

const until = async (label, predicate, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await predicate()) return true; } catch { /* not yet */ }
    if (Date.now() > deadline) { check(false, `${label} (timed out after ${timeoutMs / 1000}s)`); return false; }
    await new Promise((r) => setTimeout(r, 500));
  }
};

const doorSecret = (handle) => JSON.parse(fs.readFileSync(
  path.join(dataDir, handle, 'door-secret.json'), 'utf8')).secret;

const app = await new AppRunner().create({
  config,
  loaderProperties: { mainModulePath: pkg },
  variableBindings: {},
  shorthand: {
    port: PORT, baseUrl: BASE, seedConfig: seedPath,
    loggingLevel: process.env.FEDIPOD_E2E_LOG || 'warn',
  },
});
await app.start();

try {
  // ---- the identity provisions itself -------------------------------------
  const actorUrl = `${POD}activitypods-js/ap/actor`;
  const gotActor = await until('the agent publishes its actor document', async () =>
    (await fetch(actorUrl, { headers: { accept: 'application/activity+json' }})).status === 200);
  if (gotActor) {
    const actor = await (await fetch(actorUrl, { headers: { accept: 'application/activity+json' }})).json();
    check(actor.type === 'Person' && actor.preferredUsername === 'alice',
      'the identity is @alice, provisioned from the pod URL alone');
    check(Boolean(actor.publicKey?.publicKeyPem), 'it publishes a signing key');
  }
  check((await fetch(`${POD}.well-known/webfinger?resource=acct:alice@${ALICE}`)).status === 200,
    'the pod answers WebFinger for it');

  // Auto-fronting: because this one server also runs the door, @alice@localhost
  // resolves through the front to alice's own actor — no manual attach.
  const fronted = await until('the door fronts the identity as @alice@localhost', async () => {
    const wf = await fetch(`${BASE}.well-known/webfinger?resource=acct:alice@localhost`);
    if (wf.status !== 200) return false;
    const href = (await wf.json()).links?.[0]?.href;
    return href === `${POD}ap/actor`;
  });
  check(fronted, 'the front resolves @alice@localhost to the identity on its pod');
  const stateRes = await fetch(`${POD}activitypods-js/ap-state/`, { headers: { accept: 'text/turtle' }});
  check(stateRes.status === 401 || stateRes.status === 403,
    'the agent state tree is not readable by a stranger');

  const gotSecond = await until('a second configured pod gets its own identity', async () =>
    (await fetch(`${POD2}activitypods-js/ap/actor`,
      { headers: { accept: 'application/activity+json' }})).status === 200);
  if (gotSecond) {
    const carol = await (await fetch(`${POD2}activitypods-js/ap/actor`,
      { headers: { accept: 'application/activity+json' }})).json();
    check(carol.preferredUsername === 'carol', 'the second identity is @carol, on its own origin');
  }

  // ---- the pod is still a pod ---------------------------------------------
  check((await fetch(`${POD}profile/card`, { headers: { accept: 'text/turtle' }})).status === 200,
    'ordinary pod resources are still served by CSS');

  // ---- a client signs in, the way a phone app does ------------------------
  const nodeinfo = await fetch(`${POD}.well-known/nodeinfo`);
  check(nodeinfo.status === 200 && Boolean((await nodeinfo.json()).links?.[0]?.href),
    'a client discovers the instance through nodeinfo');
  check((await fetch(`${POD}nodeinfo/2.0`)).status === 200, 'and reads its nodeinfo document');

  const instance = await (await fetch(`${POD}api/v1/instance`)).json();
  check(String(instance.uri ?? '').includes('alice'), 'the instance it reports is the pod itself');
  check(String(instance.urls?.streaming_api ?? '').startsWith(`ws://${ALICE}`),
    'and it points live clients at this origin');

  const appReg = await (await fetch(`${POD}api/v1/apps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'e2e', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob' }),
  })).json();
  check(Boolean(appReg.client_id), 'the client registers');

  // Without a password there is no way in, however public the route is.
  const noPassword = await fetch(`${POD}oauth/authorize?client_id=${appReg.client_id
  }&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=read+write`);
  check(noPassword.status === 403, 'sign-in is refused until the identity has a password');

  // The operator sets one through their own door, which the secret guards.
  const noGate = await fetch(`${POD}app/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check(noGate.status === 401 || noGate.status === 403, "the operator's door is shut without the secret");
  const setPassword = await fetch(`${POD}app/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dk-token': doorSecret('alice') },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check(setPassword.status === 200, 'and open with it, to set the password');

  const authorize = await fetch(`${POD}oauth/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appReg.client_id, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      response_type: 'code', scope: 'read write follow', password: PASSWORD,
    }).toString(),
    redirect: 'manual',
  });
  const code = authorize.status === 200
    ? (await authorize.json()).code
    : new URL(authorize.headers.get('location') ?? 'http://x/', 'http://x/').searchParams.get('code');
  check(Boolean(code), 'the password buys an authorization code');

  const token = await (await fetch(`${POD}oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: appReg.client_id, code, grant_type: 'authorization_code' }),
  })).json();
  const bearer = token.access_token;
  check(Boolean(bearer), 'which the client exchanges for an access token');

  const auth = { authorization: `Bearer ${bearer}` };
  const me = await fetch(`${POD}api/v1/accounts/verify_credentials`, { headers: auth });
  check(me.status === 200 && (await me.json()).username === 'alice', 'and the client is signed in as @alice');
  check((await fetch(`${POD}api/v1/accounts/verify_credentials`)).status === 401,
    'while an unauthenticated client is turned away');

  // ---- the live feed -------------------------------------------------------
  const events = [];
  const socket = new WebSocket(`ws://${ALICE}/api/v1/streaming?access_token=${
    encodeURIComponent(bearer)}&stream=user`);
  socket.addEventListener('message', (event) => {
    try { events.push(JSON.parse(event.data)); } catch { /* not ours */ }
  });
  const opened = await until('the client opens the live feed', async () => socket.readyState === 1, 15_000);

  // ---- somebody follows, and the identity answers --------------------------
  const remoteActor = `${REMOTE}u/bob`;
  const put = await fetch(`${POD}activitypods-js/ap/inbox/e2e-follow.json`, {
    method: 'PUT',
    headers: { 'content-type': 'application/activity+json' },
    body: JSON.stringify({
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Follow', id: `${REMOTE}activities/1`, actor: remoteActor, object: actorUrl,
    }),
  });
  check(put.status < 300, 'a delivery can be written into the inbox');
  const accepted = await until('the identity answers the Follow with an Accept, with no agent process',
    async () => delivered.some((d) => d.type === 'Accept'));
  check(accepted && delivered.find((d) => d.type === 'Accept')?.actor === actorUrl,
    'sent as the pod owner');

  // ---- the client posts, and the follower receives it -----------------------
  const posted = await fetch(`${POD}api/v1/statuses`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'posted from a client, through the pod itself', visibility: 'public' }),
  });
  check(posted.status === 200, 'the client posts a status');
  check(await until('and it is delivered to the follower',
    async () => delivered.some((d) => d.type === 'Create')), 'the follower receives the post');
  if (opened) {
    check(await until('and the live feed carries it to the open client',
      async () => events.some((e) => e.event === 'update'), 15_000),
    'the live feed carries the new post');
  }
  socket.close();

  // ---- the operator's door -------------------------------------------------
  check((await fetch(`${POD}app/status`)).status === 401, "the operator's own routes need the secret");
  check((await fetch(`${POD}app/status`, { headers: { 'x-dk-token': doorSecret('carol') }})).status === 401,
    "one identity's secret does not open another identity's door");
  const status = await fetch(`${POD}app/status`, { headers: { 'x-dk-token': doorSecret('alice') }});
  check(status.status === 200 && (await status.json()).handle === 'alice', 'and answer with it');
  check((await fetch(`${POD}app/shutdown`, { method: 'POST', headers: { 'x-dk-token': doorSecret('alice') }})).status === 404,
    'routes that manage a local process are not there to be found');
  const page = await fetch(`${POD}app/`, { headers: { 'x-dk-token': doorSecret('alice') }});
  check(page.status === 200 && (await page.text()).toLowerCase().includes('<!doctype html'),
    'the web client is served behind the door');
  const record = await fetch(`${POD}app/admin/`, { headers: { 'x-dk-token': doorSecret('alice') }});
  check(record.status === 200, "the operator's own pages are served behind it too");
  // The pages ask for their assets and their API relative to where they are
  // served, so the same build works at an origin root and behind a door.
  check((await fetch(`${POD}app/admin/bar.css`, { headers: { 'x-dk-token': doorSecret('alice') }})).status === 200,
    'and their stylesheets resolve from there');
  check((await fetch(`${POD}app/admin/client/`, { headers: { 'x-dk-token': doorSecret('alice') }})).status === 200,
    'as does the client wrapper');

  // ---- CORS ----------------------------------------------------------------
  const preflight = await fetch(`${POD}api/v1/statuses`, {
    method: 'OPTIONS',
    headers: { origin: 'https://elk.zone', 'access-control-request-method': 'POST' },
  });
  check(preflight.status === 204 || preflight.status === 200,
    'the server answers a browser preflight itself');
  // ---- runtime opt-in: dana's pod is NOT configured anywhere ---------------
  const DANA = `http://dana.localhost:${PORT}/`;
  const bare = (await fetch(`${DANA}api/v1/instance`)).status;
  check(bare === 401 || bare === 404,
    `an unconfigured pod has no client API — it is just a pod (${bare})`);

  // The owner proves control with a real token from this very server's IdP.
  const { createRequire } = await import('node:module');
  const req_ = createRequire(import.meta.url);
  const { mintCredential, createGrantSession } = req_(path.resolve(pkg, '../../vendor/idp-grant.cjs'));
  const danaCred = await mintCredential({
    origin: BASE.replace(/\/$/, ''), email: 'dana@example.com', password: 'sekrit',
    podUrl: DANA, name: 'e2e-optin',
  });
  const danaSession = createGrantSession(danaCred);

  const noProof = await fetch(`${BASE}api/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opt-in', podBase: DANA }),
  });
  check(noProof.status === 401, 'opt-in without proof of the pod is refused');

  const optIn = await danaSession.fetch(`${BASE}api/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opt-in', podBase: DANA }),
  });
  const optInBody = await optIn.json();
  check(optIn.status === 201 && Boolean(optInBody.doorSecret),
    'proving pod control buys an identity: 201, with the door secret, once');

  const danaUp = await until("dana's identity comes up", async () =>
    (await fetch(`${DANA}activitypods-js/ap/actor`, { headers: { accept: 'application/activity+json' }})).status === 200);
  if (danaUp) {
    const dana = await (await fetch(`${DANA}activitypods-js/ap/actor`,
      { headers: { accept: 'application/activity+json' }})).json();
    check(dana.preferredUsername === 'dana', 'provisioned as @dana, from the opt-in alone');
  }
  check((await fetch(`${DANA}app/status`)).status === 401, "dana's door needs a secret");
  const danaStatus = await fetch(`${DANA}app/status`, { headers: { 'x-dk-token': optInBody.doorSecret }});
  check(danaStatus.status === 200, 'the returned secret opens it');
  check((await fetch(`${DANA}app/status`, { headers: { 'x-dk-token': doorSecret('alice') }})).status === 401,
    "alice's secret does not open dana's door");

  const reOptIn = await danaSession.fetch(`${BASE}api/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opt-in', podBase: DANA }),
  });
  const rotated = await reOptIn.json();
  check(reOptIn.status === 201 && rotated.status === 'rotated' && rotated.doorSecret !== optInBody.doorSecret,
    'opting in again rotates the secret — that is lost-secret recovery');
  check((await fetch(`${DANA}app/status`, { headers: { 'x-dk-token': optInBody.doorSecret }})).status === 401,
    'the old secret stops working at once');
  check((await fetch(`${DANA}app/status`, { headers: { 'x-dk-token': rotated.doorSecret }})).status === 200,
    'and the new one works, with no restart');

  const optOut = await danaSession.fetch(`${BASE}api/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opt-out', podBase: DANA }),
  });
  check(optOut.status === 200, 'opt-out answers 200');
  check(await until("dana's pod serves plain LDP again", async () => {
    const st = (await fetch(`${DANA}api/v1/instance`)).status;
    return st === 401 || st === 404;
  }, 15_000), 'the client API is gone from that origin');
  const pileUp = await fetch(`${DANA}activitypods-js/ap/inbox/after-optout.json`, {
    method: 'PUT', headers: { 'content-type': 'application/activity+json' },
    body: JSON.stringify({ type: 'Like', id: 'urn:e2e:late' }),
  });
  check(pileUp.status < 300, 'deliveries still land in the pod inbox, waiting');

  const carolRefused = await danaSession.fetch(`${BASE}api/agent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'opt-in', podBase: POD2 }),
  });
  check(carolRefused.status === 403, "dana's token cannot opt in carol's pod");
} finally {
  await app.stop();
  remote.close();
}

// Everything the identities are made of survives the server they ran in.
check(fs.existsSync(path.join(dataDir, 'alice', 'keys.json'))
  && fs.existsSync(path.join(dataDir, 'carol', 'keys.json')),
'each identity\'s signing key is kept where the operator was told it would be');
check(!JSON.parse(fs.readFileSync(path.join(dataDir, 'alice', 'credential.json'), 'utf8')).secret,
  'and no client secret was ever needed');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
