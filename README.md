# Solid ActivityPub

- access the fediverse from a Solid pod

`Solid ActivityPub` is a standalone, single-actor ActivityPub agent that stores your data on any subdomained Solid Pod and runs on any device that supports node >20. The agent can be moved from one device to another without any change to your account. There is support for fediverse group formation and management, see [below](#groups).

This project is inspired by the fantastic [ActivityPods project](https://github.com/activitypods) and is meant to be a light weight alternative rather than a replacement.


## Installation

In a terminal :

```
git clone https://github.com/jeff-zucker/solid-activitypub;
cd solid-activitypub;
npm install
```

## Setup

You only have to do setup once per device. From nothing — no fediverse account, no pod — one command creates the account, the pod, the actor, and leaves you in the client looking at your fediverse home with a pre-stocked home feed. Setup will prompt you for needed information. If you already have a pod, you'll be offered the opportunity to either create a new pod for your Activitypod data or to store it on your existing pod.

```
bin/activitypod.mjs setup
```

<!-- CLAUDE 2026-07-31 — added: npm start is now the one command -->
### Or just: `npm start`

```
npm start
```

That is the whole thing. It finds a port that is actually free — starting at
8030, walking up past whatever else is on your machine — starts the agent in
the background, and opens your browser at the page you need: the setup form the
first time, your client every time after. It logs to
`~/.solid-activitypub/agent.log` and `bin/activitypod.mjs stop` stops it. Run it
twice and it just tells you it is already running.

`--no-open` if you would rather it left your browser alone.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-07-30 — rewritten: setup now asks two things and finishes in the browser -->
### Or from the terminal

The terminal asks two things — your **handle**, which is the name in your
address and is permanent, and the **port** — and then opens your browser:

```
handle (the name in your address; permanent): jeff
port [8030]:

  http://jeff.localhost:8030/   <- opening this
  http://localhost:8030/        <- the same agent, if your browser cannot find that name

setup continues in the browser — Ctrl-C to stop
```

Everything else is asked on that page, and only what setup cannot do without:
person or group, the handle, and a new account and pod or one you already have
— identity provider, account email and password, pod name. Display name, bio
and pictures are not asked; they are the client's job afterwards. It shows the
address you are about to take before anything is created, and nothing is
written until you press the button.

Each agent also answers at `http://<handle>.localhost:<port>/`, which is what
setup opens. A browser keeps its storage per origin, so two identities on one
machine stop sharing a login and stop being impossible to tell apart. If your
browser cannot resolve that name, `http://localhost:<port>/` is the same
agent and everything works there.

Setup stays entirely on the command line — exactly as it always was — when
stdin is not a terminal, when `--cli` is given, or when any identity flag is
present:

```
bin/activitypod.mjs setup --new-account --email you@example.org --handle you
bin/activitypod.mjs setup --pod https://you.solidcommunity.net/ --email you@example.org --handle you
```

**If a setup dies part-way through, do not re-run it.** The credential a Solid
server mints is shown once and cannot be minted again, so a second run would
orphan the first. Run `bin/activitypod.mjs start` and finish at `/admin/setup/` in
the browser: it picks up from the credential it already has, and does not ask
for your password again.
<!-- /CLAUDE -->

### Running the agent

From the install folder, run `bin/activitypod.mjs start`.
You may optionally add `--port PORTNUM` to change your local agent's port (default is 8030), or `--name "Your Name"` to change the display name other people see.

Now point your browser (any) at http://localhost:8030 — or your own `--port` if you set it — and there you go!

<!-- CLAUDE 2026-07-30 — added: the two origins, where private data lives, the record page -->
`start` prints both URLs and opens nothing — it is run by supervisors and on
every restart, and a window arriving unasked is not a feature. `--open` opens
one. `setup` does open a browser, because that is what `setup` is for.

### Where your private data lives

Your timeline, contacts, blocklist and notifications are kept on **this
machine**, beside the credential, from the actor's first write. Your pod holds
the public face other servers read and nothing else — your address, your actor,
your inbox and your published posts. It is a relay, not a filing cabinet.

The saving is not small. Kept on the pod, every post you *receive* would cost it
several writes; kept here, receiving costs it nothing but the inbox drain — so
pod cost scales with what you publish, not with what you read.

It costs two things, both the same thing really — your private data now has one
copy:

* **No second machine.** A second agent starts, but as a read-only viewer of its
  own copy — and on another machine that copy is empty, so there is nothing for
  it to show. (The lease that decides which one acts stays on your pod.)
<!-- CLAUDE 2026-08-03 — the recovery bullet said the opposite of what the code
     does, and contradicted "Getting your posts back" below -->
* **Some of it only your backups can bring back.** Not all: your followers
  return by themselves on the next publish, and `activitypod rebuild` recovers
  your own posts from the pod's outbox — see *Getting your posts back*. What is
  gone with the machine is the timeline you received, your notifications, your
  blocklist and your client logins.
<!-- /CLAUDE -->

It is a plain **directory** — Turtle and JSON on disk, needing nothing running,
still your data in the ordinary sense; point a Solid server at it later if you
want it served. It can also be a **pod** on this machine, data-kitchen's or your
own Solid server, but that is a move you make, not a question setup asks.

Setup does not ask, because there is no case where the local directory is
unavailable and starting on the pod and moving later is strictly worse: the copy
left behind was on the pod the whole time. To see or change it afterwards:

```
bin/activitypod.mjs state                    # where it lives now
bin/activitypod.mjs state --to ~/somewhere/private/
bin/activitypod.mjs state --to http://localhost:8000/dk-pod/activitypods-js/
bin/activitypod.mjs state --to pod           # move it back
```

<!-- CLAUDE 2026-08-01 — added: paths are shown short, and taken short -->
`--to` takes a path or a URL. Paths are shown the way you would type them —
`~/.solid-activitypub/private/` rather than
`file:///home/you/.solid-activitypub/private/` — and what it prints is what it
takes back, so you can paste one line into the next. A command it suggests you
run still names the directory in full: display is for reading, a command is for
pasting.
<!-- /CLAUDE -->

Stop the agent first. It copies both trees and checks they arrived before it
repoints anything, and it leaves the old copy where it was for you to delete.

<!-- CLAUDE 2026-07-31 — new: the home root and `home --to` -->
<!-- CLAUDE 2026-08-02 — rewritten: every identity is a named folder now -->
### Where the agent itself lives

One directory holds every identity on this machine, and **every identity is a
named folder under `profiles/`** — its credential, signing keys, pidfile, log
and private data all inside its own:

```
~/.solid-activitypub/
  root.json              which identity was used last
  profiles/
    jeff/     credential.json  keys.json  agent.json  agent.log  private/
    group/    …
```

The first identity used to live at the top of the root instead, with no name of
its own — so one identity's folder contained all the others, and the listing had
to invent the word `(default)` for the one that hadn't got a name. Which was the
tell: something you have to name when you display it doesn't have an identity, it
has a position.

**You never pick a default.** `root.json` records whichever identity you last
started, and that is what a plain command means afterwards:

```
bin/activitypod.mjs start --profile group   # today
bin/activitypod.mjs status                  # …means group from now on
```

Nothing to configure and nothing to keep in sync — the answer can't drift from
the identity you actually work in, because working in it is what sets it. With
one identity there is no question to answer; with several and none ever started,
a plain command asks rather than guessing, since guessing means guessing which
fediverse account you meant.

If your root still keeps an identity at its top level, from before this:

```
bin/activitypod.mjs home --restructure
```

which moves that identity's own files down into `profiles/<its handle>/`, leaves
`profiles/` where it is, rewrites its private-data path, and refuses while any
agent is answering. Its keys move with it; nothing is copied and left behind.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-07-31 — the root's own name -->

```
bin/activitypod.mjs home                     # which directory, and what is in it
```

New installs use `~/.solid-activitypub`. Anything set up before the project was
renamed on 2026-07-30 has `~/.activitypod`, and **keeps it** — that directory
holds your private key, so nothing moves it behind your back. Take the new name
when you want it:

```
bin/activitypod.mjs home --to ~/.solid-activitypub
```

It moves the whole root, profiles and all, rewrites any private-data path that
pointed inside it, and refuses while an agent is still answering. `AP_HOME` and
`--home` override the lot and are left alone. If you installed the service, its
unit has the old path baked in, so re-run `install-service` afterwards.
<!-- /CLAUDE -->

When a lot has piled up while the agent was off, `/admin/` says so and asks what
you want: keep everything and let it work through the backlog oldest-first, or
discard the content older than a week or a month. Discarding drops posts, not
bookkeeping — follows, unfollows and deletions from that period are still
applied, so your follower list stays right and nothing stays up that its author
took down.

<!-- CLAUDE 2026-08-02 — added: the panels float now -->
The panels those buttons open — the moderation settings, the log, the dead
letters, a lifecycle confirmation — open in a small window you can move and
resize, rather than unfolding at the foot of the page. An accordion pushed
whatever you were reading out from under you, and only one could ever be open,
so checking the log meant closing what you were looking at. Drag it by its title
bar, resize from the corner, close it with ✕ or Escape. Full-page forms — adding
an account, and setup — stay full-page; this is only for what used to fold out.
<!-- /CLAUDE -->

The record is at `http://localhost:8030/admin/` — what the actor is, and the
things you do to it. Identity lists the kind, both identities (the fediverse
address and the WebID), where the private half is kept and which local address
answers. Upkeep drains the inbox, recovers posts, and shows the log and the dead
letters; Lifecycle parks, revives, rotates the signing key, transfers the identity to
another account and retires it, each behind a confirmation that states its
consequences. First-run setup is at `/admin/setup/`.

<!-- CLAUDE 2026-08-02 — added: move is in the UI, and retire offers it -->
**Transfer identity** hands your followers to another account: a `Move` goes to every
follower's inbox, their servers migrate them, and the actor left behind
advertises `movedTo`, so the old handle keeps resolving as a redirect rather
than breaking. Name the destination as `@you@elsewhere` or an actor URL — a
handle is resolved for you, because the Move's target has to be an actor URI or
the far side has nothing to migrate anyone to. Afterwards the identity is
parked, exactly as Park would. **Transfer identity** and **Retire identity** both want the handle typed, being
the two that cannot be taken back.

The retire confirmation offers those two directly rather than naming a command
to go and type. Standing down keeps the handle and just stops the mail;
transferring hands the followers on. Both are one click from the warning.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-01 — new: getting your own posts back after a restore -->
### Getting your posts back

Your private half is on this machine, so a restored backup or a replaced machine
comes back knowing less than the pod does. Your followers are recovered
automatically on the next publish. Your own posts are not, because putting them
back means reading them — so it is a thing you ask for:

```bash
bin/activitypod.mjs rebuild
```

or **Recover posts** on the Upkeep line of `/admin/`. The agent has to be
running.

It reads the pod's outbox, fetches each post that this machine no longer has,
and adds it — to the statuses store and back into the RDF. It never removes or
overwrites anything: a post already here keeps its own copy, including what only
this machine knows, like whether you boosted or favourited it.

The outbox is the index rather than the notes container, and that is deliberate.
Deleting a post rewrites the outbox in one go, so an entry still there is a post
that still stands. The note document is deleted separately and that request can
fail, which would leave a deleted post sitting published. If you would rather
have those back than lose a post:

```bash
bin/activitypod.mjs rebuild --from-notes
```

which reads every note the pod still holds, and can bring back one you deleted.

What it cannot recover: other people's posts in your timeline. Those were never
yours to publish and the pod never had them — only your own posts and your own
boosts of them are on the pod to read back.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-02 — new: follows are approved now, and why -->
### Follow requests

When somebody follows you, they appear under **Follow requests** on `/admin/`
with **Accept** and **Refuse** beside them. Your account is, in fediverse terms,
locked.

The reason is that nothing in the protocol lets this agent know a Follow really
came from the account it names. Deliveries arrive as plain documents in your
pod's inbox, which is open to the world by design — that is what makes you
reachable — and an LDN body carries none of the signature headers a direct
delivery would. For a Create or a Delete that does not matter, because there is
an object at the sender's own server to go and re-read; a Follow has nothing to
check against. So anyone at all could have named anyone at all, and this agent
would have signed an acceptance and started sending them everything you post.

If you would rather have the old behaviour, one line in the config restores it:

```json
{ "autoAcceptFollows": true }
```

A **group** is unaffected either way — `joins open` and `joins approve` still
mean exactly what they did, because a group's operator has already said in as
many words whether anyone may join.
<!-- /CLAUDE -->

The handle, the pod, the identity provider and person-vs-group are not editable:
they are what the actor *is*, and changing one would mean a different actor at a
different address. The display name, bio and pictures are editable, but not
here — see *Editing the profile* below.

A bar across the top of every page carries the same three destinations: **visit
account** opens `/admin/client/`, the bundled client under that bar; **manage
account** is the record; **add new account** opens setup for another actor.

When another actor is running on this machine, the top of the page links to it —
`admin` for its record, `app` for its client. Only actors that are actually up
are listed, and not the one you are already on, since neither is somewhere to
go. `activitypod profiles` is the same information in the terminal, including
the stopped ones.

Following a link just loads that agent's own page; nothing is shared between
them. Building the list reads one file per identity, `agent.json`, which holds a
port and a handle — no other agent's credential or keys are ever opened, and
there is a test that fails if that changes.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-01 — new: every link is named, and the client is pinned -->
Each identity is listed by its fediverse address — `jeff@jeff-zucker.teamid.live`
— and **every link to one uses its own origin**, `http://<handle>.localhost:<port>/`,
never the bare `http://localhost:<port>/`.

That matters more than it looks. A browser keys storage per origin, so a row of
identities all linked at `localhost:<port>` files them in one bucket, and the
client you open there shows whichever account that bucket happens to hold — one
actor's login on another actor's page, with the profile editor pointed at a host
that cannot answer. The named origin is what keeps them apart, so anything that
builds a URL for you now spends the handle on it: the Actors list, the startup
line in `agent.log`, what `setup` opens and tells you to log in as, and the page
a newly created actor lands on. A stopped identity is named too, from the handle
in its `agent.json`, since it is not running to be asked.

Storing per origin is only half of it, though: the client is a general fediverse
client and nothing made its current account agree with the agent serving it. So
when you open a client whose stored account is not this actor, it is sent to its
own login for this instance and back — no typing, one trip, once per identity.
The login itself lands on the client at `/`, the same place the Actors list's
`app` link goes; the bar comes back with it the next time you open `visit
account`.
<!-- /CLAUDE -->


### Running the agent as a service

If you don't want to run the agent each time, you can install it as a system sevice :
```
bin/activitypod.mjs install-service
```
This registers the agent with systemd (Linux) or launchd
(macOS) so it starts at boot, restarts on crash, and needs no terminal.
`uninstall-service` reverses it. 

On **Windows** it creates a Scheduled Task that starts the agent at log on (this path is untested — it prints the equivalent `schtasks` command either way). On **Android/Termux** there is no service manager, so it prints a boot-script recipe using the Termux:Boot app and `termux-wake-lock` instead; whatever Android kills is buffered on the pod and catches up at the next start.

### Starting and Stopping the agent

```
bin/activitypod.mjs start    # start (setup already did this the first time)
bin/activitypod.mjs stop     # graceful: flushes state, releases the lease
bin/activitypod.mjs status   # handle, active/viewer mode, followers, tag feed
```

Two more when you need them:

```
bin/activitypod.mjs tokens                  # list client logins; --revoke <prefix> / --revoke-all
bin/activitypod.mjs revoke-credential --email you@example.org   # kill this machine's pod credential
```

<!-- CLAUDE 2026-08-02 — added: the --force that makes the advice true -->
If this home's `keys.json` is lost or damaged, the agent refuses to start rather
than mint a replacement behind your back — a new key would invalidate every
signature the other device holding the old one can still make. Recovering from
that needs `rotate-key --force`, which mints the replacement and republishes the
actor so other servers learn it:

```
bin/activitypod.mjs rotate-key --force
```
<!-- /CLAUDE -->

<!-- CLAUDE 2026-07-30 — added: describe, and the mention note -->
<!-- CLAUDE 2026-08-01 — the client edits the profile now; describe still works -->
### Editing the profile

Display name, bio, avatar, header and the extra fields are edited in the client,
through Mastodon's own profile editor — the agent answers
`PATCH /api/v1/accounts/update_credentials`, so Phanpy's *Edit profile* writes
them. Pictures are uploaded to the pod's media container and the actor document
carries their URLs; the actor is republished on save.

<!-- CLAUDE 2026-08-01 — added: the edit now reaches other servers -->
Republishing puts the new document on your pod, but nothing obliges another
server to come back and read it — Mastodon shows the copy it cached, follower
count included, until something makes it look again. So a save now also delivers
an `Update` to every follower, and your edit is visible to them at once instead
of whenever their cache happens to expire.

It goes out only when the actor document actually changed. Starting the agent
never publishes — every republish is something you asked for — but a save can
still change nothing the actor document carries, so the agent keeps a digest of
what it last published and stays quiet when the new one matches.
<!-- /CLAUDE -->

The command line still works for the two it always did, and republishes the same
way:

```
bin/activitypod.mjs describe --summary "birds, mostly" --icon https://example/me.png
```

Writing `@someone@their.host` in a post resolves them, tags the post as a
mention and delivers it to them, so they are actually notified. A handle that
cannot be resolved is left as plain text rather than failing the post.
<!-- /CLAUDE -->

## Groups

A group is an actor other people follow, rather than one that follows people.
Post to it and it re-announces to everyone following it, so members see each
other without having to follow each other. Joining is following, leaving is
unfollowing, and remote Mastodon users can join exactly as pod owners do — they
need no pod of their own.

A group needs a pod of its own. A handle is answered at the root of its host, so
a person and a group cannot share one pod without fighting over the same address:

```
bin/activitypod.mjs setup --group --profile mygroup --new-account
```

Run it like any other identity — `start`, `stop`, `status`, `park`, `retire` —
on its own port.
<!-- CLAUDE 2026-08-01 — corrected in place: a group serves the client now -->
<!-- was: "It serves no client UI, because there is no timeline for a human to
     read, which also means it has no login and no client tokens." -->
<!-- /CLAUDE -->

<!-- CLAUDE 2026-07-30 — added: a group serves its own two pages, and only those -->
<!-- CLAUDE 2026-08-01 — rewritten: the client is no longer withheld -->
A group serves the same three surfaces every identity does.
`http://localhost:<port>/` is the client; `/admin/` is its console — members,
join requests, the review queue, what it has carried, and every moderation
action below as a button; `/admin/setup/` is where it was created.

The client was withheld until 2026-08-01, on the reasoning that a group has no
timeline a human reads. It has both halves of one: statuses are what it carried,
notifications are who joined. And its operator has a bio to write and a profile
they want to look at the way everyone else sees it — both of which are the
client's job.

What that opens is a login and client tokens, which a group did not have before.
`activitypod passwd` has never had a group carve-out, so a group can be gated
exactly like a person before it is exposed anywhere but loopback — and with no
password set, `/oauth/authorize` redirects instantly, for a group exactly as for
a person.

Two things the client will offer a group that do not mean what they look like:
composing posts a Note *as* the group, which is a legitimate announcement but
not the path a member's post takes; and following someone pulls their posts into
the group's timeline without making them a member — membership is who follows
the group, never who it follows.

The console reaches exactly the same loopback routes the commands below already
reach, so it grants nobody any authority they did not have; it is a different
client, not a wider door.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-01 — added: what the console shows now -->
Members are listed by their fediverse address — `@them@their.server` — rather
than by the URL their server happens to serve them at. An address only appears
once the group has actually read that actor's document; anyone it has not, it
still shows by URL, because guessing the name from the last segment of the URL
is what once rendered every group as `@actor@host`.

<!-- CLAUDE 2026-08-03 — the Moderation options panel became two dropdowns -->
The moderation settings — who may join, what gets carried — are two dropdowns
right on the kind line in Identity: **join requests** and **posts**, each
reading *moderated* or *unmoderated*. What each shows is the current state, and
changing the word is the whole action — what a group can be moderated into is a
property of being one, so the controls sit on the row that says "Group".
The join-request and post-review queues appear only when their setting is on and
something is actually waiting: with the setting off nothing can ever arrive in
them, so a heading would be promising a list that cannot fill.
<!-- /CLAUDE -->

Only members are amplified. Anyone can post into a public inbox, so a post is
carried only when its author already follows the group. That is both the
anti-spam rule and what makes joining mean something.

By default anyone who follows is admitted at once. A group can instead ask people
to request entry, which is opt-in in the same way post review is:

```
bin/activitypod.mjs joins approve           # or: setup --group --approve-joins
```

```
bin/activitypod.mjs members                 # who has joined
bin/activitypod.mjs announced               # what the group has carried
bin/activitypod.mjs mute <actor-url>        # stop carrying someone (undo: unmute)
bin/activitypod.mjs eject <actor-url>       # remove them, and tell their server
bin/activitypod.mjs retract <note-url>      # unsay something already carried
bin/activitypod.mjs review on               # hold every post until you approve it
bin/activitypod.mjs pending                 # what is waiting; approve / decline
bin/activitypod.mjs joins <open|approve>    # is entry free, or by request?
bin/activitypod.mjs requests                # who is waiting to join
bin/activitypod.mjs admit <actor-url>       # let them in (undo: eject)
bin/activitypod.mjs refuse <actor-url>      # decline this request
```

A group can be handed on rather than abandoned: `retire --move-to <actor>` tells
every follower to migrate, so the membership survives a change of host.

## Fediverse Clients
The UI is the bundled [Phanpy](https://github.com/cheeaun/phanpy)
client (MIT, by Chee Aun); patched to allow the loopback http origin. It is served same-origin over the agent's Mastodon client-API facade. Log in with one
click, using `localhost:8030` (or your own `--port`) as the instance.

<!-- CLAUDE 2026-07-30 — added: the instance name at the named origin -->
Browsed at `http://<handle>.localhost:8030/` — which is what `setup` and
`start` open — the instance to log in with is `<handle>.localhost:8030`
instead. Either works; they are the same agent. Pick one and stay on it,
because a browser keeps its login per origin.
<!-- /CLAUDE -->

The agent federates for real: follow/unfollow, post, reply, favourite,
boost, media, delete; incoming boosts from people you follow and a
configurable public-hashtag feed (`POST /tagfeed`) fill the timeline.

### Other clients

- **Web clients**: drop any static Mastodon client dist into `ui/<name>/`
  and it is served at `/<name>/`, same-origin — see `ui/README.md`.
- **Desktop clients** (Tuba, Whalebird, …): add `http://localhost:8030` as a
  custom instance.
- **Streaming**: the agent serves the Mastodon streaming API
  (`/api/v1/streaming`, WebSocket) so clients update live instead of polling.

## Android

The agent is pure JS, so [Termux](https://termux.dev) runs it unmodified:

```
bin/activitypod.mjs start      # then open http://localhost:8030/ 
```

`termux-wake-lock` keeps it alive in the background; and because the pod
buffers everything, an agent Android kills simply catches up on next start.

<!-- CLAUDE 2026-08-02 — new: setup refuses a plaintext pod that is not local -->
### A note on http:// addresses

Setup refuses an `http://` pod or identity provider that is not on this machine.
Those two addresses carry your account password and the credential it buys, and
nothing used to check the scheme, so a typo sent both in clear.

Loopback is exempt and always will be: `http://localhost:8000/…`,
`http://127.0.0.1:…` and any `*.localhost` name never reach a network interface,
so there is nothing to encrypt. A pod on this machine is an ordinary way to run
this. What gets refused is the address that looks local and is not — a LAN
address like `http://192.168.1.50:3000/` is a real wire shared with every other
device on it.
<!-- /CLAUDE -->

## Requirements

* a web browser
* node 20 or greater
* a Solid pod provider that supports subdomains

## Architecture

<!-- CLAUDE 2026-08-03 — the relay drawing is the one at root now, redrawn for
     the current layout; the older two-halves svg moved to drafts/ -->
![Solid ActivityPub flow](architecture-relay.svg)

The pod is the discovery and public storage half. The agent is the behaviour
half and the private storage sits beside it, on your machine — see *Where your
private data lives* above. The reasoning is in
[claude/plans/pod-as-relay.md](claude/plans/pod-as-relay.md).
<!-- /CLAUDE -->

## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
