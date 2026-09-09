// admin-facade-smoke.mjs — exercise the browser's owner/manage endpoint layer
// (web/app/admin-facade.mjs) against a mock agent, in Node. It proves the
// dispatch and the core personal flows — status, config read, profile edit
// (with republish), gateway read, and the person-only guards — without needing
// the service worker, a pod, or a browser.
//
//   node claude/smoke-tests/admin-facade-smoke.mjs
import assert from 'node:assert';
import { AdminFacade } from '../../web/app/admin-facade.mjs';

let published = 0;
function mockAgent() {
  const files = new Map([['config.json', {
    handle: 'fp1', remotePod: 'https://fp1.solidcommunity.net/', issuer: 'https://solidcommunity.net',
    root: 'fedipod/', kind: 'person', name: 'FP One', summary: 'hi', fields: [], aliases: [],
  }]]);
  const store = {
    read: (n, f) => (files.has(n) ? files.get(n) : f),
    write: (n, o) => files.set(n, o),
    getConfig: () => files.get('config.json') || null,
    setConfig: (c) => files.set('config.json', c),
    getContacts: () => ({ followers: [{}, {}], following: [{}] }),
    getQueue: () => [],
    getDeadLetters: () => [{ to: 'https://x/inbox', why: 'timeout' }],
    getBlocklist: () => ({ domains: ['spam.example'] }),
    idFor: () => 'abc123',
    flush: async () => {},
  };
  const publisher = {
    config: {}, urls: { base: 'https://fp1.solidcommunity.net/', actor: 'https://fp1.solidcommunity.net/fedipod/ap/actor', inbox: 'https://fp1.solidcommunity.net/fedipod/ap/inbox/', home: 'https://fp1.solidcommunity.net/fedipod/' },
    publishProfile: async () => { published++; return { unreachable: [] }; },
    lockInboxToGateway: async () => {}, publishGatewayPolicy: async () => {},
    rebuildStatuses: async ({ fromNotes }) => ({ ok: true, rebuilt: 3, fromNotes: !!fromNotes }),
    retireActor: async () => ({ inboxes: 2, deletedAt: '2026-09-08T00:00:00Z' }),
  };
  const atproto = {
    _rec: null,
    connected() { return !!this._rec; },
    feedActive() { return !!this._rec && !this._rec.feedPaused; },
    status() {
      return { connected: !!this._rec, service: this._rec?.service || null,
        handle: this._rec?.handle || null, did: this._rec?.did || null, lastError: null, cooldownFor: 0,
        storage: this._rec?.storage || null, feedPaused: !!this._rec?.feedPaused };
    },
    async connect({ service, identifier }) {
      this._rec = { did: 'did:plc:xyz', handle: identifier, service: service || 'https://bsky.social', storage: 'browser' };
      return { did: this._rec.did, handle: this._rec.handle, service: this._rec.service };
    },
    setFeedPaused(on) { if (this._rec) this._rec.feedPaused = !!on; },
    setStorage(w) { if (this._rec) this._rec.storage = w; },
    async disconnect() { this._rec = null; },
  };
  const fediaccts = {
    _rows: [],
    connected() { return this._rows.some(r => r.enabled !== false); },
    status() { return this._rows.map(r => ({ id: r.id, handle: r.handle, host: r.host, enabled: r.enabled !== false, needsReconnect: false, cooldownFor: 0, storage: r.storage || 'browser' })); },
    roster() { return this._rows.map(r => ({ id: r.id, handle: r.handle, host: r.host, enabled: r.enabled !== false, storage: r.storage || 'browser' })); },
    async begin({ host, redirectUri }) { this._redirectUri = redirectUri; return { url: `https://${host}/oauth/authorize?state=xyz`, state: 'xyz', host }; },
    async complete({ state, code }) { const row = { id: 'me@mastodon.social', handle: '@me@mastodon.social', host: 'mastodon.social', enabled: true, storage: 'browser' }; this._rows.push(row); return row; },
    async revoke(id) { this._revoked = id; },
    remove(id) { const n = this._rows.length; this._rows = this._rows.filter(r => r.id !== id); return this._rows.length < n; },
    setEnabled(id, on) { const r = this._rows.find(x => x.id === id); if (!r) return null; r.enabled = on; return { id: r.id, handle: r.handle, host: r.host, enabled: on, storage: r.storage || 'browser' }; },
    setStorage(id, w) { const r = this._rows.find(x => x.id === id); if (!r) return null; r.storage = w; return { id: r.id, handle: r.handle, host: r.host, enabled: r.enabled !== false, storage: w }; },
  };
  return {
    store, publisher, atproto, fediaccts, _bsky: false, _moved: null, _accts: false,
    startAccts() { this._accts = true; }, stopAccts() { this._accts = false; }, restartAccts() { this._accts = fediaccts.connected(); }, restartBsky() {},
    webId: 'https://fp1.solidcommunity.net/profile/card#me',
    urls: publisher.urls,
    intake: { prune: async ({ before }) => ({ before, considered: 3, applied: 1, dropped: 2, discarded: 0, failed: 0 }) },
    deliverer: {},
    remote: {
      setAcl: async () => {},
      // The DPoP session the attach proves the pod with; here it just says 201.
      session: { fetch: async () => ({ status: 201, json: async () => ({ doorInbox: 'https://fedipod.net/u/fp1/ap/inbox/', hmacSecret: 'DOOR' }) }) },
    },
    configured: () => true, viewer: false,
    requestTakeover: async () => true,
    startBsky() { this._bsky = true; }, stopBsky() { this._bsky = false; },
    async moveTo(target) { this._moved = target; return { moved: true, target, unfollowed: 1, following: 1, quiescedAt: 'now' }; },
    status() {
      const cfg = store.getConfig();
      return { configured: true, mode: 'active', kind: cfg.kind, handle: cfg.handle,
        actor: this.urls.actor, followers: 2, following: 1, queue: 0, deadLetters: 1,
        blockedDomains: 1, push: 'n/a', inbox: null, lastDrain: null, tagfeed: null,
        atproto: null, podRequests: null, update: null, inboxCooldownFor: 0 };
    },
    async rotateKey() { return { changed: true }; },
  };
}

