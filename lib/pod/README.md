# solid-ap-pod

Reading and writing an ActivityPub actor's documents on a Solid pod.

It knows **where each document lives and how it lands safely** — the container
layout, the transport, the WAC access-control documents, the deletion deny-list,
the byte budgets. It does not know **what is in them**: every AS2 document is
built by the caller and passed in. That line is why this can be lifted out of
the application it grew up in.

It currently lives inside FediPod at `lib/pod/`. Extracting it is a directory
move plus this `package.json`; `scripts/check-pod-calls.mjs` in the parent repo
exists to keep that true.

## Rules it holds itself to

1. **No upward imports.** Nothing here reaches outside this directory.
2. **No Node built-ins.** It runs unmodified in a service worker, which is why
   it carries its own `readCapped`/`retryAfterMs` in `http.mjs` rather than
   using a host application's SSRF-guarding fetch.
3. **One runtime dependency, rdflib**, reached only by `transport.mjs` (listings,
   ACL documents, ACP detection, the WebID patch). Resource modules must stay
   free of it so a size-sensitive host — a serverless function answering every
   request — can import one without paying for a parser.
4. **Everything injected.** It never builds a session, mints a credential, or
   reads config or environment.
5. **No opinions with defaults.** `apUrls` requires the container root rather
   than guessing one, because a guessed root put an identity's state in one
   container and its published documents in another.

## Layout

| file | what |
|---|---|
| `urls.mjs` | the container layout; `apUrls(remotePod, root, { publicBase })` |
| `transport.mjs` | `PodTransport` — verbs, ACLs, listings, cooldown, deny-list |
| `http.mjs` | `readCapped`, `retryAfterMs` |
| `links.mjs` | RFC 8288 `Link` header parsing |

## The transport

`PodTransport` takes a session — `{ fetch(url, init) }` — and never makes one.
A Node agent hands it a DPoP client-credentials grant, a browser hands it a
Solid-OIDC session, a pod server hands it a shim straight onto its own store.

Three manners hold for every request, and they are in `fetch()` so nothing can
route around them:

- **The cooldown.** A 429 or 503 arms a pod-wide pause. `cooldownMode: 'refuse'`
  fails fast for the window (right for a daemon with timers behind it);
  `'wait'` sleeps it out (right for a tab with a person in front of it).
- **The url map.** A fronted identity's advertised ids are mapped to their pod
  locations at this one choke point, so callers pass advertised ids throughout.
- **The deletion deny-list.** A pod's profile, settings, discovery documents,
  access-control documents and lease are never deletable. A pod was crippled
  exactly this way; the list is a DENY-list rather than an allow-prefix because
  the next caller will have a different prefix and the same things it must
  never touch.

Subclasses override **`_send`**, not `fetch` — an override of `_send` cannot
skip any of the three.
