# activitypod-js

- access the fediverse from a Solid pod

`activitypod-js` is a standalone, single-actor ActivityPub agent that stores your data on a Solid Pod and runs on any device that supports node. The agent can be moved from one device to another without any change to your account. 

## Installation

In a terminal :

```
git clone https://github.com/jeff-zucker/activitypod-js;
cd activitypod-js;
npm install
```

## Setup

You only have to do setup once per device.


### Setup if you don't have a pod yet

From nothing — no fediverse account, no pod — one command asks for your credentials, creates the account, the pod, the actor, and leaves you in the client looking at your fediverse home with a pre-stocked home feed :

```
bin/activitypod.mjs setup --new-account --email you@example.org --handle 
```

Note: handle is the label that will appear on your account address, you can also set the account display name as described in [running the agent](#running-the-agent). So fediverse users will see something like this
```
  NAME
  @HANDLE@you.example.org
```
Your name can be changed, but your handle is permanent for that account.

### Setup if you already have a pod

From the install folder on your local machine :
```
bin/activitypod.mjs setup --pod https://you.solidcommunity.net/ \
  --issuer https://solidcommunity.net --email you@example.org --handle you
```

### Running the agent

From the install folder, run `bin/activitypod.mjs start`.
You may optionally add `--port PORTNUM` to change your local agent's port (default is 8030), or `--name "Your Name"` to change the display name other people see.

Now point your browser (any) at http://localhost:8030 — or your own `--port` if you set it — and there you go!


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

## Fediverse Clients
The UI is the bundled [Phanpy](https://github.com/cheeaun/phanpy)
client (MIT, by Chee Aun); patched to allow the loopback http origin. It is served same-origin over the agent's Mastodon client-API facade. Log in with one
click, using `localhost:8030` (or your own `--port`) as the instance.

The agent federates for real: follow/unfollow, post, reply, favourite,
boost, media, delete; incoming boosts from people you follow and a
configurable public-hashtag feed (`POST /tagfeed`) fill the timeline.

## Other clients

- **Web clients**: drop any static Mastodon client dist into `ui/<name>/`
  and it is served at `/<name>/`, same-origin — see `ui/README.md`.
- **Desktop clients** (Tuba, Whalebird, …): add `http://localhost:8030` as a
  custom instance.
- **Streaming**: the agent serves the Mastodon streaming API
  (`/api/v1/streaming`, WebSocket) so clients update live instead of polling.

## Remote access (phones, https-only clients)

The agent listens on your own machine, so a phone can't see it, and mobile clients insist on https. Reaching it from another device needs two things: a password and an https address.

**Set the password first** — without one, anyone who can reach the agent is treated as you. That is fine on your own machine and dangerous anywhere else:

```
bin/activitypod.mjs passwd
```

Then give it an address. [Tailscale](https://tailscale.com) is the easy route: install it on both devices and run `tailscale serve --bg 8030`, which gives the agent an https URL only your own devices can reach, certificates included. A small server with a reverse proxy in front of `localhost:8030` does the same job if you want it publicly reachable. Add whichever hostname you use to `AP_ALLOWED_HOSTS`, or the agent will refuse requests for a name it was not told about.

## Android

The agent is pure JS, so [Termux](https://termux.dev) runs it unmodified:

```
bin/activitypod.mjs start      # then open http://localhost:8030/ 
```

`termux-wake-lock` keeps it alive in the background; and because the pod
buffers everything, an agent Android kills simply catches up on next start.

## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
