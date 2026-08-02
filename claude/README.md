# claude/ — Claude-authored artifacts for solid-activitypub

| path | what |
|---|---|
| `smoke-tests/agent-smoke.mjs` | the whole test suite (469 checks): boots an unconfigured agent on a scratch `AP_HOME`, then exercises the gate, the Mastodon facade, keys and signing, the wire and pod-RDF builders, intake, the security guards, every politeness behavior added on 2026-07-29, and (§12–§14) the browser setup flow, the named origin and the editable record. `npm test` runs it. |
| `migration-scripts/` | one-shot repair and teardown tools, kept because each does something no command does. `clear-pod-private-copy.mjs` removes the copy `state --to` leaves on the pod — everything under `ap-state/` except `lease.json` (pinned to the pod on purpose) and `.keep`, plus the whole `fediverse/` tree, and refuses outright if anything there has no local counterpart. `retire-scn-actor.mjs` retires an identity whose own agent cannot (dk's has no retire endpoint; the standalone one wants its state on the pod). `empty-retired-pod.mjs` empties the agent's container and leaves the Tombstone, because CSS has no delete-pod handler at all. Both dry-run unless given `--go`. |
| `backups/` | originals of vendored files patched by hand, e.g. `phanpy-sw-2026-07-29/` (the service worker replaced by a kill-switch). |
| `diagrams/group-actor.mmd` | mermaid: a group actor as a hub that many pods follow, and what travels each link. |
| `diagrams/architecture-relay.svg` | sibling of the root `architecture.svg`, same palette: the same two halves with the private trees moved to a pod on your machine. Read with `plans/pod-as-relay.md`. |
| `plans/identity-layout.md` | every identity is `profiles/<name>/` and the root only points at one — why the old root-is-also-an-identity layout could not name its own default, why the pointer records what you last STARTED rather than something you set, and the `default <name>` command that was built and removed. Includes the handle-as-directory-name hole it surfaced. |
| `plans/never-delete-pod-infrastructure.md` | **standing rule, all projects: a pod's `settings/`, its root `.well-known`, any `.acl`/`.meta`, and its profile are never deletable.** Enforced in code — a DENY-list on `RemotePod.delete`, which every DELETE this project sends passes through, so no script can route around it. Why a deny-list rather than an allow-prefix, and what a crippled pod looks like from outside. |
| `plans/no-regex-rdf.md` | **standing rule, all projects: never parse RDF with a regex — rdflib for reading and writing.** The five places this project used to, now fixed, and the two bugs the port turned up — a listing that read "any URL mentioned" instead of `ldp:contains`, and rdflib taking a datatype as its *second* argument. |
| `plans/pod-as-relay.md` | the pod as a relay: `privateRoot` moves the RDF truth and the operational state to a pod or a directory of your own, the pod keeps only what the protocol forces to be public (plus the lease, pinned deliberately), why the inbox drain now writes before it deletes, why `lib/storage.mjs` is four operations rather than an LDP implementation, and how a machine that is behind the pod catches up — followers, the outbox, and `activitypod rebuild` for your own posts. Diagram: `diagrams/architecture-relay.svg`. |
| `plans/browser-setup.md` | setup moved off the CLI and into a page the agent serves: why the terminal still asks two things, why the agent answers at `<handle>.localhost:<port>`, why `POST /setup` returns 202 rather than holding the response, and how a setup that died after the mint is resumed instead of re-run. |
| `plans/group-actor.md` | why groups are actors rather than tenants, the four hub designs that were dropped (and the CSS component that is **parked, not rejected**), and what is still open. |
| `plans/group-moderation.md` | every lever a group host has — mute, eject, retract, post review, request-to-join — what is structurally impossible, and what is still missing. |
| `plans/parked-lemmy-group-actor.md` | **parked, kept on purpose** — what it would take to interoperate with Lemmy-style communities, and why it was not attempted. |
| `plans/live-test.md` | **the standing to-do for live testing** — what is already verified (do not redo), then a checklist of what is not, with the two riskiest items marked. Also the traps already paid for, and the tear-down order. |
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
- **`drafts/`** is gitignored and holds the security notes plus the superseded
  architecture diagrams (`architecture.png`, `architecture2.png` — the current one
  is `architecture.svg` at repo root); leave it alone.
- **The project was renamed `activitypod-js` → `solid-activitypub` on 2026-07-30.**
  Four strings still say the old name on purpose, frozen until the
  solidcommunity.net incident is resolved — the checklist is at the end of
  `scn-incident-2026-07-29.md`.
