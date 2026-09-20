// handler.ts — the CSS HttpHandler. Thin by design: claim only the front's
// routes (canHandle), adapt Node↔WHATWG, and hand off to the same FediPod core
// the standalone gateway runs (routeFront). All the logic lives elsewhere and
// tests without CSS; this file is the wiring CSS needs.
//
// componentsjs-generator reads FediPodServerArgs to emit one component
// parameter per field, so the config injects each by name.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HttpHandler, getLoggerFor } from '@solid/community-server';
import type {
  HttpHandlerInput, ResourceStore, Initializable, Finalizable, ClusterManager,
} from '@solid/community-server';
import { claims, agentClaims, DEFAULT_RUN_PATH } from './claims';
import { nodeToWhatwg, applyToNode } from './adapt';
import { makeStoreIO } from './store-css';
import { makeStoreSession } from './store-pod';
import { makeDirectory, makeStorePodPut, makeAgentRegistry, agentKey, frontRow } from './directory';
import type { IO, Directory, AgentRegistry } from './directory';

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
 * A pod this server claims the routes of, whether or not its identity has
 * finished starting. `mount` is the pod's own path (`''` for a host-root or
 * subdomain pod, `/aisha` for a suffix pod on `https://host/aisha/`); a request
 * belongs to this claim when its host matches and its path is at or under the
 * mount.
 */
interface AgentClaim {
  host: string;
  mount: string;
  podBase: string;
  handle: string;
}

/** The pod's path as a mount prefix: `''` for a host root, else `/aisha`. */
function mountOf(podBase: string): string {
  return new URL(podBase).pathname.replace(/\/+$/u, '');
}

/** Whether `a` is `b` or an ancestor path of `b` (both mount-shaped, no trailing slash). */
function pathContains(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a === '';
}

