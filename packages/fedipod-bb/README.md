# FediPod-BB

A forum whose record lives on a Solid pod, as ActivityPub documents in the
shapes the Fediverse's boards use: each category is a Group actor (FEP-1b12),
each topic is a context collection (FEP-7888), each post is an Article or a
Note that names its topic and its category.

This package holds the pod layout, the writers for it, the host, and the
website: where every document lives, how a topic's pages are written and
sealed, how a member's post is cached for readers, the process that runs
the forum from a moderator's machine, and the page that shows the forum.
The moderator console is not here yet; the design and the phases are in
`claude/plans/fedipod-bb.md` at the repository root.

```
node --test packages/fedipod-bb/test/*.test.mjs
```

## Hosting a forum

The forum's pod credential is a FediPod one: `fedipod setup --cli … --home
DIR` makes `DIR/credential.json`. Then:

```
node packages/fedipod-bb/bin/fedipod-bb.mjs init --home DIR --handle forum --name "The Forum" \
    --category gardening:Gardening --category compost:Compost --moderator <actor id>
node packages/fedipod-bb/bin/fedipod-bb.mjs start --home DIR
```

`init` writes the forum's config and containers. `start` publishes every
actor the first time, then drains the forum's one inbox, hands each activity
to the category it names, places carried posts in topics, and carries them
to the category's followers. Several moderators run `start` on their own
machines against the same pod: one hosts, the others watch, and when the
host stops another takes over within five minutes. A public
`ap/heartbeat` says when the forum was last hosted. `status` prints
what the pod's state says without hosting.

Every category is a FediPod group: joining is a Follow, a member's public
post addressed to the category is carried (FEP-1b12) and then placed in its
topic — the one its `context` names, the one its reply chain leads to, or a
new one with the post as its opening (FEP-7888). A post from a non-member is
not carried and opens nothing.

## Layout

Under one root, `fedipod-bb/`, on the forum's pod:

| path | what |
|---|---|
| `ap/actor` | the forum's own actor, an `Application` |
| `ap/inbox/` | the one inbox every category names as its own |
| `ap/categories` | the categories, an `OrderedCollection` of their actor ids |
| `ap/administrators` | the moderators' actor ids |
| `ap-state/` | owner-only: the forum's config, keys and lease |
| `c/<slug>/` | one FediPod group root per category, unchanged from a group's |
| `c/<slug>/ap/topics` | the category's topics, newest first, paged |
| `c/<slug>/ap/topic/<tid>` | a topic: the context collection, with pages `-1`, `-2`, … oldest first |
| `c/<slug>/ap/cache/<key>` | a readable copy of a member's post, for the website |
| `c/<slug>/ap-state/topics.json`, `topics/<tid>.json` | owner-only: the topic record |

A category's `ap/actor`, `ap/outbox`, `ap/followers`, `ap/moderators` and
`ap/featured` are what a FediPod group publishes today; the forum adds the
topic documents beside them. Posts are named in a topic by their authors'
own ids; the cached copy is for readers in a browser and is never listed in
a collection.

## The website

`site/` is a static page. Staged by `scripts/stage-site.mjs` under `/bb/`
on the fedipod.net site, it opens a forum attached there at
`/bb/?forum=<handle>`, reading everything through that site's own
`/u/<handle>/` addresses; `/bb/?pod=https://…/fedipod-bb/` reads a forum
from its pod directly. Where the site has `bb.<domain>` as a domain alias,
the same page answers there for every path, with the forum named by the
first path segment: `https://bb.fedipod.net/<handle>/`. It still reads
through `<domain>`, where the handles live (the hosts are `BB_HOSTS` in the
staging script). Anyone reads.
<!-- CLAUDE 2026-09-16 - read state; delete these markers when done -->
A topic whose newest post arrived since the reader last opened it is marked
`New` on the index. The mark is the reader's own: one entry per topic in their
browser's storage, written nowhere else and sent nowhere - a public forum has
no place to keep who read what, and no business keeping it. Arriving at a
forum for the first time reads everything before that moment, so a new reader
does not meet a page of `New`.

The page is built to WCAG 2.2 AA: a skip link, named landmarks, a label on
every control, an `aria-label` on each post's buttons naming whose post they
act on, `aria-current` on the category in view, `scope` on the index's
headers, a polite live region for what the page has just done, and a reply
box that takes the keyboard when it opens and returns it when it closes.
<!-- /CLAUDE -->
<!-- CLAUDE 2026-09-16 - the index, writing and moderating; delete these markers when done -->
The front page is an index of the forum's newest posts, across every
category: topic, category, author, date and the topic's reply count, one
line each. The forum publishes that index itself (`ap/latest`, the copies it
already holds, newest first, capped at fifty), so the page makes one request
for the list rather than walking every category. The category chips filter
it; a topic's name opens the thread at that post. Pinned topics sort first -
a category's `featured` collection for a pin within it, the forum actor's own
for one that holds everywhere.

A thread is a tree: a reply sits under the post it answers, six deep. Posts
are written in Markdown (`site/markdown.mjs`, no dependency, escaped before
it is marked up) and carry their source alongside, so an edit reopens what
was typed. A topic is named by the activity that opens it; a post has no
title.

Each post offers Reply, Share and Report, and its author Edit and Delete; a
report is queued for the moderators. Under a topic's title a moderator gets
rename, pin, pin site-wide and delete. Every moderator request is published
at the moderator's own pod and fetched back from there before the forum acts
on it (FEP-fe34), which is what makes a button on a public page safe.
<!-- CLAUDE 2026-09-16 - votes, profiles, the queue, members-only; delete these markers when done -->
A post can be voted for: a `Like` to the category, its `Undo` to take it
back, counted per person and published with the post as AS2 `likes`. The
index sorts by newest or by votes, and searches what it is holding - topic
names, authors and the words of the posts. A byline opens that person's
posts in this forum.

A moderator's queue lives at `<pod>/fedipod-bb/mod/queue.json`, with a
record of what was done beside it in `log.json`. Neither is public: the
container's access rule names the moderators' WebIDs, and the page reads it
with the moderator's own login rather than through the Gateway. From it a
moderator lets a held post through (`Accept`), turns it away (`Reject`) or
bans its author (`Block`) - each published at their own pod and checked
there, like every other ask.

A category may be members-only: `--members-only <slug>` with
`--member <slug>:<webid>`. Its trees are then readable by those WebIDs
rather than by the world, and the page reads them with the member's pod
session. The actor itself stays public, since a server that cannot read it
cannot deliver to the category at all. Only a WebID can be named this way -
serving a member who has only a Fediverse account is the Server build's job,
which is not built.
<!-- /CLAUDE -->
To reply, a reader signs in once with a
Mastodon account: the page registers itself on their server, sends them to
approve it, and keeps the token in their browser; a reply is posted from
their account with the category mentioned, and answers the thread's last
post as their server resolves it. The reply shows in the thread once the
forum's host has placed it; until then the reader sees their own copy marked
as waiting. A reader with a pod account is pointed at FediPod and the
category's address; a reader with nothing is pointed at sign-up.

## Attaching to a Gateway

```
node packages/fedipod-bb/bin/fedipod-bb.mjs attach --home DIR --front https://fedipod.net
```

Takes `@<handle>@fedipod.net` for the forum and one address per category,
each a row of its own at the Gateway pointing at that category's tree on the
pod and at the forum's one inbox. Deliveries arrive verified at the front;
the next `start` republishes every actor under its front address.
