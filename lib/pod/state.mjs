// state.mjs — ap-state/: what the agent knows, kept where the agent is not.
//
// A browser has no disk you can carry to the next machine, so the durable copy
// of an identity's state lives on its pod. Most of that tree is handled by a
// caching store; what is here is the two documents read and written OUTSIDE
// it, before there is a store to read them with.
//
// The container is owner-only, and every operation here assumes that has
// already been established — see provisionKey, which is the one place that
// establishes it, and does so in an order that is not negotiable.

// ---- the owner's agent ----

export const readKeys = (pod, urls) => pod.getJson(urls.state + 'keys.json');
export const readConfig = (pod, urls) => pod.getJson(urls.state + 'config.json');

export const writeKeys = (pod, urls, keys) =>
  pod.putJson(urls.state + 'keys.json', keys, 'application/json');
export const writeConfig = (pod, urls, config) =>
  pod.putJson(urls.state + 'config.json', config, 'application/json');

// ---- a provisioning client, setting an identity up for the first time ----

/**
 * Lock the state container, THEN write the signing key into it.
 *
 * The order is the operation. Writing the key first leaves a window in which a
 * pod whose root is world-readable serves it to anyone who asks — and a pod
 * the person brought with them is exactly the case where that root may be
 * public. As two statements this was two chances to get it wrong; as one
 * operation there is nowhere to put them in the other order.
 *
 * The keys record is stored as it is: the container's access rule is what
 * keeps it to the owner, the same rule every private document on the pod
 * lives under.
 */
export async function provisionKey(pod, { stateUrl, keysUrl, keys }) {
  await pod.setAcl(stateUrl, []);
  await pod.putJson(keysUrl, keys, 'application/json');
}
