# FediPod — skills

The facts of this repository, for whoever works on the code. How to work
with Jeff is in `~/.claude/jeff-skills.md`; that file wins where the two
overlap. The public docs are `README.md` (the browser version, for the
person using it), `gateway.md`, `gui.md`, `architecture.md`,
`files-overview.md` (the map of every folder) and `specs-in-use.md`.

## What it is

A Fediverse account whose data lives on the person's Solid pod. The pod
holds the public record (actor, outbox, followers, posts, inbox) and the
private trees under access control; the agent does the ActivityPub work
(drains the inbox, builds the timeline, signs and delivers, answers the
Mastodon client API). FediPod has four builds, always called by these names:
**BrowserAgent**, **Gateway**, **Server**, **DeviceAgent**. This file is about
the first two, which together are fedipod.net.

## The BrowserAgent (`web/app/`)

- The agent runs in a service worker (`sw-src.mjs`, built to `dist/sw.js`)
  and answers the Mastodon API to a client in the same tab; `boot.mjs`
  (`dist/boot.js`) is the page side: sign-in at the pod, sign-up, the
  identity screen, registering the worker. Everything else in the folder is
  a browser edge for the shared core (`lib/core`, `lib/pod`, `lib/client`,
  `lib/connections`); `shims/` stand in for Node modules. The core never
  knows which runtime it is in.
- Two clients, both served by fedipod.net: Sengi (default, a FORK —
  `sengi/PATCHES.md` lists the patches to re-apply on any upgrade) and
  Phanpy (`phanpy/dist`, as upstream built it).
- The manage page is `web/admin/`, the same pages the DeviceAgent serves,
  reused as static files; `admin-facade.mjs` answers its data calls.
- Sign-up makes personal accounts only; no groups in the browser. A pod on
  a **suffixed** host (`host/name/`) is always fronted: the address is
  `@name@fedipod.net`. A pod on a **subdomained** host chooses at sign-up
  between `@name@yourpod` (the gateway is only the mail door) and
  `@name@fedipod.net`. The choice cannot be changed afterwards. Say
  "suffixed" and "subdomained"; never "shared host" or "path host".
- The signing key is stored on the pod as it is, in the owner-only state
  container, with an opened copy in this browser's IndexedDB. There is no
  password on fedipod.net.
- One active agent per account: the lease (`lib/core/lease.mjs`), 15
  minutes, renewed while the worker lives. A second browser runs read-only
  until it takes over. A worker restart keeps the same holder id.
- The worker is restarted by the browser whenever a client checks for
  posts, about once a minute; anything that runs at start must be cheap or
  remembered (`warm-start.mjs`, `copy-mode.mjs`).

## The Gateway (`netlify/functions/`, `lib/gateway/`, `web/front/`, `web/app-signin/`)

Six functions on Netlify, thin adapters around plain Node in `lib/gateway/`:

| function | what it does |
|---|---|
| `front` | WebFinger, every fronted public face, sign-up and attach, the directory, notices, the outbox door, held mail, the keeper switch; a delivery to a browser account |
| `inbox` | the one-person door (a DeviceAgent behind a gateway) |
| `account` | the routes that act for an account: the browser reaching its copy (`/api/state/*`) and Mastodon apps (`/oauth/*`, `/api/v1/*`, `/api/v2/*`, `/api/authorize`); `front` leaves these paths to it |
| `flush-mail` | every fifteen minutes: held mail to pods in batches, copies written to pods, kept accounts with work due handed to the keeper |
| `keeper-background` | one kept account's run, started only by `flush-mail` |
| `push-background` | one account's held mail read into its copy and each notification pushed to its phones |

- **Forum support is a switch**: `netlify/forum-support.mjs` is the one file
  that names the forum's gateway module (`packages/fedipod-bb/src/gateway.mjs`)
  or exports null; nothing in `lib/gateway/` or `netlify/functions/` imports
  the forum. With it, a forum row with `keeper` set is placed at the door as a
  post lands and run by `keeper-background`; without it, a forum delivery goes
  to the forum's pod inbox and stops there.

- An account is a row in the Netlify Blobs store `directory`, keyed by
  handle (fronted) or `handle@podhost`. `openedAt` means it is a browser
  account and when its owner was last there; `keeper` means fedipod.net
  keeps it running; `movedTo` and `closedAt` end it; `kind` is `person`,
  `group` or `application` (the forum). Read one with
  `netlify blobs:get directory <key>`.
- **Kept running**: the owner's rules name fedipod.net's own pod identity
  (the four `FEDIPOD_KEEPER_*` variables; the steps are in
  `claude/keeper-setup.md`, local only). The account's state documents then
  live in a working copy (store `state`, strong consistency) that the
  browser, the keeper and Mastodon apps all work from; the round writes it
  to the pod. The signing key, the pod lease and connected-account passwords
  never enter the copy. Turning keeping off gives the copy back first.
