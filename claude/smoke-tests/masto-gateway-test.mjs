// masto-gateway-test.mjs — Mastodon apps signing in at the gateway
// (lib/gateway/masto-gateway.mjs): registration, the sign-in page's two
// questions, the proved sign-in, the token, and an app reading an account from
// its copy. The pod sign-in is stubbed; the live run is
// claude/validation/browser-agent/copy-browser-run.mjs.
// Run from the project root: node claude/smoke-tests/masto-gateway-test.mjs
import crypto from 'node:crypto';
import { routeMastoGateway } from '../../lib/gateway/masto-gateway.mjs';
import { memoryKv } from '../../lib/gateway/copy.mjs';
import { ensureCopy } from '../../lib/gateway/state-api.mjs';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const ORIGIN = 'https://gw.example';
const WEBID = 'https://mei.pod.example/profile/card#me';
const copyKv = memoryKv();
const mastoKv = memoryKv();
const rows = {
  mei: { handle: 'mei', webId: WEBID, podHome: 'https://mei.pod.example/fedipod/', openedAt: new Date().toISOString(), keeper: { webId: 'https://keeper.example/#me' } },
  kit: { handle: 'kit', webId: 'https://kit.pod.example/profile/card#me', podHome: 'https://kit.pod.example/fedipod/', openedAt: new Date().toISOString() },
  // Kept, with no copy yet, on a pod that refuses the gateway.
  ana: { handle: 'ana', webId: 'https://ana.pod.example/profile/card#me', podHome: 'https://ana.pod.example/fedipod/', openedAt: new Date().toISOString(), keeper: { webId: 'https://keeper.example/#me' } },
};
// Mei's copy, as the gateway would have made it from her pod.
const put = (name, obj) => copyKv.set(`mei/d/${name}`, JSON.stringify(obj, null, 2) + '\n');
await put('config.json', { handle: 'mei', name: 'Mei', root: 'fedipod/', remotePod: 'https://mei.pod.example/', kind: 'person',
  gateway: { url: `${ORIGIN}/u/mei/ap/inbox/`, frontActor: `${ORIGIN}/u/mei/ap/actor` } });
await put('statuses.json', [{ noteId: 'https://mei.pod.example/fedipod/ap/notes/n1', kind: 'post', actor: `${ORIGIN}/u/mei/ap/actor`,
  content: '<p>from the copy</p>', published: new Date().toISOString(), visibility: 'public' }]);
await put('contacts.json', { followers: [], following: [] });
await copyKv.set('mei/meta', JSON.stringify({ filledAt: Date.now(), stateUrl: 'https://mei.pod.example/fedipod/ap-state/', podOnly: ['keys.json'] }));

