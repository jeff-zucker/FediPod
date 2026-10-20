// connected-feeds.test.mjs — the owner's connected Mastodon and Bluesky
// accounts read into their account at the gateway when an app checks in
// (lib/gateway/connected-feeds.mjs): when due, never over a browser holding
// the account, the logins read from the pod and never kept in the copy, and a
// Bluesky session the far end renews written back to the pod. The pod and the
// two far servers are stand-ins; the live run is
// claude/validation/browser-agent/copy-browser-run.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryKv } from '../../lib/gateway/copy.mjs';
import { readConnectedForApp, FEEDS_EVERY_MS, NONE_EVERY_MS } from '../../lib/gateway/connected-feeds.mjs';

const KEEPER = 'https://keeper.example/#me';
const STATE = 'https://mei.pod.example/fedipod/ap-state/';
const rec = { handle: 'mei', webId: 'https://mei.pod.example/profile/card#me', podHome: 'https://mei.pod.example/fedipod/',
  openedAt: new Date().toISOString(), keeper: { webId: KEEPER } };

// The pod's state container, as the gateway's own sign-in reaches it.
function podOf(docs) {
  let n = 0;
  const tags = new Map();
  const session = {
    asked: 0,
    async fetch(u, init = {}) {
      session.asked++;
      const name = String(u).slice(STATE.length);
      if (!String(u).startsWith(STATE) || !name) return new Response('', { status: 404 });
      if ((init.method || 'GET') === 'PUT') {
        const had = docs.has(name);
        docs.set(name, String(init.body)); tags.set(name, `"p${++n}"`);
        return new Response(null, { status: had ? 205 : 201 });
      }
      if (!docs.has(name)) return new Response('', { status: 404 });
      if (!tags.has(name)) tags.set(name, `"p${++n}"`);
      return new Response(docs.get(name), { status: 200, headers: { 'content-type': 'application/json', etag: tags.get(name) } });
    },
  };
  return session;
}

async function copyOf() {
  const kv = memoryKv();
  const put = (name, obj) => kv.set(`mei/d/${name}`, JSON.stringify(obj));
  await put('config.json', { handle: 'mei', name: 'Mei', root: 'fedipod/', remotePod: 'https://mei.pod.example/', kind: 'person' });
  await put('statuses.json', []);
  await put('contacts.json', { followers: [], following: [] });
  await kv.set('mei/meta', JSON.stringify({ filledAt: Date.now(), stateUrl: STATE, podOnly: ['keys.json', 'fediaccts.json', 'atproto.json'] }));
  return kv;
}

const ctxOf = (kv) => ({ copyKv: kv, keeperWebId: KEEPER, keeperCredential: { webId: KEEPER } });
const statuses = async (kv) => JSON.parse((await kv.get('mei/d/statuses.json')).text);

// A Mastodon server with one post on the account's home timeline, and Bluesky,
// whose first answer says the session has run out.
function farServers({ saysRate = true } = {}) {
  const asked = [];
  let expired = true;
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization || '';
    asked.push(`${u.host}${u.pathname}`);
    // Mastodon says on every answer how many requests the token has left.
    const rate = u.host === 'mastodon.example' && saysRate ? { 'x-ratelimit-limit': '300', 'x-ratelimit-remaining': '299' } : {};
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...rate } });
    if (u.host === 'mastodon.example') {
      if (auth !== 'Bearer full-access') return json({ error: 'The access token is invalid' }, 401);
      if (u.pathname === '/api/v1/timelines/home') {
        return json([{ id: '1001', uri: 'https://elsewhere.example/users/pat/statuses/1001', url: 'https://elsewhere.example/@pat/1001',
          content: '<p>from a followed account on Mastodon</p>', created_at: new Date().toISOString(),
          account: { id: '7', username: 'pat', acct: 'pat@elsewhere.example', display_name: 'Pat', uri: 'https://elsewhere.example/users/pat', avatar: '' } }]);
      }
      if (u.pathname === '/api/v1/notifications') return json([]);
    }
    if (u.host === 'bsky.example') {
      if (u.pathname === '/xrpc/com.atproto.server.refreshSession') {
        if (auth !== 'Bearer refresh-1') return json({ error: 'ExpiredToken' }, 400);
        expired = false;
        return json({ accessJwt: 'access-2', refreshJwt: 'refresh-2' });
      }
      if (expired || auth !== 'Bearer access-2') return json({ error: 'ExpiredToken', message: 'Token has expired' }, 400);
      if (u.pathname === '/xrpc/app.bsky.feed.getTimeline') {
        return json({ feed: [{ post: { uri: 'at://did:plc:sam/app.bsky.feed.post/3k', cid: 'c1', indexedAt: new Date().toISOString(),
          author: { did: 'did:plc:sam', handle: 'sam.bsky.social', displayName: 'Sam' },
          record: { text: 'from a followed account on Bluesky', createdAt: new Date().toISOString() } } }] });
      }
      if (u.pathname === '/xrpc/app.bsky.notification.listNotifications') return json({ notifications: [] });
    }
    return new Response('', { status: 404 });
  };
  return { fetcher, asked };
}

