# claude/ — Claude-authored artifacts for activitypod-js

| path | what |
|---|---|
| `smoke-tests/agent-smoke.mjs` | the whole test suite (194 checks): boots an unconfigured agent on a scratch `AP_HOME`, then exercises the gate, the Mastodon facade, keys and signing, the wire and pod-RDF builders, intake, the security guards, and every politeness behaviour added on 2026-07-29. `npm test` runs it. |
| `backups/` | originals of vendored files patched by hand, e.g. `phanpy-sw-2026-07-29/` (the service worker replaced by a kill-switch). |
| `diagrams/group-actor.mmd` | mermaid: a group actor as a hub that many pods follow, and what travels each link. |
| `plans/group-actor.md` | why groups are actors rather than tenants, the four hub designs that were dropped (and the CSS component that is **parked, not rejected**), and what is still open. |
| `plans/group-moderation.md` | what a group host can and cannot do, and the three capabilities still to add: eject a member (needs a decision on `Reject`), retract an announcement, hold for review. |
| `identities.md` | one identity per home, profiles, per-actor keys, groups (`setup --group`), and the park/move/retire lifecycle with the reasoning behind each choice. |
| `scn-incident-2026-07-29.md` | solidcommunity.net's retry-storm report, what was ours, what was not, and every change made in response. Read this before replying to their operators. |

## Not here

- **The local dev pod lives in `~/css`**, not in this repo — it is a general-purpose
  subdomain-authed CSS on `:4000` over its own root, useful to any project.
  Start it with `~/css/pivot-4000.sh`; it borrows the CSS build from
  data-kitchen's `pivot/node_modules` via `NODE_PATH`.
- **`README.md` may be edited**, but every change must be marked in the file —
  fence additions with `<!-- CLAUDE <date> … -->` / `<!-- /CLAUDE -->` so Jeff can
  rework or drop them by hand. Add alongside his prose; never silently reword it.
  (Superseded the older "suggestions go in a reply" rule on 2026-07-30; the
  standing version lives in the global CLAUDE.md.)
- **`drafts/`** is gitignored and holds the security notes; leave it alone.
