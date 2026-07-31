# The pod as a relay

Built 2026-07-30. Diagram: `claude/diagrams/architecture-relay.svg`.

The pod used to be the whole storage story — the public wire face, the RDF truth
in `fediverse/`, and every state document in `ap-state/`. `privateRoot` in the
credential file moves the last two to a pod of your own, usually one on this
machine. The pod keeps what the protocol forces to be public, plus one thing
more.

## What the pod must keep

`publisher.publishProfile()` writes an ACL for every document it touches, and
exactly two containers get `setAcl(url, [])`. Those two are the private ones.
Everything else is public because ActivityPub makes it so:

| stays | why |
|---|---|
| `.well-known/webfinger` + `host-meta` | answered only at a **host root**; it is how a handle resolves at all |
| `ap/actor` + public key | fetched by every server that verifies a signature |
| `ap/inbox` (public append) | **this is the relay** — the only inbound path to a machine behind NAT |
| `ap/outbox`, `followers`, `notes` | strangers dereference note `id`s; a thread that cannot be fetched does not render |
| `ap/media` | attachments are fetched the same way |
| `ap-state/lease.json` | **not public — pinned deliberately.** See below. |

## Why the gain is large for one box moved

The topology does not change: same nodes, same edges as `architecture.svg`. What
changes is where the weight sits. Every activity you *receive* costs the pod
several writes today — the note into `fediverse/timeline/` as RDF, plus
`statuses.json`, usually `notifications.json`, often `contacts.json` — each a
debounced PUT, each preceded at load time by a container sweep with ETag
revalidation. After the move, receiving costs the pod nothing but the inbox
drain that delivered it. **Pod cost stops scaling with what you read and scales
only with what you write**, and most people read far more than they write.

## The invariant that stopped being free

`intake._drainOnce()` is a destructive read: it DELETEs each item from the inbox
after handling it, and handling writes to the store. With one pod that is safe
for nothing — a pod you cannot write to is a pod you cannot list either, so the
drain never starts. Split the store off and the inbox can be reachable while the
state pod is not: the agent drains into `PodStore`'s in-memory cache, looks
healthy, and loses it all on exit.

It was worse than it looked. `store._put()` gave up silently — a 4xx logged
"refused — not retrying" and returned, retry exhaustion logged "gave up" and
returned, and either way the promise resolved. So `flush()` resolving never
meant "persisted".

The fix is **ordering, not a health check**: `_put()` now resolves a boolean,
`commit()` forces every pending write and reports whether they all landed, and
the drain calls it before each DELETE. A failure leaves the item in the inbox for
the next sweep, and re-delivered activities are already handled idempotently.
Gated on `intake.strictCommit` — true only when the state's origin differs from
the inbox's — so the default configuration takes no extra remote writes.

Health checks were the wrong shape and worth recording as rejected: last-flush
timestamps go stale on an idle agent, and a pre-flight probe puts back exactly
the periodic traffic this design removes.

## The lease is pinned to the remote pod

`bootstrap()` provisions and locks down the pod's `ap-state/` whether or not the
private half lives there, because `lease.json` stays. A lease in a pod only one
machine can reach coordinates nothing, and two agents both draining is silent,
destructive loss. It is free: `Lease` is constructed in `connect()` with its own
explicit URL built from `this.urls.state`, never from the store's base.

That single decision is what makes local state safe rather than a footgun. It
buys single-writer *safety*; it does not buy multi-device, because the second
machine still cannot see the state.

## What it costs

Two gaps, one cause — the state now has a single copy on a machine you own.

- **No concurrent multi-device.** Backups give you serial migration, not
  parallel use.
- **RPO** goes from zero to your backup interval. Restoring a stale snapshot is
  not neutral either: `publishCollections()` writes the followers list from local
  contacts, so an old backup republished would overwrite the pod's newer list.
  Nothing reconciles that today.

Not costs, on inspection: availability is a pause rather than corruption once the
ordering fix is in; Android is fine because the local store is text only (your
media goes to the pod as published copies, other people's stays on their
servers); the backup's destination is a deployment choice, though worth choosing
deliberately, since that blob holds your timeline, contacts, blocklist and key.

## The storage interface

Added 2026-07-31. `lib/storage.mjs` is what a container is, reduced to what the
store and the RDF tree actually do to one: **list, read, write, remove**. Two
implementations —

- `HttpStorage` — a pod, local or remote. Its `fetchImpl` carries whatever
  authentication it needs. Container listings are parsed by rdflib, querying
  `ldp:contains`.
