// handler.ts — the CSS HttpHandler. Thin by design: claim only the front's
// routes and the identities' (canHandle), and hand each request to the part
// that answers it: an identity's own surface, the door for a delivery to its
// inbox, or the Gateway's front. The state every part shares lives here; the
// parts are mounts.ts (which pod a request belongs to), identities.ts
// (starting and stopping them), opt-in.ts (what an owner asks), door.ts and
// front.ts.
//
// componentsjs-generator reads FediPodServerArgs to emit one component
// parameter per field, so the config injects each by name.

import { HttpHandler, getLoggerFor } from '@solid/community-server';
import type {
  HttpHandlerInput, ResourceStore, Initializable, Finalizable, ClusterManager, Logger,
} from '@solid/community-server';
import { claims, agentClaims } from './claims';
import { makeStoreIO } from './store-css';
import { makeDirectory, makeStorePodPut, makeAgentRegistry } from './directory';
import type { IO, Directory, AgentRegistry } from './directory';
import { normalizeRunPath, normalizeUiPath, resolveClaim, stripMount } from './mounts';
import type { AgentClaim } from './mounts';
import * as identities from './identities';
import type { EmbeddedIdentity } from './identities';
import * as optIn from './opt-in';
import { deliverAtDoor } from './door';
import { serveFront } from './front';

export interface FediPodServerArgs {
  /** The server's ResourceStore: the handler reads pods and writes inbox items and directory rows directly through it — no HTTP, no credential. */
  resourceStore: ResourceStore;
  /** The apex host the front answers on, e.g. fedipod.net. Defaults to the host of frontOrigin, so a server that sets nothing answers on its own address. Pod subdomains are never claimed. */
  frontHost?: string;
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
  /** The run-your-identity page HTML. */
  runPage?: string;
  /** Where that page answers. Defaults to `/.fediverse-account`; the path it takes is one the pod server no longer serves, so an operator may name it. */
  runPath?: string;
  /** The accounts-roster page HTML served at /roster. */
  adminPage?: string;
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

/**
 * What the parts beside this file share. Private on the class, because the
 * component generator would otherwise offer every public field as a
 * configurable member; read through internals().
 */
export interface Internals {
  args: FediPodServerArgs;
  io: IO;
  dir: Directory;
  runPath: string;
  uiPath: string;
  frontHost: string;
  podPut: (url: string, body: string, contentType: string) => Promise<boolean>;
  logger: Logger;
  registry: AgentRegistry | null;
  claimed: Map<string, AgentClaim>;
  agentHandles: Map<string, string>;
  roots: Map<string, string>;
  identities: Map<string, EmbeddedIdentity>;
  surfaces: Map<string, EmbeddedIdentity>;
  doorSecrets: Map<string, string>;
  starting: Set<string>;
  startCancelled: Set<string>;
  stopping: boolean;
  onSignal: ((signal: NodeJS.Signals) => void) | null;
}

export class FediPodServerHandler extends HttpHandler implements Initializable, Finalizable {
  private readonly args: FediPodServerArgs;
  private readonly io: IO;
  public readonly dir: Directory;
  private readonly runPath: string;
  private readonly podPut: (url: string, body: string, contentType: string) => Promise<boolean>;
  private readonly logger = getLoggerFor(this);
  // Every pod whose routes this server claims, keyed by pod base. A claim
  // records the host it answers on and the mount — the pod's own path, `''` for
  // a host-root or subdomain pod, `/aisha` for a suffix pod on `server/aisha/`.
  // A suffix pod shares its host (often the front's own) with others, so a
  // request is matched to an identity by host AND mount, never host alone.
  private readonly claimed = new Map<string, AgentClaim>();    // pod base → claim
  private readonly agentHandles = new Map<string, string>();   // handle → pod base
  private readonly roots = new Map<string, string>();          // pod base → where on it the account lives
  private readonly frontHost: string;
  private readonly uiPath: string;
  private readonly identities = new Map<string, EmbeddedIdentity>();
  private readonly surfaces = new Map<string, EmbeddedIdentity>();   // pod base → running identity
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
    // Without this a shipped default apex would silently claim nothing on the
    // operator's own host, and sign-up would never route.
    // hostname, not host: the claim check compares bare hostnames, so a port
    // carried here would stop the front matching its own requests.
    this.frontHost = args.frontHost || new URL(args.frontOrigin).hostname;
    // One answer for both the claim and the route, so a server cannot answer
    // at one path and refuse at another.
    this.runPath = normalizeRunPath(args.runPath);
    this.uiPath = normalizeUiPath(args.agentUiPath);
    this.registry = args.agentRuntimeOptIn
      ? makeAgentRegistry(this.io, absolute(args.agentRegistryContainer ?? '/.internal/fedipod/agents/'))
      : null;
  }

