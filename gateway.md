# The gateway

Most of what a fediverse inbox receives is broadcast noise. A gateway is an
always-on, internet-facing door that stands in front of your pod: it checks
each delivery's signature where the headers still exist, drops forgeries and
junk before they ever touch your pod, and passes the rest on with a receipt
saying it checked.

Your name, your signing key and your data stay on your own pod. The gateway is
**keyless** — it never holds the key you sign with, so it cannot post as you,
read your private things, or be you anywhere. The worst a broken one can do is
push items into your inbox, and those still face your agent's own checks.

A FediPod install works without any gateway at all. Deliveries go straight to
your pod inbox, which holds them whether your agent is running or not.

## Attaching your pod to one

There is a gateway at [fedipod.net](https://fedipod.net/). Attaching takes
three steps:

1. Open its signup page and sign in with your pod, which proves the pod is
   yours.
2. Run the one command it gives you. It looks like this, with the door's
   address and your own secret filled in:

   ```
   fedipod gateway <door-inbox-url> --secret <hmac> --inbox-only
   ```
3. Restart your agent, which republishes your actor with the new inbox.

<!-- CLAUDE 2026-08-19 — the brand-new-signup variant; delete markers when done -->
That is the attach-an-existing-account path. A brand-new signup is handed a
different one command — the installer, preloaded with the same details — and
attaching happens during setup.
<!-- /CLAUDE -->

To undo it:

```
fedipod gateway --detach
```

That republishes your actor with your pod's own inbox. Nothing else moves.
<!-- CLAUDE 2026-08-19 — detach conditions; delete markers when done -->
Detach talks to the running agent, so start it first. For a fronted identity,
detaching also moves every published id back to the pod — a rename other
servers see, not just a mail change.
<!-- /CLAUDE -->

## Easing into it

Attaching does not have to change how deliveries are treated on day one. The
mode says how far you trust the door, and every step is reversible:

<!-- CLAUDE 2026-08-19 — adds the off mode; delete markers when done -->
- **off** — configured but not advertised; nothing changes on the wire. This
  is where a by-hand configure starts, and the step back short of forgetting
  the gateway entirely.
<!-- /CLAUDE -->
- **shadow** — your actor advertises the gateway and the agent measures how
  much real traffic verifies.<!-- CLAUDE 2026-08-19 — dropped "Nothing else changes.": the door filters in every advertised mode, see the added paragraph below -->
- **trust** — verified follows are accepted without review.
- **locked** — your inbox accepts writes only from the gateway.

<!-- CLAUDE 2026-08-19 — what the door does in every advertised mode, and how to read the shadow numbers; delete markers when done -->
In every mode past **off**, the door itself is already filtering: blocked
actors, content that does not concern you, and forged signatures are dropped
at the door and never reach the pod. The mode says only how far the agent
believes the door's receipts.

The shadow numbers come from the agent:

```
curl -k https://localhost:8030/gateway
```

which reports the mode and the verified and unverified counts.
<!-- /CLAUDE -->

Set it from the agent's own API:

```
curl -k -X POST https://localhost:8030/gateway -H 'content-type: application/json' \
  -d '{"action":"mode","mode":"shadow"}'
```

<!-- CLAUDE 2026-08-19 — finding the right port; delete markers when done -->
8030 is the default identity's port; `node bin/fedipod.mjs status`
prints the right one for each identity.
<!-- /CLAUDE -->

## The receipt secret

The gateway stamps each verification receipt with a secret shared between it
and your agent, and your agent believes a receipt only when the stamp checks
out. That is what stops somebody dropping a forged "verified" receipt beside a
forged delivery.

You never fetch this secret from anywhere. Your agent mints it when you
configure the gateway and shows it to you once; you carry it to the gateway
yourself. Attaching through a signup page does this for you — the command it
hands you already carries the secret.
<!-- CLAUDE 2026-08-19 — who mints it on the signup path; delete markers when done -->
On the signup path the direction is reversed: the gateway mints the secret and
hands it to you inside the command, and your agent records it.
<!-- /CLAUDE -->

## What the gateway can see

It reads only public data to decide what concerns you: your published
followers and following, and a small public policy document your agent writes
with a mirror of your blocklist. Nothing private leaves your pod. Publishing
that mirror does make your blocklist public, which is part of the bargain of
running behind a door.

## Running a gateway

Any always-on box will do — a VPS, a home server behind a tunnel, a serverless
host. The logic is plain Node in `lib/gateway-core.mjs`, and a host needs only
a thin adapter that calls `handleDelivery`.

Two ways are ready to use:

- **On Netlify**, with the adapter in `netlify/functions/inbox.mjs`. See
  [netlify/README.md](netlify/README.md) for the deployment specifics.
- **On any box of your own**, with your own adapter around the same core.
<!-- CLAUDE 2026-08-19 — the third ready-made way; delete markers when done -->
- **Inside a Community Solid Server**, as the same door run in-process by the
  CSS component — see [packages/fedipod-server](packages/fedipod-server/README.md).
<!-- /CLAUDE -->

### Offering accounts to other people

A gateway can also be a front for many people, so a host can offer
`@name@their-host` addresses. Each user keeps their own pod, their own agent
and their own signing key; the front answers WebFinger for all of them, serves
each public face by rewriting that user's pod ids onto the shared domain, and
routes every verified delivery into the right pod.

<!-- CLAUDE 2026-08-19 — the user-side command for a fronted identity; delete markers when done -->
Taking a fronted identity is the same command pointed at the front actor,
without `--inbox-only`:

```
fedipod gateway <front-origin>/u/<name>/ap/actor --secret <hmac>
```

Choose at attach time: changing an existing identity's front later renames
every published id, and the command refuses it.
<!-- /CLAUDE -->

**A front is only a doorway.** It never hosts pods and never dictates where
they live. A host who also wants to offer pods to people who have none runs a
pod server separately, with the duties that carries — and users may always
bring a pod of their own instead.

## Setting one up by hand

If you are not using a signup page:

1. Deploy the door to your box.
2. Give it Append on your inbox, using a dedicated low-privilege pod account —
   never your owner credential. FediPod's default inbox is public-Append, so
   this is optional: with no credential the door writes with a plain PUT.
3. Point your agent at it, which mints the shared secret and returns it once:

   ```
   curl -k -X POST https://localhost:8030/gateway -H 'content-type: application/json' \
     -d '{"action":"configure","url":"<door-inbox-url>","webId":"<door-webid>"}'
   ```

   Copy that secret into the door's environment.
4. Walk the modes above, starting at shadow.