function makeRes() {
  const r = { status: 0, body: '', headers: {},
    writeHead(s, h) { r.status = s; Object.assign(r.headers, h || {}); return r; },
    setHeader(k, v) { r.headers[k] = v; }, write(c) { r.body += c; }, end(c) { if (c) r.body += c; } };
  return r;
}
async function call(facade, method, p, body) {
  const res = makeRes();
  const u = new URL('https://fp.example' + p);
  const handled = await facade.handle({ method }, res, u.pathname, u, body ? JSON.stringify(body) : '');
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* html/text response */ }
  return { handled, status: res.status, headers: res.headers, body: res.body, json };
}

let pass = 0; const ok = (name) => { console.log(`PASS  ${name}`); pass++; };

const agent = mockAgent();
// The real worker, over the mock store — the browser agent builds one the same
// way (web/app/agent.mjs). Nothing is started: stage() arms a timer only when
// the agent goes active, and this suite never does.
const { ImportWorker } = await import('../../lib/import.mjs');
agent.importer = new ImportWorker({ agent, log: () => {} });
const facade = new AdminFacade({ agent, log: () => {} });

// GET /status
let r = await call(facade, 'GET', '/status');
assert.equal(r.status, 200); assert.equal(r.json.handle, 'fp1'); assert.equal(r.json.kind, 'person');
ok('GET /status returns the identity');

// GET /config — permanent + editable + address
r = await call(facade, 'GET', '/config');
assert.equal(r.status, 200);
assert.equal(r.json.handle, 'fp1');
assert.equal(r.json.address, '@fp1@fp1.solidcommunity.net');
assert.equal(r.json.name, 'FP One');
assert.equal(r.json.webId, 'https://fp1.solidcommunity.net/profile/card#me');
ok('GET /config carries permanent fields, the address, and the profile');

// POST /config — edit the display name → republishes
const before = published;
r = await call(facade, 'POST', '/config', { name: 'FP One Renamed', summary: 'updated' });
assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.published, true);
assert.equal(agent.store.getConfig().name, 'FP One Renamed');
assert.equal(agent.publisher.config.name, 'FP One Renamed');
assert.equal(published, before + 1);
ok('POST /config edits the profile and republishes');

// POST /config — the identity itself cannot be changed
r = await call(facade, 'POST', '/config', { handle: 'someone-else' });
assert.equal(r.status, 400); assert.match(r.json.error, /cannot be changed/);
ok('POST /config refuses to change the permanent identity');

// POST /config — group-only knobs are refused on a person
r = await call(facade, 'POST', '/config', { approveJoins: true });
assert.equal(r.status, 404); assert.match(r.json.error, /not a group/);
ok('POST /config refuses group-only settings on a person');

