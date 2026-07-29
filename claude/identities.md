# Identities, keys and lifecycle

## One identity per home

An identity is a directory: credential, signing key, remembered port, local log.

| how to select it | resolves to |
|---|---|
| `--home <path>` / `AP_HOME` | exactly that (wins over everything) |
| `--profile <name>` / `AP_PROFILE` | `~/.activitypod/profiles/<name>/` |
| neither | `~/.activitypod/` |

`activitypod profiles` lists the default home and every profile with its pod,
port and whether an agent is answering. It reads local files plus a 1.5 s
liveness probe — nothing from the pod, so it works offline. Identities under a
custom `AP_HOME` cannot be discovered and the output says so.

`setup` **refuses** an existing `credential.json` (exit 2) and names the identity
it would have destroyed. This is not politeness: a minted credential is shown
once, so overwriting it lost the scn identity on 2026-07-29 with no way back.
`--force` is the deliberate escape.

## Keys belong to one actor

`keys.json` carries `mintedFor: <actor URL>`. A key stamped for a different actor
is treated as absent, so the mint path — and its "this actor already publishes a
key" guard — applies. Unstamped legacy keys are still adopted, with a warning,
so existing installs keep working.

Why it matters: before stamping, a second `setup` in the same home adopted the
first identity's key, and the two actors advertised the same public key. Anyone
comparing the documents could see one operator behind both. That is the linkage
separate identities exist to avoid.

`activitypod rotate-key` mints a replacement **and** republishes the actor that
advertises it, updating the live publisher and deliverer so the running agent
signs with the new key at once. Rotating without republishing leaves remote
servers verifying against a key nobody holds and every delivery fails silently,
so the command does both or neither. Remote servers cache public keys and
refetch on verification failure, so followers heal on the next delivery.

## Retiring, parking, moving

| command | followers told | handle resolves | inbox | reversible |
|---|---|---|---|---|
| `park` | nothing | yes | closed | `revive` |
| `retire --move-to <actor>` | `Move` → they migrate | yes, as a redirect | closed | no |
| `retire` | `Delete` → they drop you | as a Tombstone | open (cheap 201s) | no |

`park` snapshots the following list *before* unfollowing, because unfollowing is
what stops inbound traffic at source and also destroys the only record of who was
being followed. `revive` re-opens the inbox and re-sends every remembered
`Follow` — requests, not restorations: each needs the far side to `Accept`.

A parked agent that gets started anyway does not drain or poll, so the quiet does
not depend on remembering never to run it.

`retire` leaves the inbox Append-able on purpose: closing it makes deliveries
401, which Mastodon treats as permanent and drops — good — but a `Delete` already
tells well-behaved servers to stop, and an open inbox answering cheap 201s beats
generating retries. `park` closes it because there is no `Delete` to rely on.

## Leases and one-shot commands

Every command that calls `connect()` acquires the pod lease, so `rotate-key`,
`park`, `revive` and `retire` release it before exiting. They did not at first,
which left the next `start` read-only for the whole 300 s TTL — twice, during the
live rotation. `start --takeover` claims a lease whose holder is gone but whose
TTL has not expired; automatic promotion otherwise waits out both the TTL and a
viewer refresh.
