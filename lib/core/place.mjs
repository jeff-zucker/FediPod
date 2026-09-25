// place.mjs — where on a pod a FediPod account lives, and recording it.
//
// The account's container is always named `fedipod`, inside a container its
// owner chose. The choice is recorded in their public type index as an
// instance of as:Actor (lib/pod/type-index.mjs), and that record is how the
// account is found again. An account made before the choice existed sits at
// `<pod>fedipod/` with no record, and is found there.

import * as typeIndex from '../pod/type-index.mjs';
import { rootFromContainer, rootOfActor } from '../pod/location.mjs';
import { DEFAULT_ROOT } from './wire.mjs';

export { podRootPath } from '../pod/location.mjs';

/** The container someone typed, as the account's root — or why it cannot be. */
export const chosenRoot = (podBase, typed) => rootFromContainer(podBase, typed, DEFAULT_ROOT);

/**
 * The roots of the accounts this pod's owner has recorded, then the place an
 * older account sits without a record. `pod` is a transport acting as the owner.
 */
export async function candidateRoots(pod, podBase) {
  const recorded = await typeIndex.registeredActors(pod, podBase).catch(() => []);
  const roots = recorded.map(a => rootOfActor(podBase, a)).filter(Boolean);
  return [...new Set([...roots, DEFAULT_ROOT])];
}

/**
 * The account on this pod: the first candidate whose config `read(root)` finds
 * and `accept(config)` takes. Null when there is none.
 */
export async function findAccount(pod, podBase, read, accept = () => true) {
  for (const root of await candidateRoots(pod, podBase)) {
    const config = await read(root).catch(() => null);
    if (config && accept(config)) return { root, config };
  }
  return null;
}

/**
 * Record the account's place in the owner's public type index. With no index,
 * one is made only when `create` is true — the person's own yes. Returns what
 * was done: 'registered', 'already', or 'no-index'.
 */
export async function recordPlace(pod, podBase, actorAtPod, { create = false } = {}) {
  let index = await typeIndex.findPublicIndex(pod, podBase);
  if (!index) {
    if (!create) return 'no-index';
    index = await typeIndex.createPublicIndex(pod, podBase);
  }
  return (await typeIndex.register(pod, index, actorAtPod)) ? 'registered' : 'already';
}

/** Whether this person's profile names a public type index. */
export async function hasPublicIndex(pod, podBase) {
  return !!(await typeIndex.findPublicIndex(pod, podBase).catch(() => null));
}
