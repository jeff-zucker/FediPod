// token-fetches.test.mjs — checking a Solid token fetches the WebID and the
// identity provider it names, and a stranger names them. A route that knows
// whose token it wants refuses anyone else's before checking; signing up,
// where anyone may arrive, refuses addresses on a private network. The
// verifier here counts its calls: a refused token never reaches it.
delete process.env.AP_ALLOW_PRIVATE_TARGETS;
import test from 'node:test';
import assert from 'node:assert/strict';
const { verifyPodToken } = await import('../../lib/gateway/token-claims.mjs');
const { routeFront } = await import('../../lib/gateway/front-core.mjs');

const OWNER = 'https://kofi.pod.example/profile/card#me';
const ADMIN = 'https://admin.pod.example/profile/card#me';
const jwt = (claims) => [{ alg: 'ES256' }, claims].map((x) => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.') + '.sig';
const asking = (webid, iss = 'https://idp.example/') => ({ authorization: `DPoP ${jwt({ webid, iss })}`, dpop: 'proof' });
const counting = () => { const v = async () => { v.calls++; return { webid: OWNER }; }; v.calls = 0; return v; };
const post = (path, headers, body = {}) => new Request(`https://fedipod.example${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('a token naming somebody else is refused unchecked; the owner\'s is checked', async () => {
  const v = counting();
  assert.equal(await verifyPodToken(post('/x', asking('https://stranger.example/me')), '/x', v, { only: (w) => w === OWNER }), null);
  assert.equal(v.calls, 0);
  assert.equal(await verifyPodToken(post('/x', asking(OWNER)), '/x', v, { only: (w) => w === OWNER }), OWNER);
  assert.equal(v.calls, 1);
});

test('where anyone may arrive, a token naming a private address is refused unchecked', async () => {
  const v = counting();
  for (const webid of ['http://127.0.0.1:9001/me', 'https://10.0.0.5/profile/card#me', 'https://169.254.169.254/latest']) {
    assert.equal(await verifyPodToken(post('/x', asking(webid)), '/x', v, { publicOnly: true }), null, webid);
  }
  assert.equal(await verifyPodToken(post('/x', asking('https://93.184.216.34/me', 'http://192.168.0.1/')), '/x', v, { publicOnly: true }), null,
    'nor an identity provider on one');
  assert.equal(v.calls, 0);
});

const ctxFor = (v) => ({
  host: 'fedipod.example', frontOrigin: 'https://fedipod.example', verifier: v, adminWebId: ADMIN,
  listDirectory: async () => ({ kofi: { webId: OWNER, podHome: 'https://kofi.pod.example/fedipod/' } }),
  lookup: async (h) => (h === 'kofi' ? { handle: 'kofi', webId: OWNER, podHome: 'https://kofi.pod.example/fedipod/', actorUrl: 'https://kofi.pod.example/fedipod/ap/actor' } : null),
  putDirectory: async () => {}, removeDirectory: async () => true,
});

test('the admin routes, the pause and the move check no token but the admin\'s or the owner\'s', async () => {
  const v = counting();
  const ctx = ctxFor(v);
  const stranger = asking('https://stranger.example/me');
  for (const [path, body] of [['/api/roster', {}], ['/api/revoke', { handle: 'kofi' }], ['/api/pause', { handle: 'kofi', paused: true }],
    ['/api/move', { handle: 'kofi', movedTo: 'https://new.example/ap/actor' }], ['/api/relay', { handle: 'kofi', requests: [{}] }]]) {
    const out = await routeFront(post(path, stranger, body), ctx);
    assert.equal(out.status, 401, `${path} → ${out.status}`);
  }
  assert.equal(v.calls, 0, 'the verifier was never asked');
});

test('signing up on a public front fetches no private address, for the pod or for the token', async () => {
  const v = counting();
  const ctx = ctxFor(v);
  const privatePod = await routeFront(post('/api/attach', asking(OWNER), { handle: 'nia', podHome: 'https://10.0.0.5/' }), ctx);
  assert.equal(privatePod.status, 400);
  const privateIdp = await routeFront(post('/api/attach', asking('https://10.0.0.5/profile/card#me'), { handle: 'nia', podHome: 'https://93.184.216.34/' }), ctx);
  assert.equal(privateIdp.status, 401);
  assert.equal(v.calls, 0);
});
