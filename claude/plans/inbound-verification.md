# Verifying what arrives in the inbox

Written 2026-08-02. A plan, not work in progress. Nothing here is started.

## The problem, stated exactly

Deliveries land in the pod's inbox as plain LDN documents. The HTTP Signature a
sending server computed covers the *request* — method, target, date, digest —
and CSS keeps the body, not the headers. By the time this agent reads the item,
the proof is gone.

So intake verifies the only way it can: it re-fetches the object from the origin
that claims to have published it and believes that, not the delivered copy
(`lib/intake.mjs` header). That genuinely works for `Create`, `Update`, `Delete`
and `Announce`, because there is something at the far end to go and read.

It cannot work for the activities that ARE the message:

| activity | why dereference cannot help |
|---|---|
| `Follow` | Mastodon's Follow ids are fragment URIs (`…#follows/123`) that do not resolve. There is nothing to fetch. |
| `Undo` | the Follow it revokes is equally unfetchable |
| `Accept` / `Reject` | answers to a Follow *we* sent; nothing at their origin to compare |
| `Like` | a fragment id again |

Today those are handled by refusing to act on them alone: an unverifiable
`Follow` waits in the request queue, an `Undo` must name the follow we hold.
That is a workaround for missing authentication, not authentication.

## Why the obvious fix is the wrong one

"Terminate delivery at the agent's own endpoint and call `verifyRequest`."

It would work, and it would cost the thing the project is built around. The pod
is the always-on half; the agent is explicitly disposable — README: *"because the
pod buffers everything, an agent Android kills simply catches up on next start"*,
and the whole Termux story depends on it. Point the actor's `inbox` at a laptop
and every delivery made while it is shut is refused rather than stored. Remote
servers retry for a while and then drop you.

There is one `inbox` URI in an actor document. You cannot have both.

So this is not a refactor. Any version of it trades buffering for authenticity,
and that trade is bad by default.

## What is actually available

**The signature can travel in the body.** FEP-8b32 Object Integrity Proofs, and
the older LD Signatures, put the proof *inside the activity JSON* — which is
exactly the part CSS stores. A delivery carrying one is verifiable from the pod
copy, with no change to where deliveries go and no loss of buffering.

Two things are already in place for it:

* `lib/keys.mjs` already generates an Ed25519 keypair on every setup and stores
  it, commented *"stored for future FEP-8b32 use, not yet in the actor doc"*.
* Fedify already exports `verifyObject`, `verifyProof`, `verifyJsonLd`,
  `signObject` and `createProof` (checked against the installed 1.10.12).

The catch, stated honestly: **not every server sends one.** Mastodon attaches LD
signatures when it forwards or relays, and not reliably on direct delivery. So
this raises the proportion of activities that can be verified; it does not make
the inbox authenticated. The design has to degrade, not depend.

## Plan

### Phase 1 — publish the key (small, no behaviour change)
Add the Ed25519 key to the actor document as a `assertionMethod` /
`Multikey` entry alongside the existing RSA `publicKey`. Nothing consumes it
yet; this is what lets other servers verify *us*, and it is the prerequisite for
anything below. Republishing the actor is already a solved, digest-gated path.

*Risk:* an actor document that some implementation parses strictly. Mitigated by
publishing to a throwaway pod and checking Mastodon still resolves the actor
before it goes near a real identity.

### Phase 2 — verify a proof when there is one
In `Intake.handle`, before the type switch: if the activity carries `proof` or
`signature`, verify it with fedify against the actor's published key. Record the
outcome on the activity as it moves through — `verified: true` — and nothing
else changes yet.

*Cost:* one key fetch per unknown actor, cached in `actors.json` the way actor
documents already are. Zero pod requests.

### Phase 3 — let a proof stand in for approval
`onFollow` auto-accepts when the activity verified, and only queues when it did
not. Same for `Undo`: a verified one is honoured on its own; an unverified one
still has to name the follow we hold. This is the payoff — the locked-account
behaviour stops applying to every server that signs, while the queue remains the
floor for those that do not.

`autoAcceptFollows` keeps its meaning: accept regardless.

### Phase 4 — direct delivery, opt-in, for people who can host
For an agent that IS publicly reachable — a real host, a tunnel, a tailnet with
a proxy — offer `--inbox direct`: the actor advertises the agent's own endpoint,
deliveries arrive as requests, and `verifyRequest` runs on the headers as
intended. Full authentication, no queue, and the pod stops being in the delivery
path at all.

Not the default, and setup should not offer it: the buffering it gives up is
worth more to most installs than the authenticity it buys. It belongs to the
operator who already knows their agent is always on.

## What this does not fix

`Accept` and `Reject` remain unverifiable by dereference and will remain
unverified by proof from servers that send none. They are lower stakes — an
`Accept` can only confirm a Follow we ourselves sent — but the honest position
is that the pod inbox is a public mailbox, and a public mailbox is not an
authenticated channel. Phases 2 and 3 raise the floor. Phase 4 is the only one
that removes the problem, and it costs the thing that makes this project
interesting.

## Sequencing

Phase 1 is independently useful and safe. Phase 2 is inert until Phase 3 acts on
it, so the two can land separately and be observed in the log first — *how many
inbound activities actually carry a proof?* is a question worth answering with
real traffic before any behaviour depends on the answer. Phase 4 is optional
forever.

Do not start Phase 3 without the Phase 2 numbers.
