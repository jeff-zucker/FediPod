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
  daemon the first time the pod is written, kept as a file in the wallets
  directory. Beside it is a record naming the pod, holding the password,
  mnemonic and PIN sealed under this server's master key. The keys, not the
  data. `css-nextgraph wallet <pod-url> --dir <walletsDir> --key <masterKey>`
  prints them.
- **One master key for the server**, which the records are sealed under, so a
  copy of the wallets directory opens nothing. See
  [The master key](#the-master-key).
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
- A master key, from `css-nextgraph key`, kept somewhere that is not this
  server. Every pod's wallet record is sealed under it, and without it they
  cannot be opened. See [The master key](#the-master-key).
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

Mint the server's master key and keep a copy somewhere that is not this
server:

```
npx css-nextgraph key
```

Start the daemon once with `--save-key -l 1440`; it prints its PeerId and,
on its very first start, an admin invitation link. Paste that link into a
file named `setup-invitation` in the wallets directory: the first pod's
wallet registers with it, which a fresh daemon requires. Then run the daemon
with `--registration-open`, so every later wallet can register on its own.

```
CSS_NEXTGRAPH_KEY=<masterKey> \
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

## The master key

A wallet record holds the mnemonic and PIN that open one pod's wallet, and the
server opens wallets with nobody present, so it has to hold them. They are
sealed under one key for the whole server, which is never written to disk, so
a copy of the wallets directory — a backup, a synced folder, a support tarball
— is a pile of encrypted wallets and nothing that opens them.

`css-nextgraph key` mints one. Only a key it minted is accepted: a passphrase
someone chose would be guessable. **Keep a copy somewhere that is not this
server.** A lost key is every pod on it, unopenable, with no way back.

The server takes the key from one of three places, in this order.

| Where | When |
|---|---|
| The systemd credential `css-nextgraph-key` | The unit supplies one with `LoadCredentialEncrypted=`. systemd keeps it sealed to the machine, hands it over in memory, and it appears in no backup. |
| `CSS_NEXTGRAPH_KEY` | Set in the server's environment. |
| The unlock page | Neither of the above. The server starts, its pods stay closed, and it serves `/nextgraph/unlock` on its base URL until somebody pastes the key. |

On a host with a TPM the first row is the one to use: the server comes back
from a reboot on its own and nobody has to be there.

```
systemd-creds encrypt --name=css-nextgraph-key key.txt /etc/css/key.cred
```

and in the unit:

```
LoadCredentialEncrypted=css-nextgraph-key:/etc/css/key.cred
```

### The unlock page

Without a credential or an environment variable the server still starts and
listens. Every pod answers 503 until the key arrives, and a request is refused
rather than held.

The key is the only thing the page asks for: anyone holding it can already
read every wallet record on the host. A key that does not open the records
here is refused on the spot, and five wrong ones in a row stop the page
answering for a minute. It is served on the base URL and on no pod's origin,
and the key is held in memory until the server stops.

A pod created after an unlock is sealed under the same key.

### A server whose records are not sealed yet

An unsealed record works untouched on a server with no key, and is sealed in
passing the first time it is read on a server with one. There is no migration
to run: set the key and restart.

## Handing a pod over

```
css-nextgraph wallet https://alice.pods.example/ --dir ./wallets --key <masterKey>
```

prints the wallet file's path, its password, the twelve mnemonic words and
the PIN. The master key unseals the record; it is the host's and never the
owner's, and it has nothing to do with the wallet they walk away with. In the NextGraph app, "Login", "Import a Wallet File", the file,
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
- Wallet files and their records are the pod. Back the wallets directory up —
  and back the master key up separately, because the directory is worth
  nothing without it. A wallet whose mnemonic is lost is a pod that is lost.

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
npm test          # builds, then the accessor, the master key and the unlock page
```

Two live harnesses prove what a real CSS over a local daemon does. Neither is
part of `npm test`; both need a daemon running.

```
node test/css-live.mjs          # pods in NextGraph
node test/css-live-unlock.mjs   # the sealed records and the unlock page
```

The first: PUT and GET of Turtle, a JPEG and an ActivityPub
document, listings, the 409, deletes, then both daemon and server restarted
and everything read back, and the hand-over command. The second writes a pod
under a key, restarts the server with no key anywhere, and checks that the
pod is not served, that the page takes the right key and refuses a wrong one,
that the pod answers again afterwards, and that the hand-over still works.
