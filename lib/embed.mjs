// embed.mjs — the agent, running inside the pod server that holds its pod.
//
// Nothing here reimplements the agent: it is the same Agent class, the same
// intake, deliverer, publisher and lease. What changes is the transport. The
// caller hands in a session that reaches the pod through the server's own
// store, and RemotePod takes it instead of minting a credential — so an
// identity acts on its pod with no token, no socket, and no second process.
//
// The one thing a pod server can do that a laptop cannot is notice a write the
// moment it happens, so the notification socket is replaced by the store's own
// change events.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createRequire } from 'node:module';

import { Agent } from '../run-agent.mjs';
import { RemotePod } from './remote.mjs';
import { apUrls } from './wire.mjs';
import { writeJsonAtomic } from './home.mjs';
import { buildAdminSurface } from './admin.mjs';
import { FixedAuthorities } from './guard.mjs';

const require = createRequire(import.meta.url);
const { makeGate } = require('../vendor/gate.cjs');

// How long to gather store events before draining, so a delivery of several
// items costs one sweep rather than one each.
const DRAIN_COALESCE_MS = 250;

// How every secret in this project is minted (the attach flow's recipe).
const mintSecret = () => crypto.randomBytes(32).toString('base64');

/**
 * The secret guarding one identity's owner door, kept beside its signing key.
 * Minted when absent; `rotate` re-mints over an existing one — which is how a
 * lost secret is recovered, by proving pod control again. Never logged.
 */
export function ensureDoorSecret(dataDir, handle, { rotate = false } = {}) {
  const home = path.join(dataDir, handle);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'door-secret.json');
  if (!rotate) {
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (rec?.secret) return { secret: rec.secret, path: file, rotated: false };
    } catch { /* absent or unreadable: mint below */ }
  }
  const rec = { secret: mintSecret(), mintedAt: new Date().toISOString() };
  writeJsonAtomic(file, rec, { mode: 0o600 });
  return { secret: rec.secret, path: file, rotated: rotate };
}

/** The identity's name: a subdomain pod is its label, a path pod its last segment. */
export function handleFor(podBase) {
  const u = new URL(podBase);
  const segments = u.pathname.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : u.hostname.split('.')[0];
}

/**
 * The credential file an embedded identity runs on. It names the pod and
 * nothing else: there is no client id and no secret, because there is nobody
 * to authenticate to. Absent `privateRoot`, so the state tree stays on the pod.
 */
