// accessor.test.mjs — the accessor over in-memory pod stores: what a
// Community Solid Server asks of a DataAccessor, answered from a container's
// two documents. Nothing here opens a socket or loads the SDK; the live
// behaviour is proven by css-live.mjs beside this file.
//
//   node --test   (from packages/css-nextgraph, after npm run build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataFactory, Store } from 'n3';
import arrayify from 'arrayify-stream';
const arrayifyStream = arrayify.default ?? arrayify;
import {
  RepresentationMetadata, SubdomainIdentifierStrategy, guardedStreamFrom, INTERNAL_QUADS, NotFoundHttpError, ConflictHttpError,
  DC, LDP, RDF, POSIX,
} from '@solid/community-server';
import { NextGraphDataAccessor } from '../dist/accessor.js';
import { MemoryPods } from './memory-store.mjs';

const { namedNode, literal, quad, blankNode } = DataFactory;
const strategy = new SubdomainIdentifierStrategy('http://pods.test/');
const alice = 'http://alice.pods.test/';
const id = (path) => ({ path });

function make() {
  const pods = new MemoryPods();
  const accessor = new NextGraphDataAccessor({ identifierStrategy: strategy, walletsDir: '/nowhere', ngdPeerId: 'x' }).useStores(pods);
  return { pods, accessor };
}

function containerMeta(path) {
  const m = new RepresentationMetadata(id(path));
  m.add(RDF.terms.type, LDP.terms.Container);
  m.add(RDF.terms.type, LDP.terms.BasicContainer);
  m.add(DC.terms.modified, literal('2026-09-11T00:00:00Z'));
  return m;
}

function quadsMeta(path) {
  const m = new RepresentationMetadata(id(path));
  m.contentType = INTERNAL_QUADS;
  m.add(DC.terms.modified, literal('2026-09-11T00:00:00Z'));
  return m;
}

