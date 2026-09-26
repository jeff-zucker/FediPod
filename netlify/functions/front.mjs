// netlify/functions/front.mjs — the multi-user front, as one Netlify function.
// UN-DEPLOYED ARTIFACT: nothing in FediPod runs it. A HOST deploys this to
// offer @name@fedipod.net accounts to many independent FediPod users, each of
// whom keeps their own pod, agent and signing key. This box holds no user key
// and no user data — only a directory and the per-user Append credentials.
//
// The directory (handle → record) is the one piece of host state. Store it
// however suits the deploy — a JSON blob in the repo/env for a static roster,
// a KV store for open signup. Each record:
//   {
//     handle, podHome,              // "https://alice.pod/solid/"  (trailing slash)
//     actorUrl,                     // "https://fedipod.net/u/alice/ap/actor"
//     kind, following, blocklist,   // public facts for the edge concerns-us check
//     followersUrl, notesPrefix,    // derived if omitted
//     gatewayWebId, hmacSecret,     // this box's WebID + the user's receipt secret
//     appendToken,                  // Append credential for THIS user's pod inbox
//     openedAt, pausedAt, closedAt  // when the owner was last here; paused or closed
//   }                               // by them (see "accounts that go quiet" in front-core)
//
// Env:
//   FEDIPOD_FRONT_HOST     "fedipod.net"
//   FEDIPOD_FRONT_ORIGIN   "https://fedipod.net"
//   FEDIPOD_DIRECTORY_URL  a JSON map { handle: record, … } (public policy fields only;
//                          keep appendToken/hmacSecret out of anything world-readable)
//   FEDIPOD_ADMIN_WEBID    the WebID allowed to read the roster at /roster
//   FEDIPOD_PAUSE_ITEMS    content deliveries since a sign-in before an account pauses (5000)
//   FEDIPOD_CLOSE_DAYS     days without a sign-in before an address closes (183)

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';
import { routeFront } from '../../lib/gateway/front-core.mjs';
import { keeperBook } from '../../lib/gateway/keeper-due.mjs';
import { keeperSession } from '../../lib/gateway/keeper-session.mjs';
import * as podInbox from '../../lib/pod/inbox.mjs';
import grant from '../../vendor/idp-grant.cjs';

// The new-account page and the vendored auth library, read once at cold start.
let signupPage = '';
let authBundle = '';
try {
  signupPage = readFileSync(
    fileURLToPath(new URL('../../web/front/new-account.html', import.meta.url)), 'utf8');
} catch { /* the page is optional; the front still routes federation without it */ }
try {
  authBundle = readFileSync(
    fileURLToPath(new URL('../../web/front/solid-oidc-client.js', import.meta.url)), 'utf8');
} catch { /* without it the page's sign-in step is unavailable */ }
// Each page's own script (they were inline until 2026-09-09 — see the
// /new-account.js route in lib/front-core.mjs). Read at cold start, like the
// pages themselves.
const pageScripts = {};
for (const name of ['new-account.js', 'run.js', 'admin.js', 'notices.js']) {
  try {
    pageScripts[name] = readFileSync(
      fileURLToPath(new URL(`../../web/front/${name}`, import.meta.url)), 'utf8');
  } catch { /* without it that page has no behaviour; the page still serves */ }
}
let installScript = '';
try {
  installScript = readFileSync(
    fileURLToPath(new URL('../../web/front/install.sh', import.meta.url)), 'utf8');
} catch { /* without it /install 404s */ }
let runPage = '';
try {
  runPage = readFileSync(
    fileURLToPath(new URL('../../web/front/run.html', import.meta.url)), 'utf8');
} catch { /* without it /run 404s */ }
let adminPage = '';
try {
  adminPage = readFileSync(
    fileURLToPath(new URL('../../web/front/admin.html', import.meta.url)), 'utf8');
} catch { /* without it /roster 404s */ }
let noticesPage = '';
try {
  noticesPage = readFileSync(
    fileURLToPath(new URL('../../web/front/notices.html', import.meta.url)), 'utf8');
} catch { /* without it /notices 404s */ }
// The deploy's own version: what the signup page shows as current.
let frontVersion = null;
try {
  frontVersion = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version || null;
} catch { /* the page just omits the line */ }

