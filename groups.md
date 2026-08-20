# Groups

A group is an actor other people follow, rather than one that follows people.
When members post to the group, it re-announces to everyone following it, so members see each
other without having to follow each other. If they do already follow each other , the posts are not duplicated. Joining is following, leaving is
unfollowing, and remote Mastodon users can join exactly as pod owners do — they
need no pod of their own.

A group needs a pod of its own, and runs like any other identity on its own
port — the same status, parking and lifecycle controls on its record page.

A group is made the same way as any other account: choose "add a new account"
and pick group rather than person, or take the group path on a signup page.
You can turn on join review as you create it. The group's pod must be the root
of its own host, so its handle resolves.

Being in a group also connects you to the people in it: posts from fellow
members reach your timeline even when you do not follow them individually,
so a reply in the room is something you see rather than something filed
among strangers' mail. Who counts is the group's own membership, so its
moderation settings decide who reaches you.

As with persons, a group display name and bio should be handled on the client.

## Managing a group

The group passes along posts from its own members only. This stops spam from outside the group.
A carried post must also be public: the group never widens an audience, so a
followers-only post or a DM to the group is not carried.
Internal moderation is also possible :

* owner may choose to moderate join requests - no one becomes a member without review
* owner may choose to moderate posts - nothing gets posted without review
* owner may mute users (refuse to rebroadcast their posts)

The controls live on the group's admin page: members, join requests, held
posts and carried posts. Ejecting also mutes: a re-follow is accepted again,
but nothing of theirs is carried until unmuted. Refusing a join request is not
sticky — they may ask again.

A carried post names the group as its
`audience`, and when you ban or eject someone (or change the moderator roster),
the group announces that moderation to its members so their servers can mirror
it. A moderator list can be set on the group's config; those actors' moderation
requests arriving over federation are held in a review queue rather than acted
on automatically, since a delivery alone does not prove who sent it. That
queue is its own list, separate from post review, and is the one thing with no
page of its own — it is read and answered from the terminal, with `modqueue`.
A followed group's own announced deletion of a post it carried to you is honoured.

## Inviting people

A group has a page anyone can open, at `ap/profile.html` under its pod's
app container — `<pod>/activitypods-js/ap/profile.html`. It
carries the group's address and a Follow box that sends a visitor to their
own server's follow screen, so it is the link to put where people will find
it. Posts the group carries appear in members' timelines as the group
boosting the author.

## Transferring group ownership

A group can be handed on rather than abandoned using the `Transfer this account away` button. This tells every follower to migrate, so the membership survives a change of host.



## Bluesky members

A group with a connected Bluesky account is joinable from Bluesky: following
the group's Bluesky account is a join, and mentioning its handle submits a
post. Both pass through the same moderation settings as fediverse members —
join review, post review, and muting all apply, and an approved post is
carried to the group's Bluesky followers as a repost.
A follow from an already-bridged Bluesky account is ignored on the Bluesky
side — its join arrives over ActivityPub from the bridge instead. Carrying
fediverse posts to the group's Bluesky followers happens only while
crossposting is on.

A Bluesky member's posts reach the fediverse side only if their account is
bridged (it follows @ap.brid.gy on Bluesky). Unbridged members are welcomed
with a single post mentioning them explaining that, and everything else about their
membership still works, and bridging later upgrades them in place: the
bridge's follow supersedes their Bluesky-only membership rather than adding a
second one. Ejecting a Bluesky member blocks their account, since their server cannot be told any
other way.
