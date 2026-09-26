# web/app — FediPod in the browser

The in-browser build: sign up and run a FediPod account in a tab, no install.
See `claude/plans/browser-agent.md` for the whole design and status.

| file | what |
|---|---|
| `pod-auth.mjs` | A CSS account API client, browser-native: create an account + pod, mint a client credential, and a DPoP-bound `fetch`. Since 1.28.0 the app itself uses none of it — a pod is made on the provider's own page and the app runs on the pod's Solid-OIDC login — but the harnesses do, to make scratch pods and stand in for a login form. The twin of `lib/device/account.mjs` + `vendor/idp-grant.cjs`. |
| `keystore.mjs` | WebCrypto RSA/Ed25519 key generation. The key is stored on the pod as it is, in the owner-only state container, since 1.28.0 (2026-09-22); `unwrapKeys` remains for accounts from before then, whose key is under the sign-up password until it is opened once. |
| `keys-browser.mjs` | Importing a keys record for signing, and finding one: this browser's opened copy in IndexedDB first, else the pod's, read with the pod session. A pre-1.28.0 envelope raises `KeyPasswordNeeded`, which `boot.mjs` answers with the open-once pane; the same pane offers a new key to someone who no longer has that password. |
| `signup.mjs` | The `fedipod setup` flow, in the browser, up to publish, on the pod session the person already holds: pod check, gateway attach, key stored on the pod (owner-only ACL written *before* the key), config. Takes no password and no credential. Also `readAccount` (what the pod already holds) and `moveIn` (an address at another gateway moving here: attach fronted, rewrite the config with the old actor as an alias, restamp the key, leave the Move pending). |
| `gateway-move.mjs` | The pending half of a move, run when the agent goes active under the new ids: tells the old gateway (`/api/move`) and sends the Move to every follower from the old actor, signed under the old key id through the old relay. Safe to run again. |
| `shims/fedify-sig.mjs` | Browser stand-in for `@fedify/fedify/sig` (which will not bundle for a browser). `sign()` returns signed headers as data for the relay; `signRequest()` wraps it Fedify-shaped. Proven byte-identical to Fedify. |
| `shims/node-crypto.mjs` | Browser stand-in for `node:crypto` — the small synchronous slice the agent uses, via crypto-browserify, plus native WebCrypto. |
| `shims/safefetch.mjs` | Browser stand-in for `lib/shared/safefetch.mjs`. Pinning and the private-address checks are unnecessary here (a browser closes DNS rebinding itself); the BYTE BUDGET is not, so `readCapped` streams and stops at the cap exactly as the Node one does. |
| `dist/` | The bundled agent, built by `scripts/build-app.mjs`. Committed like `phanpy/dist`, regenerated on release. (Not present until the agent entry is built.) |

Build: `node scripts/build-app.mjs`. Tests live in `claude/validation/`:
`signup-browser/`, `signing-shim/`, `agent-bundle/`.

## The agent (built 2026-09-07)

| file | what |
|---|---|
| `pod-remote.mjs` | RemotePod over the DPoP session — the agent's pod I/O, ACLs and deletion deny-list, browser-native. |
| `keys-browser.mjs` | Load the signing key into WebCrypto. |
| `deliver-relay.mjs` | lib's Deliverer, sending through the relay (a browser cannot set Date/Host). |
| `agent.mjs` | Wires lib's store, publisher, intake and Mastodon facade with the browser edges. |
| `sw-src.mjs` | The service worker that hosts the agent and answers the facade (Mastodon paths + the owner/manage paths); static files fall through. Built to `dist/sw.js`. |
| `boot.mjs` | Page side: sign in at the pod (also the first half of sign-up), the identity screen on the way back, sign in by address, register the worker, route into `/admin/client/`; `?signout` / `?add` teardown. Built to `dist/boot.js`. |
| `shims/` | Browser stand-ins the bundle needs: `node-crypto`, `node-path`, `node-url`, `node-fs`, `web-push`, `safefetch`, `prelude` (process + Buffer). |

## The manage surface & connected accounts (built 2026-09-08)

The owner's record/manage page is the SAME `web/admin` UI the Node agent serves,
reused as static files under `/admin/` (staged by `scripts/stage-site.mjs`); the
worker answers the data endpoints it calls. See
`claude/plans/browser-manage-surface.md` for the whole design and status, and
`claude/plans/post-as-connected-account.md` for the deferred "post as" plan.