let dir = null, dirAt = 0;
const DIR_TTL_MS = 60_000;

// Rows created by attach live in a Netlify Blobs store; a seed roster may
// also come from the environment. Blob rows win on a name collision.
//
// A request asks for ONE row, by its key: one Blobs read, held a minute per
// process. The whole map (one read per account) is built only for the roster.
const rows = new Map();   // handle → { rec, at }
const ROWS_MAX = 1000;
async function rowFor(handle) {
  const hit = rows.get(handle);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.rec;
  const rec = (await getStore('directory').get(handle, { type: 'json' })) || (await seedRows())[handle] || null;
  if (rows.size >= ROWS_MAX) for (const [k, v] of rows) if (Date.now() - v.at >= DIR_TTL_MS) rows.delete(k);
  rows.set(handle, { rec, at: Date.now() });
  return rec;
}

async function blobRows() {
  try {
    const store = getStore('directory');
    const { blobs } = await store.list();
    const out = {};
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: 'json' });
      if (rec) out[b.key] = rec;
    }
    return out;
  } catch { return {}; }
}

let seeds = null;   // read once per process: the environment does not change under it
async function seedRows() {
  if (seeds) return seeds;
  // A small seed roster can live directly in the environment — and must, if
  // it would otherwise be fetched from this site's own origin, which this
  // function intercepts (the fetch would recurse into itself).
  if (process.env.FEDIPOD_DIRECTORY_JSON) return (seeds = JSON.parse(process.env.FEDIPOD_DIRECTORY_JSON));
  if (!process.env.FEDIPOD_DIRECTORY_URL) return (seeds = {});
  const res = await fetch(process.env.FEDIPOD_DIRECTORY_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`directory fetch → ${res.status}`);
  return (seeds = await res.json());
}

async function directory() {
  if (dir && Date.now() - dirAt < DIR_TTL_MS) return dir;
  dir = { ...await seedRows(), ...await blobRows() };
  dirAt = Date.now();
  return dir;
}

// One line per request in the function log, so the log says what the calls
// were for: method, path, status, how long, and who asked. The path only,
// never the query, which on some routes carries a token.
const logRequest = (request, status, startedAt) => {
  let path = request.url;
  try { path = new URL(request.url).pathname; } catch { /* log what was asked */ }
  const agent = (request.headers.get('user-agent') || '-').replace(/\s+/gu, ' ').slice(0, 80);
  console.log(`${request.method} ${path} ${status} ${Date.now() - startedAt}ms ${agent}`);
};

export default async function handler(request) {
  const startedAt = Date.now();
  let out;
  try { out = await route(request); } catch (e) {
    // The directory could not be read, or a route threw: a 503 the caller
    // retries, never a 404 the edge would hold.
    console.log(`front: ${e?.message || e}`);
    logRequest(request, 503, startedAt);
    return new Response(`front unavailable: ${e?.message || e}\n`, { status: 503 });
  }
  logRequest(request, out.status, startedAt);
  return new Response(out.body ?? null, { status: out.status, headers: out.headers });
}

function route(request) {
  return routeFront(request, gatewayCtx());
}

