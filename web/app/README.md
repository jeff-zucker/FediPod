# web/app — FediPod in the browser

The in-browser build: sign up and run a FediPod account in a tab, no install.
See `claude/plans/browser-agent.md` for the whole design and status.

| file | what |
|---|---|
| `pod-auth.mjs` | The pod side of sign-in, browser-native: create a CSS account + pod, mint a client credential, and a DPoP-bound `fetch` that writes to the pod. The twin of `lib/account.mjs` + `vendor/idp-grant.cjs`. |
| `keystore.mjs` | WebCrypto RSA/Ed25519 key generation, and wrapping the keys under the account password (PBKDF2-SHA256 + AES-GCM-256). The pod holds only the wrapped form, so the pod's host cannot sign as you. |
| `keys-browser.mjs` | Importing a keys record for signing, and finding one: this browser's opened copy in IndexedDB first, else the pod's. A wrapped one the browser has not opened yet raises `KeyPasswordNeeded`, which `boot.mjs` answers with the unlock pane — once per browser. |
| `signup.mjs` | The `fedipod setup` flow, in the browser, up to publish: account, pod, credential, keys locked on the pod (owner-only ACL written *before* the key). Produces the credential/keys/config shapes the agent already reads. |
| `shims/fedify-sig.mjs` | Browser stand-in for `@fedify/fedify/sig` (which will not bundle for a browser). `sign()` returns signed headers as data for the relay; `signRequest()` wraps it Fedify-shaped. Proven byte-identical to Fedify. |
| `shims/node-crypto.mjs` | Browser stand-in for `node:crypto` — the small synchronous slice the agent uses, via crypto-browserify, plus native WebCrypto. |
| `shims/safefetch.mjs` | Browser stand-in for `lib/safefetch.mjs`. Pinning and the private-address checks are unnecessary here (a browser closes DNS rebinding itself); the BYTE BUDGET is not, so `readCapped` streams and stops at the cap exactly as the Node one does. |
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
| `boot.mjs` | Page side: sign up / sign in, register the worker, hand it the boot material, route into `/admin/client/`; `?signout` / `?add` teardown. Built to `dist/boot.js`. |
| `shims/` | Browser stand-ins the bundle needs: `node-crypto`, `node-path`, `node-url`, `node-fs`, `web-push`, `safefetch`, `prelude` (process + Buffer). |

## The manage surface & connected accounts (built 2026-09-08)

The owner's record/manage page is the SAME `web/admin` UI the Node agent serves,
reused as static files under `/admin/` (staged by `scripts/stage-site.mjs`); the
worker answers the data endpoints it calls. See
`claude/plans/browser-manage-surface.md` for the whole design and status, and
`claude/plans/post-as-connected-account.md` for the deferred "post as" plan.

| file | what |
|---|---|
| `admin-facade.mjs` | Answers the owner/manage endpoints (`/status`, `/config`, `/gateway`, `/alias`, `/rotate-key`, `/rebuild`, `/move`, `/retire`, `/inbox/prune`, `/deadletter`, `/blocks`, `/atproto*`, `/fediacct*`) over the browser agent, mirroring `lib/admin.mjs`. Personal only. |
| `atproto-browser.mjs` | The Bluesky connection (`lib/atproto.mjs`) with a per-connection storage choice — IndexedDB (this browser) or owner-only pod state — plus pause. |
| `fediacct-browser.mjs` | Connections to fediverse accounts on other servers (`lib/fediacct.mjs`): the OAuth dance, the same storage choice, and a best-effort server-side revoke on disconnect. |
| `idb-kv.mjs` | The per-origin IndexedDB key/value store the two connectors use for "on this device, never the pod" credentials. |

`agent.mjs` also holds the single-active-agent **lease** (`lib/lease.mjs`) — a
second device runs read-only until it takes over — and starts the drain/mirrors
only when it is the active holder.

Build: `node scripts/build-app.mjs --entry web/app/sw-src.mjs --out web/app/dist/sw.js` and `--entry web/app/boot.mjs --out web/app/dist/boot.js`, then `node scripts/stage-site.mjs` to assemble `web/app/site/` (the front, the worker, Phanpy under `/app/`, and `web/admin` under `/admin/`). Tests: `claude/validation/browser-agent/` (run.mjs, sw-run.mjs) and `claude/smoke-tests/admin-facade-smoke.mjs`.

## What this build does not have

Declared rather than pretended: each is omitted from the instance document, so
a client hides the control instead of offering one that quietly does nothing.
See the `MastoApi` options in `agent.mjs`.

| | why |
|---|---|
| **Streaming** | a service worker answers fetches, not sockets. No streaming URL is advertised, so clients poll. |
| **Web push** | `shims/web-push.mjs` is a no-op. `vapid` is omitted, and a client that subscribes anyway gets a 422 rather than a subscription nothing will push to. |
| **Scheduled posts** | nothing runs between now and the scheduled time. A `scheduled_at` is refused with a 422 that says so — accepting one was silent loss. |
| **Groups** | sign-up makes personal identities only (`signup.mjs`), and the moderation surface is not here. Joining a group works; hosting one needs the installed agent. See `groups.md`. |
| **A fronted `@you@front` handle** | the browser model is `@you@yourpod` with the gateway as a mail door. `admin-facade.mjs` refuses a fronted attach, and `stage-site.mjs` hides the radio that offered it. |
| **Moving the private half** | `/state-move` is about filesystem paths and `credential.json`. A browser has neither; its private half is always on the pod. |
