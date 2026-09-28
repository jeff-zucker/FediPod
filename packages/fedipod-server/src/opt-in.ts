// opt-in.ts — what a pod owner asks of this server: to run their identity,
// to stop running it, and to say what their pod would be as an identity
// here; and reading who the server's own account session belongs to.

import { makeStoreSession } from './store-pod';
import { agentKey } from './directory';
import { PLACE, TRANSPORT, esmImport } from './fedipod';
import { deriveHandle, validateAgentPod } from './mounts';
import type { AgentClaim } from './mounts';
import { doorSecretFor, startIdentity } from './identities';
import type { FediPodServerHandler } from './handler';

/**
 * The WebIDs behind the account session in the request, or none. The server
 * keeps that session in a `css-account` cookie; its own account API is what
 * says which WebIDs the session owns, and it takes the same cookie. Nothing
 * here trusts the cookie's presence — the account API does the deciding, and
 * the caller picks the WebID that owns the pod being claimed.
 */
export async function webIdsFromSession(h: FediPodServerHandler,
  request: { headers: { get(name: string): string | null } }): Promise<string[]> {
  const s = h.internals();
  const cookie = request.headers.get('cookie');
  if (!cookie || !/(?:^|;\s*)css-account=/u.test(cookie)) return [];
  const base = s.args.frontOrigin.replace(/\/$/u, '');
  const asJson = { cookie, accept: 'application/json' };
  try {
    const index = await fetch(`${base}/.account/`, { headers: asJson });
    if (!index.ok) return [];
    const controls = (await index.json() as { controls?: { account?: { webId?: string } } }).controls;
    const webIdLink = controls?.account?.webId;
    if (!webIdLink) return [];
    const linked = await fetch(webIdLink, { headers: asJson });
    if (!linked.ok) return [];
    const links = (await linked.json() as { webIdLinks?: Record<string, unknown> }).webIdLinks ?? {};
    return Object.keys(links);
  } catch {
    return [];
  }
}

/**
 * A pod owner, already proven to control podBase, asks this server to run
 * their identity. Returns { httpStatus, ...body }; the secret appears in the
 * reply and nowhere else. Re-opting-in rotates the secret — that is how a
 * lost one is recovered.
 */
export async function optInPod(h: FediPodServerHandler, { podBase, webId, container = '', createIndex = false }:
{ podBase: string; webId: string; container?: string; createIndex?: boolean }):
Promise<Record<string, unknown> & { httpStatus: number }> {
  const s = h.internals();
  if (!s.registry) return { httpStatus: 501, error: 'this server does not offer runtime opt-in' };
  if (s.args.clusterManager && !s.args.clusterManager.isSingleThreaded()) {
    return { httpStatus: 503, error: 'runtime opt-in needs a single-worker server (--workers 1)' };
  }
  const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
  const handle = deriveHandle(base);
  // Already running here from an earlier opt-in: proving pod
  // control again buys a fresh secret, nothing else.
  if (s.agentHandles.get(handle) === base) {
    const door = await doorSecretFor(h, base, undefined, { rotate: true });
    s.doorSecrets.set(base, door.secret);
    return { httpStatus: 201, ok: true, handle, host: new URL(base).host.toLowerCase(),
      doorSecret: door.secret, doorPath: s.uiPath, status: 'rotated' };
  }

  let claim: AgentClaim;
  try {
    claim = validateAgentPod(h, base);
  } catch (e: unknown) {
    return { httpStatus: 409, error: (e as Error).message };
  }
  const { host } = claim;
  // Where on the pod: the container its owner named holds `fedipod/`. The
  // place is recorded in their public type index — made only on their yes —
  // before anything else is written, and read here with the server's own
  // access to the pod.
  const place = await esmImport(PLACE) as {
    chosenRoot: (base: string, typed: string) => { root?: string; problem?: string };
    hasPublicIndex: (pod: unknown, base: string) => Promise<boolean>;
    recordPlace: (pod: unknown, base: string, actor: string, o: { create: boolean }) => Promise<string>;
  };
  const chosen = place.chosenRoot(base, container);
  if (chosen.problem || !chosen.root) return { httpStatus: 400, error: `Where to store it: ${chosen.problem}.` };
  const root = chosen.root;
  const { PodTransport } = await esmImport(TRANSPORT) as unknown as {
    PodTransport: new (session: unknown, o: { webId: string }) => unknown;
  };
  const pod = new PodTransport(makeStoreSession(s.args.resourceStore, base), { webId });
  if (!createIndex && !await place.hasPublicIndex(pod, base)) {
    return { httpStatus: 409, code: 'needs-index',
      error: 'Your pod has no public type index, the list Solid apps use to find your things. '
        + 'FediPod needs one to record where your account lives.' };
  }
  try {
    await place.recordPlace(pod, base, `${base}${root}ap/actor`, { create: createIndex });
  } catch (e: unknown) {
    return { httpStatus: 500, error: `could not record where the account lives in your type index (${(e as Error).message})` };
  }
  s.roots.set(base, root);
  try {
    await s.registry.add({ podBase: base, handle, host, webId, root, optedInAt: new Date().toISOString() });
  } catch (e: unknown) {
    s.logger.error(`opt-in row for ${base} could not be written: ${(e as Error).message}`);
    return { httpStatus: 500, error: 'could not record the opt-in' };
  }
  // From this instant the pod's identity routes answer 503 instead of LDP,
  // until the agent registers its surface.
  s.claimed.set(base, claim);
  s.agentHandles.set(handle, base);
  const door = await doorSecretFor(h, base, undefined, { rotate: true });
  s.doorSecrets.set(base, door.secret);
  void startIdentity(h, base);
  s.logger.info(`runtime opt-in: @${handle} on ${base} (door secret in its pod at ${door.url})`);
  return { httpStatus: 201, ok: true, handle, host,
    doorSecret: door.secret, doorPath: s.uiPath, status: 'starting' };
}

