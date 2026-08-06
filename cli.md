# CLI admin

Everything here runs from the install folder. Most day-to-day management is
in the [GUI admin](gui.md); the terminal is for starting and stopping, and
for the few things a page cannot do. Replace NAME, DIR and EMAIL with your
own values.

## Starting and stopping

```
npm start                                        # start your default identity (the one you last used)
npm start 8081                                   # same, on a port of your choice — it is remembered
node bin/solid-activitypub.mjs up --profile NAME    # start a specific identity
node bin/solid-activitypub.mjs stop                    # stop it, saving state first
node bin/solid-activitypub.mjs status                  # is it running, and as whom
node bin/solid-activitypub.mjs profiles                # every identity on this machine, running or not
```

Installing the boot services (see the README) makes starting by hand unnecessary.

## Recovery

```
node bin/solid-activitypub.mjs rotate-key --force
```
When an identity's `keys.json` is lost or damaged the agent refuses to start;
this mints a replacement and tells other servers. Any other device still
using the old key stops working as this identity.

```
node bin/solid-activitypub.mjs rebuild --from-notes
```
A deeper version of the GUI's **Recover posts**: reads every note the pod
still holds, and can bring back a post whose deletion half-failed. Adds only;
nothing local is overwritten.  Agent must be running.

## Security

```
node bin/solid-activitypub.mjs passwd                         # require a password when a client logs in
node bin/solid-activitypub.mjs tokens                         # list client logins; --revoke <prefix> or --revoke-all
node bin/solid-activitypub.mjs revoke-credential --email EMAIL   # cut this machine off from the pod account
```

## Bluesky

```
node bin/solid-activitypub.mjs bsky connect HANDLE APP-PASSWORD   # drive an existing Bluesky account
node bin/solid-activitypub.mjs bsky status                        # which account, and any last error
node bin/solid-activitypub.mjs bsky crosspost off                 # your public posts stay off Bluesky (on: they mirror)
node bin/solid-activitypub.mjs bsky disconnect                    # forget the session and the stored credential
```
HANDLE and APP-PASSWORD come from the Bluesky account: make the app password
under its Settings → Privacy and security → App Passwords. Add
`--service URL` when the account lives on a PDS other than bsky.social.
Disconnecting does not remove anything already posted to Bluesky.

## Moving the install

```
node bin/solid-activitypub.mjs home                # where your identities live
node bin/solid-activitypub.mjs home --to DIR       # move them all somewhere else
```
Stop the agents first. If you use the boot services, run
`npm run install-service` again afterwards.
