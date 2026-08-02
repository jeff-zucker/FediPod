# A pod's infrastructure is never deletable

Standing rule, every project, stated 2026-08-02 after a Claude session crippled
the `dk-ap` pod.

Never delete, and never overwrite with something malformed:

- anything under the pod's **`settings/`**
- the pod root's **`.well-known/`**
- any **`.acl`** or **`.meta`** auxiliary, anywhere
- the **profile** (`/profile/card`) — and never write an invalid one, because a
  half-written profile is worse than none: it parses as an identity that says
  nothing

These are not data. They are the pod's ability to *be* a pod: the server reads
them to know who owns it, what it grants and how to answer discovery, and the
profile is the WebID everything authenticates against. Delete one and the pod
does not degrade, it stops — and it cannot be repaired by the tool that broke
it, because that tool can no longer authenticate.

## Where the guard lives, and why there

`protectedFromDeletion(url)` in `lib/remote.mjs`, called by `RemotePod.delete`.
Every DELETE this project sends goes through that one method — the inbox drain,
`deleteNote`, the migration scripts — so it is the only place that cannot be
routed around.

It is a **deny-list, not an allow-prefix**. `clear-pod-private-copy.mjs` jails
its deletes to two container prefixes, which is the right shape for that script
and the wrong guarantee in general: the next script will have a different prefix
and exactly the same list of things it must never touch.

The match is on a path **segment** (`/profile(/|$)`), so a container merely
beginning with the word — `/profiles-of-mine/` — is not the profile. There is a
test for that, because a rule that also blocks legitimate deletes gets removed.

## What a crippled pod looks like from outside

Checked 2026-08-02, unauthenticated, against two healthy pods for comparison:

| pod | `/profile/card` | `/settings/` | `/.meta` |
|---|---|---|---|
| `solo.teamid.live` | 200 | 401 | 200 |
| `jeff-zucker.teamid.live` | 200 | 401 | 200 |
| `activitypods-js.solidcommunity.net` | 200 | 401 | 200 |
| **`dk-ap.solidcommunity.net`** | **401** | 401 | 200 |

`/settings/` answering 401 is normal — it is private on every pod, healthy or
not. The tell is the **profile**: on `dk-ap` it is the only one of the four that
cannot be read by a stranger.

That is the whole failure. CSS verifies a cross-host token by dereferencing the
WebID and matching `solid:oidcIssuer`, so a profile nobody can read is an
identity that can no longer authenticate anywhere.

**What cannot be told from outside:** CSS answers 401 both for "absent, and you
may not know that" and for "present, but you may not read it". So whether the
document was deleted or merely lost its public-read ACL needs the pod owner's
credentials, and is not something to find out by trying.

Everything else on `dk-ap` is intact: `/.meta`, `/.well-known/solid`, the
webfinger, and the `Tombstone` at `/ap/actor` all answer exactly as the healthy
pods do.
