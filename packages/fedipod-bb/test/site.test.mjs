// site.test.mjs — the website's reader over a forum the host wrote, and its
// Mastodon sign-in and posting against a server that answers as one does.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { forumUrls } from '../src/urls.mjs';
import * as fwire from '../src/wire.mjs';
import * as topics from '../src/topics.mjs';
import * as publish from '../src/publish.mjs';
import { PodStore } from '../../../lib/core/store.mjs';
import { reader, forumBase, placeOf, cacheKey, authorLabel } from '../site/read.mjs';
import { MastoLogin, cleanHost, hostOfHandle, serverKind } from '../site/masto.mjs';

const POD = 'https://forum.example/';
const MEI = 'https://mei.pod.example/fedipod/ap/actor';

function fakePod() {
  const docs = new Map();
  return {
    docs,
    putJson: async (u, o) => { docs.set(u, o); return { ok: true }; },
    put: async (u, body) => { docs.set(u, body); return { ok: true }; },
    getJson: async (u) => docs.get(u) ?? null,
    setAcl: async () => {}, delete: async (u) => docs.delete(u),
  };
}
function memStore() {
  const st = new PodStore({ log: () => {} });
  st.attach({ base: 'mem://', list: async () => ({ names: [], etag: null }), read: async () => ({ ok: false }),
    remove: async () => true, write: async () => ({ ok: true }) });
  return st;
}
// A browser's fetch over the pod's documents: public JSON, as written.
const fetchOver = (docs) => async (url) => {
  const doc = docs.get(url);
  return doc ? new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/activity+json' } })
    : new Response('', { status: 404 });
};

test('the website reads a forum the host wrote: categories, topics, posts and their copies', async () => {
  const pod = fakePod();
  const site = forumUrls(POD);
  const g = site.category('gardening');
  const gStore = memStore();
  const siteStore = memStore();
  // What the host publishes.
  pod.docs.set(site.actor, fwire.siteActorDoc({ urls: site, handle: 'forum', name: 'The Forum', publicKeyPem: 'x', summary: 'A forum.' }));
  pod.docs.set(g.actor, { id: g.actor, type: 'Group', preferredUsername: 'gardening', name: 'Gardening', summary: '<p>Soil.</p>' });
  pod.docs.set(g.followers, { id: g.followers, type: 'OrderedCollection', totalItems: 3 });
  await publish.publishCategories({ remote: pod, store: siteStore, urls: site }, [g.actor]);
  await publish.publishHeartbeat({ remote: pod, urls: site }, { at: '2026-09-15T12:00:00Z' });
  assert.ok(pod.docs.has(POD + 'fedipod-bb/ap/heartbeat'), 'the heartbeat sits under the forum\'s face');
  const A1 = 'https://mei.pod.example/fedipod/ap/notes/blight';
  const R1 = 'https://mei.pod.example/fedipod/ap/notes/blight-r1';
  const tid = topics.open(gStore, { title: 'Tomato blight', post: { id: A1, author: MEI, published: '2026-09-15T10:00:00Z', inReplyTo: null } });
  topics.append(gStore, tid, { id: R1, author: MEI, published: '2026-09-15T11:00:00Z', inReplyTo: A1 });
  const ctx = { remote: pod, store: gStore, urls: g };
  await publish.cachePost(ctx, { id: A1, type: 'Article', attributedTo: MEI, name: 'Tomato blight', content: '<p>Three beds gone.</p>', published: '2026-09-15T10:00:00Z' });
  await publish.cachePost(ctx, { id: R1, type: 'Note', attributedTo: MEI, content: '<p>Same here.</p>', published: '2026-09-15T11:00:00Z', inReplyTo: A1 });
  await publish.publishTopic(ctx, tid);
  await publish.publishTopicIndex(ctx);

  // What a browser sees.
  const read = reader({ fetch: fetchOver(pod.docs) });
  const base = forumBase({ pod: POD + 'fedipod-bb/' });
  const forum = await read.forum(base);
  assert.equal(forum.name, 'The Forum');
  assert.equal(forum.lastHosted, '2026-09-15T12:00:00Z');
  assert.equal(forum.categories.length, 1);
  assert.equal(forum.categories[0].name, 'Gardening');
  assert.equal(forum.categories[0].members, 3);
  assert.equal(forum.categories[0].base, g.actor.replace(/ap\/actor$/u, ''));
  const list = await read.topics(forum.categories[0].base);
  assert.equal(list.total, 1);
  assert.equal(list.topics[0].name, 'Tomato blight');
  assert.equal(list.topics[0].count, 2);
  const t = await read.topic(list.topics[0].id);
  assert.deepEqual(t.posts, [A1, R1], 'posts in the order they were said');
  assert.equal(t.category, g.actor);
  const p1 = await read.post(forum.categories[0].base, A1);
  assert.equal(p1.name, 'Tomato blight');
  assert.equal(p1.content, '<p>Three beds gone.</p>');
  assert.equal(p1.author, MEI);
  assert.equal(authorLabel(MEI), '@fedipod@mei.pod.example');
  assert.equal(await cacheKey(A1), g.cached(A1).slice(g.cache.length), 'the site files a copy under the same digest as the host');
  await publish.cacheAuthor(ctx, { id: MEI, type: 'Person', preferredUsername: 'mei', name: 'Mei', icon: { type: 'Image', url: 'https://mei.pod.example/face.png' } });
  const who = await read.author(forum.categories[0].base, MEI);
  assert.equal(who.handle, '@mei@mei.pod.example', 'the author card names the handle the id does not carry');
  assert.equal(who.icon, 'https://mei.pod.example/face.png');
  assert.equal(await read.author(forum.categories[0].base, 'https://nobody.example/u/x'), null);
  await publish.tombstoneCached(ctx, R1, { formerType: 'Note' });
  assert.equal((await read.post(forum.categories[0].base, R1)).gone, true, 'a removed post reads as gone');
  assert.equal(await read.post(forum.categories[0].base, 'https://nowhere.example/x'), null);
  assert.equal(forumBase({ origin: 'https://fedipod.net', handle: 'forum' }), 'https://fedipod.net/u/forum/');
});

