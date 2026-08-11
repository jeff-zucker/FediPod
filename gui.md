# The Admin interface

Open `http://localhost:8030/` while any agent is running to reach it, then choose `manage account` and select the actor you want from the local actors dropdown.


* **Parking** (the status control) stops the mail and unfollows people you follow, but keeps your handle
  alive. Setting it back to active re-follows everyone — as requests, so a
  few may not come back.  If your local machine is going to be off for more than a couple of days, you should park the account because, if you don't, mail will accumulate on the pod possibly causing load issues.
* **Move data** copies your local data to the new place and checks it before
  switching over. The old copy is left behind for you to delete.
* **Transfer identity** hands your followers to the account you name; your
  old handle keeps working as a redirect, and the identity is parked
  afterwards.
* **Retire identity** is permanent — every follower's server is told to drop
  the account, and the identity does not come back.
* **Rotate signing key** — any other device still using the old key can no
  longer act as this identity.
* **Recover posts** re-reads your own posts from the pod after a restore. It
  only ever adds; nothing local is overwritten.
* Discarding a backlog drops old content only — its follows, unfollows and
  deletions are still applied.

The handle, the pod and person-vs-group are permanent. The display name, bio
and pictures are edited in the client, not here.

<!-- CLAUDE 2026-08-09 — the panel behaviour isn't obvious to a keyboard user;
     added so it's written down. Reword or drop; delete these markers when done. -->
Each of these opens a small window that floats over the page. You can drag it by
its title bar, resize it from its corner, and close it with its ✕ or by pressing
Escape.
<!-- /CLAUDE -->

## Sharing an account

Each identity has a page anyone can open, at `ap/profile.html` under its pod
— for example `https://your-pod.example/activitypods-js/ap/profile.html`. It
shows the name, bio and address, and offers a Follow box: a visitor types
their own server and lands on that server's follow screen. Hand out that
link, or the `@name@host` address itself, which works in the search box of
any fediverse app.

## Bluesky

Connecting a Bluesky account makes this identity also post as that account:
your **public** posts mirror to Bluesky (never followers-only or direct
ones), deleting a post deletes its Bluesky copy, and the account's timeline
and notifications appear in your home feed. Replying to, favouriting and
boosting a Bluesky post act as the connected account. A reply lives on
Bluesky only — it is always public and fits Bluesky's 300-character limit —
because your fediverse followers cannot see the post it answers. The
**crosspost** control stops the
mirroring without disconnecting. Disconnecting forgets the login but removes
nothing already posted. For a group, the connected account is the group's
presence on Bluesky — joining and posting through it follow the group's own
moderation settings; see [Groups](groups.md).

## Handling follow requests

New followers appear under **Follow requests** with **Accept** and **Refuse**
beside them; nothing is accepted without you. Groups are different — joining
follows the group's own moderation settings; see [Groups](groups.md).

## Protecting & recovering your data

Your posts, timeline, contacts, blocklist and notifications are kept locally,
in `~/.fedipod`. This is the only copy, which means you should back
it up regularly. It contains credentials, so back it up securely.

With a backup, restoring is copying the folder back and starting the agent —
everything returns, timeline included. Without one, nothing is fatal but some
things are gone: run setup again with your pod account, rotate the signing
key, and your followers return by themselves the next time you post, while
**Recover posts** reads your own posts back from the pod. What nothing can
bring back is the timeline you received, your notifications, your blocklist,
and your client logins.

