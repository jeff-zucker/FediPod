// handler.ts — the CSS HttpHandler. Thin by design: claim only the front's
// routes (canHandle), adapt Node↔WHATWG, and hand off to the same FediPod core
// the standalone gateway runs (routeFront). All the logic lives elsewhere and
// tests without CSS; this file is the wiring CSS needs.
//
// componentsjs-generator reads FediPodGatewayArgs to emit one component
// parameter per field, so the config injects each by name.

import { HttpHandler, getLoggerFor } from '@solid/community-server';
import type {
  HttpHandlerInput, ResourceStore, Initializable, Finalizable, ClusterManager,
} from '@solid/community-server';
import { claims, agentClaims } from './claims';
import { nodeToWhatwg, applyToNode } from './adapt';
import { makeStoreIO } from './store-css';
import { makeStoreSession } from './store-pod';
import { makeDirectory, makeStorePodPut } from './directory';
import type { IO, Directory } from './directory';

export interface FediPodGatewayArgs {
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
  /** Pod base URLs to run an agent for. Empty or absent means no agent runs. */
  agentPods?: string[];
  /** Directory holding each agent identity's signing key and log. Required when agentPods is set. */
  agentDataDir?: string;
  /** Path from a pod's base to the owner's WebID. */
  agentWebIdSuffix?: string;
  /** Seconds between inbox sweeps. Deliveries also wake the sweep as they land. */
  agentPollSeconds?: number;
  /** Whether a newly provisioned identity accepts follows without review. */
  agentAutoAcceptFollows?: boolean;
  /** The server's cluster manager, so the agent can say when it is running blind to other workers' writes. */
  clusterManager?: ClusterManager;
  /** The secret guarding an identity's owner pages and admin routes. Required when agentPods is set. */
  agentGateToken?: string;
  /** Path on a pod's origin where its owner's pages live. Empty serves no pages at all. */
  agentUiPath?: string;
}

/** One running identity, and the call that stops it. */
interface EmbeddedIdentity {
  handle: string;
  host: string;
  surface: { handler: (req: unknown, res: unknown) => Promise<void>; streaming?: unknown };
  stop: () => Promise<void>;
}

// The JS front-core is FediPod's own ESM tree, reached at runtime. A real
// dynamic import() built via Function keeps tsc from downleveling it to
// require() — which cannot load an ESM module with top-level await under a
// CommonJS build.
const FRONT_CORE = '../../../lib/front-core.mjs';
const EMBED = '../../../lib/embed.mjs';
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, Function>>;

// A pod that will not come up yet is usually a pod still being created by the
// server that is booting. Keep asking, slower each time, up to a few minutes.
const START_RETRY_MS = [ 2_000, 5_000, 15_000, 60_000, 300_000 ];

/** A door path always has both slashes, so claiming and stripping agree. */
function normalizeUiPath(raw?: string): string {
  if (raw === '') return '';
  const path = raw ?? '/app/';
  return `/${path.replace(/^\/+|\/+$/gu, '')}/`;
}

export class FediPodGatewayHandler extends HttpHandler implements Initializable, Finalizable {
  private readonly args: FediPodGatewayArgs;
  private readonly io: IO;
  public readonly dir: Directory;
  private readonly podPut: (url: string, body: string, contentType: string) => Promise<boolean>;
  private readonly logger = getLoggerFor(this);
  private readonly agentPods: string[];
  private readonly agentHosts = new Set<string>();
  private readonly uiPath: string;
  private readonly identities = new Map<string, EmbeddedIdentity>();
  private readonly surfaces = new Map<string, EmbeddedIdentity>();
  private stopping = false;

