# solidcommunity.net retry-storm incident — 2026-07-29

Their report: https://gist.github.com/jeswr/cad0a639deb8be70418cc8a9bf37e785

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

## Still outstanding

- **dk's `ap-agent` has none of this** and is named in their logs. Porting it is
  the remaining item with outside impact.
- Offer to `retire` the abandoned `activitypods-js.solidcommunity.net` actor so
  Mastodon stops re-delivering into a pod nobody drains.
