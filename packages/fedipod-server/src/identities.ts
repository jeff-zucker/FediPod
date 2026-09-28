// identities.ts — the identities this server runs: started when the server
// boots or an owner opts in, retried while a pod is still being created,
// stopped together at shutdown, and each given its address at the apex and
// its door secret in its pod.

import { randomBytes } from 'node:crypto';
import { makeStoreSession } from './store-pod';
import { frontRow } from './directory';
import { EMBED, esmImport } from './fedipod';
import { deriveHandle, validateAgentPod } from './mounts';
import type { AgentClaim } from './mounts';
import type { FediPodServerHandler } from './handler';

/** One running identity, and the call that stops it. */
export interface EmbeddedIdentity {
  handle: string;
  host: string;
  /** Where the identity's own tree begins on its pod, and the actor inside it. */
  podHome: string;
  actorUrl: string;
  surface: { handler: (req: unknown, res: unknown) => Promise<void>; streaming?: unknown };
  stop: () => Promise<void>;
  agent?: {
    store?: { getConfig?: () => { kind?: string } | null | undefined; getContacts?: () => { followers?: { actor?: string }[] } };
    urls?: { followers?: string; toPod?: (u: string) => string };
  };
}

// A pod that will not come up yet is usually a pod still being created by the
// server that is booting. Keep asking, slower each time, up to a few minutes.
const START_RETRY_MS = [ 2_000, 5_000, 15_000, 60_000, 300_000 ];

/**
 * Whether identities run in this process. They run in one: the lease admits
 * a single drainer, and the state each one holds is in memory. With workers,
 * that process is the primary — which serves no requests, so every process
 * still has to know which hosts belong to an identity even though only one
 * of them can answer for it.
 */
export function runsIdentities(h: FediPodServerHandler): boolean {
  const s = h.internals();
  const cluster = s.args.clusterManager;
  return !cluster || cluster.isSingleThreaded() || cluster.isPrimary();
}

/**
 * Start an agent for each opted-in pod. Runs before the server listens, so
 * the identities come up in the background and boot is never held on a pod.
 */
export async function initialize(h: FediPodServerHandler): Promise<void> {
  const s = h.internals();
  if (!s.registry) return;
  const runs = runsIdentities(h);
  // The stock CSS CLI installs no signal handlers, so a SIGTERM (systemd
  // stop, docker stop, Ctrl+C) killed the process with agent state
  // unflushed and the lease held for its whole TTL. Flush first, bounded,
  // then re-raise so the process still dies the way it was asked to.
  if (runs && !s.onSignal) {
    s.onSignal = (signal: NodeJS.Signals): void => {
      const timeout = new Promise((resolve) => { setTimeout(resolve, 5_000).unref?.(); });
      void Promise.race([ finalize(h), timeout ]).then(() => {
        process.kill(process.pid, signal);
      });
    };
    process.once('SIGTERM', s.onSignal);
    process.once('SIGINT', s.onSignal);
  }
  // Identities run in the primary, and requests are answered by the workers,
  // so with more than one worker an identity federates but cannot be reached:
  // its client API, its owner pages and its live feed are in a process no
  // request arrives at. Said once, by the process that has them.
  if (runs && s.args.clusterManager && !s.args.clusterManager.isSingleThreaded()) {
    s.logger.warn('FediPod is running in a multi-worker server. Deliveries are picked up by the inbox '
      + 'sweep rather than as they land, and no identity can answer its client API, its live feed or its '
      + "owner's pages while requests are served by other processes. Run with --workers 1.");
  }
  // Awaited, and BEFORE the server listens: a pod whose owner opted in must
  // have its routes claimed from the first request after a restart, never
  // served briefly by LDP. A failed load must not fail the boot — the rows
  // persist, and the next start recovers them.
  const pods: string[] = [];
  try {
    const keys = await s.registry.listKeys();
    for (const key of keys) {
      const row = await s.registry.get(key);
      if (!row) continue;
      if (s.claimed.has(row.podBase) || s.identities.has(row.podBase)) continue;   // already claimed
      let claim: AgentClaim;
      try {
        claim = validateAgentPod(h, row.podBase);
      } catch (e: unknown) {
        s.logger.error(`opted-in pod ${row.podBase} no longer valid: ${(e as Error).message}`);
        continue;
      }
      s.claimed.set(row.podBase, claim);
      s.agentHandles.set(row.handle, row.podBase);
      s.roots.set(row.podBase, row.root || 'fedipod/');
      pods.push(row.podBase);
    }
  } catch (e: unknown) {
    s.logger.error(`could not read the opt-in registry — opted-in identities are absent this boot: ${
      (e as Error).message}`);
  }
  if (pods.length > 0) {
    s.logger.info(runs
      ? `FediPod agent enabled for ${pods.length} opted-in pod(s)`
      : `FediPod claimed the routes of ${pods.length} opted-in pod(s); they are run elsewhere`);
  }
  // Claimed everywhere, run in one place. A process that does not run them
  // must still not let a pod answer for a path that belongs to an identity.
  if (runs) for (const pod of pods) void startIdentity(h, pod);
}

/** Stop every identity: timers cleared, state written, lease let go. */
export async function finalize(h: FediPodServerHandler): Promise<void> {
  const s = h.internals();
  s.stopping = true;
  if (s.onSignal) {
    process.removeListener('SIGTERM', s.onSignal);
    process.removeListener('SIGINT', s.onSignal);
    s.onSignal = null;
  }
  const running = [ ...s.identities.values() ];
  s.identities.clear();
  s.surfaces.clear();
  s.doorSecrets.clear();
  s.starting.clear();
  await Promise.allSettled(running.map(async (identity) => {
    await identity.stop();
    s.logger.info(`FediPod agent @${identity.handle} stopped`);
  }));
}

