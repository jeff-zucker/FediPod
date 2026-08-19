# Changes

## 2026-08-19
- Whalebird (and other megalodon-based clients) can sign in. Two changes:
  nodeinfo names the software `hometown` — a Mastodon fork those clients'
  server detection accepts; FediPod's own name was refused before sign-in
  could start — and a registered client using the out-of-band authorization
  flow now gets a code its secret can actually redeem.
- Agent addresses are https: `https://<handle>.localhost:<port+1000>`
  everywhere an address is printed, opened or linked, and the well-known door
  answers at `https://localhost:9030/`. The plain listeners remain for
  compatibility.
- The certificate is trusted automatically: the first agent start mints a
  local certificate authority carrying a critical name constraint — it can
  only ever vouch for localhost names and loopback addresses — signs the
  server certificate with it, and installs the authority in the browser
  trust store (NSS). `fedipod https --trust` remains for the system-wide
  store and odd setups; `AP_TRUST_INSTALL=0` disables the automatic step.
- On a FediPod Server, sign-up is the only way an account is made: a pod
  becomes an identity when its owner opts in at `/run` (or `POST /api/agent`)
  and stops when they opt out. The `agentPods` setting — operator-listed pods
  provisioned at boot — is gone; existing configs using it must drop it and
  have each owner sign up.
- The CSS component is renamed `fedipod-server` (was `fedipod-css-gateway`):
  the folder is `packages/fedipod-server`, the npm package `fedipod-server`,
  the config type `FediPodServerHandler` on `urn:fedipod:server:Handler`, and
  the shipped snippet `fps:config/server.json`. Existing configs need those
  four names updated.
- Signup-first onboarding: fedipod.net's create panels sign you up before
  anything is installed — sign in with your pod, pick your handle and your
  address shape (`@you@your.pod` or `@you@fedipod.net`), and the success
  screen hands one install command carrying the gateway, secret, pod, issuer,
  handle and kind. The installer saves them; the first `npm start` skips the
  terminal question, opens setup pre-filled, and attaching happens at first
  publish. The plain no-flag installer is unchanged.
- The "Run your identity on this server" flow moved off the signup page to its
  own page at `/run`, served only where a host supplies it (`runPage`).
- First run of `up` records the handle before spawning the agent, so the
  `<handle>.localhost` setup page answers instead of refusing.

## 2026-08-18
- Each server-hosted identity's owner door has its own secret, minted beside
  its signing key; the shared `agentGateToken` setting is gone. Proving pod
  control again mints a fresh secret and retires the old — lost-secret
  recovery with no restart.
- Runtime opt-in: with `agentRuntimeOptIn` on, a pod owner can sign in with
  their pod and the server starts (or stops) an identity for it while
  running — `POST /api/agent`, or "Run your identity on this server" on the
  signup page. Opted-in pods survive a server restart.
- Browser-based Mastodon clients can now sign in, the way any Mastodon server
  serves them: the client API answers any origin, an app registers for its own
  id and secret, and the sign-in screen names what is asking and where the code
  will be sent before you approve it with the password. The authorization code
  is bound to that client's registered address and is not usable until the
  client exchanges it with its secret.
- `agentAutoFront`: when one server runs both the door and its identities,
  each identity gets a `@handle@<frontHost>` address on startup automatically,
  resolving to the identity on its own pod. Off by default.
- Clearing a clogged inbox keeps what matters: `POST /inbox/prune` with
  `keepConcerning` discards the firehose but keeps posts addressed to you,
  mentions, replies to your posts, and people you follow. Follows are applied
  as always.
- Opting a pod in to run on a server accepts only a pod origin root, so on a
  server that hosts several pods on one domain no owner can claim another's.
- Hardening from a security and server-load review: the store transport is
  confined to the pod it acts for, inbound bodies and the inbox listing read
  are size-capped, the live feed caps its connections, the delivery queue has a
  ceiling, and a busy inbox no longer sweeps unpaced. None changes how the
  component is used.
- Stopping the server flushes each identity's state and releases its lease
  before exiting, even under a plain `systemctl stop`.
- The `fedipod-css-gateway` package installs standalone from npm — it ships the
  agent tree it needs and declares its dependencies.
- Opening `http://localhost:8030/` always reaches a configured identity's
  record page (which lists every identity), never an unconfigured agent's
  setup form.

## 2026-08-17
- FediPod runs inside a Community Solid Server, as a component of it. A server
  that already hosts pods can take delivery for them at its own door, and — for
  each pod named in its configuration — run the whole agent: the pod accepts
  follows, delivers posts, empties its inbox and serves its owner's Mastodon
  client on the pod's own address, with no agent process anywhere. Signing keys
  are held by the server, and sign-in needs a password per identity. See
  `packages/css-gateway`.
- One-line install: `curl -fsSL https://fedipod.net/install | sh` — checks
  git and node 20+, clones or updates `~/FediPod` (`FEDIPOD_DIR` overrides),
  installs dependencies, and prints the start command. The script is served
  at `/install` on any gateway deploy and lives at `web/front/install.sh`.
- https served beside http on every agent (port + 1000), with a certificate
  minted per machine; `fedipod https --trust` adds a local CA for clients
  that refuse self-signed certificates.
- The multi-user gateway is live at fedipod.net: signup with Solid-OIDC
  proof of pod control, attach rows in a durable directory. Attaching now
  defaults to inbox-only (`@me@my.pod` identity stays on the pod; only the
  advertised inbox moves); fronted identity sits behind an explicit flag.
- New CLI commands: `gateway` (attach/detach; `front` kept as an alias),
  `keys` (move the signing key between machine and pod), `https`, `import`,
  `alias`, `admit --all`.

## 2026-08-16
- Account migration into FediPod: migration aliases (`alsoKnownAs`),
  auto-accepted follower waves, and a paced importer for Mastodon-format
  CSV exports (follows, blocks, mutes, lists, domain blocks).

## 2026-08-09 / 2026-08-10
- The client-to-server protocol (ActivityPub §6) on the agent: `POST
  /ap/outbox` with Solid-OIDC (DPoP) auth and an owner check.
- Fuller FEP-1b12 for groups: carried posts name the group as `audience`,
  the moderator roster publishes as `attributedTo`, announced moderation to
  members, a carrier's announced Delete honoured, inbound moderation held
  for review.
- FEP-4ccd pending-follow collections and the FEP-c648 blocked collection,
  published owner-only.
- The verify-at-the-door inbox gateway and multi-user front cores.
