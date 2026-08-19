// Live-CSS validation of the css-gateway handler: instantiate the real
// HttpHandler subclass with a ResourceStore built from real CSS
// BasicRepresentation/readableToString, and drive requests through it.
// Run where @solid/community-server resolves (inside a CSS install, or with it
// symlinked into this package's node_modules). Not part of FediPod's offline
// suite — this is the live-CSS validation of the HttpHandler shell.
import { Readable } from 'node:stream';
import {
  BasicRepresentation, readableToString, NotFoundHttpError,
  DataAccessorBasedStore, InMemoryDataAccessor, SingleRootIdentifierStrategy,
  ComposedAuxiliaryStrategy, SuffixAuxiliaryIdentifierStrategy, MonitoringStore,
  RepresentationConvertingStore, ChainedConverter, RdfToQuadConverter, QuadToRdfConverter,
} from '@solid/community-server';
import { FediPodGatewayHandler } from '../dist/index.js';
import { makeStoreSession } from '../dist/store-pod.js';
import { RemotePod } from '../../../lib/remote.mjs';
import { Lease } from '../../../lib/lease.mjs';

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails++; };

// A minimal in-memory ResourceStore using the SAME Representation types CSS uses.
const disk = new Map();
const store = {
  async getRepresentation(id) {
    if (!disk.has(id.path)) throw new NotFoundHttpError();
    return new BasicRepresentation(disk.get(id.path), id, 'application/json');
  },
  async setRepresentation(id, rep) { disk.set(id.path, await readableToString(rep.data)); },
};

const DIRC = 'http://localhost:4000/.internal/fedipod/directory/';
const handler = new FediPodGatewayHandler({
  resourceStore: store, frontHost: 'fedipod.net', frontOrigin: 'https://fedipod.net',
  gatewayWebId: 'https://fedipod.net/gw#me', offersPods: true,
  directoryContainer: DIRC, signupPage: '<!doctype html><title>join</title>',
});
// Seed a user via the handler's own directory (proves the store round-trips).
await handler.dir.putDirectory('me', {
  handle: 'me', podHome: 'https://alice.pod/solid/', actorUrl: 'https://fedipod.net/u/me/ap/actor',
  kind: 'person', hmacSecret: 's', gatewayWebId: 'https://fedipod.net/gw#me',
});
check(disk.size === 1, 'directory row written through the real ResourceStore');
check((await handler.dir.lookup('me'))?.podHome === 'https://alice.pod/solid/',
  'and read back through it (BasicRepresentation + readableToString round-trip)');

const mkReq = (method, url, host, body) => {
  const r = Readable.from(body != null ? [Buffer.from(body)] : []);
  r.method = method; r.url = url;
  r.headers = { host, ...(body != null ? { 'content-type': 'application/activity+json' } : {}) };
  return r;
};
const mkRes = () => ({ s: 0, h: null, b: '', writeHead(s, h) { this.s = s; this.h = h; }, end(b) { this.b = b || ''; } });
const canHandle = async (req) => handler.canHandle({ request: req }).then(() => true).catch(() => false);

// canHandle: front host + route claimed; pod subdomain + other paths rejected.
check(await canHandle(mkReq('GET', '/', 'fedipod.net')) === true, 'canHandle claims GET / on the front host');
check(await canHandle(mkReq('GET', '/.well-known/webfinger?resource=acct:me@fedipod.net', 'fedipod.net')) === true,
  'canHandle claims WebFinger on the front host');
check(await canHandle(mkReq('GET', '/.well-known/webfinger', 'alice.fedipod.net')) === false,
  'canHandle REJECTS a pod subdomain — it falls through to CSS');
check(await canHandle(mkReq('GET', '/some/pod/doc', 'fedipod.net')) === false,
  'canHandle REJECTS a non-front path — falls through to CSS');

// handle: the signup page.
let res = mkRes();
await handler.handle({ request: mkReq('GET', '/', 'fedipod.net'), response: res });
check(res.s === 200 && /join/.test(res.b), 'handle serves the new-account page at /');

// handle: WebFinger resolves the fronted actor.
res = mkRes();
await handler.handle({ request: mkReq('GET', '/.well-known/webfinger?resource=acct:me@fedipod.net', 'fedipod.net'), response: res });
const wf = JSON.parse(res.b);
check(res.s === 200 && wf.links?.[0]?.href === 'https://fedipod.net/u/me/ap/actor',
  'handle answers WebFinger with the fronted actor');

