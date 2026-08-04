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

## Transferring group ownership

A group can be handed on rather than abandoned using the `Transfer identity` button. This tells every follower to migrate, so the membership survives a change of host.


