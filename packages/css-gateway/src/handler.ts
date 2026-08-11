// handler.ts — the CSS HttpHandler. Thin by design: claim only the front's
// routes (canHandle), adapt Node↔WHATWG, and hand off to the same FediPod core
// the standalone gateway runs (routeFront). All the logic lives elsewhere and
// tests without CSS; this file is the wiring CSS needs.
//
// componentsjs-generator reads FediPodGatewayArgs to emit one component
// parameter per field, so the config injects each by name.

import { HttpHandler } from '@solid/community-server';
import type { HttpHandlerInput, ResourceStore } from '@solid/community-server';
import { claims } from './claims';
import { nodeToWhatwg, applyToNode } from './adapt';
import { makeStoreIO } from './store-css';
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
}

// The JS front-core is FediPod's own ESM tree, reached at runtime. A real
// dynamic import() built via Function keeps tsc from downleveling it to
// require() — which cannot load an ESM module with top-level await under a
// CommonJS build.
const FRONT_CORE = '../../../lib/front-core.mjs';
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<{ routeFront: Function }>;

export class FediPodGatewayHandler extends HttpHandler {
  private readonly args: FediPodGatewayArgs;
  private readonly io: IO;
  public readonly dir: Directory;
  private readonly podPut: (url: string, body: string, contentType: string) => Promise<boolean>;

  public constructor(args: FediPodGatewayArgs) {
    super();
    this.args = args;
    this.io = makeStoreIO(args.resourceStore);
    this.dir = makeDirectory(this.io, args.directoryContainer);
    this.podPut = makeStorePodPut(this.io);
  }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const host = request.headers.host as string | undefined;
    const pathname = new URL(request.url ?? '/', `https://${host}`).pathname;
    if (!claims({ host, pathname }, this.args.frontHost)) {
      throw new Error('not a gateway route');   // reject → CSS's LDP handler takes it
    }
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
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
