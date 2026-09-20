// check-pod-calls.mjs — keeps the pod library a library, and keeps pod I/O
// inside it.
//
// Two jobs. The first is that the layer does not erode: once every pod request
// goes through a named operation, one `remote.putJson(...)` added back at a
// call site is invisible in review and undoes the property quietly. The second
// is that lib/pod/ stays EXTRACTABLE — no imports above itself, no Node
// built-ins, its one dependency confined — because "we could lift this out"
// stops being true the first time something reaches upward, and nobody notices
// until they try.
//
// Comments are stripped before every check. The rules are about code; the
// files explain themselves in prose, and prose that mentions node:dns or
// names the application it grew up in is not a violation.
//
//   node scripts/check-pod-calls.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POD = path.join(root, 'lib/pod');

let failures = 0;
const fail = (msg) => { console.log(`FAIL  ${msg}`); failures++; };
const pass = (msg) => console.log(`PASS  ${msg}`);

const read = (p) => fs.readFileSync(p, 'utf8');
// Prose is stripped LINE BY LINE, never with a regex spanning lines. A
// `/*...*/` matcher looks obvious and is not: a `*/` inside a regex literal or
// a string ends the match early, and everything up to the next one disappears —
// which silently deleted the very code these rules exist to look at, and left
// the check passing. Every comment in this project's style occupies whole
// lines, so dropping whole comment lines is both sufficient and safe.
const code = (src) => {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.endsWith('*/') || t === '*/') inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t.startsWith('//') || t.startsWith('*')) continue;
    out.push(line);
  }
  return out.join('\n');
};

const podFiles = fs.readdirSync(POD).filter((f) => f.endsWith('.mjs'));

// ---- 1. the layer: pod I/O lives behind a named operation ----

// The files that run the browser agent and the gateway. Node-only code is
// deliberately out of scope for this pass and must not fail the check.
const IN_SCOPE = [
  'lib/core/social.mjs',
  'lib/client/masto/index.mjs', 'lib/client/masto/accounts.mjs', 'lib/client/masto/media.mjs',
  'lib/client/masto/statuses.mjs', 'lib/client/masto/timelines.mjs', 'lib/client/masto/render.mjs',
  'lib/core/publisher/index.mjs', 'lib/core/publisher/collections.mjs', 'lib/core/publisher/restore.mjs',
  'lib/core/publisher/notes.mjs', 'lib/core/publisher/questions.mjs',
  'lib/core/intake/index.mjs', 'lib/core/intake/verify.mjs', 'lib/core/intake/notes.mjs',
  'lib/core/intake/channel.mjs', 'lib/core/intake/group.mjs', 'lib/core/intake/activities.mjs',
  'lib/gateway/gateway-core.mjs', 'lib/gateway/front-core.mjs',
  'web/app/agent.mjs', 'web/app/signup.mjs', 'web/app/boot.mjs',
  'web/app/admin-facade.mjs', 'web/app/keys-browser.mjs',
];
const VERBS = /\b(?:remote|pod)\??\.(put|putJson|getJson|delete|setAcl|listContainer|aclUrlFor|aclWritable|patchDocument|linkAccountInProfile|aclDoc)\(/;

for (const rel of IN_SCOPE) {
  const hits = code(read(path.join(root, rel))).split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => VERBS.test(l));
  if (hits.length) {
    fail(`${rel} calls a transport verb directly — that belongs in a lib/pod/ operation`);
    for (const [n, l] of hits.slice(0, 5)) console.log(`        ${rel}:${n}  ${l.trim()}`);
  }
}
if (!failures) pass('every in-scope caller reaches the pod through a named operation');

