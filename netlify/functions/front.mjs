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
import { routeFront } from '../../lib/front-core.mjs';

// The new-account page, read once at cold start.
let signupPage = '';
try {
  signupPage = readFileSync(
    fileURLToPath(new URL('../../web/front/new-account.html', import.meta.url)), 'utf8');
} catch { /* the page is optional; the front still routes federation without it */ }

let dir = null, dirAt = 0;
const DIR_TTL_MS = 60_000;

async function directory() {
  if (dir && Date.now() - dirAt < DIR_TTL_MS) return dir;
  const res = await fetch(process.env.FEDIPOD_DIRECTORY_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`directory fetch → ${res.status}`);
  dir = await res.json(); dirAt = Date.now();
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
    offersPods: process.env.FEDIPOD_OFFERS_PODS === '1',
    lookup: (handle) => map[handle] || null,
    // Per-user Append to that user's pod inbox, with that user's credential.
    podPut: async (handle, url, body, ct) => {
      const rec = map[handle];
      if (!rec?.appendToken) return false;
      const r = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': ct, authorization: `Bearer ${rec.appendToken}` },
        body,
      }).catch(() => null);
      return !!r && r.status < 400;
    },
  });
  return new Response(out.body ?? null, { status: out.status, headers: out.headers });
}

export const config = { path: '/*' };
