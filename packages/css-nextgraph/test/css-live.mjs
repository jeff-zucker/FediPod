// css-live.mjs — the css-nextgraph component under a real Community Solid
// Server over the spike's local ngd: the plan's verification list. Boots CSS
// (subdomain pods, in-memory .internal records) with the package's backend
// config, seeds a pod, and as its owner PUTs a Turtle document and a JPEG,
// lists the container, refuses foreign triples, deletes, then stops the
// server, restarts the daemon, boots the server again and reads it all back.
//
//   cd claude/validation/nextgraph-spike && ./ngd.sh start
//   node packages/css-nextgraph/test/css-live.mjs
//
// The daemon, its log and its control script stay in the spike directory; SPIKE
// below is where they are.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PKG, '../..');
const SPIKE = path.join(REPO, 'claude/validation/nextgraph-spike');
const { AppRunner } = require(path.join(PKG, 'node_modules/@solid/community-server'));
const { Parser, Store } = require(path.join(PKG, 'node_modules/n3'));
const { mintCredential, createGrantSession } = require(path.join(REPO, 'vendor/idp-grant.cjs'));

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails += 1; };
const timed = async (label, fn) => { const t0 = performance.now(); const r = await fn(); console.log(`      ${label}: ${(performance.now() - t0).toFixed(0)} ms`); return r; };

const PORT = 3457;
const BASE = `http://localhost:${PORT}/`;
const POD = `http://alice.localhost:${PORT}/`;
const peer = fs.readFileSync(path.join(SPIKE, 'ngd.log'), 'utf8').match(/PeerId of node:\s*(\S+)/)[1];
const PHASE2 = process.argv[2] === 'phase2';
const tmp = PHASE2 ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'css-nextgraph-live-'));
const walletsDir = path.join(SPIKE, 'wallets', 'css-live');
if (!PHASE2) fs.rmSync(walletsDir, { recursive: true, force: true });
const seed = path.join(tmp, 'seed.json');
if (!PHASE2) fs.writeFileSync(seed, JSON.stringify([{ email: 'alice@example.com', password: 'sekrit', pods: [{ name: 'alice' }] }]));
const config = path.join(tmp, 'config.json');
if (!PHASE2) fs.writeFileSync(config, JSON.stringify({
  '@context': [
    'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld',
    'https://linkedsoftwaredependencies.org/bundles/npm/css-nextgraph/^0.0.0/components/context.jsonld',
  ],
  import: ['cng:config/server.json'],
  '@graph': [{ comment: 'the package\'s own server config: subdomain pods over NextGraph, .internal on disk' }],
}, null, 2));

async function boot() {
  const app = await new AppRunner().create({
    config,
    loaderProperties: { mainModulePath: PKG },
    shorthand: {
      port: PORT, baseUrl: BASE, seedConfig: seed, rootFilePath: path.join(tmp, 'data'), loggingLevel: process.env.LOG || 'warn',
      walletsDir, ngdPeerId: peer,
    },
  });
  await app.start();
  return app;
}

