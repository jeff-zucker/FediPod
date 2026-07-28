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
- `/.well-known/webfinger` + `host-meta` at the pod root (fediverse
  discovery requires the host root).

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
are just `bin/activitypod.mjs run`.

For a no-install download, `node scripts/build-dist.mjs` produces
`dist/activitypod-js-<version>.tar.gz` (~13 MB) — unpack anywhere with
Node ≥ 20 and run the same commands, no `npm install` needed.

The UI is the bundled [Phanpy](https://github.com/cheeaun/phanpy)
client (MIT, by Chee Aun; patched to allow the loopback http origin — see
data-kitchen `claude/backups/*.pre-http-patch` for provenance) is served
same-origin over the agent's Mastodon client-API facade. Log in with one
click, instance `127.0.0.1:8030`.

The agent federates for real: follow/unfollow, post, reply, favourite,
boost, media, delete; incoming boosts from people you follow and a
configurable public-hashtag feed (`POST /tagfeed`) fill the timeline.

## Trust notes

- The pod host can read the signing key in `ap-state/` — but it already
  serves your actor document, so it could impersonate you regardless; no new
  trust is granted by storing state there.
- The CSS credential never leaves your machine and is revocable from the
  account dashboard.
- Never run two agents (e.g. this and data-kitchen's) against the same pod:
  inbox drains are destructive reads and they would race.
