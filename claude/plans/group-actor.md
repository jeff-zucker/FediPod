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
intake, deliverer — with one behavioral difference: a post addressed to it is
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

Amended 2026-07-30, when setup moved into the browser. A group now serves exactly two
pages, `/setup/` and `/admin/`, out of `web/`. It had to: person-vs-group is chosen on
the setup page, so a blanket GET 404 for groups would have made a group impossible to
create there — and a group has a display name and a bio like anything else. The
sentence above still holds for everything it was about: `admin.mjs`'s `/api/*` and
`/oauth/*` branch is untouched, so there is still no facade, no token, no oauth and no
UI password, and neither Phanpy nor `ui/*` is reachable. The console calls the same
loopback routes `activitypod members` and `activitypod eject` already call, so it
changes the client, not the trust boundary. `POST /setup` and `POST /config` are
additionally refused over any host `AP_ALLOWED_HOSTS` added: those are for whoever is
at the machine.

## The wire shape: FEP-1b12, and why it needed a second change

Added 2026-07-30. FEP-1b12 — what Lemmy implements — says a group **"MUST wrap it in an
`Announce` activity, with the original activity as object"** and that **"the wrapped
activity MUST be preserved exactly as it was received."** We were emitting
`Announce{ object: "<note url>" }`, the Guppe/Mastodon-boost shape.

Switching to the wrap on its own would have **broken Mastodon**, which is the integration
that actually works. Mastodon's `ActivityPub::Activity::Announce` resolves the object by
dereferencing its `id` (`status_from_object` → `status_from_uri(object_uri)`, then a
remote fetch); `Create` is not in its `SUPPORTED_TYPES`, so the embedded-object shortcut
is skipped. Lemmy survives that because it serves every activity at its own URL. Our
`createActivity` minted `note.id + '#create'` — a fragment, so a fetch just returns the
Note under a different id, which Mastodon rejects.

So two changes, not one: the group now wraps the member's `Create` untouched, **and**
`publishNote` publishes that `Create` as its own document at `<note>-create`, inheriting
the notes container's public-Read `acl:default`. `announceActivity` takes `object`, which
is a note URL for a personal boost (correct Mastodon boost semantics — unchanged) or the
whole activity for a group carry.

A member post held for review keeps its activity in `pending.json`, because approving
later still has to wrap the activity the member actually sent. A bare note URL remains
the fallback when no activity is available.

**Not verified against live Mastodon or Lemmy.** The reasoning is from their source; the
shape is asserted in the suite. That is the one thing a live run would still prove.

## Still unlike a standard fediverse group

- ~~Replies fragment~~ **largely fixed 2026-07-30**, once it was clear how Guppe-style
  groups actually thread. A reply reaches a group because **the group is a `Mention` in
  the post and Mastodon carries a thread's mentions into every reply** — so the reply is
  addressed to the group too, lands in its inbox, and is carried. Three things now hold
  that up:
  1. Posting to a group *is* mentioning it, which only became possible when mentions
     landed the same day — before that an activitypod member had no way to address a
     group at all.
  2. `concernsUs` accepts, **for a group only**, a reply to anything the group has
     carried. A reply that lost the mention somewhere still threads. A person does not
     inherit this: replying to anything in someone's timeline would be a way into their
     inbox.
  3. Our composer carries the parent's mentions into a reply even when the text drops
     them, so a trimmed reply does not silently leave the group.

  What is still not fixed: a reply we are **never delivered** cannot be carried — if a
  remote client strips the mention *and* the replier's server never tells us, the group
  never learns of it. The `replies` collection exposes what we do hold; it cannot conjure
  what we do not. Lemmy avoids the whole problem by making comments first-class objects
  federated through the community, which is a different data model.
- **No members or moderators collection**, and no `Add`/`Remove` on one. Lemmy and
  Mobilizon both publish those so other software can see who runs a community; we expose
  only `followers`.
- **No post/comment/vote model** — no `Page`, no pinning, locking, or mod log.
- ~~No `replies` collection~~ **added 2026-07-30.** Each note points at
  `<note>-replies`, published empty alongside it (a `replies` that 404s is worse than
  none) and appended to whenever a reply to that note is ingested. It does not repair the
  fragmentation above — a reply we were never sent still never arrives — but a server that
  fetches one of our notes can now discover the replies we *do* hold.
- ~~No `endpoints.sharedInbox`~~ **added 2026-07-30**, pointing at the inbox. With one
  actor per pod it is the same endpoint; its absence was the non-standard part.
- ~~`Delete` is ignored~~ **handled 2026-07-30.** Two guards, because a delivered body
  carries no signature and a forged Delete would otherwise erase anyone's content: it
  must come from the object's own origin, and the object must really be gone there
  (404/410, or a Tombstone at 200). An origin we cannot reach throws, so the item stays
  in the inbox and retries rather than deleting anything. A group that carried the post
  **retracts its own Announce** rather than forwarding the author's Delete — a forward
  would be signed by us and not by them, which receivers are right to refuse.
  `Update` is handled the same way: refetch at the origin and believe that, for both an
  edited note and a changed profile.

