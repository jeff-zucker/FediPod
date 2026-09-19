// console.test.mjs — the forum's window on this machine: what it shows, and
// who it shows it to.
//   node --test packages/fedipod-bb/test/*.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startConsole } from '../src/console.mjs';
import { forumUrls } from '../src/urls.mjs';
import * as topics from '../src/topics.mjs';
import { PodStore } from '../../../lib/core/store.mjs';

const POD = 'https://forum.example/';
const MEI = 'https://fedipod.net/u/mei/ap/actor';

function memStore() {
  const st = new PodStore({ log: () => {} });
  st.attach({ base: 'mem://', list: async () => ({ names: [], etag: null }), read: async () => ({ ok: false }),
    remove: async () => true, write: async () => ({ ok: true }) });
  return st;
}

// A forum as the console reads it: its config, its categories and their
// stores. Nothing here talks to a pod.
function fakeAgent({ viewer = false, waiting = [] } = {}) {
  const site = forumUrls(POD, 'fedipod-bb/');
  const store = memStore();
  topics.open(store, { title: 'Tomato blight', post: { id: POD + 'p1', author: MEI, published: '2026-09-15T10:00:00Z' } });
  store.write('modqueue.json', waiting);
  store.setContacts({ followers: [{ actor: MEI }], following: [] });
  return {
    viewer,
    site,
    config: { name: 'Federated Solid Forum', handle: 'forum', remotePod: POD,
      categories: [{ slug: 'software', name: 'Software' }], moderators: [ 'https://fedipod.net/u/jeff/ap/actor' ],
      moderatorWebIds: [ 'https://jeff.pod.example/profile/card#me' ], membersOnly: [] },
    categories: [ { slug: 'software', store, urls: site.category('software') } ],
  };
}

const read = async (url) => {
  const res = await fetch(url, { dispatcher: undefined });
  return { status: res.status, body: await res.text() };
};

test('the console shows what the forum is holding, to whoever has the key', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-console-'));
  const agent = fakeAgent({ waiting: [ { id: 'q1', type: 'Create', moderator: MEI, at: '2026-09-19T10:00:00Z',
    failed: 'the forum\'s own record could not be written' } ] });
  const port = 8131 + (process.pid % 200);
  const con = startConsole({ agent, home, port, log: () => {}, lines: () => [ 'hosting forum: @software' ] });
  // A self-signed certificate is what a loopback listener has; this is the
  // test's own client and it trusts this one run's.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const ok = await read(con.url);
    assert.equal(ok.status, 200);
    assert.match(ok.body, /Federated Solid Forum/u, 'it names the forum');
    assert.match(ok.body, /Hosting this forum/u, 'and says it is hosting');
    assert.match(ok.body, /Software/u, 'the categories are there');
    assert.match(ok.body, /@jeff@fedipod\.net/u, 'the moderators read as handles, not as addresses');
    assert.match(ok.body, /did not take/u, 'an ask that failed says so');
    assert.match(ok.body, /hosting forum: @software/u, 'and the log is on the page');

    const nokey = await read(con.url.split('?')[0]);
    assert.equal(nokey.status, 403, 'without the key it shows nothing');
    const wrong = await read(con.url.split('?')[0] + '?k=guess');
    assert.equal(wrong.status, 403, 'nor with the wrong one');
    const missing = await read(con.url.replace('/?', '/nope?'));
    assert.equal(missing.status, 404);
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    con.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a watching forum says so rather than claiming to host', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-console-'));
  const con = startConsole({ agent: fakeAgent({ viewer: true }), home, port: 8331 + (process.pid % 200), log: () => {} });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const { body } = await read(con.url);
    assert.match(body, /Watching/u);
    assert.doesNotMatch(body, /Hosting this forum/u);
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    con.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
