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
`ap/heartbeat.json` says when the forum was last hosted. `status` prints
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
staging script). Anyone reads. To reply, a reader signs in once with a
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
