// End-to-end: the Server suffix mode (mode d). Boot a real Community Solid
// Server whose pods live on PATHS of one host (suffix identifiers), opt a path
// pod in as its owner would, and drive it the way a phone app and a remote
// server would — while a second path pod on the SAME origin proves the two stay
// separate. No agent process exists anywhere; every route answers under the
// pod's own path.
//
//   npm run test:e2e:suffix     (from packages/fedipod-server)
//
// The whole point of difference from live-agent.mjs: there every identity had an
// origin of its own (a subdomain), so its surface sat at the origin root. Here
// @aisha lives at https://server/aisha/, shares the origin with the front and
// with @tamara, and answers its actor, its inbox, its client API, its OAuth and
// its door all UNDER /aisha/. WebFinger for it is answered by the front at the
// apex, because a path pod cannot resolve its own handle.
//
// FEDIPOD_E2E_LOG=info shows the server's log, the agent's own messages included.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppRunner } from '@solid/community-server';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { signRequest } from '@fedify/fedify/sig';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '../..');

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

// Resolvable as a package, the way `npm install fedipod-server` leaves it.
const selfLink = path.join(pkg, 'node_modules', 'fedipod-server');
if (!fs.existsSync(selfLink)) fs.symlinkSync(pkg, selfLink, 'dir');

// Suffix pods: every pod is a PATH of the one host, so an identity shares its
// origin with the front and with the others. That is what this test exercises.
const PORT = 4795;
const BASE = `http://localhost:${PORT}/`;
const HOST = `localhost:${PORT}`;
const POD = `${BASE}aisha/`;                 // @aisha lives here, on a path
const POD2 = `${BASE}tamara/`;               // and @tamara beside her, same origin
const PASSWORD = 'correct horse battery staple';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-suffix-'));
const dataDir = path.join(tmp, 'agent');
const seedPath = path.join(tmp, 'seed.json');
fs.writeFileSync(seedPath, JSON.stringify([
  { email: 'aisha@example.com', password: 'sekrit', pods: [{ name: 'aisha' }] },
  { email: 'tamara@example.com', password: 'sekrit', pods: [{ name: 'tamara' }] },
]));

// Deliveries in this test go to a mock instance on the loopback address.
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';

// The memory-subdomains config with suffix (path) identifiers instead — the one
// change that makes CSS put pods on paths — plus this component.
const config = path.join(tmp, 'suffix-e2e.json');
fs.writeFileSync(config, JSON.stringify({
  '@context': [
    'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld',
    'https://linkedsoftwaredependencies.org/bundles/npm/fedipod-server/^0.0.0/components/context.jsonld',
  ],
  import: [
    'css:config/app/init/static-root.json',
    'css:config/app/main/default.json',
    'css:config/app/variables/default.json',
    'css:config/http/handler/default.json',
    'css:config/http/middleware/default.json',
    'css:config/http/notifications/all.json',
    'css:config/http/server-factory/http.json',
    'css:config/http/static/default.json',
    'css:config/identity/access/public.json',
    'css:config/identity/email/default.json',
    'css:config/identity/handler/default.json',
    'css:config/identity/oidc/default.json',
    'css:config/identity/ownership/token.json',
    'css:config/identity/pod/static.json',
    'css:config/ldp/authentication/dpop-bearer.json',
    'css:config/ldp/authorization/webacl.json',
    'css:config/ldp/handler/default.json',
    'css:config/ldp/metadata-parser/default.json',
    'css:config/ldp/metadata-writer/default.json',
    'css:config/ldp/modes/default.json',
    'css:config/storage/backend/memory.json',
    'css:config/storage/key-value/resource-store.json',
    'css:config/storage/location/pod.json',
    'css:config/storage/middleware/default.json',
    'css:config/util/auxiliary/acl.json',
    'css:config/util/identifiers/suffix.json',
    'css:config/util/index/default.json',
    'css:config/util/logging/winston.json',
    'css:config/util/representation-conversion/default.json',
    'css:config/util/resource-locker/memory.json',
    'css:config/util/variables/default.json',
    'fps:config/server.json',
  ],
  '@graph': [
    {
      comment: 'The front answers on the server root; pods are on its paths.',
      '@type': 'Override',
      overrideInstance: { '@id': 'urn:fedipod:server:Handler' },
      overrideParameters: {
        '@type': 'FediPodServerHandler',
        args_resourceStore: { '@id': 'urn:solid-server:default:ResourceStore' },
        args_clusterManager: { '@id': 'urn:solid-server:default:ClusterManager' },
        args_frontOrigin: BASE.replace(/\/$/, ''),
        args_directoryContainer: '/.internal/fedipod/directory/',
        args_agentRegistryContainer: '/.internal/fedipod/agents/',
        args_agentRuntimeOptIn: true,
        args_agentAutoFront: true,
        args_agentDataDir: dataDir,
        args_agentPollSeconds: 2,
      },
    },
  ],
}, null, 2));

