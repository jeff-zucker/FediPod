
### Where your private data lives

Your timeline, contacts, blocklist and notifications are kept on **this
machine**, in the identity's folder. Your pod holds only the public face other
servers read — your address, your actor, your inbox and your published posts.
Receiving costs the pod nothing, so its load scales with what you publish, not
with what you read.

Your private data has one copy, which means:

* **No second machine.** A second agent starts only as a read-only viewer of
  its own copy — and on another machine that copy is empty.
* **Some of it only your backups can bring back.** Your followers return by
  themselves on the next publish, and **Recover posts** brings your own posts
  back from the pod — see *Getting your posts back*. What is gone with the
  machine is the timeline you received, your notifications, your blocklist and
  your client logins.

The private half is a plain directory — Turtle and JSON on disk, needing
nothing running. The **Identity** line of `/admin/` shows where it is, and
**Move data** on the Lifecycle line moves it: to another place on this
device, to an address another device serves, or onto the pod itself. Everything
is copied and checked before the agent switches over, and the old copy is left
where it was for you to delete. The agent keeps running.

### Where the agent itself lives

One directory holds every identity on this machine, each a named folder under
`profiles/` — its credential, signing keys, pidfile, log and private data all
inside its own:

```
~/.solid-activitypub/
  root.json              which identity was used last
  profiles/
    jeff/     credential.json  keys.json  agent.json  agent.log  private/
    group/    …
```

A plain command or page means whichever identity you last started. Starting a
different one is a terminal action:

```
bin/solid-activitypub.mjs start --profile <name>
```

Moving the whole root, or bringing an older install up to this layout (a root
still named `~/.activitypod`, or an identity sitting at the root's top level
instead of in `profiles/`), are terminal actions too:

```
bin/solid-activitypub.mjs home                     # which directory, and what is in it
bin/solid-activitypub.mjs home --to ~/.solid-activitypub
bin/solid-activitypub.mjs home --restructure       # move a top-level identity into profiles/
```

Both rewrite any private-data path that pointed inside, and refuse while an
agent is answering. If you installed the service, run
`npm run install-service` again afterwards — the service unit carries the path.

### Managing the account — `/admin/`

The record is at `http://localhost:8030/admin/` — what the actor is, and the
things you do to it. Port 8030 always answers while any agent is running,
whatever port an identity actually uses: it forwards to a running agent's
record page, and the **Local Actors** line there lists every identity on the
machine, running or stopped. First-run setup is at `/admin/setup/`. The buttons open
small windows you can drag by the title bar, resize from the corner, and close
with ✕ or Escape.

* **Identity** — the kind, a **status** control (active or parked — parking
  stops the mail and keeps the handle; setting it back to active re-follows
  the saved graph), both addresses (fediverse and WebID), where the private
  half is kept, and which local address answers.
* **Upkeep** — drain the inbox, recover posts, the log, the dead letters.
* **Lifecycle** — rotate the signing key, move the private data, transfer the
  identity to another account, retire it — each behind a confirmation that
  states its consequences.

**Transfer identity** hands your followers to another account: a `Move` goes to
every follower's inbox, their servers migrate them, and the old handle keeps
resolving as a redirect. Name the destination as `@you@elsewhere` or an actor
URL. Afterwards the identity is parked. Transfer and Retire both ask you to
type the handle — they are the two that cannot be taken back.

When a backlog has piled up while the agent was off, the page says so and asks
what you want: work through it oldest-first, or discard the content older than
a week or a month. Discarding drops posts, not bookkeeping — follows, unfollows
and deletions from that period are still applied.

The handle, the pod, the identity provider and person-vs-group are not
editable: they are what the actor *is*, and changing one would mean a different
actor at a different address. The display name, bio and pictures are edited in
the client.

A bar across the top of every page carries the same three destinations:
**visit account** opens the client, **manage account** the record, **add new
account** opens setup for another actor. When other actors are running on this
machine, links to them appear too — each at its own address,
`http://<handle>.localhost:<port>/`, which keeps each account's browser login
separate from the others.

### Follow requests

When somebody follows you, they appear under **Follow requests** on `/admin/`
with **Accept** and **Refuse** beside them. Your account is, in fediverse
terms, locked: a Follow arriving in an open inbox carries nothing that proves
who sent it, so it waits for you. To accept follows automatically instead, add
one line to the identity's `private/config.json`, with the agent stopped:

```json
{ "autoAcceptFollows": true }
```

A **group** is unaffected either way — `joins open` and `joins approve` mean
exactly what they say.

### Getting your posts back

A restored backup or a replaced machine comes back knowing less than the pod
does. Your followers return by themselves on the next publish. Your own posts
come back with **Recover posts** on the Upkeep line — the agent has to be
running. It reads the pod's outbox, fetches each post this machine no longer
has, and adds it. It never removes or overwrites anything: a post already here
keeps what only this machine knows, like whether you boosted or favourited it.

The outbox lists only posts that still stand. If a deletion half-failed and you
would rather have those posts back than lose one, the deeper sweep is a
terminal action:

```bash
bin/solid-activitypub.mjs rebuild --from-notes
```

which reads every note the pod still holds, and can bring back a post you
deleted.

Neither can recover other people's posts in your timeline — the pod never had
them.

### Terminal-only actions

```
bin/solid-activitypub.mjs stop                    # graceful: flushes state, releases the lease
bin/solid-activitypub.mjs tokens                  # list client logins; --revoke <prefix> / --revoke-all
bin/solid-activitypub.mjs revoke-credential --email you@example.org   # kill this machine's pod credential
bin/solid-activitypub.mjs rotate-key --force      # replace a lost or damaged keys.json
```

If this identity's `keys.json` is lost or damaged, the agent refuses to start
rather than mint a replacement — a new key would invalidate every signature a
device still holding the old one can make. `rotate-key --force` mints the
replacement and republishes the actor so other servers learn it.
