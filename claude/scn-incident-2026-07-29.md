# solidcommunity.net retry-storm incident — 2026-07-29

Their report: https://gist.github.com/jeswr/cad0a639deb8be70418cc8a9bf37e785

> The project was renamed to **solid-activitypub** on 2026-07-30. Every
> `activitypod-js` in this file is the name as it stood during the incident and
> as it appears in their logs — left verbatim on purpose. The strings still
> carrying the old name in running code are deliberate too; see
> *TODO once scn is resolved* at the end of this file.

Two client-credential identities of ours were named: `activitypod-js_b507819f…`
and `dk-ap-agent_c871cff2…` (data-kitchen's copy). Their server was also at
fault by their own account — lock expiry left at 6 s by a config typo, a single
worker, a key-value leak — and they have remediated most of it.

## What was ours

**Token-endpoint storm.** Their diagnosis ("requests a new token per operation")
was wrong: tokens were already cached until 30 s before expiry. The real
mechanism was `doFetch` forcing a fresh grant on *every* 401 with nothing
coalescing concurrent callers, so one state sweep of ~17 requests that all 401'd
minted ~17 tokens — matching the "~30 in 5 seconds" they measured. Every token
request costs them an OIDC replay-detection write, which takes a lock.

**Notification-channel churn — which their report does not attribute to any
client.** `RECONNECT_MS` was a flat 2 s with no backoff, and every reconnect
POSTs a *new* `WebSocketChannel2023` channel. While their server was dropping
sockets on a 12-minute crash cycle, that is up to ~1,800 channels/hour per agent.
Their one remaining open item is a "starved key-value cleanup sweep" — channel
records live in that store, so the leak they are chasing may be partly
demand-driven. Worth telling them; it is the most useful thing we know that they
do not.

**Long-held sockets.** 45 s pod / 60 s token timeouts against an nginx that gives
up at 60 s, so a sick server had our requests occupying workers to the wire.

## What was not ours

**"Ensure inbox ingestion does not hold the inbox-container write lock."** No
code of ours runs during that request: Mastodon POSTs an LDN body straight to
CSS, which performs the container append itself. The agent only reads and
deletes afterwards, out of band. That ask describes a change to CSS (or to
ActivityPods proper), not to us. What we *could* reduce is our own pressure on
the container — done, see below.

**Conflation of three codebases.** "ActivityPods" in that report spans
ActivityPods proper (a separate project), `activitypod-js`, and dk's
`ap-agent`. Of the three inboxes listed, `https://solidcommunity.net/ap/inbox/`
is not ours.

## Changes made in response

| commit | what |
|---|---|
| `3fcba6b` | `Retry-After` binding on 429/503 (pauses every request to that pod, opens no socket inside the window); conditional GETs on state docs and container listings; connect backoff cap 10 min → 1 h with jitter |
| `3d7359f` | token grants single-flight; circuit breaker with `Retry-After` precedence; one forced re-grant per 10 s; resubscribe backoff 2 s → 5 min; `retire` (Delete + Tombstone) so an abandoned actor stops receiving deliveries |
| `6c647fc` | a real User-Agent on every outbound request; a 60/min token bucket per pod (`AP_MAX_REQUESTS_PER_MIN`); state PUTs stop retrying 4xx; timeouts cut to 30 s / 20 s / 15 s |
| `923d5f9` | every periodic timer stretched and jittered (lease 30 s → 90 s against a 300 s TTL, viewer refresh 60 s → 5 min); breaker persisted across restarts; systemd `RestartSec`/`StartLimitBurst`; drain cooldown 2 → 30 min after inbox failures; 150 ms between item DELETEs |
| `9a6470d` | partial state loads survive one bad document; inbox attempt counts persisted (a restart no longer grants five fresh tries); a failed `subscribe()` retries instead of ending push for the process lifetime |
| `b69f833` | lease renewal is one conditional PUT (412 = taken over); poll 2 min → 10 min while push is up; notification channel reused across reconnects; access token + its DPoP key persisted, and `warmup()` no longer forces a grant |

## Cost per agent, measured

|  | before | after |
|---|---|---|
| lease renewal | 80/h (GET+PUT) | 40/h (one PUT) |
| inbox poll | 30/h | 6/h while push is up |
| token grants | 1 per TTL **+ one per restart** | 1 per TTL, none on restart |
| **idle total** | **~115/h** | **~50/h** |

At 300 agents that is ~4 requests/s rather than ~10/s. Their measured baseline
during the incident was ~12 requests/*minute* server-wide, so several hundred
agents remains infeasible on a single worker however polite the client is: they
need horizontal scale and per-credential limits. Our ceiling is per-agent and
cannot protect them at that scale.

## Retired, 2026-07-31 — scn came back up and both identities were withdrawn

Both scn actors now answer with a `Tombstone`, publicly readable, so anything
dereferencing them gets an answer rather than a 404 it would retry:

| actor | followers | deleted |
|---|---|---|
| `https://dk-ap.solidcommunity.net/ap/actor` | 1 (`@jeff_zucker@mastodon.social`) — `Delete` delivered | `2026-07-31T16:57:46Z` |
| `https://activitypods-js.solidcommunity.net/activitypods-js/ap/actor` | 0 — nothing to deliver | `2026-07-31T17:11:04Z` |

Neither agent could retire itself: dk's `ap-agent` has no retire endpoint, and
the standalone `retire` wants its state in `ap-state/` **on the pod**, which dk
keeps in local files. `claude/migration-scripts/retire-scn-actor.mjs` does what
`publisher.retireActor()` does — a Delete to every follower inbox, then a
Tombstone over the actor document — against whichever home it is pointed at, and
dry-runs unless given `--go`. Worth keeping: it is the only way to retire an
identity whose own agent cannot.

The `activitypods-js` credential had been overwritten, so it needed a fresh
`setup --force` against that pod first. `~/.activitypod-scn` held the key that
actor advertised, which is what makes its Tombstone verifiable.

**A correction worth keeping.** The first reading of this was "just delete the
pods, the actors go with them". That is wrong, and `retireActor()`'s own comment
says why: a `Delete` is what makes a well-behaved server drop the account *and
the posts it cached*, while a deleted pod leaves a 404 that servers retry rather
than a Tombstone they act on. `live-test.md`'s tear-down order — retire BEFORE
deleting anything — is the rule.

### Left to do, in this order

**Recorded 2026-07-31 before the local state was deleted**, because the
credential files were the only place these were written down:

| identity | clientId | resource |
|---|---|---|
| `dk-ap` | `dk-ap-agent_c871cff2-1f9a-4393-a1b1-3bedb957fe13` | `https://solidcommunity.net/.account/account/da1ec536-09bc-4782-b986-bb121a37e080/client-credentials/019cf01e-d645-48a4-84e3-f1f6917254c8/` |
| `activitypods-js` | already revoked — `credential.json` was gone while `keys.json`, `token.json` and `agent.json` remained, which is what `revoke-credential` leaves | — |

Note the name: dk's credential is `dk-ap-agent_*`, **not** `activitypod-js_*`.
The scn incident report named `activitypod-js_…` credentials, which are the
standalone agent's — a different set, and at least one of those is the orphan
from before the overwrite guard existed.

1. **Revoke `dk-ap-agent_c871cff2…`** at `https://solidcommunity.net/.account/`,
   along with any `activitypod-js_*` still listed. Deleting a pod does NOT
   revoke a credential; they belong to the account. This needs the account
   password, so it is the one step that cannot be automated from here.
2. **The pods cannot be deleted** — CSS has no handler for it (see above). They
   can be emptied with `claude/migration-scripts/empty-retired-pod.mjs`, which
   keeps the Tombstone, or left as they are.
3. `~/.config/data-kitchen/ap` and `~/.activitypod-scn` were removed on
   2026-07-31 once the above was recorded.

Do not restart data-kitchen until its pod is gone: `ensureAp` spawns the agent
at app start, and it would republish the actor over the Tombstone.

## Still outstanding

- **dk's `ap-agent` has none of this** and is named in their logs. With the
  identity retired it is no longer federating, so the outside impact is closed;
  porting the hardening only matters if dk is given an actor again.

## The rename was finished on 2026-07-31

The 2026-07-30 rename to `solid-activitypub` deliberately skipped everything
that identifies us **to solidcommunity.net**, so the name in their logs kept
matching the name in our code while the incident was open. With scn back up and
both actors retired the same day, the freeze was lifted:

| where | what |
|---|---|
| `lib/ua.mjs` | `USER_AGENT` — outbound requests to pods |
| `vendor/idp-grant.cjs` | a **second, independent** `USER_AGENT` with the same value — this is the one on the token grants, so it is the one scn actually logged. Changing only `ua.mjs` would have left the grants still announcing the old name |
| `bin/activitypod.mjs` | `mintCredential({ name: … })` — the source of `activitypod-js_b507819f…` in their report |
| `lib/setup.mjs` | **the same mint, in the browser-setup path.** This site did not exist when the list above was written on 07-29; setup moved into the browser on 07-30, and this is the copy a fresh install actually runs. A four-line list would have missed it |
| `claude/smoke-tests/agent-smoke.mjs` | the regex pinning the UA format, moved in the same commit |

Both UA strings were verified identical afterwards, and the repo URL inside them
now points at `https://github.com/jeff-zucker/solid-activitypub`.

Only **new** credentials get the new name; one already registered keeps the name
it was minted under, so existing pods are unchanged unless they are set up again.

`nodeinfo`'s `software.name` already said `solid-activitypub` before this, and it
is a **published pod document** — an actor that has not restarted since 07-30 is
still advertising the old name and needs a restart, or a save on `/admin/`, which
is now the only republish control.

The judgment call, made deliberately: the same software appearing under a new
User-Agent shortly after an incident can look evasive. It was held until the
incident was closed on both sides for exactly that reason, and the date is
recorded here so the record stays continuous.
