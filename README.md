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

<!-- CLAUDE 2026-07-30 — rewritten: setup now asks two things and finishes in the browser -->
The terminal asks two things — your **handle**, which is the name in your
address and is permanent, and the **port** — and then opens your browser:

```
handle (the name in your address; permanent): jeff
port [8030]:

  http://jeff.localhost:8030/   <- opening this
  http://localhost:8030/        <- the same agent, if your browser cannot find that name

setup continues in the browser — Ctrl-C to stop
```

Everything else is asked on that page: person or group, a new account and pod
or one you already have, your identity provider, email, pod name, display
name, bio, avatar, and your passwords. It shows the address you are about to
take — and the same warnings the terminal used to print — before anything is
created. Nothing is written until you press the button.

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
orphan the first. Run `bin/activitypod.mjs start` and finish at `/setup/` in
the browser: it picks up from the credential it already has, and does not ask
for your password again.
<!-- /CLAUDE -->

### Running the agent

From the install folder, run `bin/activitypod.mjs start`.
You may optionally add `--port PORTNUM` to change your local agent's port (default is 8030), or `--name "Your Name"` to change the display name other people see.

Now point your browser (any) at http://localhost:8030 — or your own `--port` if you set it — and there you go!

<!-- CLAUDE 2026-07-30 — added: the two origins, and the record page -->
`start` prints both URLs and opens nothing — it is run by supervisors and on
every restart, and a window arriving unasked is not a feature. `--open` opens
one. `setup` does open a browser, because that is what `setup` is for.

Everything about the actor that can be changed is at
`http://localhost:8030/admin/` — display name, bio, avatar (saving republishes
the actor document, so other servers learn them), the agent's own UI password,
and republish / drain / log / dead letters. The handle, the pod, the identity
provider and person-vs-group are not editable: they are what the actor *is*,
and changing one would mean a different actor at a different address.
Parking, reviving, retiring and rotating the signing key stay on the command
line.
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

<!-- CLAUDE 2026-07-30 — added: describe, and the mention note -->
Your bio and avatar live in the actor document other servers fetch, so setting
them republishes it:

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
on its own port. It serves no client UI, because there is no timeline for a
human to read, which also means it has no login and no client tokens.

<!-- CLAUDE 2026-07-30 — added: a group serves its own two pages, and only those -->
A group does serve its own two pages. `http://localhost:<port>/` is its console
at `/admin/` — members, join requests, the review queue, what it has carried,
and every moderation action below as a button — and `/setup/` is where it was
created in the first place. That is all it serves: no Mastodon client, no
`/api/*`, no `/oauth/*`, no tokens, no UI password. The console reaches exactly
the same loopback routes the commands below already reach, so it grants nobody
any authority they did not have; it is a different client, not a wider door.
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

## Requirements

* a web browser
* node 20 or greater
* a Solid pod provider that supports subdomains

## Architecture

<!-- CLAUDE 2026-07-30 — repointed png → svg; the old png moved to drafts/ -->
![Solid ActivityPub flow](architecture.svg)
<!-- /CLAUDE -->

## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