/** One running identity, and the call that stops it. */
interface EmbeddedIdentity {
  handle: string;
  host: string;
  /** Where the identity's own tree begins on its pod, and the actor inside it. */
  podHome: string;
  actorUrl: string;
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
const LIB_ROOT = existsSync(join(__dirname, '../lib/server/embed.mjs')) ? '../lib' : '../../../lib';
const FRONT_CORE = `${LIB_ROOT}/gateway/front-core.mjs`;
const EMBED = `${LIB_ROOT}/server/embed.mjs`;
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, Function>>;

// The front's pages and the files they load, carried in the same two layouts
// as lib/. A missing file is not fatal: the route it feeds answers 404.
const WEB_ROOT = existsSync(join(__dirname, '../web/front/run.html'))
  ? join(__dirname, '../web/front') : join(__dirname, '../../../web/front');
const webFile = (name: string): string | null => {
  try { return readFileSync(join(WEB_ROOT, name), 'utf8'); } catch { return null; }
};

// A pod that will not come up yet is usually a pod still being created by the
// server that is booting. Keep asking, slower each time, up to a few minutes.
const START_RETRY_MS = [ 2_000, 5_000, 15_000, 60_000, 300_000 ];

/** The identity's name, from its pod URL. Mirrors handleFor in lib/embed.mjs. */
function deriveHandle(podBase: string): string {
  const u = new URL(podBase);
  const segments = u.pathname.split('/').filter((seg) => seg.length > 0);
  return segments.length > 0 ? segments[segments.length - 1] : u.hostname.split('.')[0];
}

/** The opt-in page's path: leading slash, no trailing one, the default when unset. */
function normalizeRunPath(raw?: string): string {
  const said = String(raw ?? '').trim().replace(/\/+$/u, '');
  if (!said) return DEFAULT_RUN_PATH;
  return said.startsWith('/') ? said : `/${said}`;
}

/** A door path always has both slashes, so claiming and stripping agree. */
function normalizeUiPath(raw?: string): string {
  if (raw === '') return '';
  const path = raw ?? '/fp/';
  return `/${path.replace(/^\/+|\/+$/gu, '')}/`;
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

  /**
   * Whether this pod may become an identity here, and the claim it earns: a
   * real URL, a place no other identity already sits, and a handle no other
   * identity uses — two pods must never share <agentDataDir>/<handle>/.
   *
   * A HOST-ROOT or subdomain pod needs an origin of its own, and it may not be
   * the front's host: the whole surface answers at the origin root, so two of
   * them, or one sharing the front, would collide. A SUFFIX pod lives on a path
   * (`server/aisha/`), so it may share its host — with the front and with other
   * suffix pods — provided no claim already contains or nests under its path.
   */
  private validateAgentPod(podBase: string): AgentClaim {
    let host: string;
    let mount: string;
    try {
      const u = new URL(podBase);
      host = u.host.toLowerCase();
      mount = mountOf(podBase);
    } catch {
      throw new Error(`not a pod URL: ${podBase}`);
    }
    if (mount === '') {
      // A pod at the root of its host: it owns the whole origin, so it cannot
      // share it with the front or with any other claim.
      if (host.split(':')[0] === String(this.frontHost).toLowerCase()) {
        throw new Error(`${podBase} is on the front's own host — give the identity its own origin, or host it on a path`);
      }
      for (const c of this.claimed.values()) {
        if (c.host === host) {
          throw new Error(`the host ${host} already carries an identity — a host-root identity needs an origin of its own`);
        }
      }
    } else {
      // A pod on a path: it owns only its subtree. Refuse anything that already
      // contains it or that it would contain, so no identity can answer under
      // another's path (and none straddles the front's own routes underneath).
      for (const c of this.claimed.values()) {
        if (c.host !== host) continue;
        if (pathContains(c.mount, mount) || pathContains(mount, c.mount)) {
          throw new Error(`${podBase} nests with the identity already at ${c.podBase} — a path pod owns only its own subtree`);
        }
      }
    }
    const handle = deriveHandle(podBase);
    const holder = this.agentHandles.get(handle);
    if (holder && holder !== podBase) {
      throw new Error(`the name ${handle} already belongs to ${holder} — two identities cannot share it`);
    }
    return { host, mount, podBase, handle };
  }

  /**
   * The claim a request belongs to, or null. A request matches when its host is
   * the claim's host and its path is at or under the claim's mount; the deepest
   * mount wins, so a suffix pod's own routes are never swallowed by a shallower
   * claim on the same host.
   */
  private resolveClaim(host: string, pathname: string): AgentClaim | null {
    let best: AgentClaim | null = null;
    for (const c of this.claimed.values()) {
      if (c.host !== host) continue;
      if (c.mount === '' || pathname === c.mount || pathname.startsWith(c.mount + '/')) {
        if (!best || c.mount.length > best.mount.length) best = c;
      }
    }
    return best;
  }

  /** A request path relative to a mount: `/aisha/ap/actor` under `/aisha` → `/ap/actor`. */
  private stripMount(pathname: string, mount: string): string {
    if (!mount) return pathname;
    return pathname.slice(mount.length) || '/';
  }

  /**
   * Start an agent for each opted-in pod. Runs before the server listens, so
   * the identities come up in the background and boot is never held on a pod.
   */
  public async initialize(): Promise<void> {
    if (!this.registry) return;
    const runs = this.runsIdentities();
    // The stock CSS CLI installs no signal handlers, so a SIGTERM (systemd
    // stop, docker stop, Ctrl+C) killed the process with agent state
    // unflushed and the lease held for its whole TTL. Flush first, bounded,
    // then re-raise so the process still dies the way it was asked to.
    if (runs && !this.onSignal) {
      this.onSignal = (signal: NodeJS.Signals): void => {
        const timeout = new Promise((resolve) => { setTimeout(resolve, 5_000).unref?.(); });
        void Promise.race([ this.finalize(), timeout ]).then(() => {
          process.kill(process.pid, signal);
        });
      };
      process.once('SIGTERM', this.onSignal);
      process.once('SIGINT', this.onSignal);
    }
    // Identities run in the primary, and requests are answered by the workers,
    // so with more than one worker an identity federates but cannot be reached:
    // its client API, its owner pages and its live feed are in a process no
    // request arrives at. Said once, by the process that has them.
    if (runs && this.args.clusterManager && !this.args.clusterManager.isSingleThreaded()) {
      this.logger.warn('FediPod is running in a multi-worker server. Deliveries are picked up by the inbox '
        + 'sweep rather than as they land, and no identity can answer its client API, its live feed or its '
        + "owner's pages while requests are served by other processes. Run with --workers 1.");
    }
    // Awaited, and BEFORE the server listens: a pod whose owner opted in must
    // have its routes claimed from the first request after a restart, never
    // served briefly by LDP. A failed load must not fail the boot — the rows
    // persist, and the next start recovers them.
    const pods: string[] = [];
    try {
      const keys = await this.registry.listKeys();
      for (const key of keys) {
        const row = await this.registry.get(key);
        if (!row) continue;
        if (this.claimed.has(row.podBase) || this.identities.has(row.podBase)) continue;   // already claimed
        let claim: AgentClaim;
        try {
          claim = this.validateAgentPod(row.podBase);
        } catch (e: unknown) {
          this.logger.error(`opted-in pod ${row.podBase} no longer valid: ${(e as Error).message}`);
          continue;
        }
        this.claimed.set(row.podBase, claim);
        this.agentHandles.set(row.handle, row.podBase);
        pods.push(row.podBase);
      }
    } catch (e: unknown) {
      this.logger.error(`could not read the opt-in registry — opted-in identities are absent this boot: ${
        (e as Error).message}`);
    }
    if (pods.length > 0) {
      this.logger.info(runs
        ? `FediPod agent enabled for ${pods.length} opted-in pod(s)`
        : `FediPod claimed the routes of ${pods.length} opted-in pod(s); they are run elsewhere`);
    }
    // Claimed everywhere, run in one place. A process that does not run them
    // must still not let a pod answer for a path that belongs to an identity.
    if (runs) for (const pod of pods) void this.startIdentity(pod);
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

  /**
   * One identity's door secret, in its own pod's state. `agentDataDir` is
   * handed in as the place an identity set up before this kept it, so its
   * owner's existing door link survives the move.
   */
  private async doorSecretFor(podBase: string, session?: { fetch: unknown }, opts: { rotate?: boolean } = {}):
  Promise<{ secret: string; url: string; rotated: boolean }> {
    const { ensureDoorSecret } = await esmImport(EMBED) as {
      ensureDoorSecret: (session: unknown, podBase: string, opts?: Record<string, unknown>) =>
      Promise<{ secret: string; url: string; rotated: boolean }>;
    };
    return ensureDoorSecret(session ?? makeStoreSession(this.args.resourceStore, podBase), podBase, {
      ...opts,
      dataDir: this.args.agentDataDir,
      handle: deriveHandle(podBase),
      log: (message: string): void => { this.logger.info(`@${deriveHandle(podBase)}: ${message}`); },
    });
  }

  private async startIdentity(podBase: string): Promise<void> {
    if (this.starting.has(podBase) || this.identities.has(podBase)) return;
    this.starting.add(podBase);
    this.startCancelled.delete(podBase);
    const session = makeStoreSession(this.args.resourceStore, podBase);
    try {
      for (let attempt = 0; !this.stopping && !this.startCancelled.has(podBase); attempt++) {
        try {
          const { startEmbeddedAgent } = await esmImport(EMBED) as {
            startEmbeddedAgent: (opts: Record<string, unknown>) => Promise<EmbeddedIdentity>;
          };
          // The secret is in the map BEFORE the surface can exist, so the
          // gate's resolver never comes up empty — empty would mean gate-off.
          if (!this.doorSecrets.has(podBase)) {
            const door = await this.doorSecretFor(podBase, session);
            this.doorSecrets.set(podBase, door.secret);
            this.logger.info(`door secret for @${deriveHandle(podBase)} is in its pod at ${door.url}`);
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
          this.surfaces.set(podBase, identity);
          this.logger.info(`FediPod agent @${identity.handle} running on ${podBase}`);
          // A suffix pod cannot answer WebFinger for itself — its host root is
          // the front's — so it is followable ONLY through the door's apex
          // dispatch. Front it whether or not auto-front is on: the row is the
          // whole of what makes @handle@host resolve to it.
          if (this.args.agentAutoFront || this.claimed.get(podBase)?.mount) {
            await this.frontIdentity(podBase, identity);
          }
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
   * it. The row names the identity's own tree, which is where its inbox and
   * its actor are — the door writes deliveries there and the agent watches
   * that container. A row written by an attach belongs to its owner and is
   * left alone; one this server wrote itself is corrected. The identity keeps
   * its own ids on the pod; nothing is moved.
   */
  private async frontIdentity(podBase: string, identity: EmbeddedIdentity): Promise<void> {
    const { handle, podHome, actorUrl } = identity;
    try {
      const existing = await this.dir.lookup(handle);
      const row = frontRow(existing, {
        handle, podHome, actorUrl,
        kind: identity.agent?.store?.getConfig?.()?.kind === 'group' ? 'group' : 'person',
        gatewayWebId: this.args.gatewayWebId ?? null,
        hmacSecret: randomBytes(32).toString('base64'),
        inboxOnly: true,
      }, podBase);
      if (!row) return;
      await this.dir.putDirectory(handle, row);
      this.logger.info(existing
        ? `FediPod: the door's record of @${handle} now names ${podHome}`
        : `FediPod: @${handle}@${this.frontHost} now resolves to ${podBase}`);
    } catch (e: unknown) {
      this.logger.warn(`FediPod: could not front @${handle}: ${(e as Error).message}`);
    }
  }

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
    const c = this.resolveClaim(host, pathname);
    if (c && agentClaims({ pathname: this.stripMount(pathname, c.mount), method: request.method }, this.uiPath)) return;
    throw new Error('not a gateway route');   // reject → CSS's LDP handler takes it
  }

  /**
   * Whether identities run in this process. They run in one: the lease admits
   * a single drainer, and the state each one holds is in memory. With workers,
   * that process is the primary — which serves no requests, so every process
   * still has to know which hosts belong to an identity even though only one
   * of them can answer for it.
   */
  private runsIdentities(): boolean {
    const cluster = this.args.clusterManager;
    return !cluster || cluster.isSingleThreaded() || cluster.isPrimary();
  }

  /**
   * The identity a request belongs to (matched by host and mount) and the
   * request path relative to that identity's mount, or null. The identity is
   * undefined when the pod is claimed but still starting. Used by the streaming
   * upgrade, which has only the request to go on.
   */
  public matchIdentity(host?: string, pathname = '/'):
  { identity: EmbeddedIdentity | undefined; rel: string } | null {
    const c = this.resolveClaim(String(host ?? '').toLowerCase(), pathname);
    if (!c) return null;
    return { identity: this.surfaces.get(c.podBase), rel: this.stripMount(pathname, c.mount) };
  }

  /**
   * A pod owner, already proven to control podBase, asks this server to run
   * their identity. Returns { httpStatus, ...body }; the secret appears in the
   * reply and nowhere else. Re-opting-in rotates the secret — that is how a
   * lost one is recovered.
   */
  /**
   * The WebIDs behind the account session in the request, or none. The server
   * keeps that session in a `css-account` cookie; its own account API is what
   * says which WebIDs the session owns, and it takes the same cookie. Nothing
   * here trusts the cookie's presence — the account API does the deciding, and
   * the caller picks the WebID that owns the pod being claimed.
   */
  public async webIdsFromSession(request: { headers: { get(name: string): string | null } }):
  Promise<string[]> {
    const cookie = request.headers.get('cookie');
    if (!cookie || !/(?:^|;\s*)css-account=/u.test(cookie)) return [];
    const base = this.args.frontOrigin.replace(/\/$/u, '');
    const asJson = { cookie, accept: 'application/json' };
    try {
      const index = await fetch(`${base}/.account/`, { headers: asJson });
      if (!index.ok) return [];
      const controls = (await index.json() as { controls?: { account?: { webId?: string } } }).controls;
      const webIdLink = controls?.account?.webId;
      if (!webIdLink) return [];
      const linked = await fetch(webIdLink, { headers: asJson });
      if (!linked.ok) return [];
      const links = (await linked.json() as { webIdLinks?: Record<string, unknown> }).webIdLinks ?? {};
      return Object.keys(links);
    } catch {
      return [];
    }
  }

  public async optInPod({ podBase, webId }: { podBase: string; webId: string }):
  Promise<Record<string, unknown> & { httpStatus: number }> {
    if (!this.registry) return { httpStatus: 501, error: 'this server does not offer runtime opt-in' };
    if (this.args.clusterManager && !this.args.clusterManager.isSingleThreaded()) {
      return { httpStatus: 503, error: 'runtime opt-in needs a single-worker server (--workers 1)' };
    }
    const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
    const handle = deriveHandle(base);
    // Already running here from an earlier opt-in: proving pod
    // control again buys a fresh secret, nothing else.
    if (this.agentHandles.get(handle) === base) {
      const door = await this.doorSecretFor(base, undefined, { rotate: true });
      this.doorSecrets.set(base, door.secret);
      return { httpStatus: 201, ok: true, handle, host: new URL(base).host.toLowerCase(),
        doorSecret: door.secret, doorPath: this.uiPath, status: 'rotated' };
    }

    let claim: AgentClaim;
    try {
      claim = this.validateAgentPod(base);
    } catch (e: unknown) {
      return { httpStatus: 409, error: (e as Error).message };
    }
    const { host } = claim;
    try {
      await this.registry.add({ podBase: base, handle, host, webId, optedInAt: new Date().toISOString() });
    } catch (e: unknown) {
      this.logger.error(`opt-in row for ${base} could not be written: ${(e as Error).message}`);
      return { httpStatus: 500, error: 'could not record the opt-in' };
    }
    // From this instant the pod's identity routes answer 503 instead of LDP,
    // until the agent registers its surface.
    this.claimed.set(base, claim);
    this.agentHandles.set(handle, base);
    const door = await this.doorSecretFor(base, undefined, { rotate: true });
    this.doorSecrets.set(base, door.secret);
    void this.startIdentity(base);
    this.logger.info(`runtime opt-in: @${handle} on ${base} (door secret in its pod at ${door.url})`);
    return { httpStatus: 201, ok: true, handle, host,
      doorSecret: door.secret, doorPath: this.uiPath, status: 'starting' };
  }

  /**
   * What a pod would be as an identity here, without changing anything: its
   * handle, the host its address carries, and whether it runs here already.
   */
  public async describePod({ podBase }: { podBase: string }):
  Promise<{ handle: string; host: string; address: string; running: boolean; manage: string }> {
    const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
    const handle = deriveHandle(base);
    let host: string;
    try { host = this.validateAgentPod(base).host; } catch { host = new URL(base).host.toLowerCase(); }
    const running = this.agentHandles.get(handle) === base;
    // The management page's door takes its key once in the address and keeps
    // the browser in with a cookie. Only the owner's own page ever asks for
    // this description, so the key rides on the link for a running account.
    // Read from the pod, where the key always is, rather than from what this
    // process happens to hold: an account still starting has none in memory.
    let key: string | undefined;
    if (running) {
      try { key = (await this.doorSecretFor(base)).secret; } catch { key = this.doorSecrets.get(base); }
    }
    const door = base.replace(/\/$/u, '') + this.uiPath;
    return { handle, host, address: `@${handle}@${host}`, running,
      manage: key ? `${door}?dk-token=${encodeURIComponent(key)}` : door };
  }

  /** The reverse: stop the identity and let the pod be plain LDP again. */
  public async optOutPod({ podBase }: { podBase: string }):
  Promise<Record<string, unknown> & { httpStatus: number }> {
    if (!this.registry) return { httpStatus: 501, error: 'this server does not offer runtime opt-in' };
    const base = podBase.endsWith('/') ? podBase : `${podBase}/`;
    const host = new URL(base).host.toLowerCase();
    const key = agentKey(host, base);
    const row = await this.registry.get(key);
    if (!row || row.podBase !== base) return { httpStatus: 404, error: 'this pod has not opted in' };
    this.claimed.delete(base);                         // routes fall to LDP now
    this.startCancelled.add(base);                    // a pending start stands down
    const identity = this.identities.get(base);
    this.identities.delete(base);
    this.surfaces.delete(base);
    this.agentHandles.delete(row.handle);
    this.doorSecrets.delete(base);
    if (identity) await identity.stop();
    await this.registry.remove(key);
    this.logger.info(`runtime opt-out: @${row.handle} on ${base} — the pod serves plain LDP again`);
    return { httpStatus: 200, ok: true, stopped: Boolean(identity) };
  }

  /**
   * A delivery to an identity's own inbox, verified here — the server that
   * stores the inbox is the one the request reached, so the signature is
   * checked while its headers exist and the receipt is written beside the
   * activity. The same door code the front runs; nothing is renamed.
   */
  private async deliverAtDoor(identity: EmbeddedIdentity, request: HttpHandlerInput['request'], response: HttpHandlerInput['response']): Promise<void> {
    const { deliverToInbox } = await esmImport(EMBED) as {
      deliverToInbox: (agent: unknown, req: Request, opts: Record<string, unknown>) =>
        Promise<{ status: number; reason: string }>;
    };
    let whatwg: Request;
    try {
      // The pod's own origin: the signature covers the path and the Host header, and both are the pod's.
      whatwg = await nodeToWhatwg(request as never, new URL(identity.podHome).origin);
    } catch (e: unknown) {
      const status = (e as { statusCode?: number }).statusCode === 413 ? 413 : 400;
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: (e as Error).message }));
      return;
    }
    const out = await deliverToInbox(identity.agent, whatwg, {
      podPut: (url: string, body: string, ct: string) => this.podPut(url, body, ct),
      gatewayWebId: this.args.gatewayWebId ?? null,
    });
    this.logger.info(`FediPod: delivery for @${identity.handle} at the door — ${out.reason} (${out.status})`);
    response.writeHead(out.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ reason: out.reason }));
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const host = String(request.headers.host ?? '').toLowerCase();
    const pathname = new URL(request.url ?? '/', `https://${host}`).pathname;
    // The front's own routes win first — its dispatch, WebFinger and API sit at
    // the apex above every suffix pod — so a claim is consulted only where the
    // front does not answer.
    const claimed = claims({ host, pathname }, this.frontHost, this.runPath) ? null : this.resolveClaim(host, pathname);
    if (claimed) {
      const identity = this.surfaces.get(claimed.podBase);
      if (!identity) {
        // Claimed, but nothing here can answer for it. Saying which of the two
        // reasons it is beats letting the pod answer for a route that is not
        // the pod's, and beats telling a client to try again when trying again
        // will reach another process just as unable to help.
        if (!this.runsIdentities()) {
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
        await this.deliverAtDoor(identity, request, response);
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
      host: this.frontHost,
      frontOrigin: this.args.frontOrigin,
      // This server issued the session the reader is already using, so it can
      // read it rather than sending them to an identity provider that has just
      // told them who they are. Same-origin only; front-core decides that.
      webIdsFromSession: (req: { headers: { get(name: string): string | null } }) =>
        this.webIdsFromSession(req),
      gatewayWebId: this.args.gatewayWebId,
      offersPods: !!this.args.offersPods,
      signupPage: this.args.signupPage || webFile('new-account.html'),
      runPage: this.args.runPage || webFile('run.html'),
      runPath: this.runPath,
      adminPage: this.args.adminPage || webFile('admin.html'),
      // The opt-in and roster pages load the sign-in library, and the installer
      // command is handed out with it; without these the pages render but
      // cannot be used.
      authBundle: webFile('solid-oidc-client.js'),
      // Each page's own script — inline until 2026-09-09, so that the pages can
      // be served under `script-src 'self'` (see lib/front-core.mjs).
      pageScripts: {
        'new-account.js': webFile('new-account.js'),
        'run.js': webFile('run.js'),
        'admin.js': webFile('admin.js'),
      },
      installScript: webFile('install.sh'),
      lookup: (h: string) => this.dir.lookup(h),
      putDirectory: (h: string, rec: never) => this.dir.putDirectory(h, rec),
      podPut: (_handle: string, url: string, body: string, ct: string) => this.podPut(url, body, ct),
      // Reads for the public proxy. `this.io.read` goes STRAIGHT into the
      // resource store, which applies no access control of its own — so this is
      // the one place that has to say what may be read, and it says: only
      // inside the pod of the handle being served, and never a server-internal
      // tree. Without it a row could name any location and this would fetch it
      // (the directory, with every user's receipt secret, included).
      //
      // The front now refuses to attach such a row at all (podHomeProblem in
      // lib/front-core.mjs); this is the same refusal at the other end, because
      // a row can also arrive from a seed or an older deploy.
      podGet: async (url: string, opts?: { podHome?: string }) => {
        const denied = { status: 403, text: async () => '', headers: { get: () => null } };
        let target: URL;
        try { target = new URL(url); } catch { return denied; }
        if (/(^|\/)\.internal(\/|$)/u.test(target.pathname)) return denied;
        // Which pod asked: routeFront reads `rec.podHome + rest` and passes
        // that podHome here, so the confinement is a value on the call rather
        // than state on the handler. No podHome, no read.
        const home = opts?.podHome;
        if (!home || !url.startsWith(home)) return denied;
        const raw = await this.io.read(url);
        return raw == null
          ? { status: 404, text: async () => '', headers: { get: () => null } }
          : { status: 200, text: async () => raw, headers: { get: () => null } };
      },
      agentControl: this.registry
        ? {
          optIn: (a: { podBase: string; webId: string }) => this.optInPod(a),
          optOut: (a: { podBase: string }) => this.optOutPod(a),
          describe: (a: { podBase: string }) => this.describePod(a),
        }
        : undefined,
    });
    await applyToNode(response as never, out);
  }
}
