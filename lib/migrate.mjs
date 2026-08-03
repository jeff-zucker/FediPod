// Keeping every identity on this machine at the current shape of an install.
//
// bbba587 fixed the DEFAULT: a new install keeps its private half — timeline,
// contacts, blocklist, notifications, masto-tokens.json — on this machine.
// It did nothing for the installs that already existed, and `privateRoot`
// absent still means "on the pod" (run-agent.mjs privateUrls). So an identity
// set up before that commit still writes every state change to a pod, and
// still keeps its private data on a server.
//
// A new default only ever fixes the installs that do not exist yet. That is the
// reason this file exists rather than a one-off script: a change to install
// shape ships as a numbered step HERE, and `activitypod upgrade` runs the
// pending ones over every identity under the root, not just the one you
// happened to be in.

// Bump when a step is added, and add the step to pendingSteps below.
export const CURRENT_LAYOUT = 1;

// 0 is "never stamped", which is every install made before this file existed.
// It is not the same as "wrong": an old install may already be in the right
// shape, and pendingSteps is what decides, per step.
export const layoutOf = (cred) => Number(cred?.layout) || 0;

// Layout 1 — the private half lives on this machine.
//
// Only when `privateRoot` is ABSENT. An operator who pointed it somewhere
// deliberately, with `--private-root`, has said where they want it; a migration
// that overrode that would be moving data on its own initiative.
export function needsStateMove(cred) {
  return !cred?.privateRoot;
}

export function pendingSteps(cred) {
  const steps = [];
  if (needsStateMove(cred)) {
    steps.push({
      id: 'state-off-pod',
      what: 'move the private half off the pod, onto this machine',
      why: 'receiving a post costs pod writes, and the timeline lives on a server',
    });
  }
  return steps;
}

// True when there is nothing left to do and the stamp can be written.
export const isCurrent = (cred) => pendingSteps(cred).length === 0;

// The documents on the pod that the state tree consists of — everything the
// move copied. Deliberately NOT "everything in the container":
//
//   lease.json stays. It is the single-active-agent lock, and it is on the pod
//   precisely BECAUSE the private half is not: a lease only one machine can
//   reach coordinates nothing. run-agent builds it from urls.state, never from
//   privateRoot, so it goes on being used after the move.
//
//   .keep and .acl belong to the container, which also stays — the container is
//   what carries the owner-only ACL that lease.json sits behind.
//
// RemotePod.delete's deny-list is the backstop under all of this; this list is
// what we affirmatively claim, and the two disagreeing is a bug worth hearing
// about rather than a file quietly surviving.
export const MOVED_STATE_DOCS = new Set([
  'config.json', 'queue.json', 'blocklist.json', 'contacts.json', 'muted.json',
  'pending.json', 'requests.json', 'deadletter.json', 'statuses.json',
  'notifications.json', 'media.json', 'actors.json', 'ids.json', 'published.json',
  'outbox.json', 'outbox-removed.json', 'parked.json', 'tagfeed.json',
  'intake-attempts.json', 'inbox-channel.json', 'masto-tokens.json', 'masto-markers.json',
]);

export const KEPT_ON_POD = new Set(['lease.json', '.keep']);

// What `state --drop-remote` would remove, given a container listing. Split out
// so the decision can be tested without a pod, and so the caller can show it
// before doing anything.
export function classifyRemoteState(urls, base) {
  const drop = [];
  const keep = [];
  for (const u of urls) {
    const name = String(u).slice(String(base).length).replace(/^\/+/, '');
    if (!name || name.includes('/')) { keep.push({ url: u, name, why: 'not a document of this container' }); continue; }
    if (KEPT_ON_POD.has(name)) {
      keep.push({ url: u, name, why: name === 'lease.json' ? 'the lease stays on the pod by design' : 'the container needs it' });
    } else if (MOVED_STATE_DOCS.has(name)) {
      drop.push({ url: u, name });
    } else {
      keep.push({ url: u, name, why: 'not one of ours' });
    }
  }
  return { drop, keep };
}
