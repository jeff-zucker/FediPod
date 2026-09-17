---
slug: "xxxx"
authors: Jeff Zucker <https://jeffz.solidcommunity.net/profile/card#me>
status: DRAFT
dateReceived: 2026-09-16
---
# A discussion forum whose record is a Solid pod

## Summary

A forum — categories, topics, posts, moderation — kept as ActivityPub
documents on a Solid pod and served from static pages. No forum database and no
forum server. Readers read the pod. Members write to their own pods. A host
run by the moderators drains one inbox and writes the record back.

Existing FEPs cover the wire. This says where the documents live and how a
category is made private with the pod's own access control.

## Requirements

The key words MUST, SHOULD and MAY are to be interpreted as in RFC 2119.

## The layout

One container, by convention `fedipod-bb/`, on the forum's pod.

    ap/actor              the site, an Application
    ap/inbox/             ONE inbox; every category names it as its sharedInbox
    ap/categories         OrderedCollection of category actor ids
    ap/administrators     FEP-baf5
    ap-state/             owner-only: config, lease, keys
    c/<slug>/             one per category, an ordinary group's tree
      ap/actor            a Group (FEP-1b12)
      ap/followers        its membership
      ap/moderators       its roster; the actor's attributedTo
      ap/members          who may READ it; present only when it is private
      ap/topics(-N)       OrderedCollection of topic ids
      ap/topic/<tid>(-N)  one topic: a context collection (FEP-7888)
      ap/cache/<sha16>    the forum's readable copy of a member's post

A topic is an `OrderedCollection` whose `attributedTo` is the category, whose
`orderedItems` are the authors' own post ids, and whose `name` is the topic's
title — given by the person opening it, in the `name` of their `Create`, and
never taken from the post. Every post in it carries `context` naming it.

Posts are named, not copied, in the record: the author's server stays the
authority on edits and deletions (FEP-fe34). Because a browser cannot fetch
from a stranger's server, the forum ALSO writes a verified copy under
`ap/cache/`, replaced by a `Tombstone` (FEP-4f05) when the original goes.

## Open and private

Open or private is a property of the category, set by its administrators. It
MUST NOT change as a side effect of anybody joining, being admitted, or being
removed. On the wire it is `manuallyApprovesFollowers` on the Group.

A private category:

1. Its trees are readable by named WebIDs only; the actor stays public, since
   a server that cannot read the actor cannot deliver to it.
2. It publishes `ap/members`, an OrderedCollection of the WebIDs that may read
   it, itself readable only by those WebIDs. The forum's own WebID is among
   them, because the forum dereferences each post at its author's pod.
3. Every join waits for a moderator, and admitting somebody requires a WebID.
   A follower without one MUST be let go with a `Reject`: carrying posts to
   someone who is refused the pages is not privacy.
4. Members address their posts to the category's followers collection, not to
   `as:Public`. A group MUST NOT otherwise carry a non-public post; a private
   group carries them because its membership is exactly the set already
   permitted to read them.
5. The member's own copy is written into a container on the member's pod whose
   access rule names the same reader list. One container per category, so one
   rule covers that member's whole history there and is rewritten with each
   post.

## Security considerations

- **Revocation is not uniform.** The forum revokes its own copies at once.
  Members' own copies are behind rules only those members can write, so an
  ejected reader keeps a given author's older posts until that author next
  writes. Implementations SHOULD rewrite the rule on every post.
- **Admission is retroactive.** A new member reads the whole history, because
  the forum's copies are re-granted as a set.
- **Not confidentiality.** This is access control. Pod operators, and any
  gateway a delivery passes through, hold the plaintext. Any admitted member
  can copy anything. A category MUST NOT claim more than that.
- **Nothing is retroactive at the switch.** Posts written while a category was
  open were published to the world and stay so.
- An unsigned append to a public inbox proves nothing, so a moderator's
  request is published at the moderator's own pod and fetched back from there
  before it is applied (FEP-fe34).

## References

FEP-1b12 group federation · FEP-7888 contexts · FEP-f15d relocation ·
FEP-4f05 tombstones · FEP-fe34 origin · FEP-7458 replies · FEP-b2b8 long-form ·
FEP-baf5 administrators · FEP-044f quotes · W3C Web Access Control · Solid-OIDC

## Copyright

CC0 1.0 Universal.
