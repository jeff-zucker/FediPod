// handler.ts — the CSS HttpHandler. Thin by design: claim only the front's
// routes (canHandle), adapt Node↔WHATWG, and hand off to the same FediPod core
// the standalone gateway runs (routeFront). All the logic lives elsewhere and
// tests without CSS; this file is the wiring CSS needs.
//
// componentsjs-generator reads FediPodServerArgs to emit one component
// parameter per field, so the config injects each by name.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpHandler, getLoggerFor } from '@solid/community-server';
import type {
  HttpHandlerInput, ResourceStore, Initializable, Finalizable, ClusterManager,
} from '@solid/community-server';
import { claims, agentClaims } from './claims';
import { nodeToWhatwg, applyToNode } from './adapt';
import { makeStoreIO } from './store-css';
import { makeStoreSession } from './store-pod';
import { makeDirectory, makeStorePodPut, makeAgentRegistry } from './directory';
import type { IO, Directory, AgentRegistry } from './directory';

export interface FediPodServerArgs {
  /** The server's ResourceStore: the handler reads pods and writes inbox items and directory rows directly through it — no HTTP, no credential. */
  resourceStore: ResourceStore;
  /** The apex host the front answers on, e.g. fedipod.net. Pod subdomains are never claimed. */
  frontHost: string;
  /** The front's origin, e.g. https://fedipod.net. */
  frontOrigin: string;
  /** An internal container URL where the handle→pod directory rows live. */
  directoryContainer: string;
  /** The WebID stamped on verification receipts. */
  gatewayWebId?: string;
  /** Whether this host also offers pods (the signup page shows the take-one option). The front never hosts pods itself. */
  offersPods?: boolean;
  /** The new-account page HTML served at the root. */
  signupPage?: string;
  /** The run-your-identity page HTML served at /run. */
  runPage?: string;
  /** Directory holding each agent identity's signing key and log. Required when runtime opt-in is on. */
  agentDataDir?: string;
  /** Path from a pod's base to the owner's WebID. */
  agentWebIdSuffix?: string;
  /** Seconds between inbox sweeps. Deliveries also wake the sweep as they land. */
  agentPollSeconds?: number;
  /** Whether a newly provisioned identity accepts follows without review. */
  agentAutoAcceptFollows?: boolean;
  /** The server's cluster manager, so the agent can say when it is running blind to other workers' writes. */
  clusterManager?: ClusterManager;
  /** Path on a pod's origin where its owner's pages live. Empty serves no pages at all. */
  agentUiPath?: string;
  /** Whether a pod owner may opt in at runtime by proving control of their pod. Off unless the host chooses it. */
  agentRuntimeOptIn?: boolean;
  /** When this server also runs the door, give each identity a @handle@frontHost address as it starts — an inbox-only directory row, written once. The actor keeps its own ids on the pod. Off by default. */
  agentAutoFront?: boolean;
  /** An internal container URL where the runtime opt-in rows live. */
  agentRegistryContainer?: string;
}

/** One running identity, and the call that stops it. */
interface EmbeddedIdentity {
  handle: string;
  host: string;
  surface: { handler: (req: unknown, res: unknown) => Promise<void>; streaming?: unknown };
  stop: () => Promise<void>;
  agent?: { store?: { getConfig?: () => { kind?: string } | null | undefined } };
}

// The JS front-core is FediPod's own ESM tree, reached at runtime. A real
// dynamic import() built via Function keeps tsc from downleveling it to
// require() — which cannot load an ESM module with top-level await under a
// CommonJS build.
//
// Two layouts carry that tree: the published package ships its own copy of
// lib/ beside dist/ (prepack puts it there), and a repo checkout reaches the
// repo's lib/ three levels up. Prefer the package's own copy when it exists.
const LIB_ROOT = existsSync(join(__dirname, '../lib/embed.mjs')) ? '../lib' : '../../../lib';
const FRONT_CORE = `${LIB_ROOT}/front-core.mjs`;
const EMBED = `${LIB_ROOT}/embed.mjs`;
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, Function>>;

// A pod that will not come up yet is usually a pod still being created by the
// server that is booting. Keep asking, slower each time, up to a few minutes.
const START_RETRY_MS = [ 2_000, 5_000, 15_000, 60_000, 300_000 ];

