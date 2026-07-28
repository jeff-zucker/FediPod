# activitypod-js

A standalone, single-actor ActivityPub agent whose entire existence is
**stored on a Solid pod** (Community Solid Server). The pod serves the public
wire face; the agent is a small outbound-only Node process that can run on
any machine — laptop, Raspberry Pi, VPS — with no public IP, no TLS, no
database. Move the one credential file and the actor moves with you.

Extracted from [data-kitchen](https://github.com/SolidOS/data-kitchen)'s
ActivityPub agent (the "6c remote-pod-as-relay" design).

## What lives where

Everything the agent owns nests under one top-level pod container:

- `/activitypods-js/ap/` — the public ActivityPub wire face (actor document,
  inbox, outbox, followers/following, notes, media), served verbatim by the
  pod. Followers' servers talk to the POD, not to your machine.
- `/activitypods-js/fediverse/` — the RDF source of truth (timeline, posts,
  contacts, settings) in ActivityStreams vocabulary, owner-only.
- `/activitypods-js/ap-state/` — operational state as JSON (delivery queue,
  status mirror, notifications, keys…), owner-only, rebuildable from the RDF.
- `/.well-known/webfinger`, `host-meta` + `nodeinfo` at the pod root
  (fediverse discovery requires the host root; nodeinfo lets crawlers and
  clients see a self-describing activitypod-js server).

Locally: `~/.activitypod/credential.json` (a revocable CSS client
credential) and a log file. Nothing else.

## Use

From nothing — no account, no pod — one command creates the account, the
pod, the actor, and leaves you in the client:

```
npm install
bin/activitypod.mjs setup --new-account --email you@example.org --handle you
```

Already have a pod? Point at it instead:

```
bin/activitypod.mjs setup --pod https://you.solidcommunity.net/ \
  --issuer https://solidcommunity.net --email you@example.org --handle you
```

Setup finishes by starting the agent and opening the browser; later starts
are just `bin/activitypod.mjs run` — or make it an appliance:

```
bin/activitypod.mjs install-service
```

registers the agent with systemd (Linux, user unit + linger) or launchd
(macOS) so it starts at boot, restarts on crash, and needs no terminal.
`uninstall-service` reverses it.

For a no-install download, `node scripts/build-dist.mjs` produces
`dist/activitypod-js-<version>.tar.gz` (~13 MB) — unpack anywhere with
Node ≥ 20 and run the same commands, no `npm install` needed.

The UI is the bundled [Phanpy](https://github.com/cheeaun/phanpy)
client (MIT, by Chee Aun; patched to allow the loopback http origin — see
data-kitchen `claude/backups/*.pre-http-patch` for provenance) is served
same-origin over the agent's Mastodon client-API facade. Log in with one
click, instance `localhost:8030`.

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

Mobile clients need an https URL that reaches the agent. **First set a UI
password** — without one, `/oauth/authorize` trusts whoever can reach it
(fine on loopback, catastrophic anywhere else):

```
bin/activitypod.mjs passwd
```

Then the friction-free route is [Tailscale](https://tailscale.com):
`tailscale serve --bg 8030` gives the agent an https URL visible only to
your own devices, certificates handled for you. A public VPS + Caddy in
front of `localhost:8030` works the same way for a world-reachable UI.

## Android

The agent is pure JS, so [Termux](https://termux.dev) runs it unmodified:

```
pkg install nodejs
tar xzf activitypod-js-*.tar.gz && cd activitypod-js
bin/activitypod.mjs run        # then open http://localhost:8030/ in Chrome
```

`termux-wake-lock` keeps it alive in the background; and because the pod
buffers everything, an agent Android kills simply catches up on next start.

## Multiple devices

Only ONE agent may act on a pod at a time (inbox drains are destructive
reads). Agents coordinate through a lease in `ap-state/`: the first to
start is the active one; later starts run as **read-only viewers** — you
can browse, but posting/following answers 503 until the active agent
stops and the lease expires (~90 s).

## Trust notes

- The pod host can read the signing key in `ap-state/` — but it already
  serves your actor document, so it could impersonate you regardless; no new
  trust is granted by storing state there.
- The CSS credential never leaves your machine and is revocable from the
  account dashboard.
- Never run two agents (e.g. this and data-kitchen's) against the same pod:
  inbox drains are destructive reads and they would race.
