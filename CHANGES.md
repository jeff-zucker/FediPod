# Changes

## 2026-08-18
- Each server-hosted identity's owner door has its own secret, minted beside
  its signing key; the shared `agentGateToken` setting is gone. Proving pod
  control again mints a fresh secret and retires the old — lost-secret
  recovery with no restart.
- Runtime opt-in: with `agentRuntimeOptIn` on, a pod owner can sign in with
  their pod and the server starts (or stops) an identity for it while
  running — `POST /api/agent`, or "Run your identity on this server" on the
  signup page. Opted-in pods survive a server restart.

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
