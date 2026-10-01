// pod-only.mjs — which state documents live where, when an account works from
// a copy kept at its gateway (lib/gateway/copy.mjs).
//
// Pod only: the signing key, the pod's own lease, and the passwords and tokens
// of accounts on other servers.
export const podOnly = (name) => name === 'keys.json' || name === 'lease.json' || name.startsWith('conn-');

// The slim copy: what the gateway needs to work for an account while its owner
// is away (accept follows, send scheduled posts and retries), and nothing it
// does not. The account's settings are not in it: the gateway reads their
// public part, which the owner's FediPod keeps beside it (PUBLIC_CONFIG).
export const SLIM_DOCS = new Set([
  'contacts.json', 'requests.json', 'blocklist.json', 'queue.json', 'deadletter.json', 'scheduled.json',
  'actors.json', 'published.json', 'outbox.json', 'outbox-removed.json', 'outbox-own.json', 'liked.json',
  'counts.json', 'poll-votes.json', 'intake-attempts.json', 'forwarded.json', 'c2s-seen.json',
]);

// The settings the gateway's work for an account reads, every one of them
// public already (in the actor, the profile, or the account's addresses) or
// the gateway's own. Checked against the code on 2026-09-30; a field added to
// the settings stays on the pod unless it is added here on purpose.
export const PUBLIC_CONFIG_FIELDS = [
  'handle', 'name', 'summary', 'icon', 'image', 'fields', 'aliases', 'createdAt', 'movedTo', 'movedFrom',
  'quiescedAt', 'autoAcceptFollows', 'remotePod', 'root', 'inboxUrl', 'gateway', 'kind',
];
export const PUBLIC_CONFIG = 'config-public.json';
export const publicConfig = (config) =>
  Object.fromEntries(PUBLIC_CONFIG_FIELDS.filter((k) => config?.[k] !== undefined).map((k) => [k, config[k]]));
