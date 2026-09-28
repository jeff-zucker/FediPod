// mounts.ts — which pod a request belongs to. A claim is a pod whose routes
// this server answers for, matched by host and by mount: the pod's own path,
// `''` for a host-root or subdomain pod, `/aisha` for a suffix pod on
// `https://host/aisha/`. claims.ts says which PATHS are an identity's; this
// says which POD.

import { DEFAULT_RUN_PATH } from './claims';
import type { FediPodServerHandler } from './handler';

/**
 * A pod this server claims the routes of, whether or not its identity has
 * finished starting. A request belongs to this claim when its host matches
 * and its path is at or under the mount.
 */
export interface AgentClaim {
  host: string;
  mount: string;
  podBase: string;
  handle: string;
}

/** The pod's path as a mount prefix: `''` for a host root, else `/aisha`. */
export function mountOf(podBase: string): string {
  return new URL(podBase).pathname.replace(/\/+$/u, '');
}

/** Whether `a` is `b` or an ancestor path of `b` (both mount-shaped, no trailing slash). */
export function pathContains(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a === '';
}

/** The identity's name, from its pod URL. Mirrors handleFor in fedipod/embed. */
export function deriveHandle(podBase: string): string {
  const u = new URL(podBase);
  const segments = u.pathname.split('/').filter((seg) => seg.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : u.hostname.split('.')[0];
}

/** The opt-in page's path: leading slash, no trailing one, the default when unset. */
export function normalizeRunPath(raw?: string): string {
  const said = String(raw ?? '').trim().replace(/\/+$/u, '');
  if (!said) return DEFAULT_RUN_PATH;
  return said.startsWith('/') ? said : `/${said}`;
}

/** A door path always has both slashes, so claiming and stripping agree. */
export function normalizeUiPath(raw?: string): string {
  if (raw === '') return '';
  const path = raw ?? '/fp/';
  return `/${path.replace(/^\/+|\/+$/gu, '')}/`;
}

/**
 * Whether this pod may become an identity here, and the claim it earns: a
 * real URL, a place no other identity already sits, and a handle no other
 * identity uses — two pods must never share <agentDataDir>/<handle>/.
 *
 * A HOST-ROOT or subdomain pod needs an origin of its own, and it may not be
 * the front's host: the whole surface answers at the origin root, so two of
 * them, or one sharing the front, would collide. A SUFFIX pod lives on a path
 * (`server/aisha/`), so it may share its host — with the front and with other
 * suffix pods — provided no claim already contains or nests under its path.
 */
export function validateAgentPod(h: FediPodServerHandler, podBase: string): AgentClaim {
  const s = h.internals();
  let host: string;
  let mount: string;
  try {
    const u = new URL(podBase);
    host = u.host.toLowerCase();
    mount = mountOf(podBase);
  } catch {
    throw new Error(`not a pod URL: ${podBase}`);
  }
  if (mount === '') {
    // A pod at the root of its host: it owns the whole origin, so it cannot
    // share it with the front or with any other claim.
    if (host.split(':')[0] === String(s.frontHost).toLowerCase()) {
      throw new Error(`${podBase} is on the front's own host — give the identity its own origin, or host it on a path`);
    }
    for (const c of s.claimed.values()) {
      if (c.host === host) {
        throw new Error(`the host ${host} already carries an identity — a host-root identity needs an origin of its own`);
      }
    }
  } else {
    // A pod on a path: it owns only its subtree. Refuse anything that already
    // contains it or that it would contain, so no identity can answer under
    // another's path (and none straddles the front's own routes underneath).
    for (const c of s.claimed.values()) {
      if (c.host !== host) continue;
      if (pathContains(c.mount, mount) || pathContains(mount, c.mount)) {
        throw new Error(`${podBase} nests with the identity already at ${c.podBase} — a suffixed pod owns only its own subtree`);
      }
    }
  }
  const handle = deriveHandle(podBase);
  const holder = s.agentHandles.get(handle);
  if (holder && holder !== podBase) {
    throw new Error(`the name ${handle} already belongs to ${holder} — two identities cannot share it`);
  }
  return { host, mount, podBase, handle };
}

/**
 * The claim a request belongs to, or null. A request matches when its host is
 * the claim's host and its path is at or under the claim's mount; the deepest
 * mount wins, so a suffix pod's own routes are never swallowed by a shallower
 * claim on the same host.
 */
export function resolveClaim(h: FediPodServerHandler, host: string, pathname: string): AgentClaim | null {
  const s = h.internals();
  let best: AgentClaim | null = null;
  for (const c of s.claimed.values()) {
    if (c.host !== host) continue;
    if (c.mount === '' || pathname === c.mount || pathname.startsWith(c.mount + '/')) {
      if (!best || c.mount.length > best.mount.length) best = c;
    }
  }
  return best;
}

/** A request path relative to a mount: `/aisha/ap/actor` under `/aisha` → `/ap/actor`. */
export function stripMount(pathname: string, mount: string): string {
  if (!mount) return pathname;
  return pathname.slice(mount.length) || '/';
}
