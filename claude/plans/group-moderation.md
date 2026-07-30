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
| keep a domain out entirely | `POST /block {domain}` | checked in `Intake.handle` *before* the type switch, so it stops posts **and** `Follow`s — a blocked domain cannot join. Domain-scoped, covers subdomains |
| close the group | `activitypod park` / `revive` | inbox ACL emptied, deliveries 401 immediately, nobody can post at all |
| see who is here | `activitypod members` | followers with their muted flags |
| see what was carried | `activitypod announced` | every amplified post: author, note, timestamp |
| remove a member | `activitypod eject <actor-url>` | drops them from `followers`, **sends `Reject`** so their server ends the relationship, and mutes them — an ejection anyone can undo by re-following is not one. A re-follow is still auto-accepted, but nothing of theirs is carried |
| unsay an announcement | `activitypod retract <note-url>` | `Undo` of the original `Announce`, to exactly the set the `Announce` reached |
| review before carrying | `activitypod review on` \| `off`, then `pending` / `approve <note>` / `decline <note>` | a reviewed group holds every member post in `pending.json` and carries nothing until the operator says so |
| hand the group on | `activitypod retire --move-to <actor>` | `Move` to every follower; they migrate with the membership intact |
| stand it down / end it | `retire --keep-handle` / `retire` | park keeping the name, or `Delete` + Tombstone |

Note the difference between the two per-actor-ish tools: **block is about entry**
(domain-wide, stops joining), **mute is about amplification** (per-actor, they stay
joined). Neither is the other's substitute.

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

## Still missing

**A closed group.** `Intake.onFollow` auto-`Accept`s unconditionally, so **anyone can
join.** `Reject` now exists, so the missing piece is only the policy and the queue:
`Reject` (or hold) at join time rather than `Accept`, plus approve/decline for
membership as distinct from posts. Until then, eject-plus-mute is the closest thing —
they can rejoin, but nothing of theirs is carried.

**Per-actor entry blocking.** `block` is domain-granular by construction. There is no
way to refuse one actor at the door while accepting others on their host.

## The blunt instrument, and its trap

As pod owner you can edit the group's state documents directly — `contacts.json`,
the announced record, anything under `ap-state/`. But the running agent loads pod
state **once** at connect and holds it in memory write-through, so an external edit
is clobbered by its next write rather than picked up. If you do it: stop the agent,
edit, restart. That is surgery, not moderation, and it leaves no trace for anyone
looking at `announced` later.