- `FileStorage` — a directory. `readdir` *is* the listing, so nothing serialises
  a container into RDF only to parse it straight back out. Writes go to a
  neighbouring temp file and are renamed into place, which is atomic on POSIX,
  so no reader — and no backup — ever sees half a document. Mode 0600, and a
  write is never retried: an EACCES will still be an EACCES in two seconds.

`storageFor(base, fetchImpl)` picks by scheme: `http(s):` is a pod, anything
else is a directory.

`@solid-rest/file` was the obvious candidate and was **not** used. It is a mini
Solid server — LDP membership triples, POST-with-slug, auxiliaries, content
negotiation, status semantics — and all of that exists to satisfy HTTP. Nothing
speaks HTTP to a directory here, so it would have been a full LDP implementation
carried to perform four operations, plus a serialise-then-parse round trip on
every load.

## Using it

`privateRoot` in `credential.json` is per-machine, like `keysMode`. Absent means
on the pod, so existing installs are untouched. Under it the same two trees are
laid out as on the pod: `ap-state/` and `fediverse/`. It may be

- a **pod URL** — `http://localhost:8000/dk-pod/activitypods-js/`. dk wants this,
  because its CSS is live whenever dk is open and writing files underneath a
  running server goes around its lock and its metadata.
- a **directory** — `file:///home/you/.activitypod/private/` or a bare path.
  Nothing to install, nothing to keep running, and the store cannot be
  unreachable.

Setup asks, offering whatever pod is already answering on this machine
(`GET /setup/local-pods` probes dk's `:8000/dk-pod/` and a server on `:4000`) and
falling back to the pod when nothing is — relay is the default *where it is
possible*, because an option that needs software you do not have is not a
default.

Afterwards it is `activitypod state` to see and `activitypod state --to <url>`
(or `--to pod`) to move. That copies both trees, verifies with `commit()`, and
only then rewrites the pointer; the old copy is left behind on purpose. It
refuses while an agent is answering on the port.

## Parked, kept on purpose: serving the private half

Parked 2026-07-31. Two ideas that only make sense together:

- the agent serving its own private store as a small LDP surface on the HTTP
  server it already runs — nothing extra to install, no second process, no port
  to choose, and the store could never be unreachable, because its server and
  its client would be the same process;
- other Solid apps reading the private half there, or by pointing a CSS at the
  directory — dk's fediverse pane, SolidOS, podz.

It was attractive because it makes "your data, your apps" true of the private
half too, and because a directory of Turtle really is a pod the moment a server
points at it — that is exactly how `~/solid/dk-pod/` works today.

Two things stopped it:

- **Scope.** For our own client the surface is tiny. But the moment it is
  advertised as a pod, it owes content negotiation, correct types, `Link:
  rel="type"` on containers, and eventually access control — a server to own and
  maintain, growing by expectation rather than by need.
- **Cross-origin.** The point of serving it is that *another* app reads it, and
  `guard.checkRequest` refuses any request whose `Origin` is not in the allowed
  set — which is what dk's pane at `localhost:8000` would send. Opening that is a
  security decision about the firewall that keeps visited web pages out of the
  agent, not a plumbing detail.

What parking it settles: the private half is the agent's own storage, not a
published surface. So the on-disk layout no longer has to match what CSS expects
(`foo$.ttl` served as `foo`), which is one fewer thing to get quietly wrong — and
a filesystem store becomes the straightforward answer rather than a compromise.

What would revive it: a deliberate read-only allowlist for one path prefix,
and a reason better than "it would be nice" — a second app that actually wants
to read this data.

## Known limits

- A private **pod** is reached with plain HTTP plus an optional `AP_STATE_TOKEN`
  header (dk's gate). One with real WAC needs credentials this agent does not
  offer yet — it fails safe, because writes 401, `commit()` returns false and the
  drain declines to delete anything. A private **directory** has no auth question
  at all: mode 0600, like the credential beside it.
- Setup still only offers a pod it can find answering; pointing `privateRoot` at
  a directory is a `credential.json` edit or `activitypod state --to`. Making the
  directory the offered default is the thing that would let relay be the default
  on a fresh install everywhere, and it is not done.
- dk's local pod enforces no ACLs at all (`pivot-config/no-auth.json` swaps in
  `allow-all.json`), so the gate token and loopback binding are the whole
  boundary. And it exists only while dk runs.
- No reconcile-on-restore, and no path that rebuilds a lost local store from the
  published `ap/notes/` and `followers` on the pod. Both would close most of the
  RPO gap.
