# Running the gateway on Netlify

What a gateway is, and how someone attaches their pod to one, is in
[gateway.md](../gateway.md). This is the deployment: what is here, and what a
host has to set.

A reference deployment runs at **https://fedipod.net/**.

## What is here

Both functions are thin adapters around FediPod's own logic, which is plain
runtime-agnostic Node:

| File | What it serves | Around |
|---|---|---|
| `functions/inbox.mjs` | One person's door: verify a delivery, forward it to their pod. | `lib/gateway-core.mjs` |
| `functions/front.mjs` | A door for many people: WebFinger, each public face, per-person delivery routing, and the signup and attach flow. | `lib/front-core.mjs` |

Another host needs only its own adapter calling the same `handleDelivery`. A
Community Solid Server can run the same door as a component of itself instead
— see [packages/fedipod-server](../packages/fedipod-server/README.md).

The front also serves the installer at `/install`
(`curl -fsSL https://<host>/install | sh`) and the vendored sign-in bundle.
The `/run` page is served too, but opting in to being run is answered only on
a pod server — on Netlify the form's submit is refused.

## Deploying

This repo, with `netlify.toml` as it stands. The functions read these
environment variables:

| Variable | What it is |
|---|---|
| `FEDIPOD_FRONT_HOST` | The host the door answers on. |
| `FEDIPOD_FRONT_ORIGIN` | Its origin. |
| `FEDIPOD_GATEWAY_WEBID` | The WebID stamped on verification receipts. |
| `FEDIPOD_ADMIN_WEBID` | The WebID allowed to use the roster at `/admin`. <!-- CLAUDE 2026-08-31 new row --> |
| `FEDIPOD_DIRECTORY_JSON` | The starting directory, as JSON: which handles exist and which pod each belongs to. |

Attachments people make through the signup page are kept in a Netlify Blobs
store named `directory`, and take precedence over the rows in
`FEDIPOD_DIRECTORY_JSON`.

<!-- CLAUDE 2026-08-31 — the roster page; delete these markers when done -->
The `/admin` page lists every account the front answers for and can remove
one: the row is dropped and the name stops resolving, with nothing on the
user's pod touched. Reading or removing requires signing in as
`FEDIPOD_ADMIN_WEBID`. Rows from `FEDIPOD_DIRECTORY_JSON` can only be
removed by editing that variable and redeploying.
<!-- /CLAUDE -->

That table is the front's. `functions/inbox.mjs` — the one-person door —
reads its own set:

| Variable | What it is |
|---|---|
| `FEDIPOD_POLICY_URL` | The pod's `ap/gateway-policy.json`. Required — without it every delivery is refused. |
| `FEDIPOD_INBOX_URL` | The pod inbox deliveries are forwarded into. |
| `FEDIPOD_APPEND_TOKEN` | The bearer token the door writes with. |
| `FEDIPOD_HMAC_SECRET` | Stamps the verification receipts. |

The front also reads `FEDIPOD_DIRECTORY_URL` — a URL serving the same JSON as
`FEDIPOD_DIRECTORY_JSON`, which must live off this deploy's own origin — and
`FEDIPOD_OFFERS_PODS=1`, which offers pod creation on the signup page.
`FEDIPOD_FRONT_HOST` and `FEDIPOD_FRONT_ORIGIN` are required.

## What the door needs from a pod

Permission to write into that person's inbox, and nothing else. FediPod's
default inbox is public-Append, in which case the door needs no credential at
all and writes with a plain PUT. Where an inbox is closed, give the door's own
low-privilege WebID Append on it — never an owner credential.
The credential is a bearer token: the front takes it from the directory row's
`appendToken` field, the one-person door from `FEDIPOD_APPEND_TOKEN`.

The door holds no signing key, so it cannot post as anyone. It reads only
public data to decide what concerns a given person: their published followers
and following, and a small public policy document their agent writes with a
mirror of their blocklist.
The front reads that policy document from each person's pod, cached for a few
minutes so a delivery flood is not a read per delivery. Until an agent has
published one — the row is written before the agent runs — the door filters on
addressing alone.

## The two shapes of attachment

Most people keep their identity on their own pod and move only the advertised
inbox to the door, so they stay `@me@their.pod` and the door is just mail
handling. A person can instead take a handle on the door's own domain, which
makes their public addresses read `@name@this-host` while their data stays on
their pod; that mode is chosen explicitly, per person, at attach time.