- **Mastodon apps** sign in at `/app-signin/` (a Fediverse address or a
  WebID, proved by the pod's own login); apps, codes and token hashes are in
  the store `masto`, with the one VAPID pair. Held mail is `mail`, presence
  `present`, the keeper's due-times `keeper`, deliveries counted for quiet
  accounts `received`, notices `notices`.
- While the app is open it says so every five minutes (`/api/here`) and mail
  goes straight to the pod; closed, mail is held and batched.
- The edge holds documents ten minutes (stale served forty more), WebFinger
  an hour, 404s two minutes, 410s an hour, media a day. `front` logs one line
  per request; read them with
  `netlify logs --source functions --function <name> --since 1h`.
- Netlify realities the code lives with: functions ship with `node_modules`
  unbundled, so nothing vendored may `require()` an ES-module-only package
  (use `import()`); a file of this repo is packed into the function, a bare
  package name is not, so the forum's own `fedipod/...` imports ride along as
  loose files (a second copy of what the front packs in, about 77 files); `export const config` is read from source without
  running it, so it must be a literal; nothing reads a file at module load
  without a fallback; new variable values reach functions only at a deploy.

## Commands

```
npm test                      the whole suite, the browser rigs included (headless
                              google-chrome against a scratch CSS, about eight
                              minutes more); it restages web/app/site, so never
                              deploy while it runs
node scripts/check-netlify-bundles.mjs
                              the pre-deploy gate: builds the functions as Netlify
                              ships them and sends requests through each under
                              Netlify's Node rules; deploy only on "all green"
npm run build:app             the worker and the page; npm run stage assembles web/app/site
node scripts/check-sizes.mjs  no runtime file over 1,000 lines (front-core.mjs is at it:
                              new routes go in sibling modules)
```

The deploy is the ONE command below, run by Jeff (auto mode refuses it),
never a bare `netlify deploy --prod`, which publishes `web/front` alone and
removes the BrowserAgent from fedipod.net:

```
cd /home/jeff/Dropbox/Web/solid/FediPod && node scripts/check-netlify-bundles.mjs && node scripts/stage-site.mjs && netlify deploy --prod --dir=/home/jeff/Dropbox/Web/solid/FediPod/web/app/site --functions=/home/jeff/Dropbox/Web/solid/FediPod/netlify/functions
```

The command copies `web/app/dist/` as committed and never rebuilds it: after
a change under lib/ that the browser runs, `npm run build:app`, commit the
two bundles by path, run the suite (the rigs test the rebuilt bundles),
then deploy. A deploy taken with a stale dist ships the old worker silently.

Afterwards curl `/app/`, `/admin/client/`, `/sw.js` and `/app-signin/` for
200, and `/build.json` for the version. Each deploy costs 15 Netlify credits
(Personal plan): never raise deploying, give the per-build summary in
user-experience terms when he does, and list any change built but deferred
(the memory `undeployed-changes`). `npm publish --ignore-scripts` is his too,
after green suites, from a folder that is exactly what should go out.

Browser rigs: `claude/validation/browser-agent/` drives a real headless
`google-chrome` against a scratch Solid server (`copy-browser-run.mjs` is
the copy, an app sign-in, a push and the keeper handover). `all.mjs` runs
every rig in turn and is the last step of `npm test`, so a rig that breaks
fails the suite. The scratch server is the Server package's CSS and scans
that package as a component module on start, so `npm ci` and `npm run
build` in `packages/fedipod-server` come first, on a clone and in CI; the
runner refuses at once when they have not. A scratch pod is given a public type index first
(`pod-fixture.mjs`), as a person's pod has one; the rigs never script the
yes the page asks for. The in-app browser pane cannot register service
workers, so those never run there.

## Rules the code holds to

- ActivityStreams 2.0 terms need no asking; any other vocabulary
  (`toot:`, `schema:`, `foaf:`, FEP contexts) and any new HTML attribute
  is asked about first.
- RDF is read and written with rdflib, never a regex. A profile or type
  index is changed by N3 PATCH where the server takes it, and only if the
  result still parses.
- Every DELETE to a pod passes a deny-list: a pod's `settings/`, its root
  `.well-known`, any `.acl` or `.meta`, and the profile are never deleted.
- Nothing under `lib/device/` is a package entry, and no shared folder
  imports from it (`scripts/check-pod-calls.mjs`).
- A label never claims more than the code enforces; user-facing text says
  what the person sees, in plain sentences; Fediverse is capitalized.

## The other builds, in short

- **Server** (`packages/fedipod-server/`): the agent and the Gateway's front
  inside a Community Solid Server, importing `fedipod` by name. Its own
  `skills.md` is there. A local one runs on this machine on port 443.
- **FediPod BB** (`packages/fedipod-bb/`): the forum, live at
  bb.fedipod.net/forum/, importing `fedipod` by name. Since 2026-09-29 the
  live forum is kept by fedipod.net (`src/gateway.mjs`: placed at the door,
  run by `keeper-background`); nothing runs it on this machine, the old unit
  `fedipod-fedipod-bb1` is stopped and disabled and must stay so. A forum
  change reaches the live forum through a fedipod.net deploy.
- **DeviceAgent** (`bin/fedipod.mjs`, `lib/device/`, `run-agent.mjs`):
  deprecated. Every off-pod agent sits behind a Gateway; nothing new is
  built for it, and it is never described as running on its own.
