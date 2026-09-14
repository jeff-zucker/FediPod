// root.mjs — the pod itself, before any of its containers.
//
// Three questions get asked of a pod root rather than of a document in it: who
// owns it, whether it is there at all, and — for a service publishing someone
// else's pod on their behalf — what one of its public documents says.
//
// Every operation here takes a plain fetcher, not a transport. That is the
// honest shape: these are asked by parties that hold no credential for the pod
// — a keyless delivery gateway, a sign-up page looking at a pod the person
// brought with them — and giving them an authenticated transport would let
// them ask questions they have no business asking.

import { readCapped } from './http.mjs';
import { linkTargets, REL } from './links.mjs';

const OWNER_LOOKUP_MS = 5_000;
const PUBLIC_DOC_MAX_BYTES = 1024 * 1024;

/**
 * Who the pod server says owns this pod.
 *
 * The server hosting it is the authority on that, so when it answers, its
 * answer decides. A server that says nothing leaves where the WebID lives as
 * the only evidence there is — which is weaker, and the caller's problem.
 *
 * ---- asked by: a service deciding whether someone may speak for a pod ----
 */
export async function readOwnerLinks(fetchImpl, podBase, { timeoutMs = OWNER_LOOKUP_MS } = {}) {
  try {
    const res = await fetchImpl(podBase, {
      method: 'HEAD', signal: AbortSignal.timeout(timeoutMs),
    });
    return linkTargets(res?.headers?.get?.('link'), REL.owner, podBase);
  } catch { return []; }
}

/**
 * Does anything answer at this pod?
 *
 * ---- asked by: a provisioning client, about a pod the person brought ----
 */
/**
 * Where a provider puts its pods: on hosts of their own, or on paths of one
 * shared host. No spec says. What does say is the storage description at the
 * provider's root: a CSS that keeps pods on subdomains answers 501 there,
 * because its root is not a storage; one that keeps them on paths answers 200
 * with the root described as a storage. Anything else is unknown.
 *
 * Decides, at sign-up, whether the address can live on the pod at all: a pod
 * on a path shares its host, so nothing there answers WebFinger for it.
 *
 * @returns 'host' | 'path' | null
 */
export async function podLayout(fetchImpl, providerOrigin, { timeoutMs = OWNER_LOOKUP_MS } = {}) {
  let origin;
  try { origin = new URL(providerOrigin).origin; } catch { return null; }
  let res;
  try {
    res = await fetchImpl(`${origin}/.well-known/solid`,
      { headers: { accept: 'text/turtle' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch { return null; }
  if (res.status === 501) return 'host';
  if (res.status !== 200) return null;
  let body = '';
  try { body = await readCapped(res, 64 * 1024); } catch { return null; }
  return /ns\/pim\/space#Storage|pim:Storage/u.test(body) ? 'path' : null;
}

export async function probeAnswers(podUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(podUrl, { method: 'HEAD' });
    return { ok: res.status < 400, status: res.status };
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
}

/**
 * One public document, read on behalf of someone who is not its owner.
 *
 * `getter` is how the read happens, which is not always a network fetch: a
 * component running inside the pod server reads its own store directly and has
 * no access control of its own, so the pod this read belongs to travels with
 * the request and the getter is told what it may reach.
 *
 * ---- asked by: a front publishing a pod's public face under its own name ----
 */
export async function readPublicDocument(getter, podTarget, { podHome, maxBytes = PUBLIC_DOC_MAX_BYTES } = {}) {
  const res = await getter(podTarget, { podHome });
  if (!res || res.status >= 400) return { status: res?.status || 502, text: null };
  return { status: 200, text: await readCapped(res, maxBytes) };
}