/**
 * What a pod would be as an identity here, without changing anything: its
 * handle, the host its address carries, and whether it runs here already.
 */
export async function describePod(h: FediPodServerHandler, { podBase }: { podBase: string }):
Promise<{ handle: string; host: string; address: string; running: boolean; manage: string }> {
  const s = h.internals();
  const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
  const handle = deriveHandle(base);
  let host: string;
  try { host = validateAgentPod(h, base).host; } catch { host = new URL(base).host.toLowerCase(); }
  const running = s.agentHandles.get(handle) === base;
  // The management page's door takes its key once in the address and keeps
  // the browser in with a cookie. Only the owner's own page ever asks for
  // this description, so the key rides on the link for a running account.
  // Read from the pod, where the key always is, rather than from what this
  // process happens to hold: an account still starting has none in memory.
  let key: string | undefined;
  if (running) {
    try { key = (await doorSecretFor(h, base)).secret; } catch { key = s.doorSecrets.get(base); }
  }
  const door = base.replace(/\/$/u, '') + s.uiPath;
  return { handle, host, address: `@${handle}@${host}`, running,
    manage: key ? `${door}?dk-token=${encodeURIComponent(key)}` : door };
}

/** The reverse: stop the identity and let the pod be plain LDP again. */
export async function optOutPod(h: FediPodServerHandler, { podBase }: { podBase: string }):
Promise<Record<string, unknown> & { httpStatus: number }> {
  const s = h.internals();
  if (!s.registry) return { httpStatus: 501, error: 'this server does not offer runtime opt-in' };
  const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
  const host = new URL(base).host.toLowerCase();
  const key = agentKey(host, base);
  const row = await s.registry.get(key);
  if (!row || row.podBase !== base) return { httpStatus: 404, error: 'this pod has not opted in' };
  s.claimed.delete(base);                         // routes fall to LDP now
  s.startCancelled.add(base);                    // a pending start stands down
  const identity = s.identities.get(base);
  s.identities.delete(base);
  s.surfaces.delete(base);
  s.agentHandles.delete(row.handle);
  s.doorSecrets.delete(base);
  if (identity) await identity.stop();
  await s.registry.remove(key);
  s.logger.info(`runtime opt-out: @${row.handle} on ${base} — the pod serves plain LDP again`);
  return { httpStatus: 200, ok: true, stopped: Boolean(identity) };
}