const turtle = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<> foaf:primaryTopic <#me> .
<#me> a foaf:Person ; foaf:name "Alice" ; foaf:knows [ foaf:name "Bob" ] .
`;
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not-a-real-jpeg-'.repeat(2000)), Buffer.from([0xff, 0xd9])]);

const mint = async () => createGrantSession(await mintCredential({ origin: BASE.replace(/\/$/u, ''), email: 'alice@example.com', password: 'sekrit', podUrl: POD, name: 'css-live' }));

if (PHASE2) {
  // ---- after both restarts, in a fresh process: everything is still there
  const app = await timed('CSS boot again (opens the wallet, reads the headers)', boot);
  try {
    const session = await mint();
    const f = (url, init) => session.fetch(url, init);
    const get = await timed('GET Turtle after restart', () => f(`${POD}scratch/test`, { headers: { accept: 'text/turtle' } }));
    const getText = await get.text();
    if (get.status !== 200) console.log(`      GET answered ${get.status} ${get.headers.get('content-type')}: ${getText.slice(0, 300).replace(/\n/gu, ' ')}`);
    check(get.status === 200 && new Parser({ baseIRI: `${POD}scratch/test` }).parse(getText).length === 5, 'the Turtle document survived both restarts');
    const pic = await f(`${POD}pics/avatar.jpg`);
    check(pic.status === 200 && (await pic.text()) === 'png-bytes', 'so did the image, newest bytes');
    const ap = await f(`${POD}ap/notes/1.json`);
    check(ap.status === 200, 'and the ActivityPub document');
    const after = await f(`${POD}scratch/after`, { headers: { accept: 'text/turtle' } });
    check(after.status === 200 && /After/u.test(await after.text()), 'and the document written after the in-server daemon restart');
    const out = execFileSync('node', [path.join(PKG, 'bin/css-nextgraph.mjs'), 'wallet', POD, '--dir', walletsDir], { encoding: 'utf8' });
    check(/wallet file: \S+\.ngw/u.test(out) && /password: +\S+/u.test(out) && /mnemonic: +(\S+ ){11}\S+/u.test(out) && /PIN: +\d{4}/u.test(out), 'the hand-over command prints the file, password, mnemonic and PIN');
  } finally {
    await app.stop();
  }
  console.log(fails ? `\n${fails} FAILED (phase 2)` : '\nphase 2 passed');
  process.exit(fails ? 1 : 0);
}

let app = await timed('CSS boot (seeds the pod, makes its wallet)', boot);
let session;
try {
  session = await mint(); if (false) createGrantSession(await mintCredential({ origin: BASE.replace(/\/$/u, ''), email: 'alice@example.com', password: 'sekrit', podUrl: POD, name: 'css-live' }));
  const f = (url, init) => session.fetch(url, init);

  const root = await f(POD, { headers: { accept: 'text/turtle' } });
  check(root.status === 200, `the pod root answers (${root.status})`);
  check(fs.existsSync(path.join(walletsDir, `alice.localhost_${PORT}.ngw`)), 'the pod has a wallet file beside the server');

  const put = await timed('PUT Turtle', () => f(`${POD}scratch/test`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: turtle }));
  check(put.status === 201 || put.status === 205, `PUT text/turtle (${put.status})`);
  const get = await timed('GET Turtle', () => f(`${POD}scratch/test`, { headers: { accept: 'text/turtle' } }));
  check(get.status === 200, `GET it back (${get.status})`);
  const body = await get.text();
  const quads = new Parser({ baseIRI: `${POD}scratch/test` }).parse(body);
  const store = new Store(quads);
  check(quads.length === 5, `five triples back (${quads.length})`);
  check(store.getQuads(`${POD}scratch/test#me`, 'http://xmlns.com/foaf/0.1/name', null).length === 1, 'the name is there under the resource\'s own subject');
  const known = store.getQuads(`${POD}scratch/test#me`, 'http://xmlns.com/foaf/0.1/knows', null)[0];
  check(known && known.object.termType === 'BlankNode', 'the blank node came back as a blank node');
  check(get.headers.get('etag'), 'the response carries an ETag');

  const foreign = await f(`${POD}profile/other`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<http://elsewhere.test/x> a <http://example.org/Thing> .' });
  check(foreign.status === 409, `triples about another subject are refused (${foreign.status})`);

  const putPic = await timed('PUT JPEG (32 KB)', () => f(`${POD}pics/avatar.jpg`, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg }));
  check(putPic.status === 201, `PUT image/jpeg (${putPic.status})`);
  const getPic = await timed('GET JPEG', () => f(`${POD}pics/avatar.jpg`));
  check(getPic.status === 200 && getPic.headers.get('content-type')?.startsWith('image/jpeg'), `GET it back as image/jpeg (${getPic.status})`);
  check(Buffer.from(await getPic.arrayBuffer()).equals(jpeg), 'byte-identical');
  const put2 = await f(`${POD}pics/avatar.jpg`, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: Buffer.from('png-bytes') });
  check(put2.status === 205 || put2.status === 204, `PUT over it (${put2.status})`);
  const get2 = await f(`${POD}pics/avatar.jpg`);
  check((await get2.text()) === 'png-bytes' && get2.headers.get('content-type')?.startsWith('image/png'), 'the newer bytes and type win');

  const listing = await timed('GET container listing', () => f(`${POD}pics/`, { headers: { accept: 'text/turtle' } }));
  const lst = new Store(new Parser({ baseIRI: `${POD}pics/` }).parse(await listing.text()));
  check(lst.getQuads(`${POD}pics/`, 'http://www.w3.org/ns/ldp#contains', `${POD}pics/avatar.jpg`).length === 1, 'the container lists the image');
  // The pod root itself is not listed: under css:config/app/init/static-root.json
  // the path / on every host is the static intro page, subdomain pods included.
  const readme = await f(`${POD}README`);
  check(readme.status === 200 && /markdown/u.test(readme.headers.get('content-type') || '') && (await readme.text()).length > 100, 'the seeded README is still markdown with its text');
  const scratch = new Store(new Parser({ baseIRI: `${POD}scratch/` }).parse(await (await f(`${POD}scratch/`, { headers: { accept: 'text/turtle' } })).text()));
  check(scratch.getQuads(`${POD}scratch/`, 'http://www.w3.org/ns/ldp#contains', `${POD}scratch/test`).length === 1, 'the scratch container lists the Turtle document');

  const activity = JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', content: 'hello' });
  const putAp = await f(`${POD}ap/notes/1.json`, { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: activity });
  check(putAp.status === 201, `PUT application/activity+json (${putAp.status})`);
  const getAp = await f(`${POD}ap/notes/1.json`);
  check((await getAp.text()) === activity, 'ActivityPub JSON comes back byte for byte');

  const del = await f(`${POD}scratch/test`, { method: 'DELETE' });
  check(del.status === 205 || del.status === 204, `DELETE the Turtle document (${del.status})`);
  check((await f(`${POD}scratch/test`)).status === 404, 'and it is gone');
  const delC = await f(`${POD}scratch/`, { method: 'DELETE' });
  check(delC.status === 205 || delC.status === 204, `DELETE the emptied container (${delC.status})`);
  check((await f(`${POD}scratch/`)).status === 404, 'and it is gone too');
  const again = await f(`${POD}scratch/test`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: turtle });
  check(again.status === 201, `PUT it again, container and all (${again.status})`);

  // ---- the daemon restarts under a running server: the session reconnects
  console.log('--- restart the daemon under the running server');
  execFileSync(path.join(SPIKE, 'ngd.sh'), ['stop'], { stdio: 'inherit' });
  execFileSync(path.join(SPIKE, 'ngd.sh'), ['start'], { stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 4000));
  const during = await timed('GET after the daemon restart', () => f(`${POD}scratch/test`, { headers: { accept: 'text/turtle' } }));
  check(during.status === 200, `a read still answers (${during.status})`);
  const putAfter = await timed('PUT after the daemon restart', () => f(`${POD}scratch/after`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<> a <http://example.org/After> .' }));
  check(putAfter.status === 201, `a write goes through (${putAfter.status})`);
} finally {
  await app.stop();
}

console.log('--- restart the daemon, then the server in a fresh process');
execFileSync(path.join(SPIKE, 'ngd.sh'), ['stop'], { stdio: 'inherit' });
execFileSync(path.join(SPIKE, 'ngd.sh'), ['start'], { stdio: 'inherit' });
let phase2 = 0;
try {
  execFileSync('node', [process.argv[1], 'phase2', tmp], { stdio: 'inherit', timeout: 300000 });
} catch (error) {
  phase2 = error.status ?? 1;
}
console.log(fails || phase2 ? `\n${fails} FAILED in phase 1${phase2 ? ', and phase 2 failed' : ''}` : '\nall passed');
process.exit(fails || phase2 ? 1 : 0);
