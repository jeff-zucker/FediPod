// Live-CSS validation of the css-gateway handler: instantiate the real
// HttpHandler subclass with a ResourceStore built from real CSS
// BasicRepresentation/readableToString, and drive requests through it.
// Run where @solid/community-server resolves (inside a CSS install, or with it
// symlinked into this package's node_modules). Not part of FediPod's offline
// suite — this is the live-CSS validation of the HttpHandler shell.
import { Readable } from 'node:stream';
import { BasicRepresentation, readableToString, NotFoundHttpError } from '@solid/community-server';
import { FediPodGatewayHandler } from './src/index.mjs';

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

console.log(fails ? `\n${fails} FAILURE(S)` : '\nall green');
process.exit(fails ? 1 : 0);
