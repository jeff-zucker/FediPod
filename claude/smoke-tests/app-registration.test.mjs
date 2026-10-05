// app-registration.test.mjs — anyone may register a client, so a registration
// is small, registrations come at a bounded rate, and a flood of them pushes
// out only clients nobody has signed in with.
import test from 'node:test';
import assert from 'node:assert/strict';
const { redirectsProblem, registrationLimited, registerApp, touchApp } = await import('../../lib/client/masto/oauth.mjs');

const fakeApi = (apps = []) => {
  const docs = { 'oauth-apps.json': apps };
  const api = { store: { read: (n, f) => structuredClone(docs[n] ?? f), write: (n, v) => { docs[n] = structuredClone(v); } } };
  api.apps = () => api.store.read('oauth-apps.json', []);
  return { api, docs };
};

test('a registration names at most ten return addresses, each of ordinary length, all of them text', () => {
  assert.equal(redirectsProblem('https://app.example/cb urn:ietf:wg:oauth:2.0:oob'), null);
  assert.equal(redirectsProblem(['https://app.example/cb']), null);
  assert.equal(redirectsProblem(undefined), null);
  assert.match(redirectsProblem(Array.from({ length: 11 }, (_, i) => `https://app.example/${i}`)), /at most 10/u);
  assert.match(redirectsProblem(`https://app.example/${'x'.repeat(2100)}`), /2048 characters/u);
  assert.match(redirectsProblem([{ evil: true }]), /must be text/u);
});

test('ten registrations a minute are taken, the eleventh is not', () => {
  const api = {};
  for (let i = 0; i < 10; i++) assert.equal(registrationLimited(api), false, `registration ${i + 1}`);
  assert.equal(registrationLimited(api), true);
});

test('a full list pushes out a client nobody has used, never one the owner signed in with', () => {
  const now = Date.now();
  const app = (id, extra) => ({ clientId: id, clientSecret: 's', name: id, website: '', redirectUris: [], scopes: 'read', createdAt: now - 1e6, ...extra });
  const list = [
    app('legacy'),                                        // registered before usedAt existed
    app('used', { usedAt: now - 10 }),
    ...Array.from({ length: 198 }, (_, i) => app(`flood${i}`, { usedAt: null, createdAt: now - 1000 + i })),
  ];
  const { api } = fakeApi(list);
  registerApp(api, { name: 'new', redirectUris: ['https://new.example/cb'] });
  const ids = api.apps().map((a) => a.clientId);
  assert.equal(ids.length, 200);
  assert.ok(!ids.includes('flood0'), 'the oldest unused client went');
  assert.ok(ids.includes('legacy') && ids.includes('used'), 'the clients the owner has kept their place');
  assert.equal(api.apps().at(-1).usedAt, null, 'a new client starts unused');
});

test('signing in with a client marks it used', () => {
  const { api } = fakeApi([{ clientId: 'c1', usedAt: null, createdAt: 1 }]);
  touchApp(api, 'c1');
  assert.ok(api.apps()[0].usedAt > 0);
});
