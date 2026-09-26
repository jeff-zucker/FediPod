# Files overview

Where each major part of FediPod lives. Written 2026-09-11, after the review
that cleaned up the pod library.

## Shared libraries

| part | where | what it is |
|---|---|---|
| The pod library | `lib/pod/`: `transport.mjs`, `urls.mjs`, `containers.mjs`, `root.mjs`, `discovery.mjs`, `actor.mjs`, `inbox.mjs`, `outbox.mjs`, `collection.mjs`, `followers.mjs`, `following.mjs`, `featured.mjs`, `notes.mjs`, `media.mjs`, `private.mjs`, `notifications.mjs`, `policy.mjs`, `state.mjs`, `http.mjs`, `links.mjs` | every read and write to a Solid pod: one transport with the deny-list and the cooldown, where each document lives, one module per document kind; takes an injected session |
| The account library | `lib/session/`: `fedi-account.mjs`, `fedi-login.mjs`, `oidc-session.mjs` | a person types a Fediverse handle or a WebID, is sent to sign in at their Mastodon server or their pod, and comes back with an account the app can act with: post, timeline, follow, reply, through whichever it is; `web/app/oidc-session.mjs` binds the session engine to FediPod's database name |
| The agent's core | `lib/core/`: `intake/` (index, activity, channel, verify, activities, group, notes), `publisher/` (index, collections, restore, notes, questions), `deliver.mjs`, `social.mjs`, `wire.mjs`, `store.mjs`, `storage.mjs`, `keys.mjs`, `lease.mjs`, `polls.mjs`, `proof.mjs` | drains the inbox and applies each activity, builds and publishes documents, signs and delivers, keeps the JSON state, holds the key and the lease |
| The client face | `lib/client/`: `masto/` (index, oauth, render, instance, accounts, timelines, statuses, media, body), `streaming.mjs`, `webpush.mjs`, `c2s.mjs`, `oidc-auth.mjs`, `localapi.mjs` | the Mastodon API Phanpy talks to, streaming and push, the ActivityPub client-to-server endpoint and its Solid-OIDC check |
| The vendored clients | `phanpy/dist`, `sengi/dist` | Phanpy exactly as upstream built it. Sengi is a FORK: `sengi/PATCHES.md` lists the nine changes and how to rebuild it, and an upgrade that drops them breaks two things silently |
| Connections | `lib/connections/`: `atproto.mjs`, `bskyfeed.mjs`, `bskygroup.mjs`, `fediacct.mjs`, `acctfeed.mjs`, `tagfeed.mjs`, `import.mjs` | Bluesky, other Fediverse accounts, the hashtag feed, CSV import |
| The gateway | `lib/gateway/`: `gateway-core.mjs`, `front-core.mjs`, `httpsig.mjs`, `directory.mjs`, `caches.mjs`, `headers.mjs`, `token-claims.mjs`, `relay-extras.mjs`, `quiet.mjs`, `notices.mjs`, `held-mail.mjs`, `keeper.mjs`, `keeper-due.mjs`, `keeper-session.mjs`, `account-agent.mjs`, `copy.mjs`, `state-api.mjs`, `masto-gateway.mjs` | the door that verifies signatures, the front that serves fronted identities, the directory, accounts that go quiet, notices, mail held while the app is closed, the keeper that keeps a browser account running, the account's working copy and the state API the browser reaches it through, and Mastodon apps and phone notifications at the gateway's address |
| Shared | `lib/shared/`: `safefetch.mjs`, `guard.mjs`, `ua.mjs`, `links.mjs` | the fetch and request guards, the user agent, link headers; used by three or more parts |

## Implementation libraries

| part | where | what it is |
|---|---|---|
| FediPod DeviceAgent | `bin/fedipod.mjs` (the command map), `lib/device/cli/` (context, commands/run, setup, state, service, account), `run-agent.mjs`, `lib/device/`: `admin/` (index, surface, static, server, origins, routes/owner, setup, lifecycle, gateway, social, connections), `setup.mjs`, `account.mjs`, `remote.mjs`, `certs.mjs`, `home.mjs`, `ports.mjs`, `update.mjs`, `migrate.mjs`, `export-collections.mjs`; the pages in `web/admin/` (the record page's script is `common.js`, `record.js`, `actors.js`, `connections.js`, `group.js`, `upkeep.js`, `gateway.js`, loaded in that order) | the CLI, the process, the HTTPS server, setup and the admin pages |
| FediPod BrowserAgent | `web/app/` | the same core in a service worker: sign-up, the pod session, browser keys, the relay, the manage facade, the browser connections |
| FediPod Server | `packages/fedipod-server/src/`, with `lib/server/embed.mjs` | the CSS component: the handler, the store shims, the directory, the streaming handler |
| css-nextgraph | `packages/css-nextgraph/src/`: `accessor.ts`, `router.ts`, `wallets.ts`, `sdk.ts`, `sdk-store.ts`, `pod-store.ts`; `config/`, `bin/css-nextgraph.mjs` | the CSS storage component that keeps each pod in NextGraph under a wallet of its own: the accessor, the `.internal/`-or-pod router, the wallets, the SDK layer, the hand-over command; FediPod Server sits on top of it unchanged |
| FediPod Gateway | `netlify/functions/` (`front`, `inbox`, `account`, `flush-mail`, `keeper-background`, `push-background`), `web/front/`, `web/app-signin/` | thin functions over the edges — deliveries and the front, the routes that act for an account, the fifteen-minute round, a keeper run, a push run — the front's pages, and the page a Mastodon app sends its person to |

## What the BrowserAgent takes from the shared libraries

- **Core**: `intake`, `publisher`, `deliver`, `social`, `wire`, `store`,
  `storage`, `lease` as they are; `polls` indirectly. Not `keys.mjs`, which
  reads PEM files from disk: `web/app/keystore.mjs` and `keys-browser.mjs`
  stand in for it.
- **Client face**: `mastoapi.mjs`, and the client-to-server dispatcher
  (`lib/client/c2s.mjs`) for posts the Gateway's outbox door takes on the
  owner's behalf. No streaming, push, `/ap/outbox` of its own or Solid-OIDC
  verification in the browser.
- **Connections**: all but `bskygroup.mjs`; the browser hosts no groups.
- **Gateway**: none. The browser trusts the gateway's receipt instead of
  verifying signatures, and `safefetch.mjs` is replaced by a shim that keeps
  only the byte budget.
- **Pod library**: `transport`, `containers`, `actor`, `inbox`, `state`
  directly, the rest through the core modules that call them.

Where a Node module is unusable in a browser, the substitute lives in
`web/app/` or `web/app/shims/` with the same interface, so the core does not
know which runtime it is in.