## Open, and known

- ~~A member's post is `kind: 'mention'`, and each one raises a notification.~~ **Fixed
  2026-07-30**: `ingestNote` now reads `followers` for a group and `following` for a
  person, so member posts file as `timeline` and reach `fediverse/timeline/` (owner-only
  — the operator's record, not a public archive). A stranger posting at the group is
  still a mention, which is right: that is something the operator should see.
- ~~**Announces are not added to the group's outbox.**~~ **Fixed 2026-07-30**: a carry
  calls `recordOutbox(act)` with the whole activity, because an Announce id is only a
  fragment on the actor and would not dereference. `outbox.json` is heterogeneous from
  then on — bare note ids for own posts, activity objects for boosts — and every reader
  of it has to handle both.
- ~~**Nothing has crossed the network.**~~ **Done 2026-07-31**: `@group@activitypub.
  teamid.live` is live with members from Mastodon and from another pod.

## What the live run found (2026-08-01)

- **Every group rendered as `@actor@host`.** `fetchAP` cached only `type === 'Person'`,
  so a Group was fetched, used and thrown away and nothing knew its `preferredUsername`.
  A client with no name falls back to the last path segment of the actor URL — which for
  every actor this agent publishes is the literal word `actor`. `ACTOR_TYPES` now covers
  Person, Group, Service, Application and Organization. The lesson is the fallback, not
  the set: a name guessed from a URL is wrong silently and looks deliberate.
- **Everyone had no followers.** Counts are `totalItems` on the followers/following
  collections, not fields on the actor document, so a client asking "who is this" was
  told nobody follows anybody. `social.cacheCounts` fetches both — two GETs, and only
  when someone asked by name, never on the drain path. A collection that will not answer
  leaves the count *unset* rather than reported as zero, which is a different claim.
- **A member's fediverse address is derivable and its WebID is not.** The console lists
  `@them@their.server`, built from the cached `preferredUsername` and the actor URL's
  host. `store.handleOf` returns null rather than guessing when the actor is not cached —
  the same trap as above. A Solid WebID was considered and dropped: nothing in an actor
  document carries one, `<origin>/profile/card` answers 200 on Mastodon too, and there is
  no honest way to know it.
- **A group serves the client** (2026-08-01). `visit account` was greyed out
  because a group had no client; un-greying it framed the group's own console,
  which is what made the real question visible: *should* a group have one? Yes.
  The original reasoning — "no timeline a human reads" — was wrong twice over. A
  group has statuses (what it carried) and notifications (who joined), and its
  operator has a bio to write and a profile to see the way everyone else does.

  Three carve-outs removed in `lib/admin.mjs`: the `!isGroup()` on the
  `/api/*`+`/oauth/*` gate, the `/` → `/admin/` redirect, and the 404 on every
  static file. Plus `mastoapi.account()` now reads `group` from config for
  self — our own actor is not in the actor cache, so a group asking about itself
  was told it was a person.

  What it opens is a login and client tokens. `passwd` has never had a group
  carve-out, so a group is gateable exactly like a person; with no password set
  `/oauth/authorize` redirects instantly, for both. Verified live: logged in as
  `@group@activitypub.teamid.live` through Phanpy, home timeline rendered,
  `verify_credentials` returns `group: true`, `followers_count: 2`, and a
  `source` — so the bio editor opens populated.

  Two capabilities a group gains that read oddly: composing posts a Note *as*
  the group (legitimate, but not the Announce path a member's post takes), and
  following someone pulls their posts into the group's timeline without making
  them a member — `ingestNote` reads `followers` for a group, never `following`.
- **Mastodon's follower count for the group lags.** The pod publishes the right
  `totalItems` immediately; Mastodon shows its cached copy of the actor until it
  re-fetches, and nothing prompts it to. This agent has never sent an `Update{Group}` —
  `grep "type: 'Update'" lib/` finds nothing. Not a bug in what is published; a missing
  push. Unbuilt on purpose, not overlooked.

## Deferred: several actors in one process

Hosting a group plus your own actor is two `AP_HOME`s, two ports, two processes — the
documented pattern, and fine for one group. It gets tedious at three, and that is when a
supervisor holding several `Agent` instances with a shared outbound rate budget earns its
keep. `Agent` already holds no module-level mutable state, so N instances in one process
work today; what blocks it is module-level `HOME`/`PORT` in `bin/activitypod.mjs`, the
process-global log/pidfile/signal handlers in `startAgent`, and the single fixed
`keys.json` path in `keys.mjs`. **Demoted from foundation to optimisation — do not build
it until someone actually hosts three groups.**
