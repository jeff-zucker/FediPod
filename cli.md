# CLI admin

Everything here runs from the install folder. Most day-to-day management is
in the [GUI admin](gui.md); the terminal is for starting and stopping, and
for the few things a page cannot do. Replace NAME, DIR and EMAIL with your
own values.

## Starting and stopping

```
npm start                                        # start your default identity (the one you last used)
npm start 8081                                   # same, on a port of your choice — it is remembered
node bin/fedipod.mjs up --profile NAME    # start a specific identity
node bin/fedipod.mjs stop                    # stop it, saving state first
node bin/fedipod.mjs status                  # is it running, and as whom
node bin/fedipod.mjs profiles                # every identity on this machine, running or not
```

Installing the boot services (see the README) makes starting by hand unnecessary.

<!-- CLAUDE 2026-08-19 — setup, and which identity a command acts on; delete markers when done -->
## Creating an identity

```
node bin/fedipod.mjs setup                   # opens the browser setup
node bin/fedipod.mjs setup --cli             # the same questions in the terminal
```
`--group` makes a group actor instead of a person, `--new-account` creates the
pod account as part of it, `--keys pod` puts the signing key in pod state for
multi-device use, and `AP_PASSWORD` supplies the pod password without a
prompt. `--profile NAME` names the new identity when you have more than one.

## Which identity a command acts on

`--profile NAME` works on every command, not just `up`; `AP_PROFILE` is the
same thing as an environment variable, and `AP_HOME` points at an install
folder directly. Without either, commands act on the default identity — with
several identities, say which you mean. `profiles` does not list identities
under a custom `AP_HOME`.

Commands that manage a live identity — `alias`, `admit`, `import`, `archive`,
`bsky`, `describe`, `status`, `rebuild`, `gateway --detach` and the group
commands — talk to the running agent and say so when it is not there. `keys`,
`state`, `home` and attaching a gateway want the agent stopped.
<!-- /CLAUDE -->

## Recovery

```
node bin/fedipod.mjs rotate-key --force
```
When an identity's `keys.json` is lost or damaged the agent refuses to start;
this mints a replacement and tells other servers.
<!-- CLAUDE 2026-08-19 — it prompts; delete markers when done -->
It asks before rotating; `--yes` answers for you.
<!-- /CLAUDE --> Any other device still
using the old key stops working as this identity.

```
node bin/fedipod.mjs rebuild --from-notes
```
A deeper version of the GUI's **Recover posts**: reads every note the pod
still holds, and can bring back a post whose deletion half-failed. Adds only;
nothing local is overwritten.  Agent must be running.

## Security

```
node bin/fedipod.mjs passwd                         # require a password when a client logs in
node bin/fedipod.mjs tokens                         # list client logins; --revoke <prefix> or --revoke-all
node bin/fedipod.mjs revoke-credential --email EMAIL   # cut this machine off from the pod account
```
<!-- CLAUDE 2026-08-19 — passwd timing; delete markers when done -->
A new password takes effect when a running agent restarts.
<!-- /CLAUDE -->

## Bluesky

```
node bin/fedipod.mjs bsky connect HANDLE APP-PASSWORD   # drive an existing Bluesky account
node bin/fedipod.mjs bsky status                        # which account, and any last error
node bin/fedipod.mjs bsky crosspost off                 # your public posts stay off Bluesky (on: they mirror)
node bin/fedipod.mjs bsky disconnect                    # forget the session and the stored credential
```
HANDLE and APP-PASSWORD come from the Bluesky account: make the app password
under its Settings → Privacy and security → App Passwords. Add
`--service URL` when the account lives on a PDS other than bsky.social.
Disconnecting does not remove anything already posted to Bluesky.

## Inbox history

```
node bin/fedipod.mjs archive off        # stop keeping drained mail (on: keep it, the default)
```
The archive keeps each incoming activity's original bytes in the private
half's `inbox-archive/` after it is verified and applied (JSON-LD, so the
receipts read as RDF too) — receipts you can re-verify, and the inbound half
of an account move. It lives only in the private half; the pod cannot
rebuild it.

## Moving the install

```
node bin/fedipod.mjs home                # where your identities live
node bin/fedipod.mjs home --to DIR       # move them all somewhere else
```
Stop the agents first. If you use the boot services, run
`npm run install-service` again afterwards.

<!-- CLAUDE 2026-08-19 — going quiet, state moves, export, group commands; delete markers when done -->
## Going quiet, and leaving

```
node bin/fedipod.mjs park                    # stop the mail and unfollow, keeping the handle
node bin/fedipod.mjs revive                  # come back: re-follow everyone from the parking snapshot
node bin/fedipod.mjs retire                  # permanent: followers' servers are told to drop the account
node bin/fedipod.mjs retire --move-to @you@new.host    # tell followers to migrate, then stand down
node bin/fedipod.mjs retire --keep-handle    # stand down, but the handle keeps resolving
```
Each asks before acting; `--yes` answers for you. These are the terminal form
of the record page's status control and lifecycle buttons.

