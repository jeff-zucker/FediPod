// front.ts — a request the Gateway's front answers: the same routeFront the
// Netlify front runs, given this server's pages, its directory, its store
// and the opt-in controls.

import type { HttpHandlerInput } from '@solid/community-server';
import { nodeToWhatwg, applyToNode } from './adapt';
import { FRONT_CORE, FRONT_PAGES, esmImport } from './fedipod';
import type { FrontPages } from './fedipod';
import type { FediPodServerHandler } from './handler';

export async function serveFront(h: FediPodServerHandler,
  request: HttpHandlerInput['request'], response: HttpHandlerInput['response']): Promise<void> {
  const s = h.internals();
  const { routeFront } = await esmImport(FRONT_CORE);
  // Read on each request, so an edited page shows without a restart. A
  // missing file is not fatal: the route it feeds answers 404.
  const { frontPages } = await esmImport(FRONT_PAGES) as unknown as { frontPages: () => FrontPages };
  const pages = frontPages();
  let whatwg: Request;
  try {
    whatwg = await nodeToWhatwg(request as never, s.args.frontOrigin);
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode === 413 ? 413 : 400;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  const out = await routeFront(whatwg, {
    host: s.frontHost,
    frontOrigin: s.args.frontOrigin,
    // This server issued the session the reader is already using, so it can
    // read it rather than sending them to an identity provider that has just
    // told them who they are. Same-origin only; front-core decides that.
    webIdsFromSession: (req: { headers: { get(name: string): string | null } }) =>
      h.webIdsFromSession(req),
    gatewayWebId: s.args.gatewayWebId,
    offersPods: !!s.args.offersPods,
    signupPage: s.args.signupPage || pages.signupPage,
    runPage: s.args.runPage || pages.runPage,
    runPath: s.runPath,
    adminPage: s.args.adminPage || pages.adminPage,
    // The notices page renders here too, and says the server keeps none:
    // a notices store is the Netlify front's, not this component's.
    noticesPage: pages.noticesPage,
    // The opt-in and roster pages load the sign-in library; without it the
    // pages render but cannot be used.
    authBundle: pages.authBundle,
    // Each page's own script, so the pages can be served under
    // `script-src 'self'` (see fedipod/front).
    pageScripts: pages.pageScripts,
    lookup: (handle: string) => h.dir.lookup(handle),
    putDirectory: (handle: string, rec: never) => h.dir.putDirectory(handle, rec),
    podPut: (_handle: string, url: string, body: string, ct: string) => s.podPut(url, body, ct),
    // Reads for the public proxy. `s.io.read` goes STRAIGHT into the
    // resource store, which applies no access control of its own — so this is
    // the one place that has to say what may be read, and it says: only
    // inside the pod of the handle being served, and never a server-internal
    // tree. Without it a row could name any location and this would fetch it
    // (the directory, with every user's receipt secret, included).
    //
    // The front now refuses to attach such a row at all (podHomeProblem in
    // fedipod/front); this is the same refusal at the other end, because
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
      const raw = await s.io.read(url);
      return raw == null
        ? { status: 404, text: async () => '', headers: { get: () => null } }
        : { status: 200, text: async () => raw, headers: { get: () => null } };
    },
    agentControl: s.registry
      ? {
        optIn: (a: { podBase: string; webId: string; container?: string; createIndex?: boolean }) => h.optInPod(a),
        optOut: (a: { podBase: string }) => h.optOutPod(a),
        describe: (a: { podBase: string }) => h.describePod(a),
      }
      : undefined,
  });
  await applyToNode(response as never, out);
}
