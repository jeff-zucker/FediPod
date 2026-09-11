<!-- CLAUDE 2026-09-11 — whole file rewritten: the browser version is the
     subject; the installed agent, the gateway and the server each have a
     linked file of their own. Review pending; delete this marker when done. -->
# FediPod

- access the Fediverse from a Solid pod

FediPod gives you a Fediverse account whose data lives on a Solid pod. You
follow people on Mastodon and the rest of the Fediverse, and on Bluesky, in
one timeline. Your posts, followers and settings stay on your pod, and your
Fediverse identity is yours, independent of who runs the door in front of it.

You use it in a browser at https://fedipod.net. Nothing is installed.

## Requirements

- A current browser, on a desktop or a phone.
- A Solid pod with a host name of its own, such as
  `https://alice.solidcommunity.net/`. Sign-up can create one for you at
  solidcommunity.net or another provider, or use a pod you already have. A
  pod that lives on a path of a shared host, like `https://server.example/alice/`,
  cannot be a Fediverse address.
- Followers-only and direct posts need a pod that enforces WAC access control.
  On one that does not, the composer refuses those two and says why. Public
  and unlisted posts work on any pod.

## Getting an account

1. Open https://fedipod.net and choose **create an account**.
2. Choose a pod: a new one at the provider you name, or a pod you already have.
3. Choose your handle. Your address is `@handle@yourpod`. Both parts are
   permanent; display name, bio and pictures are set later in the client.
4. Enter your pod password once. It creates the account and locks your
   signing key. It is not stored.

Your account then opens in the client. To use it from another browser, go to
https://fedipod.net, enter your address, sign in at your pod, and unlock your
key with your password once on that browser.

## What you can do

The client is [Phanpy](https://github.com/cheeaun/phanpy) (MIT, by Chee Aun),
served by fedipod.net. Through it you follow and unfollow, post, reply,
favourite, boost, attach media, edit and delete. Content warnings, polls with
up to four options and one or several answers, all four visibility levels, a
conversations view for direct messages, bookmarks, lists, keyword filters,
pinned posts that other servers can see, blocking and muting, and the custom
emojis other servers send.

**Bluesky.** Connect a Bluesky account, or any other ATProto account, from the
manage page. Your public posts are mirrored to it, Bluesky replies and
activity flow into your timeline, and you can like, repost and reply to
Bluesky posts. Direct messages to Bluesky are not supported. None of this
needs Bridgy Fed.

**Your other Fediverse accounts.** If you also hold an account on Mastodon,
or on any other server speaking the Mastodon API such as GoToSocial, Pleroma,
Akkoma, Pixelfed or Friendica, connect it from the manage page and read it
here. Its home timeline and notifications join the feed you already read,
interleaved by time, and a post both accounts see appears once. Favouriting,
boosting and replying act as the account the post came through. The token it
hands back stays in your browser unless you choose to keep it on your pod.

**Moving in.** Mastodon-format exports of follows, blocks, mutes, lists and
domain blocks import from the manage page. Your old account can be listed as
an alias, so a Move from it lands here.

**The manage page.** `manage account` in the bar opens it: your profile,
aliases, the gateway, key rotation, recovering posts, parking, moving to
another server, retiring, and clearing a backlog. It is the same interface
the installed agent has, described in [the admin interface](gui.md).

**More than one browser.** One browser runs your account at a time. Opening
it in a second browser shows your timeline read-only, and the moment you act
there it takes over; the first drops back to reading.

## What the browser version does not do

- **Scheduled posts.** Nothing runs between now and the time you picked, so
  the composer refuses one rather than dropping it later.
- **Notifications while the client is closed.** There is no push service.
  Open the tab and they are there.
- **Live updates.** The client refreshes by polling.
- **Hosting a group.** Joining one works.
- **Other clients.** A phone app or desktop client has nothing on the network
  to connect to.

All of these work with [the installed agent](installed-agent.md).

## Your data and your keys

Everything you publish and everything you read is stored on your pod. Your
signing key is stored there too, encrypted under your password, so nobody who
can read your pod, its host included, can post as you. fedipod.net holds no
key: it verifies incoming mail, drops the junk, forwards the rest to your pod,
and hands your browser the app. You can detach from it at any time and attach
to a gateway of your own. Your address and your data do not change.

## Other ways to run FediPod

- [The installed agent](installed-agent.md) runs on your own machine and
  adds scheduled posts, push notifications, live updates, group hosting and
  the use of any Mastodon client.
- [Groups](groups.md): hosting a discussion group of Fediverse and Bluesky
  users from a pod.
- [The gateway](gateway.md): running an always-on door of your own, on
  Netlify or any small host.
- [FediPod Server](packages/fedipod-server/README.md): a full ActivityPub
  server as a Community Solid Server component, giving every pod on the server
  the option of a Fediverse account.
- [Architecture](architecture.md): how the pieces fit, and which protocols
  FediPod speaks.

## Acknowledgements

This project is inspired by the fantastic [ActivityPods project](https://github.com/activitypods) and is meant to be a lightweight alternative rather than a replacement.  Thanks to [Sébastien](https://github.com/srosset81) and collaborators for all your work.  Thanks to [Damon](https://github.com/outlaw-dame), [Mikhal](https://github.com/mrkvon), [Alain](https://github.com/bourgeoa), and [Sharon](https://github.com/SharonStrats), for testing and encouragement.  Special thanks are due to [Joseph](https://github.com/jg10-mastodon-social) whose client-to-server authentication approach and the netlify/fronted-identity ideas I borrowed from [solid-activitypub-netlify](https://github.com/jg10-mastodon-social/solid-activitypub-netlify) and to [Vincent](https://github.com/Vinnl) and [Emilia](https://github.com/ThisIsMissEm) whose ideas on the multiple Fediverse accounts sparked FediPod's support for it.

## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