test('where the page runs names the forum: ?forum= at the site, the path at bb.<site>, ?pod= anywhere', () => {
  const at = placeOf({ origin: 'https://fedipod.net', pathname: '/bb/', search: '?forum=forum' });
  assert.deepEqual(at, { front: 'https://fedipod.net', handle: 'forum', pod: null, base: 'https://fedipod.net/u/forum/' });
  const own = placeOf({ origin: 'https://bb.fedipod.net', pathname: '/forum/', search: '' });
  assert.deepEqual(own, { front: 'https://fedipod.net', handle: 'forum', pod: null, base: 'https://fedipod.net/u/forum/' }, 'read through the Gateway it is a face of');
  assert.equal(placeOf({ origin: 'https://bb.fedipod.net', pathname: '/', search: '' }).base, null, 'no forum named');
  const pod = placeOf({ origin: 'https://bb.fedipod.net', pathname: '/', search: '?pod=https://fp3.solidcommunity.net/fedipod-bb/' });
  assert.equal(pod.base, 'https://fp3.solidcommunity.net/fedipod-bb/');
  assert.equal(placeOf({ origin: 'http://localhost:4977', pathname: '/', search: '?pod=http://localhost:4977/pod/fedipod-bb' }).base, 'http://localhost:4977/pod/fedipod-bb/');
});

test('replying from a Mastodon account: register, approve, exchange, resolve, post', async () => {
  const calls = [];
  const storage = new Map();
  const ls = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  const answer = (url, init) => {
    calls.push({ url, init });
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/v1/apps')) return j({ client_id: 'cid', client_secret: 'sec' });
    if (url.endsWith('/oauth/token')) return j({ access_token: 'tok', scope: 'read:accounts read:search write:statuses' });
    if (url.endsWith('/api/v1/accounts/verify_credentials')) return j({ username: 'aisha', display_name: 'Aisha', url: 'https://mastodon.example/@aisha' });
    if (url.includes('/api/v2/search')) return j({ statuses: [{ id: '4242', url: 'https://mei.pod.example/fedipod/ap/notes/blight' }] });
    if (url.endsWith('/api/v1/statuses')) return j({ id: '9001', url: 'https://mastodon.example/@aisha/9001', uri: 'https://mastodon.example/users/aisha/statuses/9001' });
    return j({ error: 'no' }, 404);
  };
  const login = new MastoLogin({ fetch: async (u, i) => answer(u, i), storage: ls, redirectUri: 'https://fedipod.net/bb/?forum=forum' });
  assert.equal(cleanHost('https://Mastodon.Example/'), 'mastodon.example');
  assert.equal(cleanHost('not a host'), null);
  assert.equal(hostOfHandle('@aisha@mastodon.example'), 'mastodon.example');
  assert.equal(hostOfHandle('aisha@Lemmy.Example'), 'lemmy.example');
  assert.equal(hostOfHandle('https://mastodon.example/@aisha'), 'mastodon.example');
  assert.equal(hostOfHandle('aisha'), null);
  const kinds = async (paths) => serverKind('x.example', async (u) => new Response(paths.includes(new URL(u).pathname) ? '{}' : '', { status: paths.includes(new URL(u).pathname) ? 200 : 404 }));
  assert.equal(await kinds(['/api/v1/instance']), 'mastodon-api');
  assert.equal(await kinds(['/api/v3/site']), 'lemmy');
  assert.equal(await kinds([]), 'unknown');
  const url = await login.begin('mastodon.example');
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://mastodon.example/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://fedipod.net/bb/?forum=forum');
  assert.ok(u.searchParams.get('state'));
  assert.equal(JSON.parse(calls[0].init.body).scopes, 'read:accounts read:search write:statuses');
  await assert.rejects(login.complete({ state: 'wrong', code: 'c' }), /expired/u, 'a code with the wrong state binds nothing');
  const url2 = await login.begin('mastodon.example');
  const acct = await login.complete({ state: new URL(url2).searchParams.get('state'), code: 'the-code' });
  assert.equal(acct.handle, '@aisha@mastodon.example');
  assert.equal(login.account().token, 'tok');
  const made = await login.post({ text: 'Same here, three beds.', mention: '@gardening@fedipod.net', inReplyToUrl: 'https://mei.pod.example/fedipod/ap/notes/blight' });
  const posted = JSON.parse(calls.find(c => c.url.endsWith('/api/v1/statuses')).init.body);
  assert.equal(posted.status, '@gardening@fedipod.net Same here, three beds.', 'the category is named so it receives the post');
  assert.equal(posted.in_reply_to_id, '4242', 'the parent is the post as that server knows it');
  assert.equal(posted.visibility, 'public');
  assert.equal(made.uri, 'https://mastodon.example/users/aisha/statuses/9001');
  login.signOut();
  assert.equal(login.account(), null);
});
