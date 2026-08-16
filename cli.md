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

## Recovery

```
node bin/fedipod.mjs rotate-key --force
```
When an identity's `keys.json` is lost or damaged the agent refuses to start;
this mints a replacement and tells other servers. Any other device still
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