const ctx = {
  host: 'gw.example', copyKv, mastoKv,
  lookup: async (h) => rows[h] || null,
  listDirectory: async () => rows,
  keeperWebId: 'https://keeper.example/#me',
  keeperCredential: { webId: 'https://keeper.example/#me', clientId: 'x', secret: 'y', tokenEndpoint: 'https://keeper.example/token', issuerOrigin: 'https://keeper.example' },
  // Only Ana's pod is reached, and it refuses the gateway.
  keeperFetch: async () => async (u) => {
    if (!String(u).startsWith('https://ana.pod.example/')) throw new Error('the pod is not reached in this test');
    return new Response('', { status: 403 });
  },
};
const signedAs = { 'DPoP good': WEBID, 'DPoP other': 'https://eve.example/#me', 'DPoP ana': rows.ana.webId };
const deps = { verifyPodToken: async (request) => signedAs[request.headers.get('authorization')] || null };
const call = async (method, p, { body = null, headers = {} } = {}) => {
  const request = new Request(ORIGIN + p, { method, headers: { ...(body && typeof body === 'object' ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const out = await routeMastoGateway(request, new URL(ORIGIN + p).pathname, ctx, deps, { log: () => {} });
  let json = null; try { json = JSON.parse(out.body); } catch { /* not json */ }
  return { ...out, json };
};

try {
  const inst = await call('GET', '/api/v2/instance');
  check(inst.status === 200 && inst.json.domain === 'gw.example' && inst.json.registrations.enabled === false,
    'the instance is the gateway itself, and says accounts are not made through an app');
  check((await call('GET', '/api/v1/timelines/home')).status === 401, 'without a token nothing about an account is answered');
  const keeper = ctx.keeperWebId; ctx.keeperWebId = null;
  const noKeeper = await call('POST', '/api/v1/apps', { body: { client_name: 'x', redirect_uris: 'urn:ietf:wg:oauth:2.0:oob' } });
  check(noKeeper.status === 501 && /cannot sign in/.test(noKeeper.json.error), 'a gateway that cannot keep accounts running says apps cannot sign in there');
  ctx.keeperWebId = keeper;

  // ---- an app registers, as elk.zone does (a form) ----
  const reg = await call('POST', '/api/v1/apps', { body: 'client_name=Elk&redirect_uris=https%3A%2F%2Felk.zone%2Fapi%2Fgw.example%2Foauth&scopes=read+write+follow+push',
    headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const app = reg.json;
  check(reg.status === 200 && app.client_id && app.client_secret && app.redirect_uri === 'https://elk.zone/api/gw.example/oauth',
    'an app registers here once, for every account');
  const auth = await call('GET', `/oauth/authorize?client_id=${app.client_id}&redirect_uri=${encodeURIComponent(app.redirect_uri)}&response_type=code&scope=read+write`);
  check(auth.status === 302 && auth.headers.location.startsWith('/app-signin/?client_id='), 'the app\'s sign-in goes to the sign-in page, with its request');
  const info = await call('GET', `/api/authorize?client_id=${app.client_id}&redirect_uri=${encodeURIComponent(app.redirect_uri)}`);
  check(info.json?.name === 'Elk' && info.json.sendsTo === 'elk.zone', 'the page is told the app\'s name and where it will be sent back to');
  check((await call('GET', `/api/authorize?client_id=${app.client_id}&redirect_uri=https%3A%2F%2Fevil.example%2F`)).status === 400,
    'and refuses an address the app did not register');
  const who = await call('GET', '/api/authorize?address=%40mei%40gw.example');
  check(who.json?.webId === WEBID, 'an address here is the pod it belongs to');
  const byWebId = await call('GET', `/api/authorize?address=${encodeURIComponent(WEBID)}`);
  check(byWebId.json?.webId === WEBID, 'a WebID names the account here that belongs to it');
  check((await call('GET', `/api/authorize?address=${encodeURIComponent('https://nobody.example/#me')}`)).status === 404,
    'a WebID with no account here is told so');
  const notKept = await call('GET', '/api/authorize?address=kit');
  check(notKept.status === 409 && /Keep my account running/.test(notKept.json.error), 'an account the gateway does not keep running is told how to allow apps');

  // ---- the proved sign-in ----
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const ask = { client_id: app.client_id, redirect_uri: app.redirect_uri, scope: 'read write', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', address: 'mei' };
  check((await call('POST', '/api/authorize', { body: ask })).status === 401, 'no pod sign-in, no code');
  check((await call('POST', '/api/authorize', { body: ask, headers: { authorization: 'DPoP other', dpop: 'x' } })).status === 403,
    'a sign-in to somebody else\'s pod is refused');
  const signed = await call('POST', '/api/authorize', { body: ask, headers: { authorization: 'DPoP good', dpop: 'x' } });
  const back = signed.json?.redirect ? new URL(signed.json.redirect) : null;
  check(back?.origin === 'https://elk.zone' && back.searchParams.get('code') && back.searchParams.get('state') === 's1',
    'the owner\'s sign-in sends the app its code');
  const code = back.searchParams.get('code');
  const anaAsk = { ...ask, address: 'ana' };
  const refused = await call('POST', '/api/authorize', { body: anaAsk, headers: { authorization: 'DPoP ana', dpop: 'x' } });
  check(refused.status === 502 && /could not be read \(HTTP 403\)/.test(refused.json?.error) && !/another device/.test(refused.json?.error),
    `a pod that refuses the gateway is named as the reason, not another device (${refused.json?.error})`);
  const appSees = await ensureCopy(ctx, 'ana', rows.ana, () => {});
  check(appSees.status === 503 && /a moment ago: the pod could not be read \(HTTP 403\)/.test(appSees.why),
    'an app checking in just after is told to wait, and why');
  const again = await call('POST', '/api/authorize', { body: anaAsk, headers: { authorization: 'DPoP ana', dpop: 'x' } });
  check(again.status === 502 && !/a moment ago/.test(again.json?.error), 'the owner signing in again is not made to wait');
  check((await call('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code, client_id: app.client_id, redirect_uri: app.redirect_uri, code_verifier: 'wrong' } })).status === 400,
    'a code made with a challenge is not given up for a wrong answer');
  const tok = await call('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code, client_id: app.client_id, redirect_uri: app.redirect_uri, code_verifier: verifier } });
  check(tok.status === 200 && tok.json.access_token && tok.json.scope === 'read write', 'the right answer gets the app its token');
  check((await call('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code, client_id: app.client_id, code_verifier: verifier } })).status === 400,
    'and a code works once');
  check(!(await mastoKv.list('token/')).some((b) => b.key.includes(tok.json.access_token)), 'the token is kept only as its hash');

  // ---- the app reads the account from its copy ----
  const bearer = { authorization: `Bearer ${tok.json.access_token}` };
  const me = await call('GET', '/api/v1/accounts/verify_credentials', { headers: bearer });
  check(me.status === 200 && me.json.username === 'mei' && /gw\.example/.test(me.json.url || me.json.acct || ''), `the app sees whose account it is (${me.json?.acct})`);
  const home = await call('GET', '/api/v1/timelines/home', { headers: bearer });
  check(home.status === 200 && home.json.some((s) => /from the copy/.test(s.content)), 'and reads the timeline from the copy');
  const readOnly = await call('POST', '/oauth/token', { body: { grant_type: 'client_credentials', client_id: app.client_id, client_secret: app.client_secret } });
  check((await call('GET', '/api/v1/timelines/home', { headers: { authorization: `Bearer ${readOnly.json.access_token}` } })).status === 403,
    'an app\'s own token, naming no account, reads no account');
  check((await call('GET', `/api/authorize?client_id=${encodeURIComponent('../../site:state/mei/d/config.json')}&redirect_uri=x`)).status === 404,
    'a client id with a path in it is not looked up');
  check((await call('GET', '/api/v1/timelines/home', { headers: { authorization: 'Bearer never-given', 'sec-fetch-site': 'same-origin' } })).status === 503,
    'FediPod\'s own client asking before its worker answers is told to try again, not signed out');
  const keeperNow = ctx.keeperWebId; ctx.keeperWebId = 'https://keeper-two.example/#me';   // the operator changed the gateway's identity
  const moving = await call('GET', '/api/v1/timelines/home', { headers: bearer });
  check(moving.status === 503 && /open FediPod/.test(moving.json.error), 'an account kept under the former identity tells its apps to open FediPod once');
  ctx.keeperWebId = keeperNow;
  const was = rows.mei.webId; rows.mei.webId = 'https://someone-new.example/profile/card#me';
  check((await call('GET', '/api/v1/timelines/home', { headers: bearer })).status === 401, 'a token is refused once its address belongs to somebody else');
  rows.mei.webId = was;
  await call('POST', '/oauth/revoke', { body: { token: tok.json.access_token } });
  check((await call('GET', '/api/v1/timelines/home', { headers: bearer })).status === 401, 'a revoked token reads nothing');
  const pre = await call('OPTIONS', '/api/v1/statuses');
  check(pre.status === 204 && pre.headers['access-control-allow-origin'] === '*', 'an app in a browser may ask from its own page');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
