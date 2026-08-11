# fedipod-css-gateway

The FediPod inbox gateway / multi-user front, as a **Community Solid Server
component**. A host who already runs CSS for pods can add the gateway *to that
server* instead of running a separate always-on box: it verifies inbound
ActivityPub deliveries at the door, drops forgeries and spam, and writes the
verified mail straight into the right pod's inbox **through the server's own
store** — no append credential, no loopback, no second process.

It also serves the front: WebFinger for `@name@host`, each user's actor and
collections (rewritten from their pod), and the signup/attach flow.

This is the second deployment shape for the gateway; the first is the standalone
Netlify/any-box function in FediPod's `netlify/`. Both run the same core logic
(`lib/gateway-core.mjs`, `lib/front-core.mjs`); this package is only the CSS glue.

**A front is only a doorway.** It never hosts or dictates pods. Pod-hosting is
the operator's own CSS (which is exactly why this rides on it); users may always
bring their own pod.

## What it is

- `src/handler.mjs` — `FediPodGatewayHandler extends HttpHandler`. `canHandle`
  claims **only** the front host's routes (WebFinger, the actor/collection GETs,
  the per-user inbox, signup/attach); a pod subdomain or any other path is
  rejected, so normal pod/LDP traffic falls straight through to CSS.
- `src/adapt.mjs` — the one glue layer: Node request/response ↔ the WHATWG
  Request/Response the core speaks.
- `src/store-css.mjs` — the store IO: reads pods and writes inbox items and the
  directory through the injected `ResourceStore` (bypasses WAC by design — the
  handler is the thing that decided the write is legitimate).
- `src/directory.mjs` — the handle→pod directory, one JSON resource per handle
  in an internal container.

## Install

```
npm install fedipod-css-gateway
```

In your CSS config, add the package context to `@context`, import the shipped
snippet, and set your front host — for example:

```json
{
  "@context": [
    "...your CSS context...",
    "https://linkedsoftwaredependencies.org/bundles/npm/fedipod-css-gateway/^0.0.0/components/context.jsonld"
  ],
  "import": [
    "fpg:config/gateway.json"
  ]
}
```

`config/gateway.json` inserts the handler before the LDP catch-all
(`OverrideListInsertBefore` on `BaseHttpHandler#handlers`) and reads the front
host/origin from the server's `baseUrl` variables. Override `offersPods`,
`gatewayWebId`, `directoryContainer`, or `signupPage` on the
`urn:fedipod:gateway:Handler` node as needed. Restart CSS.

## Status & tests

- **CSS-free pieces — validated.** `node --test` (and FediPod's own suite) cover
  route claiming, the adapter, and the store-backed directory/podPut.
- **The HttpHandler shell — validated against real CSS 7.1.9.** `test/live-css.mjs`
  instantiates `FediPodGatewayHandler` (extending the real `HttpHandler`) with a
  `ResourceStore` built from real CSS `BasicRepresentation`/`readableToString`,
  and drives requests through it: `canHandle` claims the front routes and rejects
  pod subdomains, and `handle` serves the page, answers WebFinger, and **writes a
  delivery into the pod inbox through the store** — 10/10. (Run it where
  `@solid/community-server` resolves.)
- **The Components.js packaging in `components/` — NOT yet valid; provisional.**
  Loading it under the installed componentsjs (**5.5.1**) fails: it was drafted
  to the wrong context version and the wrong `@id`/prefix structure, and the
  component is not registered. CSS generates this metadata **from TypeScript
  sources with `componentsjs-generator`** (the `css:dist/…File.jsonld#Class`,
  `@prefix: true` shape) — hand-authoring it is the wrong approach. The correct
  fix is a small TypeScript rewrite of the handler + glue, then generate the
  JSON-LD the way CSS itself does. Until then this component's LOGIC is proven in
  a live server but it cannot yet be wired via config. `config/gateway.json` is
  likewise provisional.
- Monorepo for now, under FediPod's `packages/`. The eventual home is the CSS
  project's own component ecosystem, contributed upstream when ready (which is
  itself why matching their TS + generator toolchain is the right path).
