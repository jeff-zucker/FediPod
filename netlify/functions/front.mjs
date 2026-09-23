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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';
import { routeFront } from '../../lib/gateway/front-core.mjs';
import * as podInbox from '../../lib/pod/inbox.mjs';

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
for (const name of ['new-account.js', 'run.js', 'admin.js']) {
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

async function seedRows() {
  // A small seed roster can live directly in the environment — and must, if
  // it would otherwise be fetched from this site's own origin, which this
  // function intercepts (the fetch would recurse into itself).
  if (process.env.FEDIPOD_DIRECTORY_JSON) return JSON.parse(process.env.FEDIPOD_DIRECTORY_JSON);
  if (!process.env.FEDIPOD_DIRECTORY_URL) return {};
  const res = await fetch(process.env.FEDIPOD_DIRECTORY_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`directory fetch → ${res.status}`);
  return res.json();
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
  let map;
  try { map = await directory(); } catch (e) {
    logRequest(request, 503, startedAt);
    return new Response(`directory unavailable: ${e.message}\n`, { status: 503 });
  }
  const out = await routeFront(request, {
    host: process.env.FEDIPOD_FRONT_HOST,
    frontOrigin: process.env.FEDIPOD_FRONT_ORIGIN,
    signupPage,
    runPage,
    adminPage,
    authBundle,
    pageScripts,
    installScript,
    version: frontVersion,
    offersPods: process.env.FEDIPOD_OFFERS_PODS === '1',
    gatewayWebId: process.env.FEDIPOD_GATEWAY_WEBID || null,
    adminWebId: process.env.FEDIPOD_ADMIN_WEBID || null,
    lookup: (handle) => map[handle] || null,
    listDirectory: async () => map,
    // Drops the blob row; a handle that survives in the env seed stays.
    removeDirectory: async (handle) => {
      const store = getStore('directory');
      await store.delete(handle);
      dir = null;
      const seeds = await seedRows().catch(() => ({}));
      return !seeds[handle];
    },
    // Attach writes its row here; the next directory() pass reads it back.
    putDirectory: async (handle, record) => {
      const store = getStore('directory');
      await store.setJSON(handle, record);
      dir = null;
    },
    // Per-user Append to that user's pod inbox — with the user's credential
    // when the record carries one, plain when the inbox is public-Append
    // (FediPod's default posture).
    // What arrived for an account since its owner last signed in, one small
    // record per sign-in, in a store of its own so a delivery never writes
    // the directory row (front-core: accounts that go quiet).
    readReceived: async (key) => getStore('received').get(key, { type: 'json' }),
    writeReceived: async (key, n) => getStore('received').setJSON(key, n),
    dropReceived: async (key) => getStore('received').delete(key),
    pauseItems: process.env.FEDIPOD_PAUSE_ITEMS,
    closeDays: process.env.FEDIPOD_CLOSE_DAYS,
    podPut: async (handle, url, body, ct) => {
      const rec = map[handle];
      if (!rec) return false;
      return podInbox.appendWithToken(url, body, ct, { appendToken: rec.appendToken,
        report: (status) => { if (status >= 400 || status === 0) console.log(`door @${handle}: pod answered ${status || 'nothing'} to PUT ${url}${rec.appendToken ? ' (with token)' : ' (anonymous)'}`); } });
    },
  });
  logRequest(request, out.status, startedAt);
  return new Response(out.body ?? null, { status: out.status, headers: out.headers });
}

export const config = { path: '/*', preferStatic: true };
