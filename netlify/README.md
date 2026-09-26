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
| `functions/inbox.mjs` | One person's door: verify a delivery, forward it to their pod. | `lib/gateway/gateway-core.mjs` |
| `functions/front.mjs` | A door for many people: WebFinger, each public face, per-person delivery routing, and the signup and attach flow. | `lib/gateway/front-core.mjs` |
| `functions/account.mjs` | The routes that act for an account: the owner's browser reaching the account's working copy (`/api/state/…`), and Mastodon apps signing in and working here (`/oauth/…`, `/api/v1/…`, `/api/v2/…`, `/api/authorize`). `front.mjs` leaves these paths to it. | `lib/gateway/state-api.mjs`, `lib/gateway/masto-gateway.mjs` |
| `functions/push-background.mjs` | One kept account's held mail read into its copy, and each notification that makes pushed to the phones and browsers its owner signed up. Started by the door when it holds a delivery that becomes a notification. | `lib/gateway/masto-gateway.mjs` |
| `functions/flush-mail.mjs` | Every fifteen minutes: mail held for browser accounts whose apps are closed goes to their pods in batches, and a kept account with work due (a follow, a delivery to try again, a scheduled post) is handed to the keeper. | `lib/gateway/held-mail.mjs` |
| `functions/keeper-background.mjs` | One kept account's run: its mail delivered and read, its waiting deliveries sent, its scheduled posts published. Started only by `flush-mail`. | `lib/gateway/keeper.mjs` |

Another host needs only its own adapter calling the same `handleDelivery`. A
Community Solid Server can run the same door as a component of itself instead
— see [packages/fedipod-server](../packages/fedipod-server/README.md).

The front also serves the installer at `/install`
(`curl -fsSL https://<host>/install | sh`) and the vendored sign-in bundle.
The `/.fediverse-account` page is served too, but opting in to being run is answered only on
a pod server — on Netlify the form's submit is refused.

## Deploying

This repo, with `netlify.toml` as it stands. Before each deploy, run
`node scripts/check-netlify-bundles.mjs`: it builds the functions the way
Netlify ships them and sends requests through each one from its own bundle,
under the rules Netlify's Node keeps. Deploy only when it ends "all green".

The functions read these environment variables:

| Variable                | What it is                                                                          |
|-------------------------|-------------------------------------------------------------------------------------|
| `FEDIPOD_FRONT_HOST`    | The host the door answers on.                                                       |
| `FEDIPOD_FRONT_ORIGIN`  | Its origin.                                                                         |
| `FEDIPOD_GATEWAY_WEBID` | The WebID stamped on verification receipts.                                         |
| `FEDIPOD_ADMIN_WEBID`   | The WebID allowed to use the roster at `/roster`.                                   |
| `FEDIPOD_DIRECTORY_JSON` | The starting directory, as JSON: which handles exist and which pod each belongs to. |

Attachments people make through the signup page are kept in a Netlify Blobs
store named `directory`, and take precedence over the rows in
`FEDIPOD_DIRECTORY_JSON`. Mail held while an app is closed is in the `mail`
store, when each app last said it was open in `present`, and what each kept
account has waiting in `keeper`. A kept account's working copy is in `state`,
and the apps signed in here, with their codes and tokens (as hashes), in
`masto`, with the one push key pair the gateway makes for all its accounts
the first time an app asks; both are read with strong consistency. The round writes each copy to
its pod. The page an app sends its person to is `/app-signin/`.

To keep browser accounts running while their apps are closed, the front needs
a pod account of its own, on a Community Solid Server, with a client credential
made for it:

| Variable | What it is |
|---|---|
| `FEDIPOD_KEEPER_WEBID` | The WebID of the gateway's own pod account. Owners' apps name it in the access rules on their FediPod folders. |
| `FEDIPOD_KEEPER_ISSUER` | That account's identity provider. |
| `FEDIPOD_KEEPER_CLIENT_ID` | The client credential's id. |
| `FEDIPOD_KEEPER_CLIENT_SECRET` | Its secret. It also signs the runs `flush-mail` starts. |

Without them the manage page does not offer it, and a client cannot schedule
posts.

To change to a different pod account, set the four variables to the new one's
values. Each kept account moves over the next time its owner opens FediPod:
their browser writes the account's working copy to their pod, names the new
identity in its access rules instead of the old, and a new copy is made. Until
then the gateway leaves that account alone, and an app using it is told to
open FediPod once. The old account's login is not needed for the change.


The `/roster` page lists every account the front answers for and can remove
one: the row is dropped and the name stops resolving, with nothing on the
user's pod touched. Reading or removing requires signing in as
`FEDIPOD_ADMIN_WEBID`. Rows from `FEDIPOD_DIRECTORY_JSON` can only be
removed by editing that variable and redeploying.

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
