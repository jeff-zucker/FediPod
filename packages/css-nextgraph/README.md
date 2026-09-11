# css-nextgraph

A [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer)
storage component that keeps every pod in [NextGraph](https://nextgraph.org),
encrypted under a wallet of its own. The server is a Solid pod server as
before: WebIDs, Solid-OIDC login, containers, access control. Underneath,
each pod's resources are NextGraph documents in that pod's wallet, and the
wallet is a file the host can hand the pod's owner.

Add [fedipod-server](../fedipod-server/README.md) and every pod can also be
a Fediverse account. The two together are what ActivityPods was going to be
for NextGraph: CSS is the pod and the HTTPS face, FediPod Server the
ActivityPub server, NextGraph the store.

Experimental. NextGraph is alpha software; its formats may change without a
migration, and two things it does not do yet shape this component (see
[What NextGraph cannot do yet](#what-nextgraph-cannot-do-yet)).

## What is where

- **One wallet per pod**, made by the server on the host's own NextGraph
  daemon the first time the pod is written, kept as a file plus its
  password, mnemonic and PIN in the wallets directory. The keys, not the
  data. `css-nextgraph wallet <pod-url> --dir <walletsDir>` prints them.
- **Two documents per container** in the pod's private store, found by
  their headers: a data document holding the triples of the RDF resources
  the container directly contains and, as files named by resource URL, its
  binary resources; and a meta document holding the server's metadata for
  each of them. A pod has as many documents as it has containers, which is
  what every session start pays for.
- **RDF is triples, everything else is bytes.** Turtle, JSON-LD, N-Triples,
  N-Quads, TriG, N3 and RDF/XML are parsed and stored as triples, so they
  are queryable in NextGraph. Media, ActivityPub JSON, markdown and anything
  else are stored as the bytes they came as and come back exact.
- **A resource's triples are the ones about itself**: subject the resource's
  URL or a fragment of it. Blank nodes become fragments on the way in and
  blank nodes again on the way out. A Turtle document about other subjects
  has no home in a graph shared with its siblings and is refused with 409.
- **`.internal/`** (accounts, sign-up state, keys) stays on disk, as it does
  in CSS's own SPARQL-plus-files setup.

## Requirements

- Node 20 or later, CSS 7.
- A NextGraph daemon (`ngd`) on this machine, reachable on localhost. As of
  this writing no release carries a binary and the repository's default
  branch does not compile; the `master` branch does. How this component's
  spike built one is in the FediPod repository under
  `claude/plans/css-nextgraph-spike.md`.
- Pods on subdomains (the shipped config) or on paths (one wallet for the
  whole server, since one root is one wallet).

## Install and run

```
npm install css-nextgraph @solid/community-server
```

Start the daemon once with `--save-key -l 1440`; it prints its PeerId and,
on its very first start, an admin invitation link. Paste that link into a
file named `setup-invitation` in the wallets directory: the first pod's
wallet registers with it, which a fresh daemon requires. Then run the daemon
with `--registration-open`, so every later wallet can register on its own.

```
community-solid-server -c node_modules/css-nextgraph/config/server.json -m . \
  -b https://pods.example/ -f ./data --walletsDir ./wallets --ngdPeerId <PeerId>
```

`config/server.json` is CSS's subdomain-pods server with this backend in
place of the memory one. To put the backend under a config of your own,
drop the `css:config/storage/backend/*.json` import and import
`cng:config/backend.json` with this package's context:

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld",
    "https://linkedsoftwaredependencies.org/bundles/npm/css-nextgraph/^0.0.0/components/context.jsonld"
  ],
  "import": [ "...", "cng:config/backend.json" ]
}
```

The backend needs two values, `urn:css-nextgraph:default:variable:walletsDir`
and `urn:css-nextgraph:default:variable:ngdPeerId`; `config/server.json`
takes them from `--walletsDir` and `--ngdPeerId`.

Two things the shipped config sets that yours should too: the resource lock
expiration is raised to 30 seconds, because the first write to a new pod
makes its wallet (about eight seconds of key derivation and registration);
and the accessor sits on the server's initializer list, so every known
pod's wallet is opened when the server starts rather than on its first
request.

## Handing a pod over

```
css-nextgraph wallet https://alice.pods.example/ --dir ./wallets
```

prints the wallet file's path, its password, the twelve mnemonic words and
the PIN. In the NextGraph app, "Login", "Import a Wallet File", the file,
the password: the pod's documents are there, titled by container URL.
Today that shows them; sharing and editing them from there and having the
server see it is the part NextGraph has not built.

## Operating notes

- If the daemon restarts under a running server, the sessions reconnect on
  their own; reads are answered from the session's own state meanwhile and
  writes made then are sent once the broker is back. Those queued writes
  live in the server's memory until it is: a server stopped in that window
  loses them.
- A pod's first write, which makes its wallet, takes about eight seconds;
  after that, reads and writes are single-digit milliseconds plus the SPARQL
  round trip.
- With CSS's `static-root.json` (which the subdomain configs import), the
  path `/` on every host is the static intro page, pod roots included. That
  is CSS's behaviour, not this component's.
- Wallet files and their records are the pod. Back the wallets directory
  up; a wallet whose mnemonic is lost is a pod that is lost.

## What NextGraph cannot do yet

- **Delete a document.** The command answers `NotImplemented`. A deleted
  container's documents are emptied and reused if it comes back.
- **Remove or replace a file.** A PUT over a binary resource adds a newer
  entry under the same name; the newest is served and the older ones stay in
  the document until NextGraph can remove files.
- **Open a pod from a shared capability.** The wallet hand-over works; a
  pod appearing on its owner's devices while the server keeps serving it
  waits on NextGraph's read end and delegation.

## Build and test

```
npm install
npm test          # builds, then the accessor over in-memory stores
```

The live behaviour, a real CSS over a local daemon, is proven by
`test/css-live.mjs`: PUT and GET of Turtle, a JPEG and an ActivityPub
document, listings, the 409, deletes, then both daemon and server restarted
and everything read back, and the hand-over command. It is not part of
`npm test`; it needs a daemon running and is started with

```
node test/css-live.mjs
```
