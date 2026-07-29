# activitypod-js

A standalone, single-actor ActivityPub agent whose entire existence is
**stored on a Solid pod** (Community Solid Server). The pod serves the public
wire face; the agent is a small outbound-only Node process that can run on
any machine — laptop, Raspberry Pi, VPS — with no public IP, no TLS, no
database. Move the one credential file and the actor moves with you.

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
are just `bin/activitypod.mjs run`. The default port is 8030; pass
`--port <n>` (or set `AP_PORT`) at setup and it is remembered — later
commands need no flag. Or make it an appliance:

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
client (MIT, by Chee Aun; patched to allow the loopback http origin; is served
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

## Security model

The agent listens on loopback, but loopback is not an access control: any
web page you visit can try to talk to it, and DNS rebinding lets such a page
keep its own origin while doing so. The defences:

- **Host/Origin firewall** — requests must name `localhost`/`127.0.0.1`/`::1`
  (plus anything in `AP_ALLOWED_HOSTS`), and any cross-origin `Origin` is
  refused. Applies to the WebSocket upgrade too, which CORS does not cover.
- **Authorization is same-site only** — `/oauth/authorize` refuses cross-site
  navigations and only redirects to an address of this agent, so a visited
  page cannot have a token mailed to itself. Client tokens expire after 90
  days; `activitypod tokens` lists and revokes them.
- **Outbound requests are address-filtered** — anyone on the fediverse can
  put URLs in your inbox, so every fetch and delivery resolves the host first
  and refuses loopback, private, link-local (cloud metadata) and CGNAT
  addresses, re-checking each redirect hop. `AP_ALLOW_PRIVATE_TARGETS=1`
  lifts this for local testing.
- **Federated HTML is sanitized on ingest** — allowlisted tags and
  attributes only, no scripts, no event handlers, no `javascript:` URLs — so
  neither the pod copy nor any client holds hostile markup. A strict CSP
  backs this up.
- **The inbox is public, the timeline is not** — anyone may deliver to your
  pod, so arriving does not mean belonging. Posts from people you follow
  (and their boosts) are your home timeline; anyone else who addresses you
  becomes a **mention** — notified and readable, but out of the timeline and
  not written into your pod. Anything that names neither you nor a post of
  yours is refused before it is even fetched.
- **A leaked credential is revoked, not re-encrypted** — nothing can hide a
  secret from code running as you, so
  `activitypod revoke-credential --email you@…` kills this machine's
  credential server-side and deletes it locally. (Full-disk encryption
  covers the stolen-laptop case; the file itself is 0600 in a 0700 dir.)
- **Exposure beyond loopback** (tailnet, reverse proxy) requires
  `activitypod passwd` *and* listing the hostname in `AP_ALLOWED_HOSTS`. The
  agent will refuse requests for hostnames it was not told about.

Not defended: anything running as your user on your machine (loopback is
open to every local process — set `AP_GATE_TOKEN` to a shared secret if that
matters to you), and the pod host, which can read what it stores (below).

## Trust notes

- The CSS credential never leaves your machine and is revocable from the
  account dashboard.
- The pod stores your signing key and client tokens; the pod host can read
  them. It already serves your actor document, so it could impersonate you
  regardless — but if that trade doesn't suit you, host the pod yourself.

