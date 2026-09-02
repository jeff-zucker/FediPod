# The Admin interface

Open `https://localhost:8030/` while any agent is running — it forwards you to the agent — then choose `manage account` and select the actor you want from the local actors dropdown.
Picking an actor marked "(stopped)" starts its agent, then opens its page.

The software row names the version the agent is running. When the copy on the machine is further ahead — after an update, or after pulling a checkout — it says so and asks for a restart, because an agent goes on serving the code it started with until it is restarted.

`Update`, shown on the software row when a newer FediPod exists, pulls the latest version and restarts every agent on the machine — agents installed as services; any started by hand need their own restart. The same row flags an older data layout after an update; the `fedipod upgrade` terminal command lists those moves and the commands that make them.

* **Parking** (the status control) stops the mail and unfollows people you follow, but keeps your handle
  alive. Setting it back to active re-follows everyone — as requests, so a
  few may not come back.  If your local machine is going to be off for more than a couple of days, you should park the account because, if you don't, mail will accumulate on the pod possibly causing load issues.
* **Transfer this account away** hands your followers to the account you name; your
  old handle keeps working as a redirect, and the identity is parked
  afterwards.
* **Retire identity** is permanent — every follower's server is told to drop
  the account, and the identity does not come back.
* In the **Upkeep** group: **Drain the inbox** fetches and handles everything
  waiting now, and **Show dead letters** lists deliveries that failed for
  good and will not be retried.
* **Rotate signing key** — any other device still using the old key can no
  longer act as this identity.
* **Recover posts** re-reads your own posts from the pod after a restore. It
  only ever adds; nothing local is overwritten.
* Discarding a backlog drops old content only — its follows, unfollows and
  deletions are still applied, whatever their size.

The handle, the pod and person-vs-group are permanent. The display name, bio
and pictures are edited in the client, not here.

Most of these open a small window that floats over the page. You can drag it by
its title bar, resize it from its corner, and close it with its ✕ or by pressing
Escape. Parking is a control on the status row, and discarding a backlog is its
own section further down the page.

**+ add a new account…** at the bottom of the actors dropdown creates another
person or group on this machine: it needs a pod of its own (create one there,
or point it at one you have), and the new identity runs as its own agent on
its own port.

## Sharing an account

Each identity has a page anyone can open, at `ap/profile.html` under its pod
— for example `https://your-pod.example/activitypods-js/ap/profile.html`. It
shows the name, bio and address, and offers a Follow box: a visitor types
their own server and lands on that server's follow screen. Hand out that
link, or the `@name@host` address itself, which works in the search box of
any Fediverse app.

## Bluesky

Connecting a Bluesky account makes this identity also post as that account:
your **public** posts mirror to Bluesky (never unlisted, followers-only or direct
ones), deleting a post deletes its Bluesky copy, and the account's timeline
and notifications appear in your home feed. Replying to, favouriting and
boosting a Bluesky post act as the connected account. A reply lives on
Bluesky only — it is always public and fits Bluesky's 300-character limit —
because your Fediverse followers cannot see the post it answers. The
**crosspost** control stops the
mirroring without disconnecting. Disconnecting forgets the login but removes
nothing already posted. For a group, the connected account is the group's
presence on Bluesky — joining and posting through it follow the group's own
moderation settings; see [Groups](groups.md).

## Your other Fediverse accounts

Connecting an account you hold on another server brings its home timeline and
its notifications into the feed you already read here, interleaved by time.
Mastodon, GoToSocial, Pleroma, Akkoma, Pixelfed and Friendica all work. You
sign in at that server rather than here: this agent never sees a password, and
the token it is given stays on this machine and is never written to your pod.

Favouriting, boosting or replying to one of those posts acts **as that
account**, on its own server, because that is where the conversation is. A
reply from a connected account is public or unlisted. A post you wrote on that
account can be deleted from here, and it is deleted where it lives.

A post that two of your accounts both see appears once, not twice. The
favourite and boost controls are lit when any of your accounts has done it, so
using one again undoes it everywhere rather than adding a second from a second
account.

What arrives is held on this machine for reading. None of it is written to your
pod and none of it is republished — your own posts still go out from your pod
account alone.

Disconnecting stops the reading and removes the stored token; nothing already
posted is touched. If the other server stops accepting the token, the account
is marked **sign in again** rather than quietly dropped.

## Handling follow requests

New followers appear under **Follow requests** with **Accept** and **Refuse**
beside them; nothing is accepted without you. Groups are different — joining
follows the group's own moderation settings; see [Groups](groups.md).

**Accept all** answers the whole queue at once, and the identity pane's
**new followers** control switches between waiting for your approval and
accepting automatically.

## The gateway

The **gateway** row on the record (under **software**) attaches this account
to a mail-filtering gateway (a fedipod.net-style front) and detaches it; when
attached it names the gateway, and the handle there when you took one. Both
buttons open a popup. Attaching offers the choice of handle: keep your
pod-based handle (`@you@your.pod` — you can drop the gateway any time and
keep everything), or create a handle at the gateway (`@you@the-gateway` —
your address lives on the gateway's domain, but not your data or key), typed
straight into the blank of the address with a free/taken check as you type.
The gateway account is created automatically with either choice, and the
agent proves the pod with its own credential, so no password is typed
anywhere. Taking or leaving a gateway handle restarts the agent by itself;
detaching republishes your actor with your pod's own inbox.

## Moving here from another server

Open **Transfer an account here** on the action rail and add your old account
as an alias, set
**new followers** to *accepted automatically*, then trigger the move on the
old server (on Mastodon: Preferences → Account → *Move to a different
account*); your followers arrive by themselves. Removing an alias asks
twice — servers still processing the move check it while they retry. The CSV
files from the old server's export are imported with the CLI; see
[CLI admin](cli.md).

## Protecting & recovering your data

Your posts, timeline, contacts, blocklist and notifications are kept locally,
in `~/.fedipod`. This is the only copy, which means you should back
it up regularly. It contains credentials, so back it up securely.
Each identity's copy is under `~/.fedipod/profiles/<name>/`, and
`fedipod state --to` can move it elsewhere — if you have moved it, back up
where it lives now.

With a backup, restoring is copying the folder back and starting the agent —
everything returns, timeline included. Without one, nothing is fatal but some
things are gone: run setup again with your pod account (at `/admin/setup/` on the agent), rotate the signing
key, and your followers return by themselves the next time you post, while
**Recover posts** reads your own posts back from the pod. What nothing can
bring back is the timeline you received, your notifications, your blocklist,
and your client logins.