/**
 * One identity's door secret, in its own pod's state. `agentDataDir` is
 * handed in as the place an identity set up before this kept it, so its
 * owner's existing door link survives the move.
 */
export async function doorSecretFor(h: FediPodServerHandler, podBase: string, session?: { fetch: unknown },
  opts: { rotate?: boolean } = {}): Promise<{ secret: string; url: string; rotated: boolean }> {
  const s = h.internals();
  const { ensureDoorSecret } = await esmImport(EMBED) as {
    ensureDoorSecret: (session: unknown, podBase: string, opts?: Record<string, unknown>) =>
    Promise<{ secret: string; url: string; rotated: boolean }>;
  };
  return ensureDoorSecret(session ?? makeStoreSession(s.args.resourceStore, podBase), podBase, {
    ...opts,
    root: s.roots.get(podBase) ?? 'fedipod/',
    dataDir: s.args.agentDataDir,
    handle: deriveHandle(podBase),
    log: (message: string): void => { s.logger.info(`@${deriveHandle(podBase)}: ${message}`); },
  });
}

export async function startIdentity(h: FediPodServerHandler, podBase: string): Promise<void> {
  const s = h.internals();
  if (s.starting.has(podBase) || s.identities.has(podBase)) return;
  s.starting.add(podBase);
  s.startCancelled.delete(podBase);
  const session = makeStoreSession(s.args.resourceStore, podBase);
  try {
    for (let attempt = 0; !s.stopping && !s.startCancelled.has(podBase); attempt++) {
      try {
        const { startEmbeddedAgent } = await esmImport(EMBED) as {
          startEmbeddedAgent: (opts: Record<string, unknown>) => Promise<EmbeddedIdentity>;
        };
        // The secret is in the map BEFORE the surface can exist, so the
        // gate's resolver never comes up empty — empty would mean gate-off.
        if (!s.doorSecrets.has(podBase)) {
          const door = await doorSecretFor(h, podBase, session);
          s.doorSecrets.set(podBase, door.secret);
          s.logger.info(`door secret for @${deriveHandle(podBase)} is in its pod at ${door.url}`);
        }
        const identity = await startEmbeddedAgent({
          podBase,
          root: s.roots.get(podBase) ?? 'fedipod/',
          dataDir: s.args.agentDataDir,
          session,
          resourceStore: s.args.resourceStore,
          webIdSuffix: s.args.agentWebIdSuffix ?? 'profile/card#me',
          pollSeconds: s.args.agentPollSeconds ?? null,
          autoAcceptFollows: s.args.agentAutoAcceptFollows !== false,
          gateToken: (): string | undefined => s.doorSecrets.get(podBase),
          uiPath: s.uiPath,
          log: (message: string): void => {
            s.logger.info(message);
          },
        });
        // Stopped, or opted out, while this one was still coming up.
        if (s.stopping || s.startCancelled.has(podBase)) {
          await identity.stop();
          return;
        }
        s.identities.set(podBase, identity);
        s.surfaces.set(podBase, identity);
        s.logger.info(`FediPod agent @${identity.handle} running on ${podBase}`);
        // A suffix pod cannot answer WebFinger for itself — its host root is
        // the front's — so it is followable ONLY through the door's apex
        // dispatch. Front it whether or not auto-front is on: the row is the
        // whole of what makes @handle@host resolve to it.
        if (s.args.agentAutoFront || s.claimed.get(podBase)?.mount) {
          await frontIdentity(h, podBase, identity);
        }
        return;
      } catch (e: unknown) {
        const wait = START_RETRY_MS[Math.min(attempt, START_RETRY_MS.length - 1)];
        s.logger.warn(`FediPod agent for ${podBase} did not start: ${(e as Error).message
        } — retrying in ${Math.round(wait / 1000)}s`);
        await new Promise((resolve) => {
          setTimeout(resolve, wait).unref?.();
        });
      }
    }
  } finally {
    s.starting.delete(podBase);
  }
}

/**
 * When this server is also the door, give a running identity a
 * @handle@<frontHost> address: one inbox-only directory row so the
 * shared-domain handle resolves and the door can take verified delivery for
 * it. The row names the identity's own tree, which is where its inbox and
 * its actor are — the door writes deliveries there and the agent watches
 * that container. A row written by an attach belongs to its owner and is
 * left alone; one this server wrote itself is corrected. The identity keeps
 * its own ids on the pod; nothing is moved.
 */
export async function frontIdentity(h: FediPodServerHandler, podBase: string, identity: EmbeddedIdentity): Promise<void> {
  const s = h.internals();
  const { handle, podHome, actorUrl } = identity;
  try {
    const existing = await h.dir.lookup(handle);
    const row = frontRow(existing, {
      handle, podHome, actorUrl,
      kind: identity.agent?.store?.getConfig?.()?.kind === 'group' ? 'group' : 'person',
      gatewayWebId: s.args.gatewayWebId ?? null,
      hmacSecret: randomBytes(32).toString('base64'),
      inboxOnly: true,
    }, podBase);
    if (!row) return;
    await h.dir.putDirectory(handle, row);
    s.logger.info(existing
      ? `FediPod: the door's record of @${handle} now names ${podHome}`
      : `FediPod: @${handle}@${s.frontHost} now resolves to ${podBase}`);
  } catch (e: unknown) {
    s.logger.warn(`FediPod: could not front @${handle}: ${(e as Error).message}`);
  }
}
