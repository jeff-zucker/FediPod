# CLI admin

Everything here runs from the install folder. Most day-to-day management is
in the [GUI admin](gui.md); the terminal is for starting and stopping, and
for the few things a page cannot do. Replace NAME, DIR and EMAIL with your
own values.

## Starting and stopping

```
fedipod start              # start your default identity (the one you last used)
fedipod start --port 8081  # same, on a port of your choice — it is remembered
fedipod up --profile NAME  # start a specific identity
fedipod stop               # stop it, saving state first
fedipod status             # is it running, and as whom
fedipod profiles           # every identity on this machine, running or not
```

Installing the boot services (see the README) makes starting by hand unnecessary.

## Creating an identity

```
fedipod setup        # opens the browser setup
fedipod setup --cli  # the same questions in the terminal
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
`bsky`, `describe`, `status`, `rebuild`, `gateway --attach`,
`gateway --detach` and the group commands — talk to the running agent and say
so when it is not there. `keys`, `state`, `home` and the paste-in gateway form
(`gateway <url> --secret …`) want the agent stopped.

## Recovery

```
fedipod rotate-key --force
```
When an identity's `keys.json` is lost or damaged the agent refuses to start;
this mints a replacement and tells other servers.
It asks before rotating; `--yes` answers for you.
 Any other device still
using the old key stops working as this identity.

```
fedipod rebuild --from-notes
```
A deeper version of the GUI's **Recover posts**: reads every note the pod
still holds, and can bring back a post whose deletion half-failed. Adds only;
nothing local is overwritten.  Agent must be running.

## Security

```
fedipod passwd                           # require a password when a client logs in
fedipod tokens                           # list client logins; --revoke <prefix> or --revoke-all
fedipod revoke-credential --email EMAIL  # cut this machine off from the pod account
```
A new password takes effect when a running agent restarts.

## Bluesky

```
fedipod bsky connect HANDLE APP-PASSWORD  # drive an existing Bluesky account
fedipod bsky status                       # which account, and any last error
fedipod bsky crosspost off                # your public posts stay off Bluesky (on: they mirror)
fedipod bsky disconnect                   # forget the session and the stored credential
```
HANDLE and APP-PASSWORD come from the Bluesky account: make the app password
under its Settings → Privacy and security → App Passwords. Add
`--service URL` when the account lives on a PDS other than bsky.social.
Disconnecting does not remove anything already posted to Bluesky.

## Inbox history

```
fedipod archive off  # stop keeping drained mail (on: keep it, the default)
```
The archive keeps each incoming activity's original bytes in the private
half's `inbox-archive/` after it is verified and applied (JSON-LD, so the
receipts read as RDF too) — receipts you can re-verify, and the inbound half
of an account move. It lives only in the private half; the pod cannot
rebuild it.

## Moving the install

```
fedipod home           # where your identities live
fedipod home --to DIR  # move them all somewhere else
```
Stop the agents first. If you use the boot services, run
`fedipod install-service` again afterwards.

## Going quiet, and leaving

```
fedipod park                            # stop the mail and unfollow, keeping the handle
fedipod revive                          # come back: re-follow everyone from the parking snapshot
fedipod retire                          # permanent: followers' servers are told to drop the account
fedipod retire --move-to @you@new.host  # tell followers to migrate, then stand down
fedipod retire --keep-handle            # stand down, but the handle keeps resolving
```
Each asks before acting; `--yes` answers for you. These are the terminal form
of the record page's status control and lifecycle buttons.

## Where the private half lives

```
fedipod state           # show where the private half and public face live
fedipod state --to pod  # move the private half into pod state (multi-device)
fedipod state --to DIR  # or into another directory
fedipod upgrade         # which identities are on an older layout
```
`upgrade` reports and names the `state` commands to run; it moves nothing
itself. Stop the agent before moving state.

## Taking your data out

```
fedipod export --format as-collections --to DIR
```
Writes the outbox, followers and the archived inbox as paged AS2 collections;
`--to` also takes a pod container URL.

## Running a group

```
fedipod members             # who is in
fedipod requests            # who is waiting to join
fedipod admit ACTOR-URL     # let one in (or: admit --all)
fedipod refuse ACTOR-URL
fedipod joins open|approve  # whether joining waits for review
fedipod mute ACTOR-URL      # stop carrying them; unmute undoes it
fedipod eject ACTOR-URL
fedipod review on|off       # whether posts wait for approval
fedipod pending             # posts waiting for approval
fedipod approve NOTE-URL
fedipod decline NOTE-URL
fedipod announced           # what the group has carried
fedipod retract NOTE-URL    # un-carry one
```
The agent must be running. What these mean: [Groups](groups.md).

Also: `describe --summary "…" --icon URL` sets the bio and avatar and
republishes the actor; `install-service` / `uninstall-service` are the
service installers the README names, as fedipod subcommands; and
`home --restructure` is the one-time move of an old top-level identity into
`profiles/` — commands that need it say so.

## Moving here from another server

```
fedipod alias --add @you@old.server  # list the old account on your actor
fedipod alias                        # show the aliases
fedipod alias --remove URL --yes     # take one off
```
The alias is what the old account's server checks before it will send the
move. Add it, then trigger the move on the old server. Leave the alias in
place until the migration has settled — servers keep checking it while they
retry.

```
fedipod admit --all  # accept every waiting follow request
```
Turning on automatic acceptance first (the admin page's **new followers**
control) means the incoming wave never queues at all.

```
fedipod import following_accounts.csv blocked_accounts.csv
```
Takes the CSV files from the old server's export — follows, blocks, mutes,
lists and domain blocks; the file names say which is which, or pass
`--kind follow|block|mute|list|domain` with a single file. Rows are applied
slowly on purpose and the command shows progress; `import` with no files
shows where a run stands, and `--clear` drops the finished record. Bookmarks
are not imported.

## The gateway

```
fedipod gateway --attach <gateway-origin> [--name N] [--fronted]
fedipod gateway <door-inbox-url> --secret <hmac> --inbox-only
fedipod gateway --detach
```

`--attach` asks the gateway itself: the agent proves the pod with its own
credential, and the gateway answers with the door and the receipt secret.
`--name` defaults to your handle; `--fronted` takes a gateway-based name,
and the agent restarts itself to publish under it. The admin page's Gateway
row offers the same action with the name checked as you type.
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
fedipod keys
fedipod keys --to pod
fedipod keys --to local
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
fedipod update
```
Pulls the latest published FediPod into this install and restarts the
agents — those installed as services restart themselves; any started by hand
need their own restart. The record page offers the same thing when a newer version exists —
every agent checks once a day. A checkout with local changes is refused
rather than overwritten. `AP_UPDATE_CHECK=0` turns the daily check off.

## https

```
fedipod https
fedipod https --trust
```
Every agent's address is https, on the port you gave it.
The first agent start makes the certificate and signs it with a local
certificate authority that can only ever vouch for localhost names. On Linux
the authority lands in Chrome and Chromium's store by itself; Firefox, macOS
and Windows run `https --trust` once, which prints any remaining step.
`https` shows what is minted and when it expires.

