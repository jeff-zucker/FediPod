# claude/ — Claude-authored artifacts for activitypod-js

| path | what |
|---|---|
| `smoke-tests/agent-smoke.mjs` | the whole test suite (133 checks): boots an unconfigured agent on a scratch `AP_HOME`, then exercises the gate, the Mastodon facade, keys and signing, the wire and pod-RDF builders, intake, the security guards, and every politeness behaviour added on 2026-07-29. `npm test` runs it. |
| `backups/` | originals of vendored files patched by hand, e.g. `phanpy-sw-2026-07-29/` (the service worker replaced by a kill-switch). |
| `scn-incident-2026-07-29.md` | solidcommunity.net's retry-storm report, what was ours, what was not, and every change made in response. Read this before replying to their operators. |

## Not here

- **The local dev pod lives in `~/css`**, not in this repo — it is a general-purpose
  subdomain-authed CSS on `:4000` over its own root, useful to any project.
  Start it with `~/css/pivot-4000.sh`; it borrows the CSS build from
  data-kitchen's `pivot/node_modules` via `NODE_PATH`.
- **`README.md` is Jeff's.** Suggested additions go in a reply, not into the file.
- **`drafts/`** is gitignored and holds the security notes; leave it alone.