  /** The shared state, for the parts beside this file. */
  public internals(): Internals { return this as unknown as Internals; }

  /** Start an agent for each opted-in pod, before the server listens. */
  public initialize(): Promise<void> { return identities.initialize(this); }

  /** Stop every identity: timers cleared, state written, lease let go. */
  public finalize(): Promise<void> { return identities.finalize(this); }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const host = String(request.headers.host ?? '').toLowerCase();
    const pathname = new URL(request.url ?? '/', `https://${host}`).pathname;
    // The front's own routes win first, so a suffix pod can never shadow the
    // door's dispatch, its WebFinger or its API even where its mount would
    // otherwise contain that path.
    if (claims({ host, pathname }, this.frontHost, this.runPath)) return;
    // Claimed from the opt-in roster, never from what is running: a pod resource
    // must not be served by CSS for the seconds before an identity finishes
    // starting, and then stop being served once it has. The path is matched
    // relative to the claim's mount, so a suffix pod's `/aisha/ap/actor` is
    // judged as `/ap/actor`.
    const c = resolveClaim(this, host, pathname);
    if (c && agentClaims({ pathname: stripMount(pathname, c.mount), method: request.method }, this.uiPath)) return;
    throw new Error('not a gateway route');   // reject → CSS's LDP handler takes it
  }

  /**
   * The identity a request belongs to (matched by host and mount) and the
   * request path relative to that identity's mount, or null. The identity is
   * undefined when the pod is claimed but still starting. Used by the streaming
   * upgrade, which has only the request to go on.
   */
  public matchIdentity(host?: string, pathname = '/'):
  { identity: EmbeddedIdentity | undefined; rel: string } | null {
    const c = resolveClaim(this, String(host ?? '').toLowerCase(), pathname);
    if (!c) return null;
    return { identity: this.surfaces.get(c.podBase), rel: stripMount(pathname, c.mount) };
  }

  /** What a pod owner asks of this server; see opt-in.ts. */
  public webIdsFromSession(request: { headers: { get(name: string): string | null } }): Promise<string[]> {
    return optIn.webIdsFromSession(this, request);
  }

  public optInPod(a: { podBase: string; webId: string; container?: string; createIndex?: boolean }):
  Promise<Record<string, unknown> & { httpStatus: number }> {
    return optIn.optInPod(this, a);
  }

  public describePod(a: { podBase: string }):
  Promise<{ handle: string; host: string; address: string; running: boolean; manage: string }> {
    return optIn.describePod(this, a);
  }

  public optOutPod(a: { podBase: string }): Promise<Record<string, unknown> & { httpStatus: number }> {
    return optIn.optOutPod(this, a);
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const host = String(request.headers.host ?? '').toLowerCase();
    const pathname = new URL(request.url ?? '/', `https://${host}`).pathname;
    // The front's own routes win first — its dispatch, WebFinger and API sit at
    // the apex above every suffix pod — so a claim is consulted only where the
    // front does not answer.
    const claimed = claims({ host, pathname }, this.frontHost, this.runPath) ? null : resolveClaim(this, host, pathname);
    if (!claimed) return serveFront(this, request, response);
    const identity = this.surfaces.get(claimed.podBase);
    if (!identity) {
      // Claimed, but nothing here can answer for it. Saying which of the two
      // reasons it is beats letting the pod answer for a route that is not
      // the pod's, and beats telling a client to try again when trying again
      // will reach another process just as unable to help.
      if (!identities.runsIdentities(this)) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'this identity is not reachable on a server running more '
          + 'than one worker: it runs in the process that serves no requests. Run with --workers 1.' }));
        return;
      }
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
      response.end(JSON.stringify({ error: 'this identity is still starting' }));
      return;
    }
    // This identity's own inbox path — <mount>/<root>/ap/inbox/, from its
    // actor, so it already carries the mount for a suffix pod.
    const inboxPath = new URL(identity.actorUrl).pathname.replace(/ap\/actor$/u, 'ap/inbox/');
    if (pathname === inboxPath && String(request.method).toUpperCase() === 'POST') {
      return deliverAtDoor(this, identity, request, response);
    }
    await identity.surface.handler(request, response);
  }
}
