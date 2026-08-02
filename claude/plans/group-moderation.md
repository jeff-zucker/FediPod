# Moderating a group you host

What the owner of the pod a group lives on can actually do, what nobody can do,
and the three capabilities still to add. Written 2026-07-29 alongside
[group-actor.md](group-actor.md).

The whole moderation model follows from one fact: **the group controls its own
`Announce` and nothing else.** It never holds a member's content — an `Announce`
carries the note's URL, and the note lives on its author's pod. So every lever is
some form of "we decline to carry this", and anything that would require reaching
into a member's pod or a remote server's state is not a lever at all.

## What works today

| action | command | effect |
|---|---|---|
| stop carrying a member | `activitypod mute <actor-url>` (undo `unmute`) | their posts are ingested and dropped instead of amplified; they stay a follower and keep receiving everything |
| keep a domain out entirely | `POST /block {domain}` | checked in `Intake.handle` *before* the type switch, so it stops posts **and** `Follow`s — a blocked domain cannot join. Covers subdomains |
| keep one actor out | `POST /block {actor}` | same door, one actor instead of their whole host. Also checked against the note's **author** after dereferencing, so it holds when they arrive through somebody else's boost or a hashtag feed, and it refuses to follow or resolve them outbound |
| close the group | `activitypod park` / `revive` | inbox ACL emptied, deliveries 401 immediately, nobody can post at all |
| see who is here | `activitypod members` | followers with their muted flags |
| see what was carried | `activitypod announced` | every amplified post: author, note, timestamp |
| require a request to join | `activitypod joins approve` \| `open`, then `requests` / `admit <actor>` / `refuse <actor>` | opt-in. The actor advertises `manuallyApprovesFollowers`, so clients show "Request to follow"; a `Follow` is answered with neither `Accept` nor `Reject` until the operator says. Also settable at `setup --group --approve-joins` |
| remove a member | `activitypod eject <actor-url>` | drops them from `followers`, **sends `Reject`** so their server ends the relationship, and mutes them — an ejection anyone can undo by re-following is not one. A re-follow is still auto-accepted, but nothing of theirs is carried |
| unsay an announcement | `activitypod retract <note-url>` | `Undo` of the original `Announce`, to exactly the set the `Announce` reached |
| review before carrying | `activitypod review on` \| `off`, then `pending` / `approve <note>` / `decline <note>` | a reviewed group holds every member post in `pending.json` and carries nothing until the operator says so |
| hand the group on | `activitypod retire --move-to <actor>` | `Move` to every follower; they migrate with the membership intact |
| stand it down / end it | `retire --keep-handle` / `retire` | park keeping the name, or `Delete` + Tombstone |

Note the difference between the two per-actor tools: **block is about entry**
(they cannot join or be ingested at all), **mute is about amplification** (they stay
joined and keep receiving, their posts just are not carried). Neither is the other's
substitute.

## What is not possible, at all

- **Deleting a member's post.** It is on their pod. We only ever held its URL.
- **Forcing anyone to unfollow.** ActivityPub gives a remote server no obligation
  to drop a follow it chose to make.
- **Preventing a follow from a domain you are not willing to block.** Entry control
  is domain-granular by construction (see below for the missing per-actor half).

## Notes on the three that were added 2026-07-30

**Eject.** `Reject` was added to the wire face for this (approved 2026-07-30) — it is
what Mastodon's "remove follower" sends, and without it the ejected member's server
keeps the relationship and they keep receiving everything. The `Reject` names their
original `Follow`, reconstructed from the `followId` recorded at join time. Ejecting
also mutes, deliberately: `onFollow` still auto-`Accept`s, so without the mute a
re-follow would put them straight back.

**Retract.** The recipient set is the trap, so `Intake.announceTargets` was factored
out of `amplify` and both paths call it. An `Undo` reaching a different set than the
`Announce` did would leave the post standing for whoever the two disagreed about.

**Review.** Opt-in per group (`config.review`), because a reviewed group is a
different social thing from an open one. It queues *members* only — a non-member was
never going to be carried, so queueing them would just fill the list with things the
operator cannot say yes to.

**Request-to-join** (added the same day). `manuallyApprovesFollowers` was approved for
the wire face for this. It is **not** in the base AS2 context — verified against
`www.w3.org/ns/activitystreams`, and against Mastodon's own
`CONTEXT_EXTENSION_MAP`, which declares it inline as
`{ 'manuallyApprovesFollowers' => 'as:manuallyApprovesFollowers' }`. We emit that same
inline declaration, and only when the flag is on, so an open group's document is
unchanged.

Two things follow from it being on the wire rather than local, unlike post review:
toggling it **republishes the actor** (otherwise nothing changes for anyone), and a
gated group answers a `Follow` with *neither* `Accept` nor `Reject` — silence is the
standard locked-account state, which is exactly what the advertised flag told the
client to expect. A withdrawn request (`Undo{Follow}` before an answer) is dropped from
the queue, or it would ask forever about someone who left.

Refusing is not a ban: they may request again, and the queue is where you would see
that. `eject` is the sticky one, because it mutes.

## Still missing

~~**No way to undo a block.**~~ **Done 2026-08-01**, in `c3664a2`. `POST /unblock` removes
a domain or an actor and reports how many it removed — nothing, when it was never blocked,
rather than pretending — and `GET /blocks` lists both granularities. Editing
`blocklist.json` by hand and restarting is no longer the only way out.

**A refused requester is not remembered.** Nothing records that you already said no, so
a persistent requester reappears in the queue. `eject` after admitting is the workaround.

~~**A profile edit is invisible to everyone.**~~ **Done 2026-08-01.** Nothing obliges a
server to re-fetch an actor it already holds, so a group's name, bio or avatar — and its
follower count, which is what made this visible — stayed at whatever the far side had
cached. `publishProfile` now delivers `Update{actor}` to every follower inbox, and only
when the document it just published differs from the one it published last, which a digest
in `published.json` decides.

A silent first publish was built and then removed, and the reason is worth keeping: nothing
calls `publishProfile` on a plain start — every caller is a deliberate republish (setup, a
rename, an edit, `describe`, a key rotation, an actor document found missing). So a "first
run records the digest and sends nothing" rule would have spent a real edit doing nothing
but bookkeeping, and that edit is exactly the one whose invisibility this fixes. What the
digest is actually for is the republish that changes nothing — `/config` does one whenever
you save a field the actor document does not carry.

## The blunt instrument, and its trap

As pod owner you can edit the group's state documents directly — `contacts.json`,
the announced record, anything under `ap-state/`. But the running agent loads pod
state **once** at connect and holds it in memory write-through, so an external edit
is clobbered by its next write rather than picked up. If you do it: stop the agent,
edit, restart. That is surgery, not moderation, and it leaves no trace for anyone
looking at `announced` later.