const logins = () => new Map([
  ['fediaccts.json', JSON.stringify({ 'me@mastodon.example': { id: 'me@mastodon.example', handle: '@me@mastodon.example', host: 'mastodon.example',
    token: 'full-access', accountId: '1', enabled: true, storage: 'pod' } })],
  ['atproto.json', JSON.stringify({ service: 'https://bsky.example', identifier: 'mei.bsky.social', appPassword: 'app-pw',
    did: 'did:plc:mei', handle: 'mei.bsky.social', accessJwt: 'access-1', refreshJwt: 'refresh-1', storage: 'pod' })],
]);

test('with nothing connected, the pod is looked at again in an hour, not every five minutes', async () => {
  const kv = await copyOf();
  const { fetcher, asked } = farServers();
  const n = await readConnectedForApp(ctxOf(kv), 'mei', rec, { log: () => {}, fetcher, session: podOf(new Map()) });
  assert.equal(n, 0);
  assert.equal(asked.length, 0);
  const due = Number((await kv.get('mei/feeds-due')).text);
  assert.ok(due - Date.now() > NONE_EVERY_MS - 5_000, 'due in about an hour');
});

test('FediPod open in a browser holds the account, and reads them itself', async () => {
  const kv = await copyOf();
  await kv.set('mei/lease', JSON.stringify({ holder: 'browser:tab', expiresAt: Date.now() + 4 * 60_000 }));
  const { fetcher, asked } = farServers();
  const pod = podOf(logins());
  const n = await readConnectedForApp(ctxOf(kv), 'mei', rec, { log: () => {}, fetcher, session: pod });
  assert.equal(n, 0);
  assert.equal(asked.length, 0, 'no far server is asked');
  assert.equal(pod.asked, 0, 'nor the pod');
  assert.ok(!(await kv.get('mei/feeds-due')), 'and they are read as soon as the browser lets the account go');
  assert.deepEqual(await statuses(kv), []);
  assert.equal(JSON.parse((await kv.get('mei/lease')).text).holder, 'browser:tab', 'and the browser keeps the account');
});

test('an app checking in brings both accounts\' timelines into the copy, and the logins stay on the pod', async () => {
  const kv = await copyOf();
  const pod = logins();
  const { fetcher, asked } = farServers();
  const lines = [];
  const n = await readConnectedForApp(ctxOf(kv), 'mei', rec, { log: (m) => lines.push(m), fetcher, session: podOf(pod) });
  assert.equal(n, 2, `two posts read in (${lines.join(' / ')})`);
  const got = await statuses(kv);
  assert.ok(got.some((s) => s.kind === 'acct' && /on Mastodon/.test(s.content)), 'the Mastodon post');
  assert.ok(got.some((s) => s.kind === 'bsky' && /on Bluesky/.test(JSON.stringify(s))), 'the Bluesky post');
  assert.ok(!(await kv.get('mei/d/fediaccts.json')) && !(await kv.get('mei/d/atproto.json')), 'no login is in the copy');
  assert.ok(![...kv.map.values()].some((v) => /full-access|refresh-2|app-pw/.test(v.text)), 'not anywhere at the gateway');
  const bsky = JSON.parse(pod.get('atproto.json'));
  assert.equal(bsky.refreshJwt, 'refresh-2', 'the renewed Bluesky session went back to the pod');
  assert.equal(JSON.parse((await kv.get('mei/lease')).text).expiresAt, 0, 'the account is let go after');
  const marks = JSON.parse((await kv.get('mei/d/fediacctfeed.json')).text);
  assert.equal(marks.accounts['me@mastodon.example'].homeSinceId, '1001', 'the next read starts after this one');

  const before = asked.length;
  assert.equal(await readConnectedForApp(ctxOf(kv), 'mei', rec, { log: () => {}, fetcher, session: podOf(pod) }), 0);
  assert.equal(asked.length, before, 'checking in again at once asks nobody');
  const due = Number((await kv.get('mei/feeds-due')).text);
  assert.ok(due - Date.now() <= FEEDS_EVERY_MS && due - Date.now() > FEEDS_EVERY_MS - 5_000, 'due again in five minutes');
});

test('an account set aside is not read', async () => {
  const kv = await copyOf();
  const cfg = JSON.parse((await kv.get('mei/d/config.json')).text);
  await kv.set('mei/d/config.json', JSON.stringify({ ...cfg, quiescedAt: new Date().toISOString() }));
  const { fetcher, asked } = farServers();
  assert.equal(await readConnectedForApp(ctxOf(kv), 'mei', rec, { log: () => {}, fetcher, session: podOf(logins()) }), 0);
  assert.equal(asked.length, 0);
});

test('a server that does not say how many requests are left is still read', async () => {
  const kv = await copyOf();
  const { fetcher } = farServers({ saysRate: false });
  await readConnectedForApp(ctxOf(kv), 'mei', rec, { log: () => {}, fetcher, session: podOf(logins()) });
  assert.ok((await statuses(kv)).some((s) => s.kind === 'acct' && /on Mastodon/.test(s.content)));
});