// Everything the front reads and keeps, as the core asks for it. Exported so
// the held-mail timer (flush-mail.mjs) works on the same stores.
export function gatewayCtx() {
  return {
    host: process.env.FEDIPOD_FRONT_HOST,
    frontOrigin: process.env.FEDIPOD_FRONT_ORIGIN,
    signupPage,
    runPage,
    adminPage,
    noticesPage,
    authBundle,
    pageScripts,
    installScript,
    version: frontVersion,
    offersPods: process.env.FEDIPOD_OFFERS_PODS === '1',
    gatewayWebId: process.env.FEDIPOD_GATEWAY_WEBID || null,
    adminWebId: process.env.FEDIPOD_ADMIN_WEBID || null,
    lookup: rowFor,
    // Drops the edge's copies carrying these tags. Netlify gives a function the
    // token for its own site's purge API; with none, there is nothing to purge.
    purge: async (tags) => {
      const token = process.env.NETLIFY_PURGE_API_TOKEN;
      if (!token || !process.env.SITE_ID) return;
      await fetch('https://api.netlify.com/api/v1/purge', { method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ site_id: process.env.SITE_ID, cache_tags: tags }) });
    },
    listDirectory: directory,
    // Drops the blob row; a handle that survives in the env seed stays.
    removeDirectory: async (handle) => {
      const store = getStore('directory');
      await store.delete(handle);
      rows.delete(handle);
      dir = null;
      const seeds = await seedRows().catch(() => ({}));
      return !seeds[handle];
    },
    // Attach writes its row here; the next directory() pass reads it back.
    putDirectory: async (handle, record) => {
      const store = getStore('directory');
      await store.setJSON(handle, record);
      rows.delete(handle);
      dir = null;
    },
    // Per-user Append to that user's pod inbox — with the user's credential
    // when the record carries one, plain when the inbox is public-Append
    // (FediPod's default posture).
    // The operator's notices, beside the directory (lib/gateway/notices.mjs).
    listNotices: async () => {
      const store = getStore('notices');
      const { blobs } = await store.list();
      const out = {};
      for (const b of blobs) { const n = await store.get(b.key, { type: 'json' }); if (n) out[b.key] = n; }
      return out;
    },
    putNotice: async (id, notice) => getStore('notices').setJSON(id, notice),
    deleteNotice: async (id) => getStore('notices').delete(id),
    // What arrived for an account since its owner last signed in, one small
    // record per sign-in, in a store of its own so a delivery never writes
    // the directory row (front-core: accounts that go quiet).
    readReceived: async (key) => getStore('received').get(key, { type: 'json' }),
    writeReceived: async (key, n) => getStore('received').setJSON(key, n),
    dropReceived: async (key) => getStore('received').delete(key),
    pauseItems: process.env.FEDIPOD_PAUSE_ITEMS,
    closeDays: process.env.FEDIPOD_CLOSE_DAYS,
    podPut: async (handle, url, body, ct) => {
      const rec = await rowFor(handle);
      if (!rec) return false;
      return podInbox.appendWithToken(url, body, ct, { appendToken: rec.appendToken,
        report: (status) => { if (status >= 400 || status === 0) console.log(`door @${handle}: pod answered ${status || 'nothing'} to PUT ${url}${rec.appendToken ? ' (with token)' : ' (anonymous)'}`); } });
    },
    // A browser account's mail while its app is closed, and when the app last
    // said it was open (lib/gateway/held-mail.mjs).
    holdMail: async (handle, name, body, ct) => getStore('mail').set(`${handle}/${name}`, body, { metadata: { ct } }),
    listHeld: async (handle) => (await getStore('mail').list({ prefix: `${handle}/` })).blobs.map((b) => b.key.slice(handle.length + 1)),
    readHeld: async (handle, name) => getStore('mail').get(`${handle}/${name}`),
    dropHeld: async (handle, name) => getStore('mail').delete(`${handle}/${name}`),
    heldAccounts: async () => [...new Set((await getStore('mail').list()).blobs.map((b) => b.key.split('/')[0]))],
    markPresent: async (handle) => getStore('present').setJSON(handle, { at: Date.now() }),
    presentAt: async (handle) => (await getStore('present').get(handle, { type: 'json' }))?.at || 0,
    // The gateway's own pod identity, which an owner may let act for them while
    // their app is closed (lib/gateway/keeper.mjs), and what its last run left.
    keeperWebId: process.env.FEDIPOD_KEEPER_WEBID || null,
    // The working copies of kept accounts (lib/gateway/copy.mjs), in a store
    // read and written with strong consistency: two functions working on one
    // account must see each other's writes at once.
    copyKv: blobsKv('state'),
    // Mastodon apps signed in here: their registrations, codes and tokens
    // (lib/gateway/masto-gateway.mjs).
    mastoKv: blobsKv('masto'),
    // Phone notifications (lib/gateway/masto-gateway.mjs): whether an account
    // has any, and a run that reads its held mail in and pushes what it makes.
    pushWanted: async (handle) => Number((await blobsKv('masto').get(`push/${handle}`))?.text || 0) > 0,
    // One run at a time per account: an arrival while one runs is noted, and
    // the run goes round again for it (masto-gateway.mjs: pushHeld).
    startPush: async (handle) => {
      const secret = process.env.FEDIPOD_KEEPER_CLIENT_SECRET;
      if (!secret || !process.env.URL) return;
      const kv = blobsKv('masto');
      await kv.set(`pushwant/${handle}`, `${Date.now()}-${Math.random()}`);
      const running = await kv.get(`pushrun/${handle}`);
      if (running && Date.now() - Number(running.text) < 60_000) return;
      await kv.set(`pushrun/${handle}`, String(Date.now()));
      const body = JSON.stringify({ handle, at: Date.now() });
      const mac = crypto.createHmac('sha256', `fedipod-push:${secret}`).update(body).digest('hex');
      await fetch(`${process.env.URL}/.netlify/functions/push-background`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-fedipod-push': mac }, body,
      });
    },
    // Signs the tokens the state API hands the owner's browser. Derived from
    // the keeper's own secret, which a deploy that keeps copies already has.
    stateSecret: process.env.FEDIPOD_KEEPER_CLIENT_SECRET
      ? crypto.createHash('sha256').update(`fedipod-state:${process.env.FEDIPOD_KEEPER_CLIENT_SECRET}`).digest()
      : null,
    // The keeper's pod fetch, for making, writing back and giving up copies.
    keeperFetch: async () => {
      const cred = await keeperCredential();
      if (!cred) return null;
      const session = keeperSession(cred);
      return (u, i) => session.fetch(u, i);
    },
    // When each kept account's keeper next has work (keeper-due.mjs).
    ...keeperBook({
      get: (k) => getStore('keeper').get(k, { type: 'json' }),
      set: (k, v) => getStore('keeper').setJSON(k, v),
      keys: async () => (await getStore('keeper').list()).blobs.map((b) => b.key),
    }),
  };
}

