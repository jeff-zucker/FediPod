// hold-test.mjs — the hold (lib/gateway/copy.mjs, state-api.mjs): every
// fifteen minutes a person's copy at the gateway is written to their pod and
// deleted, whatever is happening, and made again from the pod the next time it
// is asked for; the browser holding it does not notice. With the hold off
// (the admin's choice), no copy is made and mail is not held. The pod is a
// map standing in for one; the live run is
// claude/validation/browser-agent/copy-browser-run.mjs.
// Run from the project root: node claude/smoke-tests/hold-test.mjs
import crypto from 'node:crypto';
import { memoryKv, copyMeta, holdOver, clearLeftover, holdFrom, holdOn, isPersonal, heldByBrowser } from '../../lib/gateway/copy.mjs';
import { routeStateApi, endHold } from '../../lib/gateway/state-api.mjs';
import { holdsMail, mayBeAway, routeHereApi } from '../../lib/gateway/held-mail.mjs';
import { HttpStorage, FencedStorage } from '../../lib/core/storage.mjs';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

// ---- a pod, as far as the gateway's storage asks of one ----
function memPod() {
  const docs = new Map();            // url -> { text, etag }
  const refuse = new Set();          // urls whose PUT the pod answers 500
  const asked = [];
  let n = 0;
  const fetchImpl = async (u, init = {}) => {
    const url = String(u);
    const method = (init.method || 'GET').toUpperCase();
    asked.push(`${method} ${url}`);
    const header = (k) => init.headers?.[k] ?? init.headers?.get?.(k) ?? null;
    if (method === 'GET' && url.endsWith('/')) {
      const kids = [...docs.keys()].filter((k) => k.startsWith(url) && !k.slice(url.length).includes('/'));
      if (!kids.length) return new Response('', { status: 404 });
      const body = `@prefix ldp: <http://www.w3.org/ns/ldp#>.\n<> ldp:contains ${kids.map((k) => `<${k.slice(url.length)}>`).join(', ')}.\n`;
      const tag = `"l${crypto.createHash('sha256').update(kids.map((k) => k + docs.get(k).etag).join()).digest('hex').slice(0, 12)}"`;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/turtle', etag: tag } });
    }
    if (method === 'GET') {
      const d = docs.get(url);
      return d ? new Response(d.text, { status: 200, headers: { 'content-type': 'application/json', etag: d.etag } }) : new Response('', { status: 404 });
    }
    if (method === 'PUT') {
      if (refuse.has(url)) return new Response('', { status: 500 });
      const ifMatch = header('if-match');
      if (ifMatch && docs.get(url)?.etag !== ifMatch) return new Response('', { status: 412 });
      const etag = `"${++n}"`;
      docs.set(url, { text: String(init.body ?? ''), etag });
      return new Response(null, { status: 205, headers: { etag } });
    }
    if (method === 'DELETE') { docs.delete(url); return new Response(null, { status: 205 }); }
    return new Response('', { status: 405 });
  };
  return { docs, refuse, asked, fetchImpl, json: (u) => JSON.parse(docs.get(u)?.text || 'null') };
}

const ORIGIN = 'https://gw.example';
const WEBID = 'https://mei.pod.example/profile/card#me';
const HOME = 'https://mei.pod.example/fedipod/';
const STATE = HOME + 'ap-state/';
const pod = memPod();
const seed = (name, obj) => pod.docs.set(STATE + name, { text: JSON.stringify(obj, null, 2) + '\n', etag: `"s-${name}"` });
seed('config.json', { handle: 'mei', root: 'fedipod/', kind: 'person' });
seed('statuses.json', [{ noteId: 'n1', content: 'from before' }]);
seed('contacts.json', { followers: [], following: [] });
seed('keys.json', { rsa: { privatePem: 'the key' } });
seed('lease.json', { holder: 'old', expiresAt: 0 });