// A stand-in for another fediverse server: it answers for one actor and keeps
// whatever is delivered to them.
const REMOTE_PORT = 4796;
const REMOTE = `http://127.0.0.1:${REMOTE_PORT}/`;
const delivered = [];
const remoteKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const remotePublicPem = remoteKeys.publicKey.export({ type: 'spki', format: 'pem' });
const signingKeyOf = (privateKey) => webcrypto.subtle.importKey('pkcs8',
  privateKey.export({ type: 'pkcs8', format: 'der' }), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
const remote = http.createServer((req, res) => {
  const isActor = /^\/u\/([a-z]+)$/u.exec(req.url || '');
  if (isActor) {
    const name = isActor[1];
    res.writeHead(200, { 'content-type': 'application/activity+json' });
    res.end(JSON.stringify({
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
      id: `${REMOTE}u/${name}`, type: 'Person', preferredUsername: name,
      inbox: `${REMOTE}u/${name}/inbox`, outbox: `${REMOTE}u/${name}/outbox`,
      publicKey: { id: `${REMOTE}u/${name}#main-key`, owner: `${REMOTE}u/${name}`, publicKeyPem: remotePublicPem },
    }));
    return;
  }
  const isInbox = /^\/u\/([a-z]+)\/inbox$/u.exec(req.url || '');
  if (isInbox && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        delivered.push(Object.assign(
          JSON.parse(Buffer.concat(chunks).toString()), { deliveredTo: isInbox[1] },
        ));
      } catch { /* not ours */ }
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

const secrets = new Map();
const doorSecret = (handle) => secrets.get(handle);

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

const { createRequire } = await import('node:module');
const req_ = createRequire(import.meta.url);
const { mintCredential, createGrantSession } = req_(path.resolve(pkg, '../../vendor/idp-grant.cjs'));
const sessionFor = async (email, podUrl) => createGrantSession(await mintCredential({
  origin: BASE.replace(/\/$/, ''), email, password: 'sekrit', podUrl, name: 'e2e-optin',
}));
const optIn = (session, podBase) => session.fetch(`${BASE}api/agent`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'opt-in', podBase }),
});

const actorUrl = `${POD}fedipod/ap/actor`;