// handle: a delivery is verified (unverified here, no reachable key) and written
// to the pod inbox THROUGH THE STORE.
process.env.AP_ALLOW_PRIVATE_TARGETS = '1';
res = mkRes();
await handler.handle({
  request: mkReq('POST', '/u/me/ap/inbox/', 'fedipod.net',
    JSON.stringify({ type: 'Follow', actor: 'https://x.example/u/a', object: 'https://fedipod.net/u/me/ap/actor' })),
  response: res,
});
check(res.s === 202, 'handle accepts a delivery to a fronted inbox (202)');
check([...disk.keys()].some(k => k.startsWith('https://alice.pod/solid/ap/inbox/')),
  'and writes the verified item into the pod inbox via the store — no credential, no HTTP');

// A gateway with no agent configured is the gateway as it was: the lifecycle
// hooks exist, and do nothing.
check(typeof handler.initialize === 'function' && typeof handler.finalize === 'function',
  'the handler offers the start and stop hooks CSS calls');
await handler.initialize();
await handler.finalize();
check(true, 'and with no agent configured they do nothing');

// SIGTERM/SIGINT: when the component runs an agent it installs a bounded
// clean-shutdown handler (the stock CSS CLI installs none, so a stop killed
// state unflushed and held the lease for its TTL) and takes it off at finalize.
{
  const sigHandler = new FediPodGatewayHandler({
    resourceStore: store, frontHost: 'fedipod.net', frontOrigin: 'https://fedipod.net',
    directoryContainer: DIRC, agentRuntimeOptIn: true,
    agentDataDir: fs.mkdtempSync('/tmp/fedipod-sig-'), agentRegistryContainer: '/reg/',
  });
  const before = process.listenerCount('SIGTERM');
  await sigHandler.initialize();
  check(process.listenerCount('SIGTERM') === before + 1 && process.listenerCount('SIGINT') >= 1,
    'initialize installs a SIGTERM/SIGINT clean-shutdown handler');
  await sigHandler.finalize();
  check(process.listenerCount('SIGTERM') === before,
    'and finalize removes it, leaving no listener behind');
}

const built = (args) => {
  try { return new FediPodGatewayHandler({ resourceStore: store, frontHost: 'fedipod.net',
    frontOrigin: 'https://fedipod.net', directoryContainer: DIRC, ...args }) && null; }
  catch (e) { return e.message; }
};
const withAgent = (extra) => built({ agentDataDir: '/tmp/x', ...extra });
check(/agentDataDir/.test(built({ agentPods: [ 'http://alice.localhost:4000/' ] }) || ''),
  'a server told to run an agent with nowhere to keep its key refuses to start');
check(/agentDataDir/.test(built({ agentRuntimeOptIn: true }) || ''),
  'and the same refusal covers runtime opt-in');
check(/not a pod URL/.test(withAgent({ agentPods: [ 'alice' ] }) || ''),
  'and refuses a pod that is not an address');
check(/origin of its own/.test(withAgent({
  agentPods: [ 'http://alice.localhost:4000/', 'http://alice.localhost:4000/two/' ] }) || ''),
'and refuses two identities on one origin — a client API is rooted at one');
check(/cannot share/.test(withAgent({
  agentPods: [ 'http://alice.a.example/', 'http://alice.b.example/' ] }) || ''),
"and refuses two pods that would share one identity directory");
check(/front/.test(withAgent({ agentPods: [ 'https://fedipod.net/alice/' ] }) || ''),
  'and refuses an identity on the front\'s own host');
check(withAgent({ agentPods: [ 'http://alice.localhost:4000/' ] }) === null,
  'a complete agent configuration constructs');

// ---------------------------------------------------------------------------
// The agent's transport: a REAL CSS store stack — DataAccessorBasedStore with
// conversion and monitoring, the same layering a running server has — driven
// through makeStoreFetch, RemotePod and Lease. What this proves is that the
// agent's own classes work unchanged when the pod is reached through the store
// instead of the network.
// ---------------------------------------------------------------------------
const podBase = 'http://alice.localhost:4000/';
const idStrategy = new SingleRootIdentifierStrategy(podBase);
const metaStrategy = new ComposedAuxiliaryStrategy(
  new SuffixAuxiliaryIdentifierStrategy('.meta'), undefined, undefined, false, true);
