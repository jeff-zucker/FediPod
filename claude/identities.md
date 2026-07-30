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

## A group is an identity too

`setup --group` writes `kind: 'group'` into pod state, and the actor publishes as a
`Group` rather than a `Person` — which is what makes Mastodon and Lemmy treat it as
a community you join. Everything else is identical: credential, signing key,
remembered port, park/revive/retire. A group is one more home.

| | person | group |
|---|---|---|
| connects by | following whoever it likes | others following it |
| carries | its own posts | its members' posts, by `Announce` |
| client surface | Phanpy + the Mastodon facade | none |

**A group needs a pod of its own.** WebFinger is one document at the pod root, so a
person and a group sharing a host would fight over the same handle. `setup --group`
*refuses* a pod that is a path rather than a host root rather than warning: a person
accepting that warning is the one who suffers for it, and here they are not.

**Only members are amplified.** Anyone can Append to a public inbox, so arriving is
not the same as being carried to every follower — a post is announced only when its
author already follows the group. That is the anti-spam rule and the moderation lever
at once, and it is what makes joining mean something. `activitypod mute <actor>`
declines to carry a member; a group cannot force an unfollow, so this is the whole of
what it can enforce.

An inbound `Announce` is never re-announced, a re-delivered `Create` is carried once,
and the author's own inbox is dropped from the fan-out — unless it is a shared inbox,
which carries co-tenants who would otherwise be deprived.

`activitypod members | announced | mute | unmute` are the group's operator commands.
`profiles` shows the kind only for a *running* identity: it lives in pod state, and a
stopped identity is shown as `—` rather than guessed at.

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
