# ui/ — additional web clients

Drop any static Mastodon web client dist here as `ui/<name>/` and the agent
serves it at <!-- CLAUDE 2026-08-19 — was http://localhost:8030/<name>/ -->`https://<handle>.localhost:9030/<name>/`<!-- /CLAUDE -->, same-origin with the API —
no CORS, no mixed content. Phanpy stays at `/`.

`/admin/` is taken: that is the agent's own surface — the record at `/admin/`,
first-run setup at `/admin/setup/`<!-- CLAUDE 2026-08-19 — the third page -->, the framed client view at
`/admin/client/`<!-- /CLAUDE --> — served from `web/` rather than from here,
so a dist dropped in as `ui/admin/` would never be reached.

Known-good candidates: Enafore (Pinafore successor), Soapbox — anything
that ships as a plain static `dist/` folder. (Elk does not fit: it is
server-rendered, not static.)

One patch is usually needed: most clients hardcode `https://${instance}`
when building API URLs. Replace those construction sites with
`${location.protocol}//${instance}` so the client works over <!-- CLAUDE 2026-08-19 — was "the agent's http origin" -->whichever of
the agent's origins it is opened on<!-- /CLAUDE -->.

After adding a client, watch `~/.fedipod/profiles/<name>/agent.log` while using it:
every API endpoint it needs that the facade lacks is logged as an
`unhandled` line — that list is the to-do for full support.