| file | what |
|---|---|
| `admin-facade.mjs` | Answers the owner/manage endpoints (`/status`, `/config`, `/gateway`, `/alias`, `/rotate-key`, `/rebuild`, `/move`, `/retire`, `/inbox/prune`, `/deadletter`, `/blocks`, `/atproto*`, `/fediacct*`) over the browser agent, mirroring `lib/device/admin.mjs`. Personal only. |
| `atproto-browser.mjs` | The Bluesky connection (`lib/connections/atproto.mjs`) with a per-connection storage choice — IndexedDB (this browser) or owner-only pod state — plus pause. |
| `fediacct-browser.mjs` | Connections to fediverse accounts on other servers (`lib/connections/fediacct.mjs`): the OAuth dance, the same storage choice, and a best-effort server-side revoke on disconnect. |
| `idb-kv.mjs` | The per-origin IndexedDB key/value store the two connectors use for "on this device, never the pod" credentials. |

`agent.mjs` also holds the single-active-agent **lease** (`lib/core/lease.mjs`) — a
second device runs read-only until it takes over — and starts the drain/mirrors
only when it is the active holder.

Build: `node scripts/build-app.mjs --entry web/app/sw-src.mjs --out web/app/dist/sw.js` and `--entry web/app/boot.mjs --out web/app/dist/boot.js`, then `node scripts/stage-site.mjs` to assemble `web/app/site/` (the front, the worker, Phanpy under `/app/`, and `web/admin` under `/admin/`).

Tests: `claude/smoke-tests/admin-facade-smoke.mjs`, and eight harnesses in
`claude/validation/browser-agent/` that drive a real Chrome against a scratch
Solid server — `run` (the agent and the facade), `sw-run` (the same through the
service worker, plus media upload and notification paging), `full-run` (the
staged site, sign-up to Phanpy rendering), `unlock-run` (a browser with no opened
key, and a pre-1.28.0 account opened once), `oidc-run`, `resume-run`,
`gateway-run`, and `provider-csp-run` (the sign-up page's own policy, read from
the browser's refusal reports). Four helpers sit beside them: `idp-login.mjs`
fills the pod's login and consent screens, `page-signup.mjs` drives the page
through sign-up the way a person does since 1.28.0 (pod first, then the pod's
login, then the identity screen), `worker-log.mjs` reads the agent's console
out of the service worker, and the attach and relay stubs in `sw-run.mjs` stand
in for the front.

## What this build does not have

Declared rather than pretended: each is omitted from the instance document, so
a client hides the control instead of offering one that quietly does nothing.
See the `MastoApi` options in `agent.mjs`.

| | why |
|---|---|
| **Streaming** | a service worker answers fetches, not sockets. No streaming URL is advertised, so clients poll. |
| **Web push** | `shims/web-push.mjs` is a no-op. `vapid` is omitted, and a client that subscribes anyway gets a 422 rather than a subscription nothing will push to. |
| **Scheduled posts** | nothing runs between now and the scheduled time. A `scheduled_at` is refused with a 422 that says so — accepting one was silent loss. |
<!-- CLAUDE 2026-09-25 — the row above now holds only while the gateway does not keep the account running; replace it with this; delete these markers when done -->
| **Scheduled posts** | only while the gateway keeps the account running (`setKeeper`), because then something is running when the time comes: the app publishes what falls due while it is open, the gateway's keeper while it is closed. Otherwise a `scheduled_at` is refused with a 422 that says so — accepting one was silent loss. |
<!-- /CLAUDE -->
| **Groups** | sign-up makes personal identities only (`signup.mjs`), and the moderation surface is not here. Joining a group works; hosting one needs the DeviceAgent. See `groups.md`. |
| **Changing where the address lives** | the shape is chosen at sign-up (`signup.mjs`): on the pod, `@you@yourpod` with the gateway as a mail door, or at the gateway, `@you@front` — and a suffixed pod is always fronted. `admin-facade.mjs` refuses changing it afterwards, because a rename needs a restart a browser does not have. |
| **Moving the private half** | `/state-move` is about filesystem paths and `credential.json`. A browser has neither; its private half is always on the pod. |