try {
  // ---- a path pod opts in --------------------------------------------------
  const aishaIn = await optIn(await sessionFor('aisha@example.com', POD), POD);
  check(aishaIn.status === 201, "aisha's opt-in is accepted — a pod on a path is a pod");
  secrets.set('aisha', (await aishaIn.clone().json()).doorSecret);
  const tamaraIn = await optIn(await sessionFor('tamara@example.com', POD2), POD2);
  check(tamaraIn.status === 201, "tamara's too, on a path of the very same host");
  secrets.set('tamara', (await tamaraIn.clone().json()).doorSecret);

  // The gateway's own origin ROOT is refused: it is the front, not a pod, and
  // the path is what a pod claims.
  const apex = await optIn(await sessionFor('aisha@example.com', POD),
    BASE);
  check(apex.status === 403, 'the origin root itself is refused — it is the gateway, not a pod');

  // ---- the identity provisions itself, on its own path --------------------
  const gotActor = await until('the agent publishes its actor document under /aisha/', async () =>
    (await fetch(actorUrl, { headers: { accept: 'application/activity+json' }})).status === 200);
  let actor = null;
  if (gotActor) {
    actor = await (await fetch(actorUrl, { headers: { accept: 'application/activity+json' }})).json();
    check(actor.type === 'Person' && actor.preferredUsername === 'aisha',
      'the identity is @aisha, provisioned from the opt-in alone');
    check(Boolean(actor.publicKey?.publicKeyPem), 'it publishes a signing key');
    check(actor.id === actorUrl, 'and its id is on its own path, served by the pod itself');
  }

  // ---- WebFinger is answered at the apex, and points straight at the pod ---
  // A path pod cannot answer its own handle (its host root is the front's), so
  // the door dispatches @aisha@<host> to it — with no id rewrite and no alias,
  // because the Server IS the pod's server.
  const fronted = await until('the door resolves @aisha@localhost to the pod actor', async () => {
    const wf = await fetch(`${BASE}.well-known/webfinger?resource=acct:aisha@localhost`);
    if (wf.status !== 200) return false;
    return (await wf.json()).links?.[0]?.href === actorUrl;
  });
  check(fronted, 'the front resolves @aisha@localhost straight to the pod actor');
  if (fronted) {
    const wf = await (await fetch(`${BASE}.well-known/webfinger?resource=acct:aisha@localhost`)).json();
    check(!wf.aliases || wf.aliases.length === 0,
      'with no alias — the actor already lives at its real id, nothing is rewritten');
  }

  // ---- the actor advertises its surface under its path --------------------
  if (actor) {
    check(actor.endpoints?.oauthAuthorizationEndpoint === `${POD}oauth/authorize`
      && actor.endpoints?.oauthTokenEndpoint === `${POD}oauth/token`,
    'the actor points a client at OAuth endpoints under its own path');
    check(actor.outbox === `${POD}ap/outbox`,
      'the actor names an outbox a client can write to, on its path');
    check(actor.inbox === `${POD}fedipod/ap/inbox/`,
      'while the inbox names the pod, which buffers deliveries');
    const readOutbox = await fetch(actor.outbox, { redirect: 'manual' });
    check(readOutbox.status === 303
      && readOutbox.headers.get('location') === `${POD}fedipod/ap/outbox`,
    "and reading the outbox goes on to the pod's own collection under the path");
  }

  // ---- the pod is still a pod ---------------------------------------------
  check((await fetch(`${POD}profile/card`, { headers: { accept: 'text/turtle' }})).status === 200,
    'ordinary pod resources on the path are still served by CSS');

  // ---- discovery and the client API, all under the path -------------------
  const nodeinfo = await (await fetch(`${POD}.well-known/nodeinfo`)).json().catch(() => ({}));
  check(nodeinfo.links?.[0]?.href === `${POD}nodeinfo/2.0`,
    'nodeinfo points at the document under the pod path');
  check((await fetch(`${POD}nodeinfo/2.0`)).status === 200, 'and that document is served there');

  const meta = await (await fetch(`${POD}.well-known/oauth-authorization-server`)).json().catch(() => ({}));
  check(meta.issuer === `${BASE.replace(/\/$/, '')}/aisha`
    && meta.authorization_endpoint === `${POD}oauth/authorize`,
  'the OAuth metadata issuer and endpoints are the pod path');

  const instance = await (await fetch(`${POD}api/v1/instance`)).json().catch(() => ({}));
  check(String(instance.uri ?? '').length > 0, 'the Mastodon instance API answers under the path');

  // ---- a client signs in through the door under the path ------------------
  const appReg = await (await fetch(`${POD}api/v1/apps`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'e2e', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob' }),
  })).json();
  check(Boolean(appReg.client_id), 'a client registers at the pod-path apps endpoint');

  const setPassword = await fetch(`${POD}fp/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dk-token': doorSecret('aisha') },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check(setPassword.status === 200, "the operator's door under /aisha/fp/ opens with its own secret");
  const crossDoor = await fetch(`${POD}fp/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dk-token': doorSecret('tamara') },
    body: JSON.stringify({ password: PASSWORD }),
  });
  check(crossDoor.status === 401 || crossDoor.status === 403,
    "and tamara's secret does not open aisha's door on the shared origin");

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
  check(Boolean(code), 'the password buys an authorization code at the pod path');
  const token = await (await fetch(`${POD}oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: appReg.client_id, client_secret: appReg.client_secret,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', code, grant_type: 'authorization_code',
    }),
  })).json();
  const bearer = token.access_token;
  check(Boolean(bearer), 'which the client exchanges for an access token');
  check(token.activitypub_actor_id === actorUrl, 'and the token acts for the pod-path actor');
  const auth = { authorization: `Bearer ${bearer}` };
  const me = await fetch(`${POD}api/v1/accounts/verify_credentials`, { headers: auth });
  check(me.status === 200 && (await me.json()).username === 'aisha',
    'the client is signed in as @aisha, all under the path');

  // ---- a remote follows the path pod, verified at its own door ------------
  const podInbox = `${POD}fedipod/ap/inbox/`;
  const follow = (who, n) => JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Follow', id: `${REMOTE}activities/${n}`, actor: `${REMOTE}u/${who}`, object: actorUrl,
  });
  const signedPost = async (who, body, privateKey) => {
    const r = new Request(podInbox, { method: 'POST',
      headers: { 'content-type': 'application/activity+json' }, body });
    return signRequest(r, await signingKeyOf(privateKey), new URL(`${REMOTE}u/${who}#main-key`));
  };
  const verifiedRes = await fetch(await signedPost('erin', follow('erin', 3), remoteKeys.privateKey));
  const verified = await verifiedRes.json().catch(() => ({}));
  check(verifiedRes.status === 202 && verified.reason === 'verified',
    `a signed delivery to the path pod's inbox is verified at the door (${verifiedRes.status} ${verified.reason})`);
  check(await until('the identity answers the verified follow',
    async () => delivered.some((d) => d.type === 'Accept' && d.deliveredTo === 'erin')),
  'and the identity acts on it, sent as the pod-path actor');

  const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forgedRes = await fetch(await signedPost('frank', follow('frank', 4), otherKeys.privateKey));
  const forged = await forgedRes.json().catch(() => ({}));
  check(forgedRes.status === 202 && forged.reason === 'forged signature',
    `a delivery signed with the wrong key is dropped at the door (${forgedRes.status} ${forged.reason})`);

  // ---- the client posts, the follower receives it -------------------------
  const posted = await fetch(`${POD}api/v1/statuses`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'posted through the pod on its own path', visibility: 'public' }),
  });
  check(posted.status === 200, 'the client posts a status at the pod-path statuses endpoint');
  check(await until('the follower receives the post',
    async () => delivered.some((d) => d.type === 'Create' && d.deliveredTo === 'erin')),
  'and the post reaches the follower, delivered by the identity itself');

  // ---- the second path pod is a separate identity -------------------------
  const gotTamara = await until('@tamara comes up on her own path', async () =>
    (await fetch(`${POD2}fedipod/ap/actor`, { headers: { accept: 'application/activity+json' }})).status === 200);
  if (gotTamara) {
    const tamara = await (await fetch(`${POD2}fedipod/ap/actor`,
      { headers: { accept: 'application/activity+json' }})).json();
    check(tamara.preferredUsername === 'tamara' && tamara.id === `${POD2}fedipod/ap/actor`,
      'the second identity is @tamara, on her own path, a distinct actor');
  }
  const tamaraWf = await fetch(`${BASE}.well-known/webfinger?resource=acct:tamara@localhost`);
  check(tamaraWf.status === 200
    && (await tamaraWf.json()).links?.[0]?.href === `${POD2}fedipod/ap/actor`,
  'and the door resolves @tamara@localhost to her, not to aisha');
} catch (e) {
  check(false, `unexpected throw: ${e?.stack || e}`);
} finally {
  await app.stop().catch(() => {});
  await new Promise((r) => remote.close(r));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* leave it */ }
}

console.log(`\n${fails ? `${fails} FAILURE(S)` : 'all green'}`);
process.exit(fails ? 1 : 0);