// A Netlify Blobs store as the copy's key-value store (lib/gateway/copy.mjs).
function blobsKv(name) {
  const store = () => getStore({ name, consistency: 'strong' });
  return {
    async get(key) {
      const r = await store().getWithMetadata(key, { type: 'text' });
      return r ? { text: r.data, etag: r.etag } : null;
    },
    async set(key, text, { ifMatch = null, ifNew = false } = {}) {
      const r = await store().set(key, text, ifMatch ? { onlyIfMatch: ifMatch } : ifNew ? { onlyIfNew: true } : {});
      // The library answers a conditional write that failed any way but 412 as
      // one made with an empty ETag; that is not a write this code can count
      // on. A plain write that fails throws.
      return { ok: r.modified !== false && (!(ifMatch || ifNew) || !!r.etag), etag: r.etag };
    },
    async delete(key) { await store().delete(key); },
    async list(prefix) { return (await store().list({ prefix })).blobs.map((b) => ({ key: b.key, etag: b.etag })); },
  };
}

// The keeper's pod credential: a client id and secret minted for its WebID
// at its issuer, whose token endpoint is looked up once per running copy.
let tokenEndpoint = null;
export async function keeperCredential() {
  const { FEDIPOD_KEEPER_WEBID: webId, FEDIPOD_KEEPER_ISSUER: issuer,
    FEDIPOD_KEEPER_CLIENT_ID: clientId, FEDIPOD_KEEPER_CLIENT_SECRET: secret } = process.env;
  if (!webId || !issuer || !clientId || !secret) return null;
  const issuerOrigin = issuer.replace(/\/+$/u, '');
  tokenEndpoint ||= await grant.discoverTokenEndpoint(issuerOrigin);
  return { webId, issuerOrigin, clientId, secret, tokenEndpoint };
}

// The account routes are the account function's (account.mjs): it carries
// the pieces that act for an account, which a delivery never needs.
export const ACCOUNT_PATHS = ['/api/state/*', '/api/v1/*', '/api/v2/*', '/oauth/*', '/api/authorize',
  '/.well-known/oauth-authorization-server'];
export const config = { path: '/*', excludedPath: ACCOUNT_PATHS, preferStatic: true };