/** The identity's name, from its pod URL. Mirrors handleFor in lib/embed.mjs. */
function deriveHandle(podBase: string): string {
  const u = new URL(podBase);
  const segments = u.pathname.split('/').filter((seg) => seg.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : u.hostname.split('.')[0];
}

/** A door path always has both slashes, so claiming and stripping agree. */
function normalizeUiPath(raw?: string): string {
  if (raw === '') return '';
  const path = raw ?? '/app/';
  return `/${path.replace(/^\/+|\/+$/gu, '')}/`;
}

export class FediPodServerHandler extends HttpHandler implements Initializable, Finalizable {
  private readonly args: FediPodServerArgs;
  private readonly io: IO;
  public readonly dir: Directory;
  private readonly podPut: (url: string, body: string, contentType: string) => Promise<boolean>;
  private readonly logger = getLoggerFor(this);
  private readonly agentHosts = new Set<string>();
  private readonly agentHandles = new Map<string, string>();   // handle → pod base
  private readonly uiPath: string;
  private readonly identities = new Map<string, EmbeddedIdentity>();
  private readonly surfaces = new Map<string, EmbeddedIdentity>();
  private readonly registry: AgentRegistry | null;
  private readonly doorSecrets = new Map<string, string>();    // pod base → its door secret
  private readonly starting = new Set<string>();
  private readonly startCancelled = new Set<string>();
  private stopping = false;
  private onSignal: ((signal: NodeJS.Signals) => void) | null = null;

  public constructor(args: FediPodServerArgs) {
    super();
    this.args = args;
    this.io = makeStoreIO(args.resourceStore);
    // The internal containers are configured as paths; the store speaks
    // absolute identifiers, rooted at the server's own origin.
    const absolute = (container: string): string =>
      (container.startsWith('/') ? new URL(container, args.frontOrigin).href : container);
    this.dir = makeDirectory(this.io, absolute(args.directoryContainer));
    this.podPut = makeStorePodPut(this.io);
    // Fail at construction, not at first use: a server told to run agents
    // and unable to should not boot into a state where it silently runs none.
    if (args.agentRuntimeOptIn && !args.agentDataDir) {
      throw new Error('runtime opt-in is enabled but agentDataDir is not set — identities have nowhere to keep their signing keys');
    }
    this.uiPath = normalizeUiPath(args.agentUiPath);
    this.registry = args.agentRuntimeOptIn
      ? makeAgentRegistry(this.io, absolute(args.agentRegistryContainer ?? '/.internal/fedipod/agents/'))
      : null;
  }

  /**
   * Whether this pod may become an identity here: a real URL, an origin of its
   * own, not the front's host, and a handle no other identity already uses —
   * two pods must never share <agentDataDir>/<handle>/.
   */
  private validateAgentHost(podBase: string): string {
    let host: string;
    try {
      host = new URL(podBase).host.toLowerCase();
    } catch {
      throw new Error(`not a pod URL: ${podBase}`);
    }
    // The Mastodon client API is rooted at an origin, so two identities
    // cannot share one — and an identity cannot share the front's origin.
    if (this.agentHosts.has(host)) {
      throw new Error(`the host ${host} already carries an identity — an identity needs an origin of its own`);
    }
    if (host.split(':')[0] === String(this.args.frontHost).toLowerCase()) {
      throw new Error(`${podBase} is on the front's own host — give the identity its own origin`);
    }
    const handle = deriveHandle(podBase);
    const holder = this.agentHandles.get(handle);
    if (holder && holder !== podBase) {
      throw new Error(`the name ${handle} already belongs to ${holder} — two identities cannot share it`);
    }
    return host;
  }

  /**
   * Start an agent for each opted-in pod. Runs before the server listens, so
   * the identities come up in the background and boot is never held on a pod.
   */
  public async initialize(): Promise<void> {
    if (!this.registry) return;
    // The stock CSS CLI installs no signal handlers, so a SIGTERM (systemd
    // stop, docker stop, Ctrl+C) killed the process with agent state
    // unflushed and the lease held for its whole TTL. Flush first, bounded,
    // then re-raise so the process still dies the way it was asked to.
    if (!this.onSignal) {
      this.onSignal = (signal: NodeJS.Signals): void => {
        const timeout = new Promise((resolve) => { setTimeout(resolve, 5_000).unref?.(); });
        void Promise.race([ this.finalize(), timeout ]).then(() => {
          process.kill(process.pid, signal);
        });
      };
      process.once('SIGTERM', this.onSignal);
      process.once('SIGINT', this.onSignal);
    }
    // The agent runs in the primary process, and a write made by a worker
    // raises its change event there — so with workers the inbox is swept on the
    // timer rather than the moment a delivery lands. Everything still works; it
    // is just slower, and worth saying rather than leaving to be discovered.
    if (this.args.clusterManager && !this.args.clusterManager.isSingleThreaded()) {
      this.logger.warn('FediPod agent is running in a multi-worker server: deliveries are picked up by the '
        + 'inbox sweep instead of as they arrive. Run with --workers 1 for immediate delivery.');
    }
    // Awaited, and BEFORE the server listens: a pod whose owner opted in must
    // have its routes claimed from the first request after a restart, never
    // served briefly by LDP. A failed load must not fail the boot — the rows
    // persist, and the next start recovers them.
    const pods: string[] = [];
    try {
      const hosts = await this.registry.listHosts();
      for (const host of hosts) {
        const row = await this.registry.get(host);
        if (!row) continue;
        if (this.agentHosts.has(row.host) || this.identities.has(row.podBase)) continue;   // already claimed
        try {
          this.validateAgentHost(row.podBase);
        } catch (e: unknown) {
          this.logger.error(`opted-in pod ${row.podBase} no longer valid: ${(e as Error).message}`);
          continue;
        }
        this.agentHosts.add(row.host);
        this.agentHandles.set(row.handle, row.podBase);
        pods.push(row.podBase);
      }
    } catch (e: unknown) {
      this.logger.error(`could not read the opt-in registry — opted-in identities are absent this boot: ${
        (e as Error).message}`);
    }
    if (pods.length > 0) this.logger.info(`FediPod agent enabled for ${pods.length} opted-in pod(s)`);
    for (const pod of pods) void this.startIdentity(pod);
  }

  /** Stop every identity: timers cleared, state written, lease let go. */
  public async finalize(): Promise<void> {
    this.stopping = true;
    if (this.onSignal) {
      process.removeListener('SIGTERM', this.onSignal);
      process.removeListener('SIGINT', this.onSignal);
      this.onSignal = null;
    }
    const running = [ ...this.identities.values() ];
    this.identities.clear();
    this.surfaces.clear();
    this.doorSecrets.clear();
    this.starting.clear();
    await Promise.allSettled(running.map(async (identity) => {
      await identity.stop();
      this.logger.info(`FediPod agent @${identity.handle} stopped`);
    }));
  }

  private async startIdentity(podBase: string): Promise<void> {
    if (this.starting.has(podBase) || this.identities.has(podBase)) return;
    this.starting.add(podBase);
    this.startCancelled.delete(podBase);
    const session = makeStoreSession(this.args.resourceStore, podBase);
    try {
      for (let attempt = 0; !this.stopping && !this.startCancelled.has(podBase); attempt++) {
        try {
          const { startEmbeddedAgent, ensureDoorSecret } = await esmImport(EMBED) as {
            startEmbeddedAgent: (opts: Record<string, unknown>) => Promise<EmbeddedIdentity>;
            ensureDoorSecret: (dataDir: string, handle: string, opts?: { rotate?: boolean }) =>
            { secret: string; path: string; rotated: boolean };
          };
          // The secret is in the map BEFORE the surface can exist, so the
          // gate's resolver never comes up empty — empty would mean gate-off.
          if (!this.doorSecrets.has(podBase)) {
            const door = ensureDoorSecret(this.args.agentDataDir!, deriveHandle(podBase));
            this.doorSecrets.set(podBase, door.secret);
            this.logger.info(`door secret for @${deriveHandle(podBase)} is at ${door.path}`);
          }
          const identity = await startEmbeddedAgent({
            podBase,
            dataDir: this.args.agentDataDir,
            session,
            resourceStore: this.args.resourceStore,
            webIdSuffix: this.args.agentWebIdSuffix ?? 'profile/card#me',
            pollSeconds: this.args.agentPollSeconds ?? null,
            autoAcceptFollows: this.args.agentAutoAcceptFollows !== false,
            gateToken: (): string | undefined => this.doorSecrets.get(podBase),
            uiPath: this.uiPath,
            log: (message: string): void => {
              this.logger.info(message);
            },
          });
          // Stopped, or opted out, while this one was still coming up.
          if (this.stopping || this.startCancelled.has(podBase)) {
            await identity.stop();
            return;
          }
          this.identities.set(podBase, identity);
          this.surfaces.set(identity.host, identity);
          this.logger.info(`FediPod agent @${identity.handle} running on ${podBase}`);
          if (this.args.agentAutoFront) await this.frontIdentity(podBase, identity);
          return;
        } catch (e: unknown) {
          const wait = START_RETRY_MS[Math.min(attempt, START_RETRY_MS.length - 1)];
          this.logger.warn(`FediPod agent for ${podBase} did not start: ${(e as Error).message
          } — retrying in ${Math.round(wait / 1000)}s`);
          await new Promise((resolve) => {
            setTimeout(resolve, wait).unref?.();
          });
        }
      }
    } finally {
      this.starting.delete(podBase);
    }
  }

  /**
   * When this server is also the door, give a running identity a
   * @handle@<frontHost> address: one inbox-only directory row so the
   * shared-domain handle resolves and the door can take verified delivery for
   * it. Written once — a manual attach or an earlier boot wins. The identity
   * keeps its own actor ids on the pod; nothing is moved.
   */
  private async frontIdentity(podBase: string, identity: EmbeddedIdentity): Promise<void> {
    const { handle } = identity;
    try {
      if (await this.dir.lookup(handle)) return;
      const kind = identity.agent?.store?.getConfig?.()?.kind === 'group' ? 'group' : 'person';
      await this.dir.putDirectory(handle, {
        handle, podHome: podBase, actorUrl: `${podBase}ap/actor`, kind,
        gatewayWebId: this.args.gatewayWebId ?? null,
        hmacSecret: randomBytes(32).toString('base64'),
        inboxOnly: true,
      });
      this.logger.info(`FediPod: @${handle}@${this.args.frontHost} now resolves to ${podBase}`);
    } catch (e: unknown) {
      this.logger.warn(`FediPod: could not front @${handle}: ${(e as Error).message}`);
    }
  }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const host = request.headers.host as string | undefined;
    const pathname = new URL(request.url ?? '/', `https://${host}`).pathname;
    // Claimed from the opt-in roster, never from what is running: a pod resource
    // must not be served by CSS for the seconds before an identity finishes
    // starting, and then stop being served once it has.
    if (claims({ host, pathname }, this.args.frontHost)) return;
    if (agentClaims({ host, pathname }, this.agentHosts, this.uiPath)) return;
    throw new Error('not a gateway route');   // reject → CSS's LDP handler takes it
  }

  /** The running identity answering on a host, if it has finished starting. */
  public surfaceFor(host?: string): EmbeddedIdentity | undefined {
    return this.surfaces.get(String(host ?? '').toLowerCase());
  }

  /**
   * A pod owner, already proven to control podBase, asks this server to run
   * their identity. Returns { httpStatus, ...body }; the secret appears in the
   * reply and nowhere else. Re-opting-in rotates the secret — that is how a
   * lost one is recovered.
   */
  public async optInPod({ podBase, webId }: { podBase: string; webId: string }):
  Promise<Record<string, unknown> & { httpStatus: number }> {
    if (!this.registry) return { httpStatus: 501, error: 'this server does not offer runtime opt-in' };
    if (this.args.clusterManager && !this.args.clusterManager.isSingleThreaded()) {
      return { httpStatus: 503, error: 'runtime opt-in needs a single-worker server (--workers 1)' };
    }
    const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
    const handle = deriveHandle(base);
    const { ensureDoorSecret } = await esmImport(EMBED) as {
      ensureDoorSecret: (dataDir: string, handle: string, opts?: { rotate?: boolean }) =>
      { secret: string; path: string; rotated: boolean };
    };

    // Already running here from an earlier opt-in: proving pod
    // control again buys a fresh secret, nothing else.
    if (this.agentHandles.get(handle) === base) {
      const door = ensureDoorSecret(this.args.agentDataDir!, handle, { rotate: true });
      this.doorSecrets.set(base, door.secret);
      return { httpStatus: 201, ok: true, handle, host: new URL(base).host.toLowerCase(),
        doorSecret: door.secret, doorPath: this.uiPath, status: 'rotated' };
    }

    let host: string;
    try {
      host = this.validateAgentHost(base);
    } catch (e: unknown) {
      return { httpStatus: 409, error: (e as Error).message };
    }
    try {
      await this.registry.add({ podBase: base, handle, host, webId, optedInAt: new Date().toISOString() });
    } catch (e: unknown) {
      this.logger.error(`opt-in row for ${base} could not be written: ${(e as Error).message}`);
      return { httpStatus: 500, error: 'could not record the opt-in' };
    }
    // From this instant the pod's identity routes answer 503 instead of LDP,
    // until the agent registers its surface.
    this.agentHosts.add(host);
    this.agentHandles.set(handle, base);
    const door = ensureDoorSecret(this.args.agentDataDir!, handle, { rotate: true });
    this.doorSecrets.set(base, door.secret);
    void this.startIdentity(base);
    this.logger.info(`runtime opt-in: @${handle} on ${base} (door secret at ${door.path})`);
    return { httpStatus: 201, ok: true, handle, host,
      doorSecret: door.secret, doorPath: this.uiPath, status: 'starting' };
  }

  /** The reverse: stop the identity and let the pod be plain LDP again. */
  public async optOutPod({ podBase }: { podBase: string }):
  Promise<Record<string, unknown> & { httpStatus: number }> {
    if (!this.registry) return { httpStatus: 501, error: 'this server does not offer runtime opt-in' };
    const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
    const host = new URL(base).host.toLowerCase();
    const row = await this.registry.get(host);
    if (!row || row.podBase !== base) return { httpStatus: 404, error: 'this pod has not opted in' };
    this.agentHosts.delete(host);                     // routes fall to LDP now
    this.startCancelled.add(base);                    // a pending start stands down
    const identity = this.identities.get(base);
    this.identities.delete(base);
    this.surfaces.delete(host);
    this.agentHandles.delete(row.handle);
    this.doorSecrets.delete(base);
    if (identity) await identity.stop();
    await this.registry.remove(host);
    this.logger.info(`runtime opt-out: @${row.handle} on ${base} — the pod serves plain LDP again`);
    return { httpStatus: 200, ok: true, stopped: Boolean(identity) };
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const host = String(request.headers.host ?? '').toLowerCase();
    if (this.agentHosts.has(host)) {
      const identity = this.surfaces.get(host);
      if (!identity) {
        // Claimed, but its identity is not up yet. Saying so is better than
        // letting the pod answer for a route that is about to stop being pod.
        response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
        response.end(JSON.stringify({ error: 'this identity is still starting' }));
        return;
      }
      await identity.surface.handler(request, response);
      return;
    }
    const { routeFront } = await esmImport(FRONT_CORE);
    let whatwg: Request;
    try {
      whatwg = await nodeToWhatwg(request as never, this.args.frontOrigin);
    } catch (e: unknown) {
      const status = (e as { statusCode?: number }).statusCode === 413 ? 413 : 400;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: (e as Error).message }));
      return;
    }
    const out = await routeFront(whatwg, {
      host: this.args.frontHost,
      frontOrigin: this.args.frontOrigin,
      gatewayWebId: this.args.gatewayWebId,
      offersPods: !!this.args.offersPods,
      signupPage: this.args.signupPage || null,
      runPage: this.args.runPage || null,
      lookup: (h: string) => this.dir.lookup(h),
      putDirectory: (h: string, rec: never) => this.dir.putDirectory(h, rec),
      podPut: (_handle: string, url: string, body: string, ct: string) => this.podPut(url, body, ct),
      podGet: async (url: string) => {
        const raw = await this.io.read(url);
        return raw == null
          ? { status: 404, text: async () => '', headers: { get: () => null } }
          : { status: 200, text: async () => raw, headers: { get: () => null } };
      },
      agentControl: this.registry
        ? {
          optIn: (a: { podBase: string; webId: string }) => this.optInPod(a),
          optOut: (a: { podBase: string }) => this.optOutPod(a),
        }
        : undefined,
    });
    await applyToNode(response as never, out);
  }
}