const profile = [
  quad(namedNode(`${alice}profile/card`), namedNode('http://xmlns.com/foaf/0.1/primaryTopic'), namedNode(`${alice}profile/card#me`)),
  quad(namedNode(`${alice}profile/card#me`), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Alice')),
];

async function podWithProfile() {
  const { pods, accessor } = make();
  await accessor.writeContainer(id(alice), containerMeta(alice));
  await accessor.writeContainer(id(`${alice}profile/`), containerMeta(`${alice}profile/`));
  await accessor.writeDocument(id(`${alice}profile/card`), guardedStreamFrom(profile), quadsMeta(`${alice}profile/card`));
  return { pods, accessor };
}

test('a read on a pod that has no wallet is 404 and makes no wallet', async () => {
  const { pods, accessor } = make();
  await assert.rejects(accessor.getMetadata(id(alice)), NotFoundHttpError);
  assert.deepEqual(pods.opened, [[alice, false]]);
  assert.equal(pods.stores.size, 0);
});

test('writing a root container makes the pod: a wallet, and the root\'s two documents', async () => {
  const { pods, accessor } = make();
  await accessor.writeContainer(id(alice), containerMeta(alice));
  const store = pods.stores.get(alice);
  assert.ok(store, 'a store for the root');
  assert.deepEqual(store.calls, [['createDoc', alice, 'css-nextgraph:data'], ['createDoc', alice, 'css-nextgraph:meta']]);
  const meta = await accessor.getMetadata(id(alice));
  assert.ok(meta.has(RDF.terms.type, LDP.terms.Container));
  assert.equal(meta.contentType, undefined, 'a container has no content type');
});

test('an RDF resource round-trips as quads and lives in its container\'s data document', async () => {
  const { pods, accessor } = await podWithProfile();
  const meta = await accessor.getMetadata(id(`${alice}profile/card`));
  assert.equal(meta.contentType, INTERNAL_QUADS);
  const back = await arrayifyStream(await accessor.getData(id(`${alice}profile/card`)));
  assert.equal(back.length, 2);
  assert.ok(new Store(back).has(profile[1]));
  const store = pods.stores.get(alice);
  const docs = await store.listDocs();
  assert.deepEqual(docs.map((d) => [d.title, d.about]).sort(), [
    [alice, 'css-nextgraph:data'], [alice, 'css-nextgraph:meta'],
    [`${alice}profile/`, 'css-nextgraph:data'], [`${alice}profile/`, 'css-nextgraph:meta'],
  ].sort(), 'two documents per container, none per resource');
});

test('a second resource in the same container shares the document and is read apart', async () => {
  const { accessor } = await podWithProfile();
  const other = [quad(namedNode(`${alice}profile/other`), RDF.terms.type, namedNode('http://example.org/Thing'))];
  await accessor.writeDocument(id(`${alice}profile/other`), guardedStreamFrom(other), quadsMeta(`${alice}profile/other`));
  assert.equal((await arrayifyStream(await accessor.getData(id(`${alice}profile/card`)))).length, 2);
  assert.equal((await arrayifyStream(await accessor.getData(id(`${alice}profile/other`)))).length, 1);
  const children = [];
  for await (const child of accessor.getChildren(id(`${alice}profile/`))) children.push(child.identifier.value);
  assert.deepEqual(children.sort(), [`${alice}profile/card`, `${alice}profile/other`]);
});

test('a PUT replaces: the old triples go, the new ones stay', async () => {
  const { accessor } = await podWithProfile();
  const renamed = [quad(namedNode(`${alice}profile/card#me`), namedNode('http://xmlns.com/foaf/0.1/name'), literal('Alicia'))];
  await accessor.writeDocument(id(`${alice}profile/card`), guardedStreamFrom(renamed), quadsMeta(`${alice}profile/card`));
  const back = await arrayifyStream(await accessor.getData(id(`${alice}profile/card`)));
  assert.equal(back.length, 1);
  assert.equal(back[0].object.value, 'Alicia');
});

test('blank nodes go in as fragments of the resource and come out as blank nodes', async () => {
  const { pods, accessor } = await podWithProfile();
  const b = blankNode('k');
  const withBlank = [
    quad(namedNode(`${alice}profile/card#me`), namedNode('http://xmlns.com/foaf/0.1/knows'), b),
    quad(b, namedNode('http://xmlns.com/foaf/0.1/name'), literal('Bob')),
  ];
  await accessor.writeDocument(id(`${alice}profile/card`), guardedStreamFrom(withBlank), quadsMeta(`${alice}profile/card`));
  const stored = await pods.stores.get(alice).construct([...pods.stores.get(alice).docs.keys()][2]);
  assert.ok(stored.every((q) => q.subject.termType === 'NamedNode' && q.subject.value.startsWith(`${alice}profile/card`)), 'every stored subject is the resource\'s own');
  const back = await arrayifyStream(await accessor.getData(id(`${alice}profile/card`)));
  const known = back.find((q) => q.predicate.value.endsWith('knows'));
  assert.equal(known.object.termType, 'BlankNode');
  const named = back.find((q) => q.predicate.value.endsWith('name') && q.object.value === 'Bob');
  assert.equal(named.subject.termType, 'BlankNode');
  assert.equal(named.subject.value, known.object.value, 'the same blank node on both sides');
});

test('triples about another subject are refused with 409', async () => {
  const { accessor } = await podWithProfile();
  const foreign = [quad(namedNode('http://elsewhere.test/x'), RDF.terms.type, namedNode('http://example.org/Thing'))];
  await assert.rejects(
    accessor.writeDocument(id(`${alice}profile/card`), guardedStreamFrom(foreign), quadsMeta(`${alice}profile/card`)),
    ConflictHttpError,
  );
  assert.equal((await arrayifyStream(await accessor.getData(id(`${alice}profile/card`)))).length, 2, 'the old triples are untouched');
});

test('a binary resource is a file on the container\'s document, sized, replaced by a newer entry', async () => {
  const { pods, accessor } = await podWithProfile();
  const bytes = Buffer.from('not really a jpeg');
  const m = new RepresentationMetadata(id(`${alice}profile/avatar.jpg`));
  m.contentType = 'image/jpeg';
  await accessor.writeDocument(id(`${alice}profile/avatar.jpg`), guardedStreamFrom([bytes]), m);
  const meta = await accessor.getMetadata(id(`${alice}profile/avatar.jpg`));
  assert.equal(meta.contentType, 'image/jpeg');
  assert.equal(meta.get(POSIX.terms.size).value, `${bytes.length}`);
  const back = Buffer.concat(await arrayifyStream(await accessor.getData(id(`${alice}profile/avatar.jpg`))));
  assert.ok(back.equals(bytes));
  const m2 = new RepresentationMetadata(id(`${alice}profile/avatar.jpg`));
  m2.contentType = 'image/png';
  await accessor.writeDocument(id(`${alice}profile/avatar.jpg`), guardedStreamFrom([Buffer.from('png')]), m2);
  assert.equal((await accessor.getMetadata(id(`${alice}profile/avatar.jpg`))).contentType, 'image/png');
  assert.equal(Buffer.concat(await arrayifyStream(await accessor.getData(id(`${alice}profile/avatar.jpg`)))).toString(), 'png');
  const store = pods.stores.get(alice);
  const dataDoc = [...store.docs.values()].find((d) => d.title === `${alice}profile/` && d.about === 'css-nextgraph:data');
  assert.equal(dataDoc.files.length, 2, 'the old entry stays; the newest wins');
});

test('delete removes a resource from its container and its triples from the document', async () => {
  const { accessor } = await podWithProfile();
  await accessor.deleteResource(id(`${alice}profile/card`));
  await assert.rejects(accessor.getMetadata(id(`${alice}profile/card`)), NotFoundHttpError);
  const children = [];
  for await (const child of accessor.getChildren(id(`${alice}profile/`))) children.push(child.identifier.value);
  assert.deepEqual(children, []);
  await accessor.deleteResource(id(`${alice}profile/`));
  await assert.rejects(accessor.getMetadata(id(`${alice}profile/`)), NotFoundHttpError);
  // The container comes back and its documents are reused, not made again.
  await accessor.writeContainer(id(`${alice}profile/`), containerMeta(`${alice}profile/`));
  assert.ok(await accessor.getMetadata(id(`${alice}profile/`)));
});

test('writeMetadata replaces only the metadata', async () => {
  const { accessor } = await podWithProfile();
  const m = quadsMeta(`${alice}profile/card`);
  m.add(DC.terms.title, literal('Alice\'s card'));
  m.removeAll(namedNode('http://www.w3.org/ns/ma-ont#format'));
  await accessor.writeMetadata(id(`${alice}profile/card`), m);
  const meta = await accessor.getMetadata(id(`${alice}profile/card`));
  assert.equal(meta.get(DC.terms.title).value, 'Alice\'s card');
  assert.equal((await arrayifyStream(await accessor.getData(id(`${alice}profile/card`)))).length, 2);
});

test('a new accessor over the same pods finds every document by its header', async () => {
  const { pods } = await podWithProfile();
  const again = new NextGraphDataAccessor({ identifierStrategy: strategy, walletsDir: '/nowhere', ngdPeerId: 'x' }).useStores(pods);
  const back = await arrayifyStream(await again.getData(id(`${alice}profile/card`)));
  assert.equal(back.length, 2);
  const children = [];
  for await (const child of again.getChildren(id(alice))) children.push(child.identifier.value);
  assert.deepEqual(children, [`${alice}profile/`]);
  assert.equal(pods.stores.get(alice).calls.filter(([verb]) => verb === 'createDoc').length, 4, 'no document made twice');
});

test('two pods are two stores, and one cannot see the other', async () => {
  const { pods, accessor } = await podWithProfile();
  const bob = 'http://bob.pods.test/';
  await accessor.writeContainer(id(bob), containerMeta(bob));
  assert.equal(pods.stores.size, 2);
  await assert.rejects(accessor.getMetadata(id(`${bob}profile/card`)), NotFoundHttpError);
});

// ---- a locked server: the key has not been supplied yet

test('while the key is missing a pod answers 503 rather than holding the request', async () => {
  const { MasterKey, newKey } = await import('../dist/masterkey.js');
  const master = new MasterKey();
  const pods = new MemoryPods();
  const accessor = new NextGraphDataAccessor({
    identifierStrategy: strategy, walletsDir: '/nowhere', ngdPeerId: 'x', masterKey: master,
  }).useStores(pods);

  // A request that waited instead would hold a connection for as long as
  // nobody unlocks, and enough of them would be a server that cannot serve
  // its own unlock page.
  for (const call of [
    () => accessor.getData(id(`${alice}notes/one`)),
    () => accessor.getMetadata(id(`${alice}notes/one`)),
    () => accessor.writeContainer(id(alice), containerMeta(alice)),
  ]) {
    await assert.rejects(call, (error) => {
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /this server is locked/u);
      return true;
    });
  }

  // Starting a locked server does not open anything and does not throw.
  await accessor.initialize();

  master.supply(newKey());
  await accessor.writeContainer(id(alice), containerMeta(alice));
  assert.ok(await accessor.getMetadata(id(alice)), 'and once the key is here the pod is served');
});
