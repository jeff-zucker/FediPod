# Groups

A group is an actor other people follow, rather than one that follows people.
When members post to the group, it re-announces to everyone following it, so members see each
other without having to follow each other. If they do already follow each other , the posts are not duplicated. Joining is following, leaving is
unfollowing, and remote Mastodon users can join exactly as pod owners do — they
need no pod of their own.

A group needs a pod of its own. Run it like any other identity — `start`, `stop`, `status`, `park`, `retire` — on its own port.

As with persons, a group display name and bio should be handled on the client.

## Managing a group

The group passes along posts from its own members only. This stops spam from outside the group. Internal moderation is also possible :

* owner may choose to moderate join requests - no one becomes a member without review
* owner may choose to moderate posts - nothing gets posted without review
* owner may mute users (refuse to rebroadcast their posts)

## Inviting people

A group has a page anyone can open, at `ap/profile.html` under its pod. It
carries the group's address and a Follow box that sends a visitor to their
own server's follow screen, so it is the link to put where people will find
it. Posts the group carries appear in members' timelines as the group
boosting the author.

## Transferring group ownership

A group can be handed on rather than abandoned using the `Transfer identity` button. This tells every follower to migrate, so the membership survives a change of host.



## Bluesky members

A group with a connected Bluesky account is joinable from Bluesky: following
the group's Bluesky account is a join, and mentioning its handle submits a
post. Both pass through the same moderation settings as fediverse members —
join review, post review, and muting all apply, and an approved post is
carried to the group's Bluesky followers as a repost.

A Bluesky member's posts reach the fediverse side only if their account is
bridged (it follows @ap.brid.gy on Bluesky). Unbridged members are welcomed
with a single reply explaining that, and everything else about their
membership still works; bridging later upgrades them in place. Ejecting a
Bluesky member blocks their account, since their server cannot be told any
other way.
