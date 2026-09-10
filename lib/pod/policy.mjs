// policy.mjs — ap/gateway-policy.json: what the pod's owner has published
// about which mail they want.
//
// The point of the document is that a service filtering on someone's behalf
// reads their stated wishes from their own pod rather than holding a private
// copy of them. So the reader here is deliberately unauthenticated: the
// document is public, and a service that needed a credential to read it would
// be holding something about the person it should not have to.

import { readCapped } from './http.mjs';

const POLICY_TTL_MS = 5 * 60_000;
const POLICY_MAX_BYTES = 256 * 1024;

/**
 * The published policy, or null when there is none to read.
 *
 * The cache is passed IN rather than kept here. A library that holds
 * process-global state decides its own lifetime, and the lifetime that matters
 * belongs to the service: on a warm serverless container one Map is shared
 * across every user it serves, so what it is keyed by is a correctness
 * property, not an optimisation. Keyed by `podHome`, it is one person's policy
 * under one person's key.
 *
 * Cached at all because a delivery flood must not become one read per delivery
 * against the person's pod — which is the load the whole arrangement exists to
 * spare them.
 *
 * ---- asked by: a delivery gateway, deciding what concerns this person ----
 */
export async function read(fetchImpl, podHome, { cache = null, ttlMs = POLICY_TTL_MS } = {}) {
  const hit = cache?.get(podHome);
  if (hit && Date.now() - hit.at < ttlMs) return hit.policy;
  let policy = null;
  try {
    const res = await fetchImpl(podHome + 'ap/gateway-policy.json',
      { headers: { accept: 'application/json' } });
    if (res && res.status < 400) policy = JSON.parse(await readCapped(res, POLICY_MAX_BYTES));
  } catch { /* unpublished or unreachable: the caller's own fields stand */ }
  cache?.set(podHome, { at: Date.now(), policy });
  return policy;
}