const auxStrategy = new ComposedAuxiliaryStrategy(
  new SuffixAuxiliaryIdentifierStrategy('.dummy'), undefined, undefined, false, false);
const rdfConverter = new ChainedConverter([ new RdfToQuadConverter(), new QuadToRdfConverter() ]);
const realStore = new MonitoringStore(new RepresentationConvertingStore(
  new DataAccessorBasedStore(new InMemoryDataAccessor(idStrategy), idStrategy, auxStrategy, metaStrategy),
  metaStrategy, { outConverter: rdfConverter, inConverter: rdfConverter },
));

const session = makeStoreSession(realStore);
const sf = session.fetch;

// Reads and writes, and the absence a caller must be able to tell from failure.
check((await sf(podBase + 'nothing.json')).status === 404, 'a missing document reads 404, not an error');
let r = await sf(podBase + 'doc.json', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"n":1}',
});
check(r.status < 300, 'PUT writes through the store');
r = await sf(podBase + 'doc.json');
const firstEtag = r.headers.get('etag');
check(r.status === 200 && (await r.json()).n === 1, 'and the document reads back');
check(Boolean(firstEtag), 'a read carries an ETag');
check((await sf(podBase + 'doc.json', { headers: { 'if-none-match': firstEtag }})).status === 304,
  'a conditional read of the unchanged document answers 304');

// The lease's protocol, against the real store's own condition checking.
check((await sf(podBase + 'doc.json', {
  method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': '"stale"' }, body: '{"n":2}',
})).status === 412, 'a PUT with a stale If-Match is refused with 412');
check((await sf(podBase + 'doc.json', {
  method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': firstEtag }, body: '{"n":2}',
})).status < 300, 'and the same PUT with the current ETag is accepted');

check((await sf(podBase + 'doc.json', { method: 'DELETE' })).status < 300, 'DELETE removes it');
check((await sf(podBase + 'doc.json')).status === 404, 'and it is gone');

// Confinement: the store serves every pod on the server; a base-scoped session
// must not. Anything outside the base is refused before the store is asked.
const confined = makeStoreSession(realStore, podBase);
check((await confined.fetch(podBase + 'doc2.json', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
})).status < 300, 'a confined session still writes under its own base');
check((await confined.fetch('http://mei.localhost:4000/doc.json')).status === 403,
  'and refuses a read on another origin');
check((await confined.fetch('http://mei.localhost:4000/doc.json', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
})).status === 403, 'and a write there the same way');
const subtree = makeStoreSession(realStore, podBase + 'pods/mei/');
check((await subtree.fetch(podBase + 'doc2.json')).status === 403,
  'a subtree-scoped session cannot reach above its base');

// RemotePod itself, unmodified, over that transport.
const remote = new RemotePod({ webId: podBase + 'profile/card#me' }, { session });
await remote.warmup();
await remote.putJson(podBase + 'ap/inbox/one.json', { type: 'Follow', id: 'urn:one' });
await remote.putJson(podBase + 'ap/inbox/two.json', { type: 'Like', id: 'urn:two' });
check((await remote.getJson(podBase + 'ap/inbox/one.json'))?.id === 'urn:one',
  'RemotePod reads and writes JSON with no credential');
check(await remote.getJson(podBase + 'ap/inbox/absent.json') === null,
  'and a missing document is null rather than a throw');
const listed = await remote.listContainer(podBase + 'ap/inbox/');
check(listed.length === 2 && listed.every(i => i.modified),
  'listContainer parses the real container listing, with modification times to drain oldest-first');
check((await remote.listContainer(podBase + 'ap/inbox/')).length === 2,
  'and the revalidated second listing agrees');
check(await remote.delete(podBase + 'ap/inbox/one.json') === true, 'RemotePod deletes an inbox item');

// The deny-list is above the transport, so it still guards what a pod cannot lose.
const refuses = async (url) => remote.delete(url).then(() => false).catch(() => true);
check(await refuses(podBase + 'profile/card'), 'the deny-list still refuses to delete the WebID document');
check(await refuses(podBase + 'ap/inbox/.acl'), 'and an access-control document');
check(await refuses(podBase + 'activitypods-js/ap-state/lease.json'), 'and the lease');

