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

<!-- CLAUDE 2026-08-17 — new section: the agent option. Rework freely. -->
## Running the agent

The gateway receives; the agent acts. Set `agentPods` and this same component
also runs FediPod's agent inside the server, for the pods you name — so a pod
here is a fediverse identity that accepts follows, delivers posts and drains its
inbox with no separate process to keep alive:

```json
{
  "@id": "urn:fedipod:gateway:Handler",
  "@type": "FediPodGatewayHandler",
  "args_agentPods": [ "https://alice.example.org/" ],
  "args_agentDataDir": "/var/lib/css/fedipod-agent/"
}
```

An identity that does not exist yet is provisioned on first start: its name is
the pod's subdomain label (or last path segment), and it publishes an actor, a
signing key and WebFinger on the pod itself. Its state lives on the pod; its
signing key lives in `agentDataDir`, one directory per identity.

| Setting | What it is |
|---|---|
| `agentPods` | Pod base URLs to run an identity for. Listing a pod is how you turn the agent on; with none, nothing runs. |
| `agentDataDir` | Where each identity keeps its signing key and log. Required whenever `agentPods` is set. |
| `agentWebIdSuffix` | Path from a pod's base to its owner's WebID. Defaults to `profile/card#me`. |
| `agentPollSeconds` | How often the inbox is swept. Deliveries also wake the sweep as they land, so this is the fallback. |
| `agentAutoAcceptFollows` | Whether a newly provisioned identity accepts follows without review. On by default. |
| `agentGateToken` | The secret guarding the owner's pages and admin routes. Required whenever `agentPods` is set. |
| `agentUiPath` | Where those pages live on the pod's origin. `/app/` by default; empty serves no pages. |

Two things to know before turning it on. The signing keys are held by the
server process, so whoever runs the server can act as those identities. And a
delivery is picked up the moment it lands only in a single-worker server; with
`--workers` above one the inbox is swept on the timer instead.

### The identity's own origin

Each identity answers on its pod's origin, so the pod is the instance a client
connects to. Point a Mastodon app at `https://alice.example.org/` and it finds
everything it expects: nodeinfo, the client API under `/api/`, sign-in under
`/oauth/`, the live feed at `/api/v1/streaming`, and the ActivityPub write API
at `/ap/outbox`. The owner's own pages — the record, the setup screens and the
bundled web client — sit behind `agentUiPath`, which the gate secret guards.

Because a client API is rooted at an origin, each identity needs an origin of
its own: subdomain pods, one per identity. Two entries on one host, or an entry
on the front's own host, are refused at startup rather than half-working.

**Sign-in needs a password.** These routes face the whole internet, so
`/oauth/authorize` refuses until the identity has one. Set it once through the
door, with the gate secret:

```
curl -X POST https://alice.example.org/app/config \
  -H 'x-dk-token: YOUR_GATE_SECRET' -H 'content-type: application/json' \
  -d '{"password":"the one you will type into your phone"}'
```

**What the identity takes over.** On that origin the paths above belong to the
identity, so pod resources at those names — a container called `api`, `oauth`
or `app`, or documents at `ap/actor`, `ap/outbox`, `.well-known/nodeinfo` and
`nodeinfo/2.0` — are not served over HTTP there. They remain in the pod and in
its listings. Every other path is the pod, exactly as before. The server logs
the list for each identity when it starts.
<!-- /CLAUDE -->

## Build

TypeScript, built the way CSS builds its own components:

<!-- CLAUDE 2026-08-17 — corrected: CSS is now a devDependency of this package
     (fresh from npm), so there is no symlink step. -->
```
npm install         # installs @solid/community-server too
npm run build       # tsc → dist, then componentsjs-generator → dist/components
```
<!-- /CLAUDE -->

`dist/` and `node_modules/` are gitignored; `src/`, `config/`, and this README
are the sources.

<!-- CLAUDE 2026-08-17 — the section below is stale: it is written against CSS
     7.1.9 and quotes check counts that have moved. The package now builds and
     is validated against 7.2.0, and there are three suites:
       npm test          unit + test/live-css.mjs (the transport, against a real
                         CSS store stack: ETags, If-Match, container listings,
                         the lease, the deletion deny-list)
       npm run test:e2e  boots a real CSS, two seeded pods become two fediverse
                         identities, a Follow delivered over HTTP is answered
                         with a signed Accept, clean shutdown
     Whether the prose below is rewritten or simply deleted is yours to say —
     it reads as a validation diary rather than a description of the package. -->
## Status & tests — validated against real CSS 7.1.9

- **Pure pieces** (route claiming, the adapter, the store-backed directory/podPut):
  `npm test` → 6/6.
- **The HttpHandler shell** (`test/live-css.mjs`): instantiates the real
  `HttpHandler` subclass with a `ResourceStore` built from real CSS
  `BasicRepresentation`/`readableToString` and drives it — `canHandle` claims the
  front routes and rejects pod subdomains, and `handle` serves the page, answers
  WebFinger, and **writes a delivery into the pod inbox through the store** —
  10/10.
- **The Components.js packaging**: generated by `componentsjs-generator` from the
  TypeScript sources (the same tool + `-r` prefix flag CSS uses). Verified that
  componentsjs **5.5.1** — the version CSS 7 loads — **loads the metadata and
  discovers `FediPodGatewayHandler` with all seven parameters**. The
  `config/gateway.json` snippet uses `OverrideListInsertBefore` (confirmed present
  in componentsjs 5.5.1) to insert the handler before the LDP catch-all in
  `BaseHttpHandler`'s waterfall.
- **Full live boot — validated.** A real CSS 7.1.9 server booted with
  `config/gateway.json` imported alongside CSS's `config/default.json` (via
  `AppRunner`): a front route reached the handler while pod traffic fell through.
  `GET /api/handle?handle=x` with `Host: fedipod.net` returned the handler's JSON
  (`{ handle, available, offersPods }` — which CSS itself never produces),
  confirming the `OverrideListInsertBefore` landed the handler in the running
  waterfall; `GET /` with `Host: localhost` returned CSS's pod root (200),
  confirming a non-front request is untouched. So the component installs and
  routes correctly in a live server. (`args_frontHost` and the chain target may
  still want per-distribution tuning — the pivot's http-handler override could
  reshape the chain — but the mechanism is proven on stock default config.)
- Monorepo for now under FediPod's `packages/`. The eventual home is the CSS
  project's own component ecosystem, contributed upstream when ready — which is
  why matching their TS + generator toolchain was the right path.
