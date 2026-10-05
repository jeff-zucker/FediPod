// signin-hardening.test.mjs — three ways an account's sign-in was looser than
// it should be: on a host shared with other pods, a return address anywhere
// on the host counted as the account's own; an unknown proof method was read
// as the weakest; a wrong proof used the code up. And the management pages of
// an account on a pod server refuse, rather than open, if their key is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
const { handle, redirectAllowed, peekCode, consumeCode, mintCode, provesCode } = await import('../../lib/client/masto/oauth.mjs');
const { makeGate } = createRequire(import.meta.url)('../../vendor/gate.cjs');

const host = (h) => ({ has: (x) => x === h, isLocalRequest: () => false });

test('on a suffixed pod, only addresses under its own path are its own', () => {
  const aisha = { allowed: host('server.example'), mount: '/aisha' };
  assert.equal(redirectAllowed(aisha, 'https://server.example/aisha/fp/admin/client/'), true);
  assert.equal(redirectAllowed(aisha, 'https://server.example/aisha'), true);
  assert.equal(redirectAllowed(aisha, 'https://server.example/tamara/catch.html'), false, "another pod's page");
  assert.equal(redirectAllowed(aisha, 'https://server.example/aishabad/x'), false, 'a path that only starts the same');
  assert.equal(redirectAllowed(aisha, 'https://server.example/'), false, "the server's own root");
  const mei = { allowed: host('mei.server.example'), mount: '' };
  assert.equal(redirectAllowed(mei, 'https://mei.server.example/anything'), true, 'a subdomained pod owns its whole host');
});

const memoryStore = () => { const d = {}; return { read: (n, f) => structuredClone(d[n] ?? f), write: (n, v) => { d[n] = structuredClone(v); }, getConfig: () => ({}) }; };
const apiWith = () => {
  const store = memoryStore();
  const api = { store, log: () => {}, urls: null, mount: '', allowed: host('kofi.pod.example'), ownerWebId: () => null,
    findApp: (id) => (id === 'app1' ? { clientId: 'app1', clientSecret: 's', name: 'App', redirectUris: ['https://app.example/cb'] } : null),
    resolveClientDocument: async () => null, redirectAllowed: (r) => redirectAllowed(api, r),
    peekCode: (c) => peekCode(api, c), consumeCode: (c) => consumeCode(api, c),
    mintToken: () => 'token-1', tokens: () => [], tokenRecords: () => [] };
  return api;
};
const call = async (api, method, pathname, { query = '', body = null } = {}) => {
  const req = Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } });
  let out = null;
  const send = (status, obj) => { out = { status, obj }; return true; };
  await handle(api, { req, res: { writeHead() {}, end() {} }, pathname, url: new URL(`https://kofi.pod.example${pathname}${query}`), send });
  return out;
};

test('a proof method the account does not know is refused, not read as the weakest', async () => {
  const out = await call(apiWith(), 'GET', '/oauth/authorize',
    { query: '?client_id=app1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&code_challenge=abc&code_challenge_method=S512' });
  assert.equal(out?.status, 400);
  assert.match(out.obj.error, /S256 or plain/u);
});

test('a wrong proof does not use the code up for the app that can prove it', async () => {
  const api = apiWith();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = mintCode(api, { clientId: 'app1', redirectUri: 'https://app.example/cb', scope: 'read', challenge, challengeMethod: 'S256' });
  const wrong = await call(api, 'POST', '/oauth/token', { body: { grant_type: 'authorization_code', client_id: 'app1', code, code_verifier: 'x'.repeat(43) } });
  assert.equal(wrong.status, 400);
  assert.ok(peekCode(api, code), 'the code is still there');
  const right = await call(api, 'POST', '/oauth/token', { body: { grant_type: 'authorization_code', client_id: 'app1', code, code_verifier: verifier } });
  assert.equal(right.status, 200);
  assert.equal(peekCode(api, code), null, 'and used once it is redeemed');
  const again = await call(api, 'POST', '/oauth/token', { body: { grant_type: 'authorization_code', client_id: 'app1', code, code_verifier: verifier } });
  assert.equal(again.status, 400, 'never twice');
  assert.equal(provesCode({ challenge, challengeMethod: 'S256' }, verifier), true);
});

test("an account's management pages refuse, rather than open, when they have no key", () => {
  let written = null;
  const res = { writeHead: (s) => { written = s; }, end: () => {} };
  const closed = makeGate(() => undefined, { failClosed: true });
  assert.equal(closed({ headers: {}, url: '/fp/' }, res), true);
  assert.equal(written, 401);
  assert.equal(closed.upgradeOk({ headers: {} }), false);
  const open = makeGate(() => undefined);
  assert.equal(open({ headers: {}, url: '/' }, res), false, 'a gate not asked to keeps its old way');
});