// The lease, unmodified, coordinating through the store.
const leaseUrl = podBase + 'activitypods-js/ap-state/lease.json';
const first = new Lease({ url: leaseUrl, fetchImpl: (u, i) => remote.fetch(u, i), log: () => {} });
check(await first.acquire() === true, 'an agent acquires the lease through the store');
const second = new Lease({ url: leaseUrl, fetchImpl: (u, i) => remote.fetch(u, i), log: () => {} });
check(await second.acquire() === false, 'a second agent on the same pod is refused it');
check(await first.renewOnce() === true, 'the holder renews — the conditional PUT protocol works unchanged');
await first.release();
check(await second.acquire() === true, 'and once released the other agent may act');

// ---------------------------------------------------------------------------
// Runtime opt-in: rows through the real store, claims flipping live, and a
// fresh handler over the same store re-claiming at initialize() — the restart
// property, pinned without booting a server.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';

const optDataDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fpg-optin-'));
const OPT_POD = 'http://dana.localhost:4000/';
const optHandler = new FediPodGatewayHandler({
  resourceStore: realStore, frontHost: 'fedipod.net', frontOrigin: 'https://fedipod.net',
  directoryContainer: podBase + '.internal/fedipod/directory/',
  agentRuntimeOptIn: true, agentDataDir: optDataDir,
  agentRegistryContainer: podBase + '.internal/fedipod/agents/',
});
const claimsFor = async (host, path_) =>
  optHandler.canHandle({ request: { headers: { host }, url: path_ } }).then(() => true).catch(() => false);

check(await claimsFor('dana.localhost:4000', '/api/v1/instance') === false,
  'before opt-in a pod origin is not claimed');
const optReply = await optHandler.optInPod({ podBase: OPT_POD, webId: OPT_POD + 'profile/card#me' });
check(optReply.httpStatus === 201 && optReply.status === 'starting' && Boolean(optReply.doorSecret),
  'opt-in answers 201 with a door secret, once');
check(await claimsFor('dana.localhost:4000', '/api/v1/instance') === true,
  'and the pod origin is claimed from that instant');
const optRes = { s: 0, writeHead(st) { this.s = st; return this; }, end() {} };
await optHandler.handle({ request: { headers: { host: 'dana.localhost:4000' }, url: '/api/v1/instance' }, response: optRes });
check(optRes.s === 503, 'the surface answers 503 while the identity is still coming up');
const secretFile = pathMod.join(optDataDir, 'dana', 'door-secret.json');
check(fs.existsSync(secretFile) && (fs.statSync(secretFile).mode & 0o777) === 0o600,
  'the secret file sits in the identity directory, owner-readable only');
check(JSON.parse(fs.readFileSync(secretFile, 'utf8')).secret === optReply.doorSecret,
  'and holds exactly the secret the reply carried');

const again = await optHandler.optInPod({ podBase: OPT_POD, webId: OPT_POD + 'profile/card#me' });
check(again.httpStatus === 201 && again.status === 'rotated' && again.doorSecret !== optReply.doorSecret,
  'a second opt-in rotates the secret — proving pod control again is the recovery');

// A different handler over the SAME store: the restart. Claims must be back
// before any request is answered.
const rebooted = new FediPodGatewayHandler({
  resourceStore: realStore, frontHost: 'fedipod.net', frontOrigin: 'https://fedipod.net',
  directoryContainer: podBase + '.internal/fedipod/directory/',
  agentRuntimeOptIn: true, agentDataDir: optDataDir,
  agentRegistryContainer: podBase + '.internal/fedipod/agents/',
});
await rebooted.initialize();
check(await rebooted.canHandle({ request: { headers: { host: 'dana.localhost:4000' }, url: '/ap/actor' } })
  .then(() => true).catch(() => false),
'after a restart the opted-in pod is claimed again, from the registry alone');
await rebooted.finalize();

const out = await optHandler.optOutPod({ podBase: OPT_POD });
check(out.httpStatus === 200, 'opt-out answers 200');
check(await claimsFor('dana.localhost:4000', '/api/v1/instance') === false,
  'and the pod origin falls back to plain pod serving');
check(fs.existsSync(secretFile), "the identity's directory stays for a later return");
const gone = await optHandler.optOutPod({ podBase: OPT_POD });
check(gone.httpStatus === 404, 'opting out twice says the pod is not opted in');
await optHandler.finalize();
fs.rmSync(optDataDir, { recursive: true, force: true });

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