## Where the private half lives

```
node bin/fedipod.mjs state                   # show where the private half and public face live
node bin/fedipod.mjs state --to pod          # move the private half into pod state (multi-device)
node bin/fedipod.mjs state --to DIR          # or into another directory
node bin/fedipod.mjs upgrade                 # which identities are on an older layout
```
`upgrade` reports and names the `state` commands to run; it moves nothing
itself. Stop the agent before moving state.

## Taking your data out

```
node bin/fedipod.mjs export --format as-collections --to DIR
```
Writes the outbox, followers and the archived inbox as paged AS2 collections;
`--to` also takes a pod container URL.

## Running a group

```
node bin/fedipod.mjs members                 # who is in
node bin/fedipod.mjs requests                # who is waiting to join
node bin/fedipod.mjs admit ACTOR-URL         # let one in (or: admit --all)
node bin/fedipod.mjs refuse ACTOR-URL
node bin/fedipod.mjs joins open|approve      # whether joining waits for review
node bin/fedipod.mjs mute ACTOR-URL          # stop carrying them; unmute undoes it
node bin/fedipod.mjs eject ACTOR-URL
node bin/fedipod.mjs review on|off           # whether posts wait for approval
node bin/fedipod.mjs pending                 # posts waiting for approval
node bin/fedipod.mjs approve NOTE-URL
node bin/fedipod.mjs decline NOTE-URL
node bin/fedipod.mjs announced               # what the group has carried
node bin/fedipod.mjs retract NOTE-URL        # un-carry one
```
The agent must be running. What these mean: [Groups](groups.md).

Also: `describe --summary "…" --icon URL` sets the bio and avatar and
republishes the actor; `install-service` / `uninstall-service` are the
service installers the README names, as fedipod subcommands; and
`home --restructure` is the one-time move of an old top-level identity into
`profiles/` — commands that need it say so.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-16 — new commands: alias, import, admit --all; delete markers when done -->
## Moving here from another server

```
node bin/fedipod.mjs alias --add @you@old.server   # list the old account on your actor
node bin/fedipod.mjs alias                         # show the aliases
node bin/fedipod.mjs alias --remove URL --yes      # take one off
```
The alias is what the old account's server checks before it will send the
move. Add it, then trigger the move on the old server. Leave the alias in
place until the migration has settled — servers keep checking it while they
retry.

```
node bin/fedipod.mjs admit --all                   # accept every waiting follow request
```
Turning on automatic acceptance first (the admin page's **new followers**
control) means the incoming wave never queues at all.

```
node bin/fedipod.mjs import following_accounts.csv blocked_accounts.csv
```
Takes the CSV files from the old server's export — follows, blocks, mutes,
lists and domain blocks; the file names say which is which, or pass
`--kind follow|block|mute|list|domain` with a single file. Rows are applied
slowly on purpose and the command shows progress; `import` with no files
shows where a run stands, and `--clear` drops the finished record. Bookmarks
are not imported.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-17, revised 2026-08-19 — gateway, keys, https commands; delete markers when done -->
## The gateway

```
node bin/fedipod.mjs gateway <door-inbox-url> --secret <hmac> --inbox-only
node bin/fedipod.mjs gateway --detach
```
Attaching points your actor's advertised inbox at a gateway's door, so
deliveries are verified and de-junked before they reach your pod; your name,
key and data stay on your pod. The URL and secret come from the gateway's
signup page. Attaching takes effect when the agent next starts; detaching
needs it running, and republishes your actor with the pod's own inbox.
(`front` still works as an alias, and the `<…/ap/actor>` form without
`--inbox-only` takes a fronted identity instead.)

What a gateway is, easing into one, and running your own: [gateway.md](gateway.md).

## Keys

```
node bin/fedipod.mjs keys
node bin/fedipod.mjs keys --to pod
node bin/fedipod.mjs keys --to local
```
Where the signing key lives. On the pod, every device that reaches your
state store can sign as the actor — that is what multi-device needs; the
pod's operator can also read a pod-held key. The pod copy is shared between
devices only when the state store is on the pod too — `state --to pod`
first. Local keeps it on this machine
alone; the next start adopts the pod copy and removes it from the pod. Stop
the agent before moving keys.

## update

```
node bin/fedipod.mjs update
```
Pulls the latest published FediPod into this install and restarts the
agents — those installed as services restart themselves; any started by hand
need their own restart. The record page offers the same thing when a newer version exists —
every agent checks once a day. A checkout with local changes is refused
rather than overwritten. `AP_UPDATE_CHECK=0` turns the daily check off.

## https

```
node bin/fedipod.mjs https
node bin/fedipod.mjs https --trust
```
Every agent's address is https, on the port you gave it.
The first agent start makes the certificate and signs it with a local
certificate authority that can only ever vouch for localhost names. On Linux
the authority lands in Chrome and Chromium's store by itself; Firefox, macOS
and Windows run `https --trust` once, which prints any remaining step.
`https` shows what is minted and when it expires.
<!-- /CLAUDE -->

