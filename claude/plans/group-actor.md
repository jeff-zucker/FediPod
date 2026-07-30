# Group actors — one pod holds it, many pods follow

Built 2026-07-29. Phases 1–4 shipped; phase 5 deliberately deferred.

## What was asked, and what it turned into

The question was whether there could be a multi-actor version of the agent: *"one pod
holds a thing, multiple pods attach"*. Four readings were worked through and dropped
before the literal one turned out to be right. **They are recorded here so they are not
rediscovered as new ideas.**

- **A multi-tenant hub** — one service holding a WebID, granted into other people's
  pods, running their actors for them. It *is* buildable: CSS verifies a token by
  dereferencing its `webid` claim and matching `solid:oidcIssuer`, with no requirement
  that the issuer be local, and `aud` is presence-checked only (`retrieveWebidTrusted‑
  OidcIssuers.ts`, `verifySolidAccessTokenIssuer.ts`, `verifySolidAccessTokenRequired‑
  Claims.ts` in CommunitySolidServer/access-token-verifier). So a hub credential works
  cross-host. But the remote pod *fetches the hub's WebID document*, so the hub needs a
  publicly resolvable WebID — a hub on loopback or a tailnet cannot drive off-host pods
  at all. Plus TLS, per-tenant auth to replace `mastoapi.authed()`'s "any valid bearer
  is the user", and a trust story where the hub can post as you and holds your signing
  key. Large, and it makes the hub load-bearing.
- **A hub as documents on a pod** — a pod is passive, so it can only be single-writer,
  many-reader, bulk-fetched. It changes no load numbers: the cost measured in
  `scn-incident-2026-07-29.md` is each agent talking to *its own* pod, and a document
  hub is not in that path.
- **A follow-pack** — honest as a starter pack, dishonest as a community. Joining is N
  Follow requests that may never be accepted, you cannot post to it, leaving does not
  unfollow, nobody consented to being listed, and an advisory blocklist is a safety
  feature that does not enforce.
- **A CSS component** — genuinely better on several axes: dynamic WebFinger would
  dissolve the one-handle-per-host constraint, real inbound HTTP-Signature verification
  becomes possible (impossible today, see `intake.mjs` header), and polling, token
  grants and channel churn disappear entirely. **PARKED by Jeff to revisit — not
  rejected.** The cost is that you must be the pod server, so pods elsewhere can never
  join.
- **A shared inbox** for members — the only pod-hub variant that cuts real traffic, but
  it routes everyone's inbound public activity through the operator's pod and needs
  `endpoints`/`sharedInbox` in the actor document. Its own decision, not taken.

## The constraint that decided it

`publisher.publishProfile` writes `{pod}/.well-known/webfinger` as a single static
document with one `subject`, and CSS ignores `?resource=`. `webfingerHost` returns a
host only when `pathname === '/'`. So: **one resolvable handle per pod host.** The
aspiration in `wire.mjs`'s `apUrls` comment — one pod hosting several actors under
different roots — is refuted by its own next sentence.

Therefore the group cannot be a tenant of anything. It is an actor with its own pod,
and people attach by following it.

## What shipped

A group is another single-actor agent — same credential, key, pod layout, publisher,
intake, deliverer — with one behavioural difference: a post addressed to it is
announced to its followers.

**The member side needed no code at all.** A member follows the group; `onAnnounce`
sees they follow the announcer and calls `ingestNote(id, group, { via: group })`;
`followed = via || …` is truthy, so it lands in their timeline tagged `via`. The boost
path was already right, because a group announcing is structurally identical to
someone you follow boosting.

| decision | why |
|---|---|
| `Group` as the actor `type` | what makes Mastodon and Lemmy treat it as a community rather than a person, and what stops the design over-promising |
| `Announce` as the fan-out, reusing the boost path | re-`Create`ing as the group would make the group look like the author |
| members-only amplification | anyone can Append to a public inbox; membership is the gate, and it is the anti-spam rule and the moderation lever at once |
| the group needs its own pod | the WebFinger constraint above; `setup --group` refuses a path pod rather than warning |
| nothing new ships | `setup --group` plus one `kind` field in pod state; no new package, no build variant |

Guards, each with a check: only reached from `Create`, so an inbound `Announce` never
re-enters; `announcedAt` on the status means a re-delivered `Create` is carried once;
the author's own target is dropped **only when it serves nobody else**, because a
shared inbox carries co-tenants who would otherwise be deprived.

A group serves no client — no facade, no tokens, no oauth, no UI password — which
removes its whole authentication surface rather than securing it. The kind is checked
per request, not at mount time, because `startAdmin` runs before `connect`.

## Open, and known

- **A member's post is `kind: 'mention'`, not `'timeline'`.** `ingestNote` decides
  `followed` from the *following* list and a group follows nobody, so nothing is written
  to `fediverse/timeline/` — there is no RDF community archive. The statuses index does
  hold them, which is what amplification and dedupe use, so nothing is broken.
- **Same cause: every member post fires a `mention` notification** on the group. Nothing
  reads them, but `notifications.json` fills.
- Both are fixed by teaching `ingestNote` that a group's members are its `followers` —
  which changes shared ingest behaviour for persons too, so it was left alone.
- **Announces are not added to the group's outbox.** `outbox.json` holds note ids, not
  activities; boosts have never been recorded there either.
- **Nothing has crossed the network.** The suite exercises real `startAdmin` and real
  `Intake` in-process. A live run — throwaway group pod, follow from Mastodon, post
  through it — has not been done.

## Deferred: several actors in one process

Hosting a group plus your own actor is two `AP_HOME`s, two ports, two processes — the
documented pattern, and fine for one group. It gets tedious at three, and that is when a
supervisor holding several `Agent` instances with a shared outbound rate budget earns its
keep. `Agent` already holds no module-level mutable state, so N instances in one process
work today; what blocks it is module-level `HOME`/`PORT` in `bin/activitypod.mjs`, the
process-global log/pidfile/signal handlers in `startAgent`, and the single fixed
`keys.json` path in `keys.mjs`. **Demoted from foundation to optimisation — do not build
it until someone actually hosts three groups.**
