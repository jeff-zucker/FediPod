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

`web/admin/`, served at `/admin/`: the record at `/admin/`, first-run setup at
`/admin/setup/`, and room for the rest — group management next. Moved under one
mount on 2026-07-31, because setup is one admin section rather than a peer of
the whole admin surface. The JSON API stayed flat (`/setup/state`,
`POST /setup`, beside `/status` and `/config`), which is how the rest of the
admin API already reads; nesting it would put `POST /admin/setup` one slash
from the page at `/admin/setup/`.

Not `ui/`: that is documented as the drop-in mount for third-party client
dists, so a dist named `ui/admin/` would shadow the page — and the group
relaxation needs a prefix nobody is invited to write into.

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

## `npm start` — added 2026-07-31

`activitypod up` is the one command, and `npm start` runs it. It is a launcher,
not the agent: pick a port, spawn `run-agent.mjs` **detached**, wait for it to
answer, open the browser, print the URL, exit. Logs already go to
`AP_HOME/agent.log` and `startAdmin` writes the pidfile after listen, so `stop`
works on it unchanged.

Two decisions worth keeping:

- **"Occupied" means "will not bind", not "does not answer HTTP."** The old
  probe in `start` asks `GET /status`, which only sees things that speak HTTP
  *and* reply — a squatter holding the port silently reads as free, and the
  agent then dies on EADDRINUSE. `up` binds a `net` server to find out, and only
  asks `/status` to answer the different question of whether what is there is
  *ours*.
- **Walking the range is a step, not a branch.** It always ends in a bind, so
  there is no error path: an occupied preferred port simply means the next one,
  recorded so `stop`/`status` and the next run agree. A configured agent's port
  is a preference too — moving it costs a Phanpy login and nothing more, which
  is far cheaper than refusing to start.

Where it opens is a separate question from which port it got: no credential →
`/admin/setup/`; otherwise the agent's own origin, where `/` already routes to
the client (or to `/admin/` for a group). There is a TOCTOU gap between the bind
probe and the child's own bind; the window is milliseconds and the child already
exits with a clear message, so it is accepted rather than passing a pre-bound
socket down.

## Known gaps

- `activitypod passwd` still opens its own pod connection and writes
  `config.json` behind a running agent's back — the clobber described in
  `group-moderation.md`. `POST /config` is the fix; the CLI was left pointing
  at the old path.
- Still no `POST /unblock` and no `GET /blocks`, so the admin page has no
  blocklist panel.
- Nothing here has been run against a real CSS. §13 drives the real account API
  and the real mint against a mock; everything past the mint is faked.

## The named origin is only half of it (2026-08-01)

Each identity answers at `<handle>.localhost:<port>` so a browser keys its
storage separately — two identities on one machine otherwise share a client
login and become impossible to tell apart. That was built; what was missing is
that almost nothing *used* it.

**Every URL this project hands a browser now carries the handle.** The sharp
ones were `GET /profiles`, which returned `http://localhost:<port>/admin/` and
the sibling's handle on adjacent lines, and `POST /new-actor`, which returned
`{ handle, url: 'http://localhost:<port>/admin/setup/' }` — the handle and the
bare URL in the same object literal. Also: the startup banner (the only record
of where to browse on a detached `npm start`), `POST /start-actor`, the `--cli`
setup tail (which opened the shared origin *and* told you to log the client into
it), and `up`'s unconfigured branch. `namedOrigin(handle, port)` in `admin.mjs`
is the one place that builds it now.

Left bare on purpose: the CLI's own `fetch('http://localhost:<port>/…')` calls.
Those are process-to-self HTTP with no browser storage anywhere near them.

**`agent.json` was not holding the handle.** `connect()` sets the guard's label
from pod state, so the named origin worked from the first *request* — but
nothing outside the process can read pod state, so every external link was built
from a file that had only a port. `Agent.recordHandle()` caches it beside the
port on connect. Pod state stays the authority; this is the cache. Until it ran,
this machine's three identities all had `{"port":N}` and every link came out
bare, which is exactly the bug that made it visible.

## Pinning the client to its own actor

Per-origin storage keeps identities apart. It does not make the client's
*current* account agree with the agent serving the page — the client keeps a
list and picks one, and a leftover account from another identity wins. That is
how `@jeff@jeff.localhost:4000` turned up on the group's page with the profile
editor pointed at a Solid pod that answers `UnauthorizedHttpError` to
`/api/v1/instance`.

`web/admin/client/client.js` closes it. The frame keeps declaring what it loads
(`src="/"`, unchanged); the script asks `/status` for this agent's `actor`, and
if no stored account's `info.uri` matches, navigates the loaded app to
`#/login?instance=<host>&submit=1`.

Three things that took reading the bundle to get right:

- **Match on the actor URI, not the origin.** `accounts[i].instanceURL` answers
  "which account logged in at this origin", which is a different question — and
  it is the one that goes wrong when two origins get mixed. `info.uri` is the
  pod actor URI and is exact.
- **The query goes after the hash.** It is a HashRouter, so `?instance=` on the
  document query is invisible to `useSearchParams`.
- **`submit` must be non-empty.** `searchParams.get('submit')` returns `""` for
  a bare `?submit=`, which is falsy, so the auto-submit never registers.

What it costs: the OAuth round trip takes over the top window and lands on the
client at `/` without the bar. Once per identity, and `/` is where the Actors
list's `app` link goes anyway, so it is not a strange place to end up — the bar
returns on the next `visit account`. Phanpy builds its callback from
`location.pathname`, so returning to `/admin/client/` is not ours to choose.