// ---- 2. the deny-list cannot be routed around ----
{
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', 'site', '.git', 'claude', 'phanpy', 'ui', 'packages'].includes(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.mjs') && p !== path.join(POD, 'transport.mjs')) {
        // A DELETE is only a problem when it is sent on a RAW fetch. One sent
        // through an injected fetcher is going through the transport — that is
        // what `storage.mjs` does, and is the point of it being injected.
        const src = code(read(p));
        for (const m of src.matchAll(/method:\s*['"]DELETE['"]/g)) {
          const before = src.slice(Math.max(0, m.index - 240), m.index);
          const call = before.lastIndexOf('(');
          const receiver = before.slice(Math.max(0, call - 60), call + 1);
          if (/(?:^|[^.\w])(?:window\.)?fetch\($/.test(receiver) || /session\.fetch\($/.test(receiver)) {
            offenders.push(`${path.relative(root, p)} (raw fetch)`);
          }
        }
      }
    }
  };
  walk(path.join(root, 'lib'));
  walk(path.join(root, 'web/app'));
  if (offenders.length) fail(`a DELETE is issued outside the transport, skipping the deny-list: ${offenders.join(', ')}`);
  else pass('every DELETE goes through the transport, where the deny-list is');
}

// ---- 3. the signing key is never written without its ACL ----
{
  const s = code(read(path.join(root, 'web/app/signup.mjs')));
  if (/keys\.json[\s\S]{0,200}method:\s*['"]PUT['"]/.test(s) || /method:\s*['"]PUT['"][\s\S]{0,200}keys\.json/.test(s)) {
    fail('signup writes keys.json directly — it must go through state.provisionKey, which sets the ACL first');
  } else pass('the signing key is written only by the operation that locks the container first');
}

// ---- 4. lib/pod/ reaches nothing above itself ----
{
  let bad = 0;
  for (const f of podFiles) {
    const src = code(read(path.join(POD, f)));
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (spec.startsWith('../')) { fail(`lib/pod/${f} imports ${spec} — the library may not reach above itself`); bad++; }
      if (spec.startsWith('node:')) { fail(`lib/pod/${f} imports ${spec} — the library must run in a service worker`); bad++; }
    }
  }
  if (!bad) pass('lib/pod/ imports nothing above itself and no Node built-ins');
}

// ---- 5. its one dependency stays confined ----
{
  const rdflibbers = podFiles.filter((f) => /from\s+['"]rdflib['"]/.test(code(read(path.join(POD, f)))));
  const allowed = ['transport.mjs', 'notifications.mjs'];
  const extra = rdflibbers.filter((f) => !allowed.includes(f));
  if (extra.length) fail(`rdflib reached from ${extra.join(', ')} — a resource module must not pull a parser in behind it`);
  else pass(`rdflib is confined to ${allowed.join(' and ')}`);

  const importsTransport = podFiles
    .filter((f) => f !== 'transport.mjs')
    .filter((f) => /from\s+['"]\.\/transport\.mjs['"]/.test(code(read(path.join(POD, f)))));
  if (importsTransport.length) fail(`${importsTransport.join(', ')} imports the transport — operations receive one, they do not reach for it`);
  else pass('no resource module imports or constructs a transport');
}

// ---- 6. it does not know what application it grew up in ----
{
  const named = podFiles.filter((f) => /fedipod/i.test(code(read(path.join(POD, f)))));
  if (named.length) fail(`lib/pod/${named.join(', ')} names FediPod in code — the library is meant to outlive it`);
  else pass('no FediPod vocabulary in library code');
}

// ---- 7. and it actually runs on its own ----
{
  const { apUrls } = await import(path.join(POD, 'urls.mjs'));
  const { PodTransport, protectedFromDeletion } = await import(path.join(POD, 'transport.mjs'));
  const urls = apUrls('https://p.example/', 'anything/');
  let threw = false;
  try { apUrls('https://p.example/'); } catch { threw = true; }
  if (!threw) fail('apUrls guessed a container root instead of requiring one');

  const seen = [];
  const pod = new PodTransport(
    { fetch: async (u, i) => { seen.push(`${i?.method || 'GET'} ${u}`); return { status: 200, headers: { get: () => null } }; } },
    { webId: 'https://p.example/profile/card#me', role: 'agent', runtime: 'node' },
  );
  const inbox = await import(path.join(POD, 'inbox.mjs'));
  await inbox.writeKeep(pod, urls);
  await inbox.setPosture(pod, urls, 'open');
  let refused = false;
  try { await pod.delete('https://p.example/profile/card'); } catch { refused = true; }
  if (!refused) fail('the deny-list did not refuse a DELETE of the WebID document');
  if (!seen.some((r) => r.startsWith('PUT https://p.example/anything/ap/inbox/.keep'))) {
    fail(`the inbox operations did not reach the pod as expected: ${seen.join(', ')}`);
  }
  if (pod.label !== 'agent/node') fail(`the transport did not label itself: ${pod.label}`);
  if (typeof protectedFromDeletion !== 'function') fail('protectedFromDeletion is not exported');
  pass('the library imports and runs against a stub with nothing but rdflib on the path');
}

// ---- 8. lib/session/ is a library on the same terms ----
{
  const SESSION = path.join(root, 'lib/session');
  const files = fs.readdirSync(SESSION).filter((f) => f.endsWith('.mjs'));
  let bad = 0;
  for (const f of files) {
    const src = code(read(path.join(SESSION, f)));
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('./')) { fail(`lib/session/${f} imports ${m[1]} — the session library imports nothing but its own files`); bad++; }
    }
    if (/fedipod/i.test(src)) { fail(`lib/session/${f} names FediPod in code — the database and client names are the caller's`); bad++; }
  }
  const { solidOidcSession } = await import(path.join(SESSION, 'oidc-session.mjs'));
  const oidc = solidOidcSession({ dbName: 'x', clientName: 'y' });
  for (const k of ['beginLogin', 'completeLogin', 'getSession', 'signOut']) {
    if (typeof oidc[k] !== 'function') { fail(`solidOidcSession() returned no ${k}`); bad++; }
  }
  // An address at a Gateway resolves to the POD's login, through the alias
  // WebFinger names; an address on a Mastodon server is refused in words.
  const { fediLogin, parseAddress } = await import(path.join(SESSION, 'fedi-login.mjs'));
  const jrd = (host, aliases, self) => ({ ok: true, json: async () => ({ aliases, links: [{ rel: 'self', type: 'application/activity+json', href: self }] }) });
  const stub = async (url) => {
    if (url.startsWith('https://front.example/.well-known/webfinger')) return jrd('front.example', ['https://mei.pod.example/anything/ap/actor'], 'https://front.example/u/mei/ap/actor');
    if (url.startsWith('https://masto.example/.well-known/webfinger')) return jrd('masto.example', ['https://masto.example/@kwame'], 'https://masto.example/users/kwame');
    if (url === 'https://mei.pod.example/.well-known/openid-configuration') return { ok: true, json: async () => ({ issuer: 'https://pod.example/', authorization_endpoint: 'https://pod.example/.oidc/auth' }) };
    // A pod whose host answers no discovery: the actor names the WebID, and
    // the WebID document names the issuer.
    if (url.startsWith('https://server.example/.well-known/webfinger')) return jrd('server.example', [], 'https://server.example/aisha/anything/ap/actor');
    if (url === 'https://server.example/aisha/anything/ap/actor') return { ok: true, json: async () => ({ id: url, alsoKnownAs: ['https://server.example/aisha/profile/card#me'] }) };
    if (url === 'https://server.example/aisha/profile/card#me') return { ok: true, json: async () => ([{ '@id': url, 'http://www.w3.org/ns/solid/terms#oidcIssuer': [{ '@id': 'https://idp.example/' }] }]) };
    if (url === 'https://idp.example/.well-known/openid-configuration') return { ok: true, json: async () => ({ issuer: 'https://idp.example/', authorization_endpoint: 'https://idp.example/auth' }) };
    return { ok: false, json: async () => ({}) };
  };
  const login = fediLogin({ dbName: 'x', fetch: stub });
  const found = await login.resolve('@mei@front.example').catch((e) => ({ error: e.message }));
  if (found.issuer !== 'https://pod.example/' || found.origin !== 'https://mei.pod.example' || found.actor !== 'https://front.example/u/mei/ap/actor') {
    fail(`a fronted address did not resolve to its pod's login: ${JSON.stringify(found)}`); bad++;
  }
  const viaWebId = await login.resolve('@aisha@server.example').catch((e) => ({ error: e.message }));
  if (viaWebId.issuer !== 'https://idp.example/' || viaWebId.webId !== 'https://server.example/aisha/profile/card#me') {
    fail(`an address on a host without discovery did not resolve through its WebID: ${JSON.stringify(viaWebId)}`); bad++;
  }
  const typedWebId = await login.resolve('https://server.example/aisha/profile/card#me').catch((e) => ({ error: e.message }));
  if (typedWebId.issuer !== 'https://idp.example/') { fail(`a typed WebID did not resolve: ${JSON.stringify(typedWebId)}`); bad++; }
  const refused = await login.resolve('kwame@masto.example').then(() => '', (e) => e.message);
  if (!/masto\.example is not a Solid pod/.test(refused)) { fail(`a Mastodon address was not refused in words: ${refused || 'resolved'}`); bad++; }
  if (parseAddress('nonsense') !== null || parseAddress('@mei@Front.Example')?.at !== '@mei@front.example') { fail('parseAddress does not read @you@host'); bad++; }
  // The account library tells a Mastodon address from a pod address and
  // speaks to each: the Mastodon API for one, the outbox door for the other.
  const { fediAccount, BROWSER_ACCOUNT_NOTICE } = await import(path.join(SESSION, 'fedi-account.mjs'));
  const seen = [];
  const acctStub = async (url, init = {}) => {
    seen.push(`${init.method || 'GET'} ${url}`);
    const ok = (body, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k] || null }, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.startsWith('https://masto.example/.well-known/webfinger')) return jrd('masto.example', ['https://masto.example/@kwame'], 'https://masto.example/users/kwame');
    if (url === 'https://masto.example/api/v1/instance') return ok({ uri: 'masto.example', title: 'Masto' });
    if (url === 'https://masto.example/api/v1/statuses' && init.method === 'POST') return ok({ id: '77', url: 'https://masto.example/@kwame/77' });
    if (url.startsWith('https://masto.example/api/v1/timelines/home')) return ok([{ id: '1', url: 'https://masto.example/@aisha/1', created_at: '2026-09-20T10:00:00Z', content: '<p>hi</p>', account: { acct: 'aisha', display_name: 'Aisha', url: 'https://masto.example/@aisha' } }]);
    if (url.startsWith('https://masto.example/api/v1/accounts/lookup')) return ok({ id: '9' });
    if (url === 'https://masto.example/api/v1/accounts/9/follow') return ok({ following: true });
    if (url === 'https://front.example/api/v1/instance' || url === 'https://mei.pod.example/api/v1/instance') return { ok: false, status: 404, json: async () => ({}) };
    return stub(url, init);
  };
  const accounts = fediAccount({ dbName: 'x', fetch: acctStub, storage: undefined });
  const kwame = await accounts.describe('@kwame@masto.example').catch((e) => ({ error: e.message }));
  if (kwame.kind !== 'mastodon' || kwame.host !== 'masto.example') { fail(`a Mastodon address was not recognised: ${JSON.stringify(kwame)}`); bad++; }
  const mei = await accounts.describe('@mei@front.example').catch((e) => ({ error: e.message }));
  if (mei.kind !== 'pod' || mei.root !== 'https://mei.pod.example/anything/' || mei.issuer !== 'https://pod.example/') { fail(`a pod address was not recognised: ${JSON.stringify(mei)}`); bad++; }
  // The Mastodon account acts through its server's API.
  const store = { getItem: (k) => store.m.get(k) ?? null, setItem: (k, v) => store.m.set(k, String(v)), removeItem: (k) => store.m.delete(k), m: new Map() };
  store.setItem('x:masto:account', JSON.stringify({ host: 'masto.example', token: 't', handle: '@kwame@masto.example', name: 'Kwame', actor: 'https://masto.example/@kwame' }));
  const me = await fediAccount({ dbName: 'x', fetch: acctStub, storage: store }).current();
  const posted = await me.post({ text: 'hello' }).catch((e) => ({ error: e.message }));
  const tl = await me.timeline().catch((e) => ({ error: e.message }));
  const followed = await me.follow('@aisha@masto.example').catch((e) => ({ error: e.message }));
  if (me.kind !== 'mastodon' || me.notice !== null || posted.id !== '77' || tl[0]?.author?.handle !== '@aisha@masto.example' || followed.followed !== '@aisha@masto.example') {
    fail(`the Mastodon account did not act through its API: ${JSON.stringify({ posted, tl, followed })}`); bad++;
  }
  // The pod account acts through its outbox door and reads its own records;
  // a sealed key on the pod marks it browser-based, which sets the notice.
  const doorSeen = [];
  const podFetch = async (url, init = {}) => {
    doorSeen.push(`${init.method || 'GET'} ${url}`);
    if (url === 'https://front.example/u/mei/ap/outbox') return { ok: true, status: 202, headers: { get: (k) => (k === 'location' ? 'https://front.example/u/mei/ap/notes/n1' : null) }, text: async () => '' };
    if (url === 'https://mei.pod.example/anything/ap-state/keys.json') return { ok: true, status: 200, json: async () => ({ v: 1, kdf: 'PBKDF2-SHA256', ct: 'x', salt: 'y' }) };
    if (url === 'https://mei.pod.example/anything/ap-state/statuses.json') return { ok: true, status: 200, json: async () => ([{ noteId: 'https://x.example/n/1', actor: 'https://x.example/u/tamara', content: '<p>one</p>', published: '2026-09-20T09:00:00Z', kind: 'timeline' }, { noteId: 'https://x.example/n/2', actor: 'https://x.example/u/tamara', content: '<p>dm</p>', published: '2026-09-20T09:30:00Z', kind: 'timeline', direct: true }]) };
    if (url === 'https://mei.pod.example/anything/ap-state/actors.json') return { ok: true, status: 200, json: async () => ({ 'https://x.example/u/tamara': { preferredUsername: 'tamara', name: 'Tamara' } }) };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const session = { webId: 'https://mei.pod.example/profile/card#me', fetch: podFetch, signOut: async () => {} };
  const stubWithCard = async (url, init = {}) => {
    if (url === 'https://mei.pod.example/profile/card#me') return { ok: true, json: async () => ([{ '@id': url, 'https://www.w3.org/ns/activitystreams#outbox': [{ '@id': 'https://front.example/u/mei/ap/outbox' }], 'http://xmlns.com/foaf/0.1/account': [{ '@id': 'https://front.example/u/mei/ap/actor' }] }]) };
    if (url === 'https://front.example/u/mei/ap/actor') return { ok: true, json: async () => ({ id: url, preferredUsername: 'mei', name: 'Mei', followers: 'https://front.example/u/mei/ap/followers' }) };
    return acctStub(url, init);
  };
  const podStore = { getItem: (k) => podStore.m.get(k) ?? null, setItem: (k, v) => podStore.m.set(k, String(v)), removeItem: (k) => podStore.m.delete(k), m: new Map() };
  // Reach the pod account the way resume() would, with the session handed in.
  const meiAcct = await fediAccount({ dbName: 'x', fetch: stubWithCard, storage: podStore })
    ._podAccount(session, { handle: '@mei@front.example', actor: 'https://front.example/u/mei/ap/actor', root: 'https://mei.pod.example/anything/' });
  const p2 = await meiAcct.post({ text: 'hello <b>' }).catch((e) => ({ error: e.message }));
  const t2 = await meiAcct.timeline().catch((e) => ({ error: e.message }));
  const f2 = await meiAcct.follow('@tamara@x.example').catch((e) => ({ error: e.message }));
  const doorBodies = doorSeen.filter((s) => s.startsWith('POST https://front.example/u/mei/ap/outbox')).length;
  if (meiAcct.kind !== 'pod' || meiAcct.notice !== BROWSER_ACCOUNT_NOTICE || !p2.queued || p2.id !== 'https://front.example/u/mei/ap/notes/n1'
    || t2.length !== 1 || t2[0].author.handle !== '@tamara@x.example' || !f2.queued || doorBodies !== 2) {
    fail(`the pod account did not act through its door: ${JSON.stringify({ notice: meiAcct.notice, p2, t2, f2, doorBodies })}`); bad++;
  }
  const bound = code(read(path.join(root, 'web/app/oidc-session.mjs')));
  if (!/dbName:\s*'fedipod-oidc'/.test(bound)) { fail("web/app/oidc-session.mjs must bind dbName 'fedipod-oidc' — every signed-in browser holds its session under that name"); bad++; }
  if (!bad) pass('lib/session/ imports nothing above itself, names no application, tells a Mastodon address from a pod one and acts through each, and the app binds its own database name');
}

console.log(failures ? `\n${failures} failure(s)` : '\npod layer intact');
process.exit(failures ? 1 : 0);
