# Live test — what is left to prove

The suite is 240-odd offline checks and it has been green through every bug found so far,
including one that made a member unable to read its own group's posts. **Offline green
means nothing here.** This is the list of things only a real run can settle.

Two sections: everything that needs no group, then everything that does. Shared material —
the traps already paid for, where to look when something fails, and the tear-down order —
is at the end.

Updated 2026-07-30, after the first live run.

---

# 1. Without groups

A single person actor. This is the whole agent minus one behavior, and most of what
changed on 2026-07-30 lives here rather than in the group work.

## Already verified

On `solo.teamid.live`, live and public:

- `setup` completes: the request ceiling defers instead of dying, and the wire face is
  published once rather than twice.
- The actor publishes with `endpoints.sharedInbox`.
- Phanpy logs in — so the `/oauth/token` change did not break client login, which was the
  most likely regression of the day.
- A post appears in both the home timeline and the profile view.
- The lease refuses a second agent; `--takeover` reclaims one whose holder crashed;
  `ensureActorPublished` repairs a half-finished publish.
- The instance now names itself `@handle@pod-host`, and an agent browsed at its own name
  (`solo.localhost:8041`) serves its UI.

## What is left

Nothing to set up — `solo` is on :8041.

- [ ] **Mentions resolve.** Post `hello @jeff_zucker@mastodon.social` — note the
      **underscore**; `jeff-zucker` does not exist and the first attempt failed on that.
      Three things must all hold: it renders as a link rather than plain text, the note
      carries a `tag` and the actor in `cc`, and Mastodon notifies you.
- [ ] **The replies collection fills.** Reply from Mastodon, then fetch
      `<note-url>-replies` — your reply should be in `items`.
- [ ] **Inbound `Delete`.** Follow a Mastodon account, get a post of theirs into your
      timeline, have them delete it. It should vanish from yours. *Never worked before
      today.*
- [ ] **Inbound `Update`.** The same account edits a post → your copy changes. Then they
      change display name or avatar → your cached copy refreshes.
- [ ] **A plain boost still ingests.** Have a Mastodon account boost one of your posts.
      A regression check: the receiver was taught to unwrap *wrapped* Announces and must
      still accept ordinary ones.
- [ ] **Boosting out still works.** Boost something from Phanpy, then fetch your outbox
      (`<pod>/activitypods-js/ap/outbox`) unauthenticated — the `Announce` should be in
      `orderedItems` as an inline activity. Un-boost and it should be gone again. Boosts
      used to go only to inboxes and left no public trace.
- [ ] **Blocking one actor, not their host.** `POST /block {"actor":"<their-actor-url>"}`
      to the admin port, then have them post. Nothing of theirs arrives, while somebody
      else on the same instance still comes through. Test the indirect route too: have an
      account you follow boost the blocked actor — that is the path a domain block could
      never see, because the author is only known after the note is fetched.
      **There is no `unblock`** — undoing means editing `blocklist.json` on the pod and
      restarting, so use a throwaway actor.
- [ ] **`describe`.** `describe --summary "…" --icon <url>` → both appear on the actor,
      then on your Mastodon view of it. Mastodon caches hard; give it time.
- [ ] **Live updates from the named host.** Browsing `http://solo.localhost:8041`, a new
      status should arrive without a refresh. This is what the CSP fix was for — before
      it, the page loaded and the socket was silently blocked.
- [ ] **`park` then `revive`.**
- [ ] **`rotate-key`** — the actor republishes with the new key and delivery keeps working.
- [ ] **`retire`** → Tombstone with `formerType: Person`. Destructive; do it last.

## Decided on 2026-07-30, worth confirming live

- [ ] Reply to a thread and **delete one of the prefilled `@handles`** before sending.
      That person should **not** be notified: the reply's text is now authoritative, which
      is what every fediverse client leads people to expect. Retype the handle and they
      should be notified normally.
- [ ] The exception is a **`Group`**, which is carried forward whether or not the client
      prefilled it — covered by the group section below, and the reason the rule is not
      simply "the text decides".

---

# 2. With groups

## Already verified

Locally only, against `~/css` on :4000, with a group and two throwaway member pods:

- The group publishes `type: Group`, `endpoints.sharedInbox`, and a resolving WebFinger.
- Members follow and are auto-accepted; `members` lists them.
- The `Create` is dereferenceable at `<note>-create` — **the FEP-1b12 fix, confirmed**.
- The group carries a member's post: filed as `timeline`, not a stranger's mention, and
  amplified to exactly the right inboxes with the author's own solo inbox dropped.
- A member ingests the wrapped `Announce` and files it under `via: <group>`.
- **The property the whole design exists for: a member sees another member's post while
  following nothing but the group.**

## What is left

**None of this has ever run against Mastodon.** Two items are riskier than everything else
in this document.

Set up three identities on a subdomain-capable host — teamid.live works, scn is down.
Replace `YOUR-EMAIL`; everything else is literal.

```
bin/activitypod.mjs setup --group --profile finches --new-account --issuer https://teamid.live --email YOUR-EMAIL --handle finches --pod-name finches --name "Finches" --port 8031
```

Then the same twice without `--group`, for two members on 8032 and 8033. Add
`AP_ALLOWED_HOSTS=<name>.localhost:<port>` on `start` and browse each at its own name, or
the clients are hard to tell apart.

