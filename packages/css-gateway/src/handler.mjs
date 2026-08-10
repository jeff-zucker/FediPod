// handler.mjs — the CSS HttpHandler. Thin by design: claim only the front's
// routes (canHandle), adapt Node↔WHATWG (adapt.mjs), and hand off to the same
// FediPod core the standalone gateway runs (routeFront). Everything with logic
// lives elsewhere and tests without CSS; this file is the wiring CSS needs.
//
// Constructor args are injected by Components.js (see components/ + config/).

import { HttpHandler } from '@solid/community-server';
import { routeFront } from '../../../lib/front-core.mjs';
import { claims } from './claims.mjs';
import { nodeToWhatwg, applyToNode } from './adapt.mjs';
import { makeStoreIO } from './store-css.mjs';
import { makeDirectory, makeStorePodPut } from './directory.mjs';

export class FediPodGatewayHandler extends HttpHandler {
  constructor(args) {
    super();
    // args: { resourceStore, frontHost, frontOrigin, gatewayWebId, offersPods,
    //         directoryContainer, signupPage }
    this.args = args;
    this.io = makeStoreIO(args.resourceStore);
    this.dir = makeDirectory(this.io, args.directoryContainer);
    this.podPut = makeStorePodPut(this.io);
  }

  async canHandle({ request }) {
    const host = request.headers.host;
    const pathname = new URL(request.url, `https://${host}`).pathname;
    if (!claims({ host, pathname }, this.args.frontHost)) {
      throw new Error('not a gateway route');   // reject → CSS's LDP handler takes it
    }
  }

  async handle({ request, response }) {
    const whatwg = await nodeToWhatwg(request, this.args.frontOrigin);
    const out = await routeFront(whatwg, {
      host: this.args.frontHost,
      frontOrigin: this.args.frontOrigin,
      gatewayWebId: this.args.gatewayWebId,
      offersPods: !!this.args.offersPods,
      signupPage: this.args.signupPage || null,
      lookup: (h) => this.dir.lookup(h),
      putDirectory: (h, rec) => this.dir.putDirectory(h, rec),
      podPut: (_handle, url, body, ct) => this.podPut(url, body, ct),
      // Reads of a user's pod (actor/collection proxy) go straight through the
      // store too, since the pods live on this same server.
      podGet: async (url) => {
        const raw = await this.io.read(url);
        return raw == null
          ? { status: 404, text: async () => '', headers: { get: () => null } }
          : { status: 200, text: async () => raw, headers: { get: () => null } };
      },
    });
    await applyToNode(response, out);
  }
}