  public constructor(args: FediPodGatewayArgs) {
    super();
    this.args = args;
    this.io = makeStoreIO(args.resourceStore);
    this.dir = makeDirectory(this.io, args.directoryContainer);
    this.podPut = makeStorePodPut(this.io);
    this.agentPods = (args.agentPods ?? []).filter((p) => p.trim().length > 0);
    // Fail at construction, not at first use: a server told to run an agent
    // and unable to should not boot into a state where it silently runs none.
    if (this.agentPods.length > 0 && !args.agentDataDir) {
      throw new Error('agentPods is set but agentDataDir is not — the agent has nowhere to keep its signing key');
    }
    if (this.agentPods.length > 0 && !args.agentGateToken) {
      throw new Error('agentPods is set but agentGateToken is not — the identity\'s own pages and admin '
        + 'routes would answer anyone who found them');
    }
    this.uiPath = normalizeUiPath(args.agentUiPath);
    for (const pod of this.agentPods) {
      let host: string;
      try {
        host = new URL(pod).host.toLowerCase();
      } catch {
        throw new Error(`agentPods entry is not a URL: ${pod}`);
      }
      // The Mastodon client API is rooted at an origin, so two identities
      // cannot share one — and an identity cannot share the front's origin.
      if (this.agentHosts.has(host)) {
        throw new Error(`two agentPods entries share the host ${host} — an identity needs an origin of its own`);
      }
      if (host.split(':')[0] === String(args.frontHost).toLowerCase()) {
        throw new Error(`agentPods entry ${pod} is on the front's own host — give the identity its own origin`);
      }
      this.agentHosts.add(host);
    }
    for (const pod of this.agentPods) {
      this.logger.info(`FediPod agent on ${pod} answers ${this.uiPath || '(no pages)'} `
        + `plus /api, /oauth, /ap/actor, /ap/outbox and nodeinfo — pod resources at those paths are not served`);
    }
  }

  /**
   * Start an agent for each configured pod. Runs before the server listens, so
   * the identities come up in the background and boot is never held on a pod.
   */
  public async initialize(): Promise<void> {
    if (this.agentPods.length === 0) return;
    // The agent runs in the primary process, and a write made by a worker
    // raises its change event there — so with workers the inbox is swept on the
    // timer rather than the moment a delivery lands. Everything still works; it
    // is just slower, and worth saying rather than leaving to be discovered.
    if (this.args.clusterManager && !this.args.clusterManager.isSingleThreaded()) {
      this.logger.warn('FediPod agent is running in a multi-worker server: deliveries are picked up by the '
        + 'inbox sweep instead of as they arrive. Run with --workers 1 for immediate delivery.');
    }
    this.logger.info(`FediPod agent enabled for ${this.agentPods.length} pod(s)`);
    for (const pod of this.agentPods) void this.startIdentity(pod);
  }

  /** Stop every identity: timers cleared, state written, lease let go. */
  public async finalize(): Promise<void> {
    this.stopping = true;
    const running = [ ...this.identities.values() ];
    this.identities.clear();
    this.surfaces.clear();
    await Promise.allSettled(running.map(async (identity) => {
      await identity.stop();
      this.logger.info(`FediPod agent @${identity.handle} stopped`);
    }));
  }

  private async startIdentity(podBase: string): Promise<void> {
    const session = makeStoreSession(this.args.resourceStore);
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const { startEmbeddedAgent } = await esmImport(EMBED) as
          { startEmbeddedAgent: (opts: Record<string, unknown>) => Promise<EmbeddedIdentity> };
        const identity = await startEmbeddedAgent({
          podBase,
          dataDir: this.args.agentDataDir,
          session,
          resourceStore: this.args.resourceStore,
          webIdSuffix: this.args.agentWebIdSuffix ?? 'profile/card#me',
          pollSeconds: this.args.agentPollSeconds ?? null,
          autoAcceptFollows: this.args.agentAutoAcceptFollows !== false,
          gateToken: this.args.agentGateToken,
          uiPath: this.uiPath,
          log: (message: string): void => {
            this.logger.info(message);
          },
        });
        // Stopped while this one was still coming up.
        if (this.stopping) {
          await identity.stop();
          return;
        }
        this.identities.set(podBase, identity);
        this.surfaces.set(identity.host, identity);
        this.logger.info(`FediPod agent @${identity.handle} running on ${podBase}`);
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
  }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const host = request.headers.host as string | undefined;
    const pathname = new URL(request.url ?? '/', `https://${host}`).pathname;
    // Claimed from configuration, never from what is running: a pod resource
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
    const whatwg = await nodeToWhatwg(request as never, this.args.frontOrigin);
    const out = await routeFront(whatwg, {
      host: this.args.frontHost,
      frontOrigin: this.args.frontOrigin,
      gatewayWebId: this.args.gatewayWebId,
      offersPods: !!this.args.offersPods,
      signupPage: this.args.signupPage || null,
      lookup: (h: string) => this.dir.lookup(h),
      putDirectory: (h: string, rec: never) => this.dir.putDirectory(h, rec),
      podPut: (_handle: string, url: string, body: string, ct: string) => this.podPut(url, body, ct),
      podGet: async (url: string) => {
        const raw = await this.io.read(url);
        return raw == null
          ? { status: 404, text: async () => '', headers: { get: () => null } }
          : { status: 200, text: async () => raw, headers: { get: () => null } };
      },
    });
    await applyToNode(response as never, out);
  }
}
