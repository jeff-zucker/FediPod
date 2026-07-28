# ui/ — additional web clients

Drop any static Mastodon web client dist here as `ui/<name>/` and the agent
serves it at `http://localhost:8030/<name>/`, same-origin with the API —
no CORS, no mixed content. Phanpy stays at `/`.

Known-good candidates: Enafore (Pinafore successor), Soapbox — anything
that ships as a plain static `dist/` folder. (Elk does not fit: it is
server-rendered, not static.)

One patch is usually needed: most clients hardcode `https://${instance}`
when building API URLs. Replace those construction sites with
`${location.protocol}//${instance}` — see data-kitchen's
`claude/backups/*.pre-http-patch` files for how this was done for Phanpy.

After adding a client, watch `~/.activitypod/agent.log` while using it:
every API endpoint it needs that the facade lacks is logged as an
`unhandled` line — that list is the to-do for full support.