const rows = { mei: { handle: 'mei', kind: 'person', webId: WEBID, podHome: HOME, openedAt: new Date().toISOString(), keeper: { webId: 'https://keeper.example/#me' } } };
const copyKv = memoryKv();
const ctx = {
  copyKv, hold: true, keeperWebId: 'https://keeper.example/#me', stateSecret: Buffer.from('a-test-secret'),
  lookup: async (h) => rows[h] || null, listDirectory: async () => rows,
  keeperFetch: async () => pod.fetchImpl,
};
const deps = { verifyPodToken: async (request) => (request.headers.get('authorization') === 'DPoP mei' ? WEBID : null) };
let token = null;
const state = async (method, name, { body, headers = {} } = {}) => {
  const p = name === 'open' ? '/api/state/open' : `/api/state/mei/${name}`;
  const request = new Request(ORIGIN + p, { method, headers: { ...(name === 'open' ? { authorization: 'DPoP mei' } : { authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const out = await routeStateApi(request, p, ctx, deps);
  let json = null; try { json = JSON.parse(out.body); } catch { /* none */ }
  return { ...out, json };
};
const browser = { 'x-fedipod-holder': 'browser-1' };
const copyDocs = async () => (await copyKv.list('mei/d/')).length;

try {
  // ---- the setting ----
  check(holdFrom(undefined) && holdFrom('') && holdFrom('on') && holdFrom('yes'), 'the hold is on unless the admin says otherwise');
  check(!holdFrom('off') && !holdFrom('OFF') && !holdFrom('no') && !holdFrom('false') && !holdFrom('0'), 'FEDIPOD_HOLD=off (or no, false, 0) turns it off');
  check(holdOn({}) && !holdOn({ hold: false }), 'and a gateway context says which');
  check(isPersonal(rows.mei) && isPersonal({ handle: 'x' }) && !isPersonal({ kind: 'application' }) && !isPersonal({ kind: 'person', forum: 'hall' }),
    'a person\'s account is held; a forum and its categories are not');

  // ---- the copy, made and used ----
  const opened = await state('POST', 'open', { body: { handle: 'mei' } });
  token = opened.json?.token;
  check(opened.status === 200 && !!(await copyMeta(copyKv, 'mei')), 'the owner\'s browser opens the account, and the copy is made from the pod');
  check(!(await copyKv.get('mei/d/keys.json')), 'without the key');
  check((await state('PUT', 'lease.json', { body: { holder: 'browser-1', expiresAt: Date.now() + 900_000 } })).status === 204, 'the browser takes the copy\'s lease');
  check((await state('PUT', 'statuses.json', { body: [{ noteId: 'n2', content: 'new' }, { noteId: 'n1', content: 'from before' }], headers: browser })).status === 204,
    'and writes to the copy');
  check(!/new/.test(pod.docs.get(STATE + 'statuses.json').text), 'which the pod does not have yet');

  // ---- the end of the hold ----
  const ended = await endHold(ctx, 'mei', rows.mei);
  check(ended.ok && /new/.test(pod.docs.get(STATE + 'statuses.json').text), 'the round writes the copy to the pod');
  check(!(await copyMeta(copyKv, 'mei')) && !(await copyDocs()) && !(await copyKv.get('_copies/mei')), 'and deletes it: nothing of the account is left at the gateway');
  check(pod.json(STATE + 'lease.json')?.expiresAt === 0, 'the pod\'s lease is let go');
  check(JSON.parse((await copyKv.get('mei/lease')).text).holder === 'browser-1', 'the copy\'s lease stays, so the browser still holds it');
  check(await heldByBrowser(copyKv, 'mei'), 'and the gateway can tell a browser holds it');

  // ---- asked for again ----
  const again = await state('GET', 'statuses.json');
  check(again.status === 200 && /new/.test(again.body) && !!(await copyMeta(copyKv, 'mei')), 'the browser\'s next read makes the copy again, from the pod');
  check(pod.json(STATE + 'lease.json')?.holder === 'gateway-copy', 'holding the pod\'s lease again for it');
  await endHold(ctx, 'mei', rows.mei);
  check((await state('PUT', 'contacts.json', { body: { followers: [{ actor: 'https://a.example/u/ama' }], following: [] }, headers: browser })).status === 204,
    'a write after the copy was deleted lands in a copy made again, the browser\'s lease standing');
  check(!!(await copyKv.get('mei/d/statuses.json')) && /new/.test((await copyKv.get('mei/d/statuses.json')).text), 'with everything from before in it');

  // ---- while the round is at it ----
  await copyKv.set('mei/closing', String(Date.now()));
  const busyPut = await state('PUT', 'statuses.json', { body: [], headers: browser });
  const busyGet = await state('GET', 'statuses.json');
  const leaseGet = await state('GET', 'lease.json');
  check(busyPut.status === 503 && busyGet.status === 503, 'a write or read while the round writes and deletes the copy is asked to come again');
  check(leaseGet.status === 200, 'the lease is answered all the same');
  await copyKv.delete('mei/closing');

  // A write that lands while the round is writing: written too, before the delete.
  const podStore = new HttpStorage(STATE, pod.fetchImpl);
  let late = false;
  const racing = { ...pod, fetchImpl: async (u, i) => {
    if (!late && (i?.method || 'GET') === 'PUT' && String(u).endsWith('/contacts.json')) {
      late = true;
      await copyKv.set('mei/d/liked.json', JSON.stringify(['late']));
    }
    return pod.fetchImpl(u, i);
  } };
  await copyKv.set('mei/d/contacts.json', JSON.stringify({ followers: [], following: [{ actor: 'x' }] }));
  const raced = await holdOver(copyKv, 'mei', { pod: new HttpStorage(STATE, racing.fetchImpl), podFetch: pod.fetchImpl, stateUrl: STATE });
  check(raced.ok && late && pod.json(STATE + 'liked.json')?.[0] === 'late', 'a write landing while the round writes is written too, before the copy goes');

  // A pod that will not take a document: nothing is deleted.
  await state('GET', 'statuses.json');
  await state('PUT', 'statuses.json', { body: [{ noteId: 'n3' }], headers: browser });
  pod.refuse.add(STATE + 'statuses.json');
  const refused = await holdOver(copyKv, 'mei', { pod: podStore, podFetch: pod.fetchImpl, stateUrl: STATE });
  check(!refused.ok && !!(await copyMeta(copyKv, 'mei')) && /n3/.test((await copyKv.get('mei/d/statuses.json')).text),
    `a copy the pod would not take all of is not deleted (${refused.why})`);
  check(!(await copyKv.get('mei/closing')) && (await state('GET', 'statuses.json')).status === 200, 'and is used as before until the next round');
  pod.refuse.clear();

  // A delete cut off part way: the next round finds what is left.
  await copyKv.delete('mei/meta');
  check(await clearLeftover(copyKv, 'mei') && !(await copyDocs()) && !(await copyKv.get('_copies/mei')),
    'documents left by a delete cut off part way are deleted by the next round');

  // ---- the hold off ----
  await state('GET', 'statuses.json');                     // a copy from before the change
  await state('PUT', 'statuses.json', { body: [{ noteId: 'n4', content: 'before the hold went off' }], headers: browser });
  ctx.hold = false;
  check(!holdsMail({ ...ctx, holdMail: () => {} }, rows.mei) && mayBeAway({ ...ctx, holdMail: () => {} }, rows.mei),
    'with the hold off no mail is held, though a follow or a mention still starts the work that answers it');
  const off = await state('POST', 'open', { body: { handle: 'mei' } });
  check(off.status === 501 && off.json?.hold === false, 'the browser opening the account is told the gateway keeps no copy');
  check(!(await copyMeta(copyKv, 'mei')) && !(await copyDocs()) && /before the hold went off/.test(pod.docs.get(STATE + 'statuses.json').text),
    'and the copy from before is written to the pod and deleted first');
  const goneGet = await state('GET', 'statuses.json');
  check(goneGet.status === 404 && goneGet.json?.gone === true && !(await copyMeta(copyKv, 'mei')), 'a browser still asking for its copy is told it has gone, and none is made');
  check((await state('GET', 'lease.json')).status === 404, 'its lease too');
  check((await state('POST', 'leave')).status === 200, 'and leaving a copy there is none of is no error');
  const here = await routeHereApi(new Request(ORIGIN + '/api/here', { method: 'POST', body: JSON.stringify({ handle: 'mei' }) }), '/api/here',
    { ...ctx, markPresent: async () => {}, listHeld: async () => [] }, { j: (status, obj) => ({ status, body: JSON.stringify(obj) }), provedOwner: async () => ({}), apiPreflight: () => null });
  check(JSON.parse(here.body).hold === false, 'the browser\'s check-in is told the hold is off');

  // ---- the browser on the pod, fenced ----
  let mine = true;
  let told = 0;
  const fenced = new FencedStorage(podStore, { fence: async () => mine, onRefused: () => { told++; } });
  check((await fenced.write('liked.json', '["a"]', 'application/json')).ok, 'a fenced write goes while the browser holds the pod\'s lease');
  mine = false;
  const refusedWrite = await fenced.write('liked.json', '["b"]', 'application/json');
  check(!refusedWrite.ok && refusedWrite.lost && told === 1 && pod.json(STATE + 'liked.json')?.[0] === 'a',
    'and once the gateway has taken it to act for an app, the browser\'s write is refused and it stands down');
  check(!(await fenced.remove('liked.json')) && pod.docs.has(STATE + 'liked.json'), 'a remove too');
  check((await new FencedStorage(podStore).write('liked.json', '["c"]', 'application/json')).ok, 'with no fence it is the pod as it was');
} catch (e) { console.log('ERROR', e.stack || e.message); fails++; }

console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
