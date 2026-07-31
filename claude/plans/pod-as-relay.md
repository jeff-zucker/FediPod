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

## Using it

`privateRoot` is a container URL in `credential.json`, per-machine like
`keysMode`. Absent means on the pod, so existing installs are untouched. Under it
the same two trees are laid out as on the pod: `ap-state/` and `fediverse/`.

Setup asks, offering whatever pod is already answering on this machine
(`GET /setup/local-pods` probes dk's `:8000/dk-pod/` and a server on `:4000`) and
falling back to the pod when nothing is — relay is the default *where it is
possible*, because an option that needs software you do not have is not a
default.

Afterwards it is `activitypod state` to see and `activitypod state --to <url>`
(or `--to pod`) to move. That copies both trees, verifies with `commit()`, and
only then rewrites the pointer; the old copy is left behind on purpose. It
refuses while an agent is answering on the port.

## Known limits

- The private-pod fetch does plain HTTP plus an optional `AP_STATE_TOKEN` header
  (dk's gate). A pod with real WAC needs credentials this agent does not offer
  yet — it fails safe, because writes 401, `commit()` returns false and the drain
  declines to delete anything.
- dk's local pod enforces no ACLs at all (`pivot-config/no-auth.json` swaps in
  `allow-all.json`), so the gate token and loopback binding are the whole
  boundary. And it exists only while dk runs.
- No reconcile-on-restore, and no path that rebuilds a lost local store from the
  published `ap/notes/` and `followers` on the pod. Both would close most of the
  RPO gap.
