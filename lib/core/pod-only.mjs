// pod-only.mjs — what stays on the pod, and only there, when an account works
// from a copy kept at its gateway (lib/gateway/copy.mjs): the signing key, the
// pod's own lease, and the passwords and tokens of accounts on other servers
// (`conn-*` as the vault names them, and the browser's two documents).
const CONNECTED = new Set(['fediaccts.json', 'atproto.json']);
export const podOnly = (name) => name === 'keys.json' || name === 'lease.json' || name.startsWith('conn-') || CONNECTED.has(name);