- [ ] **⚠ Does the wrapped `Announce` render in Mastodon?** Follow the group, have a
      member post `@finches@finches.teamid.live hello`, and see whether it appears in your
      Mastodon timeline as a boost by the group. If the group logs `amplified` and Mastodon
      shows nothing, the FEP-1b12 change is the cause. Check that
      `curl -H 'accept: application/activity+json' <note-url>-create` returns a `Create`
      whose `id` is exactly that URL.
- [ ] **⚠ Does a reply thread back?** Reply from Mastodon; the other member should see it
      while following only the group. This rests on Mastodon copying the group's mention
      into your reply — reasoned from its source, never observed. **The single least
      certain claim in the design.**
- [ ] **A reply that lost the mention still threads.** Reply again with `@finches@…`
      deleted from the text. It should *still* be carried, because a group accepts replies
      to anything it holds — and because our own composer carries a `Group` mention forward
      even when the author trims it, which is the one exception to the rule that the reply's
      text decides who is mentioned.
- [ ] **The group's outbox is its public record.** After a carry, fetch
      `<group-pod>/activitypods-js/ap/outbox` unauthenticated — the `Announce` should be
      there inline. This is the only crawlable record of what the community has carried.
- [ ] Mastodon renders the group as a **Group**, not a person.
- [ ] `joins approve` → Mastodon offers "Request to follow"; `requests`, then `admit`.
- [ ] `mute <actor>` → their next post is not carried. `unmute`.
- [ ] `review on` → the next post is held; `pending` lists it; `approve` releases it.
- [ ] `retract <note-url>` → the boost disappears from Mastodon, and the `Announce` is
      gone from the group's outbox too.
- [ ] `eject <actor>` → Mastodon shows you no longer follow the group.
- [ ] A member deletes a carried post → the group retracts it.
- [ ] `retire` on the group → Tombstone with `formerType: Group`. *Fixed today, unverified.*
      Destructive; do it last.

---

# Shared

## Traps already paid for

- **WebFinger needs https.** Over plain-http localhost a handle never resolves, so
  mentions do not — and mentions are how a member addresses a group. Both sections above
  are therefore public-only. To exercise carry locally, POST the `Create` into the group's
  inbox yourself (it is public-Append) and `POST /drain`.
- **`--new-account` after a crash.** Fixed today, but if it recurs: the pod exists and the
  retry says "already registered to this account". Use `--pod <url>` or a fresh
  `--pod-name`.
- **Deleting a profile directory after the actor was published** trips the key guard. That
  is the guard working — `--rotate-key`, or a fresh pod name.
- **A crashed `setup` leaves the lease held.** The next `start` is a read-only viewer for
  the full 300 s TTL unless you pass `--takeover`.
- **The instance title reads `solid-activitypub` until the agent finishes connecting.** Not a
  bug; wait rather than believing it.
- **Mastodon caches actor documents hard** — `manuallyApprovesFollowers`, `icon` and
  `summary` may lag. Nothing on our side can force a refetch.
- **A running agent does not survive renaming the project directory.** Found 2026-07-30,
  a day after `activitypod-js` → `solid-activitypub`: two long-running agents kept
  federating and kept answering `/status`, while every static path returned
  `404 not found`. `admin.mjs` resolves its project root from `import.meta.url` **once, at
  module load**, so the captured string still named a directory that no longer existed.
  Nothing in `/status`, the log or the pod shows it, because none of them touch the
  filesystem. Symptom to recognise: `/status` fine, `/` 404. Fix: restart.
- **A restart is also how an agent learns its own name.** `<handle>.localhost:<port>`
  arrived on 2026-07-30; a process started before that logs
  `refused: unexpected Host "<handle>.localhost:<port>"` and cannot be talked round.

## Where to look

- `~/.activitypod/profiles/<name>/agent.log` — the instrument for everything. `unhandled`
  lines are the Mastodon-facade punch list.
- `bin/activitypod.mjs deadletter --port <p>` — rejected inbound items **with the reason**.
  The distinction that matters most: a reply that arrived and was refused appears here; a
  reply that never arrived shows nothing, and that is the whole diagnosis.
- `bin/activitypod.mjs status --port <p>` — `podRequests` is what a pod operator sees in
  their access log.

## Tear-down

**Retire BEFORE deleting anything local. This order is not a preference.** `retire` needs
the credential and the signing key; delete the profile directory first and the actor can
never be retired, parked or moved again — it is stranded as a live-looking document nobody
can speak for. Four local throwaways were orphaned that way on 2026-07-30.

1. `bin/activitypod.mjs retire --profile <name>` — Delete to every follower, Tombstone in
   place of the actor. Irreversible, and it asks.
2. Only then remove `~/.activitypod/profiles/<name>/`.
3. Then delete the pod or account with the provider.

Two things worth knowing before relying on step 1:

- **The follow graph outlives the agent.** Stopping an agent stops nothing inbound. If the
  follower is an account you control, removing the actor from *your* followers stops
  delivery immediately and needs nothing from the pod — faster than waiting for the pod to
  come back so you can retire.
- **Retiring is only worth it if someone is following.** With no followers the Delete
  reaches nobody and the Tombstone is the whole benefit.

`identities.md` has the park/retire/move matrix.
