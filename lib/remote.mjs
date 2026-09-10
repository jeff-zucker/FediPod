// remote.mjs — the Node agent's pod transport: CSS client-credentials + DPoP
// (vendor/idp-grant.cjs, extracted from data-kitchen's "remember this IdP"
// machinery — plain Node, no Electron).
//
// Everything about talking to a pod — the verbs, the ACL documents, the
// deletion deny-list, the Retry-After cooldown, the container listing — lives
// in lib/pod/transport.mjs, which knows nothing about Node and is shared with
// the browser. What is left here is the one thing that genuinely differs: how
// the session is obtained. That top-level `require` of the vendor grant is also
// exactly why the split exists — it cannot be bundled for a service worker.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PodTransport } from './pod/transport.mjs';

const require = createRequire(import.meta.url);
const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor');
const { mintCredential, discoverTokenEndpoint, createGrantSession, revokeCredentialViaAccount } =
  require(path.join(vendorDir, 'idp-grant.cjs'));

export { mintCredential, discoverTokenEndpoint, revokeCredentialViaAccount };

// Re-exported so the callers that guard their own deletions — run-agent, the
// server package's live test, the smoke suite — keep importing it from here.
export { protectedFromDeletion } from './pod/transport.mjs';

export class RemotePod extends PodTransport {
  constructor(credential, { log = () => {}, home = null, session = null, role = 'agent' } = {}) {
    // An injected session replaces the credential-backed one, and everything
    // above it — the cooldown, the deny-list, the url map — is unchanged. That
    // is how the agent runs inside a pod server: same class, no token to mint.
    super(session || createGrantSession(credential, home ? {
      backoffFile: path.join(home, 'backoff.json'),
      tokenFile: path.join(home, 'token.json'),
    } : {}), {
      webId: credential.webId,
      log,
      role,
      runtime: 'node',
      // Fail fast for the window rather than sleeping it out: a daemon has
      // timers behind it, and a request that waits is a timer that does not
      // fire. The callers' existing retry paths take it from there.
      cooldownMode: 'refuse',
    });
  }

  async warmup() { return this.session.warmup(); }

  /** The grant's own counters, under the transport's. */
  stats() {
    return { ...(this.session.stats?.() || {}), ...super.stats() };
  }
}