// GET /gateway — never returns the secret, only whether one is set
agent.store.setConfig({ ...agent.store.getConfig(), gateway: { url: 'https://fedipod.net', webId: 'https://fedipod.net/door#me', mode: 'trust', hmacSecret: 'SECRET' } });
r = await call(facade, 'GET', '/gateway');
assert.equal(r.status, 200); assert.equal(r.json.configured, true); assert.equal(r.json.mode, 'trust');
assert.equal(r.json.hasSecret, true); assert.equal(r.json.hmacSecret, undefined);
ok('GET /gateway reports config without leaking the secret');

// POST /rotate-key → delegates to the agent
r = await call(facade, 'POST', '/rotate-key');
assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.changed, true);
ok('POST /rotate-key rotates via the agent');

// GET /deadletter + /blocks — read-only health
r = await call(facade, 'GET', '/deadletter');
assert.equal(r.status, 200); assert.equal(r.json.items.length, 1);
r = await call(facade, 'GET', '/blocks');
assert.equal(r.status, 200); assert.equal(r.json.domains[0], 'spam.example');
ok('GET /deadletter and /blocks read health state');

// atproto: connect stores the account (owner-only) and starts the mirror
r = await call(facade, 'POST', '/atproto/connect', { identifier: 'me.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' });
assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.connected, true);
assert.equal(agent.store.getConfig().atproto.crossPost, true);
assert.equal(agent._bsky, true);
ok('POST /atproto/connect connects Bluesky and starts the mirror');

// connect refuses without the app password
r = await call(facade, 'POST', '/atproto/connect', { identifier: 'me.bsky.social' });
assert.equal(r.status, 400);
ok('POST /atproto/connect requires the app password');

// GET /config now reports the connected account
r = await call(facade, 'GET', '/config');
assert.equal(r.json.atproto.connected, true); assert.equal(r.json.atproto.handle, 'me.bsky.social');
ok('GET /config reports the connected Bluesky account');

// pause the Bluesky mirror without disconnecting
r = await call(facade, 'POST', '/atproto', { feedPaused: true });
assert.equal(r.status, 200); assert.equal(r.json.feedPaused, true);
assert.equal(agent.atproto.feedActive(), false); assert.equal(agent.atproto.connected(), true);
ok('POST /atproto pauses the feed without disconnecting');

// move the Bluesky credential to the pod
r = await call(facade, 'POST', '/atproto', { storage: 'pod' });
assert.equal(r.status, 200); assert.equal(r.json.storage, 'pod');
ok('POST /atproto moves the Bluesky credential between browser and pod');

// disconnect tears it down and stops the mirror
r = await call(facade, 'POST', '/atproto/disconnect');
assert.equal(r.status, 200); assert.equal(agent.store.getConfig().atproto, undefined);
assert.equal(agent._bsky, false);
ok('POST /atproto/disconnect disconnects and stops the mirror');

// rebuild — recover posts from the pod
r = await call(facade, 'POST', '/rebuild', { fromNotes: true });
assert.equal(r.status, 200); assert.equal(r.json.rebuilt, 3);
ok('POST /rebuild recovers posts via the publisher');

// inbox prune — catch up on a backlog
r = await call(facade, 'POST', '/inbox/prune', {});
assert.equal(r.status, 400); assert.match(r.json.error, /before/);
r = await call(facade, 'POST', '/inbox/prune', { before: '2026-08-01T00:00:00Z' });
assert.equal(r.status, 200); assert.equal(r.json.considered, 3); assert.equal(r.json.dropped, 2);
ok('POST /inbox/prune discards old inbox posts via intake');

// retire — typed-handle interlock, then the Delete + Tombstone
r = await call(facade, 'POST', '/retire', {});
assert.equal(r.status, 400); assert.match(r.json.error, /type the handle/);
r = await call(facade, 'POST', '/retire', { confirm: 'fp1' });
assert.equal(r.status, 200); assert.equal(r.json.inboxes, 2);
ok('POST /retire needs the handle, then delivers the Delete');

// move — interlock, then the federated Move to a resolved target
r = await call(facade, 'POST', '/move', { target: 'https://other.example/actor' });
assert.equal(r.status, 400); assert.match(r.json.error, /type the handle/);
r = await call(facade, 'POST', '/move', { target: 'https://other.example/actor', confirm: 'fp1' });
assert.equal(r.status, 200); assert.equal(agent._moved, 'https://other.example/actor'); assert.equal(r.json.moved, true);
ok('POST /move needs the handle, then moves to the target');

// gateway attach — the browser model is the inbox door, never a front
r = await call(facade, 'POST', '/gateway', { action: 'attach', front: 'https://fedipod.net', handle: 'fp1', fronted: true });
assert.equal(r.status, 400); assert.match(r.json.error, /not the browser model/);
ok('POST /gateway attach refuses a fronted identity in the browser');

