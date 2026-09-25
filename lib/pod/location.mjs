// location.mjs — where in a pod an application's container goes.
//
// The container's own name is the caller's. The person says which container of
// their pod holds it, as a path on the pod's own origin: `/` for a pod at its
// own host, `/jeff/` for one on a path of a shared host, or any container below
// either. Everything then lives under `<that><name>`, and the root kept is that
// place relative to the pod.

// The pod's own furniture: its profile, its settings, its well-known documents.
const RESERVED = new Set(['profile', 'settings', '.well-known']);
const SEGMENT = /^[A-Za-z0-9._-]+$/u;

/** The prefilled answer: the pod's own root, as a path. */
export function podRootPath(podBase) {
  return new URL(podBase).pathname;
}

/**
 * The container path someone typed, checked against their pod. Returns
 * `{ root }` — the root relative to the pod, ending in `name` — or
 * `{ problem }` saying what is wrong, in words for them.
 */
export function rootFromContainer(podBase, typed, name) {
  const base = new URL(podBase);
  let path = String(typed ?? '').trim() || base.pathname;
  if (!path.startsWith('/')) path = '/' + path;
  if (!path.endsWith('/')) path += '/';
  if (!path.startsWith(base.pathname)) {
    return { problem: `that is not in your pod — your pod starts at ${base.pathname}` };
  }
  const inside = path.slice(base.pathname.length);
  const segments = inside.split('/').filter(Boolean);
  if (segments.some(s => s === '.' || s === '..')) return { problem: 'a container path cannot go up with ..' };
  if (segments.some(s => !SEGMENT.test(s))) {
    return { problem: 'container names are letters, digits, dots, dashes and underscores' };
  }
  if (segments.length && RESERVED.has(segments[0])) {
    return { problem: `${base.pathname}${segments[0]}/ belongs to your pod itself — choose another container` };
  }
  if (segments.length > 8) return { problem: 'that is nested too deep — eight containers at most' };
  return { root: (segments.length ? segments.join('/') + '/' : '') + name };
}

/** Where the account lives, in full: the pod plus its root. */
export const homeOf = (podBase, root) => podBase + root;

/** The root back from a pod actor's address: `<pod><root>ap/actor`. */
export function rootOfActor(podBase, actorUrl) {
  const a = String(actorUrl || '');
  if (!a.startsWith(podBase) || !a.endsWith('ap/actor')) return null;
  const root = a.slice(podBase.length, -'ap/actor'.length);
  return root.endsWith('/') ? root : null;
}
