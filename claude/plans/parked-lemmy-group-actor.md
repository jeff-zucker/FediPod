# PARKED — hosting a Lemmy/threadiverse Group actor (possible future option)

*Status: parked, not scheduled. Written 2026-07-30 from the question "can a
Lemmy client connect to our group?". Baseline is the single-actor agent that
federates live as a `Person`.*

## The one-sentence assessment

Technically a short hop — a Group actor is mostly the `Announce` machinery we
already built for boosts, pointed outward instead of inward — but the
operational profile inverts everything the agent is designed around, so the
work is not the protocol, it is agreeing to run an always-on rebroadcast hub
whose traffic scales with other people's activity.

## The question, answered

**A Lemmy client cannot connect to us.** Jerboa, Voyager, Thunder and the Lemmy
web UI speak Lemmy's own HTTP API and are wired to a Lemmy *server*. Supporting
them means implementing that API surface — the same shape of work as the
Mastodon client-API facade we wrote for Phanpy, against a second, unrelated API.

**A Lemmy user can, through their own instance.** They search
`!name@our-domain`, their instance WebFingers us, fetches the Group actor and
sends `Follow`. Their client never touches us; their server does. Mastodon users
come along free — they can follow a Group and see its `Announce` stream.

So the buildable version of this is "serve a credible Group actor", not "support
Lemmy clients".

## Where Lemmy sits

ActivityPub for server-to-server (the `activitypub_federation` Rust crate, which
the Lemmy devs wrote); a custom API for client-to-server. "Fediverse" in 2026 is
effectively "the ActivityPub network" — OStatus, Diaspora and Zot/Nomad are
vestigial, and ATProto is deliberately outside it. The link-aggregator subset —
Lemmy, PieFed, Mbin — is the "threadiverse".

## Delta over the current Person actor

- WebFinger `acct:name@domain` → the Group actor URI.
- Actor doc: `type: Group`, `preferredUsername`, inbox/outbox/followers,
  `publicKey`, and `attributedTo` carrying the moderator list — Lemmy reads
  that field specifically.
- `endpoints.sharedInbox`; probably also an `Application` actor at the domain
  root plus `/.well-known/nodeinfo`, since Lemmy models remote instances as
  first-class records.
- `Follow` → `Accept`.
- Objects: posts are `Page` (`name` is the title and is required), comments are
  `Note` chaining `inReplyTo` up to the Page, `audience` set to the community
  URI on both.
- Votes: `Like` and `Dislike`. `Dislike` is valid AS2; Mastodon discards it.
- Moderation verbs: `Remove`, `Block`, `Flag`, `Undo`.
- **`Announce` is the whole job.** A Group is not a publisher. Every accepted
  `Create` / `Like` / `Update` / `Delete` gets re-wrapped and delivered to every
  follower inbox. The verb is not new; the fan-out is.

## Why it is parked

1. **Outbound volume scales with follower count × their activity**, not with
   our posting rate. Idle cost for one `Person` was tuned 115 → ~50 req/h after
   the scn incident; a Group inverts that curve. Retry and backoff discipline is
   the thing a Group stresses hardest, and it is exactly the axis we already got
   burned on (`activitypod-js/claude/scn-incident-2026-07-29.md`).
2. **Always-on becomes a correctness requirement.** An offline `Person` misses
   its own notifications. An offline `Group` silently drops everyone else's
   posts and wakes to a delivery backlog. This conflicts head-on with the
   park/revive lifecycle.
3. **Every post to the community lands in the pod.** Moderation of record,
   spam, and unlawful-content exposure sit with the pod owner.
4. **Storage and lifecycle assume one Person.** Whether a Group belongs inside
   the single-actor agent at all, or wants to be a separate service, is an open
   design question — not a flag on the existing one.

## If it is ever unparked

- Bring it up against **PieFed and Mbin first**. Same threadiverse, generally
  more forgiving validators — they will say the actor is roughly right before
  Lemmy says it is exactly wrong.
- **Do not assume the Mastodon-verified signing path carries over.** Lemmy's
  signature strictness has bitten other implementations; test it, don't infer
  it.
- **Settle fan-out and retry policy before writing the delivery loop**, not
  after.
- Decide the naming/identity question first if a rename is also in flight — a
  Group's actor URI gets cached by remote instances the same way the `Person`'s
  did.

## Confidence note

The Group-side requirements above are from ActivityPub/Lemmy knowledge as of
mid-2026 and should be re-checked against current Lemmy before any build. The
characterisation of our own agent here comes from design discussion and prior
session notes, **not** from re-reading the source — verify against
`activitypod-js/` if this is picked up.