// gateway attach (inbox door) — availability check + attach + advertise.
// Start from no gateway, so a fresh attach lands in shadow mode.
agent.store.setConfig({ ...agent.store.getConfig(), gateway: undefined });
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ json: async () => ({ available: true }) });
try {
  r = await call(facade, 'POST', '/gateway', { action: 'attach', front: 'https://fedipod.net', handle: 'fp1' });
} finally { globalThis.fetch = realFetch; }
assert.equal(r.status, 200); assert.equal(agent.store.getConfig().gateway.url, 'https://fedipod.net/u/fp1/ap/inbox/');
assert.equal(agent.store.getConfig().gateway.mode, 'shadow');
ok('POST /gateway attach (inbox door) attaches and advertises');

// gateway forget — detach and re-advertise the pod inbox
r = await call(facade, 'POST', '/gateway', { action: 'forget' });
assert.equal(r.status, 200); assert.equal(r.json.forgotten, true);
assert.equal(agent.store.getConfig().gateway, undefined);
ok('POST /gateway forget detaches');

// CSV import — the same ImportWorker the Node agent runs, staged onto the pod.
r = await call(facade, 'POST', '/import', {});
assert.equal(r.status, 400);
assert.match(r.json.error, /kind must be one of/);
ok('POST /import with no kind says which kinds there are');

r = await call(facade, 'POST', '/import', { kind: 'follow', text: '' });
assert.equal(r.status, 400);
ok('and with no CSV text, that the text is what is missing');

r = await call(facade, 'POST', '/import',
  { kind: 'follow', text: 'Account address,Show boosts\n@alice@mastodon.example,true\nnot-an-address\n' });
assert.equal(r.status, 200);
assert.equal(r.json.kind, 'follow');
assert.equal(r.json.invalid, 1);
ok(`POST /import stages a follow list and counts what it could not read (${r.json.staged ?? r.json.added ?? '?'} staged, 1 invalid)`);

r = await call(facade, 'GET', '/import');
assert.equal(r.status, 200);
assert.equal(typeof r.json.rows, 'number');
assert.equal(typeof r.json.pending, 'number');
ok(`GET /import reports the run's progress (${r.json.rows} row(s), ${r.json.pending} pending)`);

r = await call(facade, 'POST', '/import', { clear: true });
assert.equal(r.status, 200); assert.equal(r.json.cleared, true);
ok('and the run can be cleared');
agent.importer.stop();

// fediacct mirror — connect (redirect out), the HTML callback, list, disconnect
r = await call(facade, 'GET', '/fediacct');
assert.equal(r.status, 200); assert.equal(r.json.accounts.length, 0);
r = await call(facade, 'POST', '/fediacct/connect', { host: 'mastodon.social' });
assert.equal(r.status, 200); assert.match(r.json.authorize, /mastodon\.social\/oauth\/authorize/);
assert.equal(agent.fediaccts._redirectUri, 'https://fp.example/fediacct/callback');
ok('POST /fediacct/connect starts OAuth with the callback redirect');

r = await call(facade, 'GET', '/fediacct/callback?code=abc&state=xyz');
assert.equal(r.status, 200);
assert.match(r.headers['content-type'] || '', /text\/html/);
assert.match(r.body, /connected/);
assert.equal(agent._accts, true);
ok('GET /fediacct/callback completes the connection and returns HTML');

r = await call(facade, 'GET', '/fediacct');
assert.equal(r.json.accounts.length, 1); assert.equal(r.json.accounts[0].host, 'mastodon.social');
r = await call(facade, 'POST', '/fediacct', { id: 'me@mastodon.social', enabled: false });
assert.equal(r.status, 200); assert.equal(r.json.account.enabled, false);
r = await call(facade, 'POST', '/fediacct', { id: 'me@mastodon.social', storage: 'pod' });
assert.equal(r.status, 200); assert.equal(r.json.account.storage, 'pod');
r = await call(facade, 'POST', '/fediacct/disconnect', { id: 'me@mastodon.social' });
assert.equal(r.status, 200); assert.equal(agent.fediaccts._rows.length, 0);
assert.equal(agent.fediaccts._revoked, 'me@mastodon.social');   // revoked server-side, not just locally
ok('fediacct list / pause / storage-move / disconnect (with server-side revoke) work');

// a path the facade does not own falls through (handled=false)
r = await call(facade, 'GET', '/api/v1/timelines/home');
assert.equal(r.handled, false);
ok('a non-admin path is left for the Mastodon facade');

console.log(`\nall green — ${pass} checks`);
