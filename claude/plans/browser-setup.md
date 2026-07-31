# Setup in the browser

Built 2026-07-30. `setup` used to be 160 lines of terminal prompting that ended
by starting the agent and opening a client. Now the terminal asks two things —
the handle and the port — and everything else is asked on a page the agent
serves itself.

## Why two questions and not none

The handle is permanent, and it names the origin the browser is sent to. The
port decides where that origin is. Neither can be asked in the browser, because
there is no browser until both are known. Everything else can.

## The named origin

An agent answers at `<handle>.localhost:<port>` as well as `localhost:<port>`.
That is the whole reason the handle is asked first: a browser keeps storage per
origin, so two identities on one machine stop sharing a Phanpy login and stop
being indistinguishable. `claude/plans/live-test.md` was already telling people
to do this by hand with `AP_ALLOWED_HOSTS`.

`lib/guard.mjs` grew `hostLabel()`, `loopbackAuthorities()` and an
`Authorities` class. The class exists because the set has to be **live**:
`startAdmin` listens before `connect` reads pod state, and `MastoApi`
consults the same object to decide whether an OAuth `redirect_uri` is ours — a
snapshot taken at listen time would refuse the named origin for the life of the
process, and Phanpy could never log in there.

Rules that are not negotiable:

- The label comes from config or the CLI, **never** from a request header.
- Matching is exact-string set membership. Never `endsWith('.localhost')`.
- `.localhost` is RFC 6761 special-use and cannot be delegated in public DNS,
  so widening to it is not the rebinding hole `guard.mjs` exists to close.

Not every browser and resolver maps `*.localhost` to loopback, so the CLI
always prints both URLs and the page is origin-agnostic by construction —
every request it makes is relative.

## Why POST /setup returns 202

The credential a CSS server mints is shown once and cannot be recovered;
losing one destroyed an identity on 2026-07-29 (`scn-incident-2026-07-29.md`).
If a long-held response drove the flow, a closed tab would take it with it. So
the server owns the run, writes `credential.json` (0600) the instant it is
minted, and the page polls `GET /setup/progress`. The durable record is the
file, not the connection.

Three ways in, all computed from the world rather than a state file:

| state | what happens |
|---|---|
| configured | 409 — this home already holds an identity |
| credential, no actor | **resume**: skip account and mint, no password asked |
| neither | full run |

The resume path is the one that matters. A setup that died after the mint used
to be unrecoverable-in-practice: re-running it minted a second credential and
orphaned the first. Now `/setup/state` reports `resumable`, and the CLI's own
refusal says so too.

## Routes

`GET /setup/state`, `POST /setup/check` (pure — the CLI's address preview and
warnings as data), `POST /setup` (202), `GET /setup/progress`, `GET /config`,
`POST /config`. `/setup` and `/setup/check` join `/block` in the set of POSTs
an unconfigured agent answers; `/config` deliberately stays behind that gate
because it touches `agent.publisher`, which does not exist before `connect`.

All three are refused over any host `AP_ALLOWED_HOSTS` added: a tailnet name
may carry the fediverse side, it may not create accounts or edit the record.

`POST /config` merges, never replaces (a partial write once destroyed the UI
password), refuses the permanent keys with a 400 rather than dropping them
silently, and republishes only when a wire key changed.

## The pages

`web/setup/` and `web/admin/`, served at `/setup/` and `/admin/`. Not `ui/`:
that is documented as the drop-in mount for third-party client dists, and
`ui/setup/` would shadow the page — and the group relaxation needs a prefix
nobody is invited to write into.

Inline `<style>`, external `<script src>`. The CSP is `script-src 'self'` plus
hashes taken only from `phanpy/dist/index.html`, so an inline script on our own
page is served, looks fine, and does nothing. §12 asserts the page has none.

`GET /` is keyed on **`credential.json` existing**, never on
`agent.configured()`: a healthy install whose pod is briefly unreachable
reports itself unconfigured for up to an hour, and must not be sent to setup.

## What stayed on the CLI

Everything. `setup` keeps the whole flag-driven path verbatim — any identity
flag, `--cli`, or a non-TTY stdin takes it, which is what `build-dist`'s
unpack-and-go line and the smoke tests use. `stop`, `status`, `profiles`,
`tokens`, `park`, `revive`, `retire`, `rotate-key`, `revoke-credential`,
`install-service` and all 14 group commands are unchanged.

`start` prints both URLs and opens nothing. It briefly did open one, which was
wrong and Jeff said so within the hour: `start` is what supervisors run and
what fires on every restart, so a browser window arrives unasked, repeatedly,
over whatever you were doing. `--open` is the opt-in. `setup` opens one because
that is the whole point of `setup`.

## Known gaps

- `activitypod passwd` still opens its own pod connection and writes
  `config.json` behind a running agent's back — the clobber described in
  `group-moderation.md`. `POST /config` is the fix; the CLI was left pointing
  at the old path.
- Still no `POST /unblock` and no `GET /blocks`, so the admin page has no
  blocklist panel.
- Nothing here has been run against a real CSS. §13 drives the real account API
  and the real mint against a mock; everything past the mint is faked.
