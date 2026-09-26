# The gateway

Most of what a Fediverse inbox receives is broadcast noise. A gateway is an
always-on, internet-facing door that stands in front of your pod: it checks
each delivery's signature where the headers still exist, drops forgeries and
junk before they ever touch your pod, and passes the rest on with a receipt
saying it checked.

Your name, your signing key and your data are kept on your own pod. The gateway is
**keyless** — it never holds the key you sign with, so it cannot post as you,
read your private things, or be you anywhere. The worst a broken one can do is
push items into your inbox, and those still face your agent's own checks.
With the outbox door below, a gateway can also hand your agent a post marked as
yours, which your agent then signs and sends. It still holds no key, but what you
trust it with grows by that much. A browser account is also kept running by
the gateway (below). That gives the gateway your key while it works, so it can
post as you, as any Fediverse server can, and your account's working data is
kept at the gateway too and written to your pod every fifteen minutes.

A FediPod install works without any gateway at all. Deliveries go straight to
your pod inbox, which holds them whether your agent is running or not.

## Attaching your pod to one

There is a gateway at [fedipod.net](https://fedipod.net/). Attaching happens
from your own agent, which proves the pod with its own credential — no
password is typed anywhere:

1. Open your agent's admin page and, in the **Gateway** panel, give the
   gateway's address and the name you want there. The panel checks the name
   is free as you type.
2. Choose a pod-based name (`@you@your.pod`) or a gateway-based name
   (`@you@the-gateway`). The gateway account is created automatically either
   way. A pod-based attach applies immediately; taking a gateway-based name
   restarts the agent itself to publish under it.

In the BrowserAgent the same choice is made once, at sign-up, and cannot be
changed afterwards. A suffixed pod, like
`https://server.example/alice/`, always takes the gateway-based name: nothing
at that host answers for the handle, so the gateway does. Its posts, key and
data stay on the pod.

The same attach from the command line, against the running agent:

```
fedipod gateway --attach https://fedipod.net --name yourname
```

`--name` defaults to your handle; add `--fronted` for a gateway-based name.

To undo it:

```
fedipod gateway --detach
```

That republishes your actor with your pod's own inbox. Nothing else moves.
Detach talks to the running agent, so start it first. For a fronted identity,
detaching also moves every published id back to the pod — a rename other
servers see, not just a mail change.

## Easing into it

Attaching does not have to change how deliveries are treated on day one. The
mode says how far you trust the door, and every step is reversible:

- **off** — configured but not advertised; nothing changes on the wire. This
  is where a by-hand configure starts, and the step back short of forgetting
  the gateway entirely.
- **shadow** — your actor advertises the gateway and the agent measures how
  much real traffic verifies.
- **trust** — verified follows are accepted without review.
- **locked** — your inbox accepts writes only from the gateway.

In every mode past **off**, the door itself is already filtering: blocked
actors, content that does not concern you, and forged signatures are dropped
at the door and never reach the pod. The mode says only how far the agent
believes the door's receipts.

The shadow numbers come from the agent:

```
curl -k https://localhost:8030/gateway
```

which reports the mode and the verified and unverified counts.

Set it from the agent's own API:

```
curl -k -X POST https://localhost:8030/gateway -H 'content-type: application/json' \
  -d '{"action":"mode","mode":"shadow"}'
```

8030 is the default identity's port; `fedipod status`
prints the right one for each identity.

## The receipt secret

The gateway stamps each verification receipt with a secret shared between it
and your agent, and your agent believes a receipt only when the stamp checks
out. That is what stops somebody dropping a forged "verified" receipt beside a
forged delivery.

You never fetch this secret from anywhere. When you run your own gateway,
your agent mints it and shows it to you once; you carry it to the gateway
yourself. When you attach to a multi-user gateway, the direction is reversed:
the gateway mints the secret and answers the attach with it, and your agent
records it.

## The outbox door

The gateway also takes your own posts from any app that speaks ActivityPub
client-to-server, dokieli for one. Your actor document names the door as your
outbox, and your WebID profile names it as `as:outbox`. The app sends the post
there, signed in at your pod. The door checks that the token is yours, puts the
post in your inbox marked as yours, and answers with the address the post will
have. Your agent publishes it and sends it to your followers the next time it
runs: for a browser account, the next time you open the site.

A post with no audience of its own goes out as a public post. A post that is
not a note, an annotation say, is kept as the app sent it, under your name.

## Moving to another gateway

An address that lives at a gateway, `@you@gateway-a`, can move to another
one and keep its pod, its posts, its followers and its key. Open the new
gateway, choose **create an account**, and sign in with the same pod. The
new gateway reads the account on the pod, sees that its address lives
elsewhere, and offers a move instead of a new account: keep the handle or
choose a new one, and the address becomes `@you@gateway-b`.

What happens then, in order:

1. The new gateway takes the name and the account's config on the pod is
   rewritten to name it, with the old address kept as an alias.
2. The agent boots under the new ids and publishes the actor at the new
   address, naming the old one among its `alsoKnownAs`.
3. The old gateway is told (`POST /api/move`, proved with the pod session
   the way attaching was). From then on it serves the old actor as a moved
   stub under the old id, with the same key and `movedTo` the new address;
   every other old id redirects to its new one; its door for that address
   is shut.
4. A Move goes to every follower from the old address, signed under the old
   key through the old gateway's relay. Followers' servers fetch the old
   actor, see where it went, check the new actor names the old, and move
   the follow.

The old gateway keeps the stub for as long as its row stands; the owner can
remove the row from the roster later. An address on the pod, `@you@yourpod`,
needs none of this: it detaches from one mail door and attaches to another.

A DeviceAgent moves the same way: set it up with the pod you already have
and an address at the new gateway (`--address front`, or "At the gateway"
on the setup page). Setup reads the account on the pod, keeps its state and
key there, attaches at the new gateway, and completes the move when the
agent first acts. See [the DeviceAgent](device-agent.md).

## While your app is closed

A browser account runs only while FediPod is open somewhere. While it is
closed, fedipod.net does two things for it.

**Your mail waits at the gateway.** Deliveries are kept there, not written to
your pod one by one, and reach your pod in batches of up to a hundred: when you
open FediPod, or every fifteen minutes otherwise. While FediPod is open, mail
goes straight to your pod as before. A DeviceAgent's mail always goes straight
to its pod.

**The gateway keeps your account running.** Unless you turn it off, the
gateway accepts your follows, tries again what failed to go out, and publishes
the posts you scheduled, all while FediPod is closed. Other mail waits on your
pod for FediPod to open, as before. It works under its own pod identity, which your app
names in the access rules on your FediPod folder. It reads your signing key
from your pod when it needs it, so it can post as you, and keeps no copy of the
key. **Stop keeping it running** on the manage page takes it out of the rules.
Scheduling a post is offered only while this is on, because otherwise nothing
would be running when the time came.

**Your account's working data is kept at the gateway.** While the gateway
keeps your account running, your timeline, notifications, followers, settings
and the rest of your FediPod state are kept at fedipod.net, and FediPod in your
browser, the gateway and any app you use all work from that one copy, so they
never disagree. fedipod.net writes what changed to your pod every fifteen
minutes, and everything at once when you stop it keeping your account running,
move your address or close it. Your signing key and the passwords of accounts
you connected elsewhere are never in the copy; they stay on your pod only.

## Using any Mastodon app

While the gateway keeps your account running, any Mastodon app can use it:
elk.zone, Ivory, Tusky, Phanpy and the rest. In the app, give `fedipod.net` as
your server. The app sends you to a fedipod.net page that asks for your
address here and signs you in at your own pod; no password is typed on
fedipod.net. The app then reads your timeline and notifications from your
account's copy at the gateway, and posts, boosts, likes and follows as you.

An app checks for new posts every minute or so while it is open; there are no
live updates. Accounts are made on the fedipod.net front page, with a pod, not
from an app.

## Accounts that go quiet

Every delivery the gateway accepts ends up in your pod inbox, and your agent
reads it from there. A BrowserAgent reads only while
its page is open, so an account nobody opens grows on its pod without limit
and comes back to a drain of everything at once. fedipod.net keeps two facts
about each browser account — when its owner last signed in or posted, and
how much content has arrived since — and acts on them.

**Paused.** After about 5,000 posts, replies, likes, boosts and edits since
you were last here, or when you say so on the manage page, the door accepts
content and discards it. Follows, unfollows, account moves, deletions and
blocks still reach your pod. Signing in ends an automatic pause by itself; a
pause you set lasts until you lift it.

**Closed.** After six months without a sign-in, or when you say so on the
manage page, the address is closed for good: its handle, its actor and its
door answer 410 Gone, other servers drop the account the next time they look,
and nobody can take the name. Nothing on your pod is touched. An address that
had already moved to another gateway keeps answering as moved.

Only accounts opened from a browser are counted. A DeviceAgent behind the
gateway drains its own inbox as it runs, and is never paused or closed by
time. Accounts from before this was built are counted from their next
sign-in. A gateway operator sets the cap and the window with
`FEDIPOD_PAUSE_ITEMS` and `FEDIPOD_CLOSE_DAYS`.

## Notices

Whoever runs the gateway can write notices to everyone with an account
there. A bell at the right end of the bar, on the record page and in the
client, shows how many this browser has not opened yet; the list gives the
titles and each one opens on its own. The operator writes, changes and
removes them at `/notices`, signed in as the admin the way the roster is.
A notice is a title and plain text: a blank line starts a paragraph, and a
web address becomes a link.

## What the gateway can see

It reads only public data to decide what concerns you: your published
followers and following, and a small public policy document your agent writes
with a mirror of your blocklist. Publishing that mirror does make your
blocklist public, which is part of the bargain of running behind a door.

Three things go further, all for browser accounts only. Mail that waits at
the gateway while your app is closed, direct messages included, is stored there
until it reaches your pod. A gateway keeping your account running can read and
write everything in your FediPod folder, your signing key included, while it
works; nothing else on your pod is open to it. And it keeps your account's
working data — your timeline, notifications and direct messages among it — for
as long as it keeps your account running.

## Running a gateway

Any always-on box will do — a VPS, a home server behind a tunnel, a serverless
host. The logic is plain Node in `lib/gateway/gateway-core.mjs`, and a host needs only
a thin adapter that calls `handleDelivery`.

Two ways are ready to use:

- **On Netlify**, with the adapter in `netlify/functions/inbox.mjs`. See
  [netlify/README.md](netlify/README.md) for the deployment specifics.
- **On any box of your own**, with your own adapter around the same core.
- **Inside a Community Solid Server**, as the same door run in-process by the
  CSS component — see [packages/fedipod-server](packages/fedipod-server/README.md).

### Offering accounts to other people

A gateway can also be a front for many people, so a host can offer
`@name@their-host` addresses. Each user keeps their own pod, their own agent
and their own signing key; the front answers WebFinger for all of them, serves
each public face by rewriting that user's pod ids onto the shared domain, and
routes every verified delivery into the right pod.

A fronted identity is the gateway-based name choice in the admin page's
Gateway panel, or:

```
fedipod gateway --attach <front-origin> --name <name> --fronted
```

Choose at attach time: changing an existing identity's front later renames
every published id, and the attach refuses it.

**Following from elsewhere.** Each account's WebFinger answer names the front's
`/authorize_interaction?uri={uri}` page in the link other servers read for it
(`http://ostatus.org/schema/1.0/subscribe`). That is what a remote **Follow**
button uses when its reader says they are at this host: the reader lands on
that page, and the follow is sent by the agent in their own browser. Without
the link, and without the page, pressing Follow and naming this host ends in
"not found" on the other server.

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
