## Groups

A group is an actor other people follow, rather than one that follows people.
Post to it and it re-announces to everyone following it, so members see each
other without having to follow each other. Joining is following, leaving is
unfollowing, and remote Mastodon users can join exactly as pod owners do — they
need no pod of their own.

A group needs a pod of its own. Run it like any other identity — `start`, `stop`, `status`, `park`, `retire` — on its own port.

A group serves the same three surfaces every identity does.
`http://localhost:<port>/` is the client; `/admin/` is its console — members,
join requests, the review queue, what it has carried, and every moderation
action below as a button; `/admin/setup/` is where it was created.

The client was withheld until 2026-08-01, on the reasoning that a group has no
timeline a human reads. It has both halves of one: statuses are what it carried,
notifications are who joined. And its operator has a bio to write and a profile
they want to look at the way everyone else sees it — both of which are the
client's job.

What that opens is a login and client tokens, which a group did not have before.
`solid-activitypub passwd` has never had a group carve-out, so a group can be gated
exactly like a person before it is exposed anywhere but loopback — and with no
password set, `/oauth/authorize` redirects instantly, for a group exactly as for
a person.

Two things the client will offer a group that do not mean what they look like:
composing posts a Note *as* the group, which is a legitimate announcement but
not the path a member's post takes; and following someone pulls their posts into
the group's timeline without making them a member — membership is who follows
the group, never who it follows.

The console reaches exactly the same loopback routes the commands below already
reach, so it grants nobody any authority they did not have; it is a different
client, not a wider door.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-08-01 — added: what the console shows now -->
Members are listed by their fediverse address — `@them@their.server` — rather
than by the URL their server happens to serve them at. An address only appears
once the group has actually read that actor's document; anyone it has not, it
still shows by URL, because guessing the name from the last segment of the URL
is what once rendered every group as `@actor@host`.

<!-- CLAUDE 2026-08-03 — the Moderation options panel became two dropdowns -->
The moderation settings — who may join, what gets carried — are two dropdowns
right on the kind line in Identity: **join requests** and **posts**, each
reading *moderated* or *unmoderated*. What each shows is the current state, and
changing the word is the whole action — what a group can be moderated into is a
property of being one, so the controls sit on the row that says "Group".
The join-request and post-review queues appear only when their setting is on and
something is actually waiting: with the setting off nothing can ever arrive in
them, so a heading would be promising a list that cannot fill.
<!-- /CLAUDE -->

Only members are amplified. Anyone can post into a public inbox, so a post is
carried only when its author already follows the group. That is both the
anti-spam rule and what makes joining mean something.

By default anyone who follows is admitted at once. A group can instead ask people
to request entry, which is opt-in in the same way post review is:

```
bin/solid-activitypub.mjs joins approve           # or: setup --group --approve-joins
```

```
bin/solid-activitypub.mjs members                 # who has joined
bin/solid-activitypub.mjs announced               # what the group has carried
bin/solid-activitypub.mjs mute <actor-url>        # stop carrying someone (undo: unmute)
bin/solid-activitypub.mjs eject <actor-url>       # remove them, and tell their server
bin/solid-activitypub.mjs retract <note-url>      # unsay something already carried
bin/solid-activitypub.mjs review on               # hold every post until you approve it
bin/solid-activitypub.mjs pending                 # what is waiting; approve / decline
bin/solid-activitypub.mjs joins <open|approve>    # is entry free, or by request?
bin/solid-activitypub.mjs requests                # who is waiting to join
bin/solid-activitypub.mjs admit <actor-url>       # let them in (undo: eject)
bin/solid-activitypub.mjs refuse <actor-url>      # decline this request
```

A group can be handed on rather than abandoned: `retire --move-to <actor>` tells
every follower to migrate, so the membership survives a change of host.

