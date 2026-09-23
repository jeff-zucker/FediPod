# FediPod

- access the Fediverse from a Solid pod

FediPod gives you a Fediverse account whose data lives on a Solid pod. You
follow people on Mastodon, Bluesky, and other Fediverse or ATProto servers in
one timeline. Your posts, followers and settings stay on your pod.

The easiest way to run FediPod is to use it in any browser at https://fedipod.net. Nothing to install. Sign-up points you to a pod provider if you need a pod, then attaches a Fediverse identity to the pod you sign in with.


This README is about the `FediPod BrowserAgent`. There are also a number of [other ways to run FediPod](#other-ways-to-run-fedipod) which offer a variety of scenarios.  If interested in the code, see also : [architecture overview](architecture.md) and [files overview](files-overview.md). Which specs FediPod follows, and where it stops short: [specs-in-use.md](specs-in-use.md).

## Requirements

- A current browser
- A free account on a gateway such as https://fedipod.net
- A Solid pod that supports WAC (you can get one if you don't have one as part of account setup)

## Getting an account

1. Open https://fedipod.net and choose **create an account**.
2. Choose your pod provider. You'll be redirected to your provider to login if you have a pod or sign up if you need to create one.
3. Back on fedipod.net, choose your handle and where your address lives:
   on your pod, `@handle@yourpod`, or at this site, `@handle@fedipod.net`.
4. You see your Fediverse timeline.

From now on, anyone can open your profile at `https://fedipod.net/@handle@provider`, signed in or not.

## What you can do

There are two clients, both served by fedipod.net:
[Sengi](https://github.com/NicolasConstant/sengi) (MIT, by Nicolas Constant),
which you get by default, and [Phanpy](https://github.com/cheeaun/phanpy)
(MIT, by Chee Aun). The links at the top right of every page switch between
them, at any time; whichever you opened last is the one that opens next time.

You follow and unfollow, post, reply,
favourite, boost, attach media, edit and delete. Content warnings, polls with
up to four options and one or several answers, all four visibility levels, a
conversations view for direct messages, bookmarks, lists, keyword filters,
pinned posts that other servers can see, blocking and muting, and the custom
emojis other servers send.

A post can quote another post. Quote is offered on posts whose author allows
it; the quoted author's server is asked, and the quote shows as pending until
they answer. Anyone may quote your public posts, nobody your followers-only
or direct ones, and you are notified when someone does. Emoji reactions from
Misskey, Sharkey, Pleroma and Akkoma arrive as notifications showing the
emoji.

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

**Posting from another app.** Any app that speaks ActivityPub
client-to-server, dokieli for one, can post as you. It sends to the outbox
address in your actor document, which your WebID profile also names, signed in
at your pod. The post goes out the next time you open fedipod.net.

**The manage page.** `manage`, in the bar's account group, opens it: your profile,
aliases, the gateway, key rotation, recovering posts, parking, moving to
another server, retiring, and clearing a backlog. It is the same interface
the DeviceAgent has, described in [the admin interface](gui.md).

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

For these, see [Other ways to run FediPod](#other-ways-to-run-fedipod).

## Your data and your keys

Everything you publish and everything you read is stored on your pod. Your
signing key is stored there too, in a container only you can read through
your pod's login. fedipod.net holds no key: it verifies incoming mail, drops
the junk, forwards the rest to your pod, and hands your browser the app.
With an address on your pod, `@handle@yourpod`, you can detach from it at
any time and attach to a gateway of your own; your address and your data do
not change.

## Other ways to use FediPod

- [fediverse-account]() - an ESM library that supports both Solid-based and regular Fediverse accounts with methods to login, reply, boost, etc.
- [FediPod Server](packages/fedipod-server/README.md): a full ActivityPub
  server as a Community Solid Server component, giving every pod on the server
  the option of a Fediverse account.
- [FediPod BB](packages/fedipod-bb/README.md) - A Lemmy-like  bulletin board forum with the structure stored on a group pod and users' data stored on their own pod or on their Fediverse server if they don't have a pod.
- [FediPod DeviceAgent](device-agent.md) a single-user AP server that lives partly in a gateway, partly on a local device, with all data stored on your pod.
- [FediPod Groups](groups.md): hosting a discussion group of Fediverse and Bluesky users from a pod.
- [FediPod Gateway](gateway.md): A thin, always-on door running on Netlify or any small host that provides a middleman between a pod and the single-user agents. (only needed with `BrowserAgent` and `DeviceAgent`)


## Acknowledgements

This project is inspired by the fantastic [ActivityPods project](https://github.com/activitypods) and is meant to be a lightweight alternative rather than a replacement.  Thanks to [Sébastien](https://github.com/srosset81) and collaborators for all your work.  Thanks to [Damon](https://github.com/outlaw-dame), [Mikhal](https://github.com/mrkvon), [Alain](https://github.com/bourgeoa), and [Sharon](https://github.com/SharonStrats), [Michael](@m5m5:matrix.org) for testing and encouragement.  Special thanks are due to [Joseph](https://github.com/jg10-mastodon-social) whose client-to-server authentication approach and the netlify/fronted-identity ideas I borrowed from [solid-activitypub-netlify](https://github.com/jg10-mastodon-social/solid-activitypub-netlify) and to [Vincent](https://github.com/Vinnl) and [Emilia](https://github.com/ThisIsMissEm) whose ideas on the multiple Fediverse accounts sparked FediPod's support for it.

## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
