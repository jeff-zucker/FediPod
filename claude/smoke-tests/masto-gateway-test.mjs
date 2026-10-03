// masto-gateway-test.mjs — Mastodon apps signing in at the gateway
// (lib/gateway/masto-gateway.mjs): registration, the sign-in page's two
// questions, the proved sign-in, the token, and an app reading an account from
// its copy. The pod sign-in is stubbed; the live run is
// claude/validation/browser-agent/copy-browser-run.mjs.
// Run from the project root: node claude/smoke-tests/masto-gateway-test.mjs
import crypto from 'node:crypto';
import { routeMastoGateway } from '../../lib/gateway/masto-gateway.mjs';
import { memoryKv } from '../../lib/gateway/copy.mjs';
import { ensureCopy, routeStateApi } from '../../lib/gateway/state-api.mjs';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const ORIGIN = 'https://gw.example';
const WEBID = 'https://mei.pod.example/profile/card#me';
const copyKv = memoryKv();
let podAsks = 0;
const mastoKv = memoryKv();
const rows = {
  mei: { handle: 'mei', webId: WEBID, podHome: 'https://mei.pod.example/fedipod/', openedAt: new Date().toISOString(), keeper: { webId: 'https://keeper.example/#me' } },
  kit: { handle: 'kit', webId: 'https://kit.pod.example/profile/card#me', podHome: 'https://kit.pod.example/fedipod/', openedAt: new Date().toISOString() },
  // Signed up a moment ago: FediPod has not finished its first start.
  new1: { handle: 'new1', webId: 'https://new1.pod.example/profile/card#me', podHome: 'https://new1.pod.example/fedipod/', attachedAt: new Date().toISOString() },
  // Set up long ago and never opened in a browser; and a forum, run by a server.
  old1: { handle: 'old1', webId: 'https://old1.pod.example/profile/card#me', podHome: 'https://old1.pod.example/fedipod/' },
  old2: { handle: 'old2', webId: 'https://old2.pod.example/profile/card#me', podHome: 'https://old2.pod.example/fedipod/', attachedAt: '2026-01-01T00:00:00.000Z' },
  hall: { handle: 'hall', kind: 'application', webId: 'https://hall.pod.example/profile/card#me', podHome: 'https://hall.pod.example/forum/', inboxUrl: 'https://hall.pod.example/forum/ap/inbox/' },
  // Kept, with no copy yet: Bo's pod is where the gateway's own sign-in is refused.
  bo: { handle: 'bo', webId: 'https://bo.pod.example/profile/card#me', podHome: 'https://bo.pod.example/fedipod/', openedAt: new Date().toISOString(), keeper: { webId: 'https://keeper.example/#me' } },
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
  putDirectory: async (h, r) => { rows[h] = r; },
  keeperWebId: 'https://keeper.example/#me',
  keeperMark: 'first-credential',
  keeperCredential: { webId: 'https://keeper.example/#me', clientId: 'x', secret: 'y', tokenEndpoint: 'https://keeper.example/token', issuerOrigin: 'https://keeper.example' },
  // Only Ana's and Bo's pods are reached: Ana's refuses the gateway, and at
  // Bo's the gateway's own sign-in is refused.
  keeperFetch: async () => async (u) => {
    podAsks++;
    if (String(u).startsWith('https://bo.pod.example/')) throw new Error('token request failed (HTTP 401): {"error":"invalid_client"}');
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
  check(info.json?.name === 'Elk' && info.json.sendsTo === 'elk.zone', 'the page is told the app\'s name and where you will be sent back to');
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
  const fresh = await call('GET', '/api/authorize?address=new1');
  check(fresh.status === 409 && /set up moments ago/.test(fresh.json.error) && /under a minute/.test(fresh.json.error) && !/no account/.test(fresh.json.error),
    'an account signed up a moment ago is told it is being got ready and how long that takes, not that there is no account');
  const byNewWebId = await call('GET', `/api/authorize?address=${encodeURIComponent(rows.new1.webId)}`);
  check(byNewWebId.status === 409 && /set up moments ago/.test(byNewWebId.json.error), 'and so is its WebID');
  check(/last few minutes/.test(notKept.json.error) && /Keep my account running while I'm away/.test(notKept.json.error),
    'an opened account not kept running is told both: wait if it is new, else turn keeping on');
  check((await call('GET', '/api/authorize?address=nobody')).status === 404, 'an address with no account here is still told there is none');
  const old1 = await call('GET', '/api/authorize?address=old1');
  const old2 = await call('GET', '/api/authorize?address=old2');
  check(old1.status === 409 && /open it in FediPod first/.test(old1.json.error) && !/moments ago/.test(old1.json.error)
    && /open it in FediPod first/.test(old2.json.error),
    'an account never opened in a browser, and not new, is told to open it in FediPod first, not that it was just set up');
  const hall = await call('GET', '/api/authorize?address=hall');
  check(hall.status === 409 && /run by a server/.test(hall.json.error), 'a forum is told apps cannot sign in to it here');

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
  check(Date.now() - Date.parse(rows.mei.openedAt) < 5_000, 'signing an app in counts as the owner being here');
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

  // ---- using an app counts as being here, at most once an hour ----
  const longAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  rows.mei.openedAt = longAgo;
  await call('GET', '/api/v1/timelines/home', { headers: bearer });
  const stamped = rows.mei.openedAt;
  check(stamped !== longAgo && Date.now() - Date.parse(stamped) < 5_000,
    'an app used two hours after the owner was last here counts as being here, so the account is not paused or closed');
  await call('GET', '/api/v1/timelines/home', { headers: bearer });
  check(rows.mei.openedAt === stamped, 'and is not written again within the hour');

  // ---- an app left open, checking again and again ----
  const reads = [];
  const realGet = copyKv.get;
  copyKv.get = async (k) => { reads.push(k); return realGet(k); };
  const poll = '/api/v1/timelines/home?since_id=0';
  const firstPoll = await call('GET', poll, { headers: bearer });
  reads.length = 0;
  const repeated = await call('GET', poll, { headers: bearer });
  check(repeated.status === 200 && repeated.body === firstPoll.body && reads.length === 0,
    `the same check with nothing changed gets the same answer without the copy being opened (${reads.length} read(s))`);
  await put('statuses.json', [{ noteId: 'https://mei.pod.example/fedipod/ap/notes/n2', kind: 'post', actor: `${ORIGIN}/u/mei/ap/actor`,
    content: '<p>arrived since</p>', published: new Date().toISOString(), visibility: 'public' }]);
  const afterPost = await call('GET', poll, { headers: bearer });
  check(afterPost.json?.some((s) => /arrived since/.test(s.content)), 'a post that arrived since is in the next answer');
  ctx.listHeld = async () => ['held-1'];
  reads.length = 0;
  await call('GET', poll, { headers: bearer });
  check(reads.includes('mei/meta'), 'with mail waiting, the check is answered in full, so the mail is read in after it');
  delete ctx.listHeld;
  const other = crypto.randomBytes(32).toString('base64url');
  await mastoKv.set(`token/${crypto.createHash('sha256').update(other).digest('base64url')}`,
    JSON.stringify({ handle: 'mei', webId: WEBID, scope: 'read', clientId: app.client_id, at: Date.now() }));
  reads.length = 0;
  await call('GET', poll, { headers: { authorization: `Bearer ${other}` } });
  check(reads.includes('mei/meta'), 'another app\'s token is never given this app\'s remembered answer');
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60_000;
  reads.length = 0;
  await call('GET', poll, { headers: bearer });
  Date.now = realNow;
  check(reads.includes('mei/meta'), 'after ten minutes the answer is made again, for what changes with the clock');
  copyKv.get = realGet;
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
  // ---- the gateway's own sign-in refused: no account is tried for a while ----
  const boFirst = await ensureCopy(ctx, 'bo', rows.bo, () => {}, { owner: true });
  check(boFirst.status === 502 && /token request failed \(HTTP 401\)/.test(boFirst.why), 'a refused sign-in by the gateway itself is named');
  const asked = podAsks;
  const anaHeld = await ensureCopy(ctx, 'ana', rows.ana, () => {}, { owner: true });
  check(anaHeld.status === 503 && /token request failed/.test(anaHeld.why) && podAsks === asked,
    'then no account is tried, the owner\'s included, and no pod is asked');
  ctx.keeperMark = 'second-credential';           // the operator put a new credential in
  const anaTried = await ensureCopy(ctx, 'ana', rows.ana, () => {}, { owner: true });
  check(podAsks > asked && /HTTP 403/.test(anaTried.why), 'a new credential is tried at once');

  // ---- FediPod asking for the copy the moment it has turned keeping on ----
  ctx.stateSecret = Buffer.from('state-secret-for-the-test');
  const open = () => routeStateApi(new Request(`${ORIGIN}/api/state/open`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'DPoP good', dpop: 'x' },
    body: JSON.stringify({ handle: 'mei' }) }), '/api/state/open', ctx, deps);
  const lookup = ctx.lookup;
  ctx.lookup = async (h) => (h === 'mei' ? { ...rows.mei, keeper: undefined } : rows[h] || null);   // a row read before keeping was on
  check((await open()).status === 409, 'a row read too early says the account is not kept');
  ctx.lookupFresh = async (h) => rows[h] || null;
  check((await open()).status === 200, 'read fresh, the account just turned on is kept, and FediPod gets its copy');
  ctx.lookup = lookup; delete ctx.lookupFresh;

  const pre = await call('OPTIONS', '/api/v1/statuses');
  check(pre.status === 204 && pre.headers['access-control-allow-origin'] === '*', 'an app in a browser may ask from its own page');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