function ensureCredential(home, { podBase, webId }) {
  const file = path.join(home, 'credential.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { /* first run for this identity */ }
  const rec = {
    webId,
    remotePod: podBase.endsWith('/') ? podBase : podBase + '/',
    root: 'activitypods-js/',
  };
  writeJsonAtomic(file, rec, { mode: 0o600 });
  return rec;
}

/**
 * Bring one identity up inside the server.
 *
 * `session` is the store-backed transport ({ fetch, warmup, stats }).
 * `resourceStore` is optional and used only to watch for inbox writes.
 * Returns the running agent and a stop() that leaves the pod tidy.
 */
export async function startEmbeddedAgent({
  podBase,
  dataDir,
  session,
  resourceStore = null,
  webIdSuffix = 'profile/card#me',
  log = () => {},
  pollSeconds = null,
  autoAcceptFollows = true,
  gateToken = null,
  uiPath = '/app/',
}) {
  const base = podBase.endsWith('/') ? podBase : podBase + '/';
  const handle = handleFor(base);
  const home = path.join(dataDir, handle);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const webId = base + webIdSuffix.replace(/^\//u, '');
  const cred = ensureCredential(home, { podBase: base, webId });

  const agent = new Agent({ home, log });
  agent.log = log;
  agent.store.log = log;
  // Read by connect() when it builds Intake: in-process, the pod's own change
  // events are the push channel.
  agent.embedded = true;
  if (pollSeconds) agent.pollSeconds = pollSeconds;
  agent.remote = new RemotePod(cred, { log, session });
  await agent.remote.warmup();

  // Whether this pod already carries an identity is the question connect()
  // assumes an answer to, so settle it first.
  const urls = apUrls(cred.remotePod, cred.root);
  agent.store.attach(agent.privateStorage(cred, 'state', urls));

  // A state container that is NOT THERE means a pod nobody has set up yet. A
  // state container we could not READ means a pod we could not ask, which is a
  // different answer: treating it as empty would provision a second identity
  // over the top of a working one.
  const state = await agent.remote.fetch(urls.state, { headers: { accept: 'text/turtle' } });
  const unprovisioned = state.status === 404 || state.status === 410;
  if (!unprovisioned && state.status >= 400) {
    throw new Error(`state at ${urls.state} → ${state.status} — cannot tell whether this pod is set up`);
  }
  if (!unprovisioned) {
    await agent.store.load();
    agent.stateLoaded = true;
  }

  if (!agent.store.getConfig()) {
    // The pod itself must exist first. A server creates its seeded pods after
    // it runs its initializers, so an agent that provisioned eagerly would
    // leave a container tree exactly where a pod is about to be created.
    const profile = await agent.remote.fetch(webId.split('#')[0], { headers: { accept: 'text/turtle' } });
    if (profile.status === 404 || profile.status === 410) {
      throw new Error(`no pod at ${base} yet — its owner profile is not there`);
    }
    log(`no identity on ${base} yet — provisioning @${handle}`);
    await agent.bootstrap({ handle, name: handle, kind: 'person' });
    if (autoAcceptFollows) {
      agent.store.setConfig({ ...agent.store.getConfig(), autoAcceptFollows: true });
      await agent.store.flush();
    }
    agent.stateLoaded = true;
  }

  await agent.connect();

  // The client surfaces, on the pod's own origin: the Mastodon API a phone app
  // speaks, the write API, nodeinfo, and behind the door the admin routes and
  // the web client. Same code the standalone agent serves, minus the routes
  // that only mean something to a process of one's own.
  const authorities = new FixedAuthorities(base);
  agent.authorities = authorities;
  const surface = buildAdminSurface({
    agent,
    log,
    gate: makeGate(gateToken, { secureCookie: authorities.secure }),
    allowed: authorities,
    embedded: true,
    basePath: uiPath,
    publicOrigin: base,
    scheme: new URL(base).protocol,
  });

  // A delivery landing in the inbox — through the door, or from any other
  // writer — wakes the drain at once. Only additions, and only in the inbox:
  // the drain's own DELETEs must not call it back.
  let coalesce = null;
  let onChanged = null;
  if (typeof resourceStore?.on === 'function') {
    const inbox = urls.inbox;
    onChanged = (identifier, activity) => {
      const kind = String(activity?.value ?? activity ?? '');
      if (!identifier?.path?.startsWith(inbox)) return;
      if (!kind.endsWith('Create') && !kind.endsWith('Add')) return;
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        if (!agent.viewer) agent.intake?.drain().catch((e) => log(`drain: ${e.message}`));
      }, DRAIN_COALESCE_MS);
      coalesce.unref?.();
    };
    resourceStore.on('changed', onChanged);
  }

  const stop = async () => {
    if (onChanged) resourceStore.off('changed', onChanged);
    surface.streaming?.stop?.();
    clearTimeout(coalesce);
    agent.intake?.stop();
    agent.tagfeed?.stop();
    agent.bskyfeed?.stop();
    agent.deliverer?.stop();
    agent.importer?.stop();
    clearInterval(agent.schedTimer);
    clearInterval(agent.refreshTimer);
    // Same order the standalone agent's shutdown uses: write what is pending,
    // then let go of the lease so the next agent need not wait out the TTL.
    await Promise.allSettled([
      agent.store.flush(),
      agent.viewer ? Promise.resolve() : agent.lease?.release(),
    ]);
  };

  return { agent, handle, home, surface, host: authorities.host, stop };
}
