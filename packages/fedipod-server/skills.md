# fedipod-server — skills

The FediPod Server: a Community Solid Server component that runs an
ActivityPub identity for each pod whose owner opts in. It is CSS glue only;
the agent, the Gateway's front and the pages are the `fedipod` package,
imported by name. `README.md` is for the operator; this file is for whoever
works on the code.

## Overview

A Community Solid Server serves pods; this component is added to it and does
two jobs. At the server's own address it answers what is not any one pod's:
which pod a handle like `@aisha@example.org` belongs to, and the page where a
pod owner turns their pod into a Fediverse account. That code is shared with
fedipod.net and comes from the `fedipod` package (`lib/gateway/front-core.mjs`);
this component only supplies the pages and the server's storage. Then, for
every pod whose owner has opted in, it runs `fedipod`'s agent inside the
server (`lib/server/embed.mjs`) and answers that pod's Fediverse routes
itself: the actor, the inbox where deliveries are verified as they land, the
Mastodon API for phone apps, and each pod owner's management pages at `/fp/`
on their own pod, opened with a secret that owner was given when opting in.
Everything else on the server is untouched.

## Files

```
src/
  index.ts             the two classes Components.js instantiates; nothing else is exported here
  handler.ts           the HttpHandler: FediPodServerArgs (the settings), the class, its state,
                       canHandle and handle; Internals is the typed view the parts read
  mounts.ts            which pod a request belongs to: claims by host and mount, the handle,
                       the run and door path defaults
  identities.ts        starting each opted-in identity (retried while its pod is still being
                       made), fronting it at the apex, its door secret, stopping them all
  opt-in.ts            what an owner asks: opt in, opt out, describe my pod; reading the
                       server's own account session
  door.ts              a delivery to an identity's inbox, verified where it lands
  front.ts             the Gateway's front (routeFront) with this server's pages, directory,
                       store reads and opt-in controls
  fedipod.ts           the fedipod modules loaded by name, and the dynamic import that loads them
  claims.ts            which PATHS are the front's and which are an identity's
  adapt.ts             Node request/response to the WHATWG pair the shared code speaks
  store-css.ts         the component's own reads and writes through the ResourceStore
  store-pod.ts         an identity's whole conversation with its pod, through the store
  directory.ts         the handle-to-pod directory and the opt-in registry, one document each
  streaming-handler.ts the live feed: websocket upgrades arrive here, not in the waterfall
config/server.json     the snippet an operator imports: the handler in the waterfall before
                       LDP, the streaming handler, the initializer and finalizer lists, the
                       activity+json / ld+json relabelling
scripts/link-fedipod.mjs   in a FediPod checkout, links the checkout into node_modules as
                       `fedipod`; does nothing anywhere else. Every test script runs it first
test/server.test.mjs   claims, the adapter, the directory: no CSS needed
test/live-css.mjs      the handler over a real CSS store stack: opt-in, the transport, the lease
test/e2e/live-agent.mjs    a real CSS with subdomained pods, used as a client would (77 checks)
test/e2e/live-suffix.mjs   the same with suffixed pods (31 checks)
tmp/                   the local Server's data (gitignored)
```

## Commands

```
npm run build        tsc → dist, then componentsjs-generator → dist/components
npm test             build, unit tests, live-css
npm run test:e2e     about 20 seconds; test:e2e:suffix likewise
npm publish --ignore-scripts   after the suites; fedipod must be on npm at the version
                     package.json names first
```

## Rules the code holds to

- `fedipod` is imported by name (`fedipod/embed`, `fedipod/front`,
  `fedipod/front-pages`, `fedipod/place`, `fedipod/pod/transport.mjs`),
  through `esmImport` in `fedipod.ts`, because tsc would turn a plain
  `import()` into `require()` under CommonJS.
- Only what CSS needs lives here. Anything an identity does belongs in
  `fedipod`.
- The generator reads `FediPodServerArgs` and the classes `index.ts`
  exports. It wants CommonJS, extensionless imports, plain parameter types,
  and it offers every PUBLIC class field as a configurable member: the
  handler's state stays private and the parts read it through
  `internals()`.
- Writes go through the top-level `urn:solid-server:default:ResourceStore`,
  never a lower store.
- A runtime file stays under 1,000 lines.
