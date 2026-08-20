// netlify/functions/inbox.mjs — the always-on inbox gateway, as a Netlify
// Scheduled/HTTP function. THIS IS AN UN-DEPLOYED ARTIFACT: nothing in FediPod
// starts it. An operator who wants door-side signature verification deploys
// this themselves and points an identity at it from the admin page.
//
// It is keyless: it holds no RSA signing key. Its only secrets (Netlify
// encrypted env) are an Append-only pod credential for the identity's inbox and
// the HMAC secret shared with that identity's drain.
//
// Env:
//   FEDIPOD_POLICY_URL   public URL of the identity's ap/gateway-policy.json
//   FEDIPOD_INBOX_URL    the pod inbox container (from the policy doc, or set)
//   FEDIPOD_APPEND_TOKEN a bearer/x-dk-token granting Append to that inbox
//   FEDIPOD_HMAC_SECRET  the receipt secret (matches the identity's config)
//   FEDIPOD_GATEWAY_WEBID the WebID this gateway authenticates as

import { handleDelivery } from '../../lib/gateway-core.mjs';

let cachedPolicy = null;
let cachedAt = 0;
const POLICY_TTL_MS = 60_000;

async function loadPolicy() {
  if (cachedPolicy && Date.now() - cachedAt < POLICY_TTL_MS) return cachedPolicy;
  const res = await fetch(process.env.FEDIPOD_POLICY_URL, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`policy fetch → ${res.status}`);
  cachedPolicy = await res.json();
  cachedAt = Date.now();
  return cachedPolicy;
}

function podPutter() {
  const token = process.env.FEDIPOD_APPEND_TOKEN;
  return async (url, body, contentType) => {
    const res = await fetch(url, {
      method: 'PUT',
      // No token means the pod's inbox is public-Append, which is FediPod's
      // default: send no authorization at all rather than `Bearer undefined`,
      // which a pod rejects outright instead of treating as anonymous.
      headers: { 'content-type': contentType, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body,
    }).catch(() => null);
    return !!res && res.status < 400;
  };
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('POST an ActivityPub delivery here\n', { status: 405 });
  }
  let policy;
  try { policy = await loadPolicy(); } catch (e) {
    // Cannot read policy → tell the sender to retry (its buffer, not ours).
    return new Response(`policy unavailable: ${e.message}\n`, { status: 503 });
  }
  const ident = {
    inboxUrl: process.env.FEDIPOD_INBOX_URL || policy.inboxUrl,
    actorUrl: policy.actorUrl,
    followersUrl: policy.followersUrl,
    notesPrefix: policy.notesPrefix,
    following: policy.following || [],
    blocklist: policy.blocklist || { domains: [], actors: [] },
    kind: policy.kind || 'person',
    gatewayWebId: process.env.FEDIPOD_GATEWAY_WEBID,
    hmacSecret: process.env.FEDIPOD_HMAC_SECRET,
  };
  const { status } = await handleDelivery(request, ident, { podPut: podPutter() });
  return new Response(null, { status });
}

export const config = { path: '/inbox' };
