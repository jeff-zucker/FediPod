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
//     appendToken                   // Append credential for THIS user's pod inbox
//   }
//
// Env:
//   FEDIPOD_FRONT_HOST     "fedipod.net"
//   FEDIPOD_FRONT_ORIGIN   "https://fedipod.net"
//   FEDIPOD_DIRECTORY_URL  a JSON map { handle: record, … } (public policy fields only;
//                          keep appendToken/hmacSecret out of anything world-readable)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';
import { routeFront } from '../../lib/front-core.mjs';

// The new-account page and the vendored auth library, read once at cold start.
let signupPage = '';
let authBundle = '';
try {
  signupPage = readFileSync(
    fileURLToPath(new URL('../../web/front/new-account.html', import.meta.url)), 'utf8');
} catch { /* the page is optional; the front still routes federation without it */ }
try {
  authBundle = readFileSync(
    fileURLToPath(new URL('../../web/front/solid-client-authn.bundle.js', import.meta.url)), 'utf8');
} catch { /* without it the page's sign-in step is unavailable */ }
let installScript = '';
try {
  installScript = readFileSync(
    fileURLToPath(new URL('../../web/front/install.sh', import.meta.url)), 'utf8');
} catch { /* without it /install 404s */ }

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

export default async function handler(request) {
  let map;
  try { map = await directory(); } catch (e) {
    return new Response(`directory unavailable: ${e.message}\n`, { status: 503 });
  }
  const out = await routeFront(request, {
    host: process.env.FEDIPOD_FRONT_HOST,
    frontOrigin: process.env.FEDIPOD_FRONT_ORIGIN,
    signupPage,
    authBundle,
    installScript,
    offersPods: process.env.FEDIPOD_OFFERS_PODS === '1',
    gatewayWebId: process.env.FEDIPOD_GATEWAY_WEBID || null,
    lookup: (handle) => map[handle] || null,
    // Attach writes its row here; the next directory() pass reads it back.
    putDirectory: async (handle, record) => {
      const store = getStore('directory');
      await store.setJSON(handle, record);
      dir = null;
    },
    // Per-user Append to that user's pod inbox — with the user's credential
    // when the record carries one, plain when the inbox is public-Append
    // (FediPod's default posture).
    podPut: async (handle, url, body, ct) => {
      const rec = map[handle];
      if (!rec) return false;
      const headers = { 'content-type': ct,
        ...(rec.appendToken ? { authorization: `Bearer ${rec.appendToken}` } : {}) };
      const r = await fetch(url, { method: 'PUT', headers, body }).catch(() => null);
      return !!r && r.status < 400;
    },
  });
  return new Response(out.body ?? null, { status: out.status, headers: out.headers });
}

export const config = { path: '/*' };
