# FediPod

- access the fediverse from a Solid pod

`FediPod` is a merger of three federating protocols - feeds from Mastodon and other Fediverse servers and from Bluesky and other ATProto servers, with all user data stored on a Solid pod. There are four different kinds of FediPod accounts :

| Kind of Account | Description | User requirements | Host requirements |
|---|---|---|---|
| FediPod Solo | Browse & interact with the fediverse and ATProto from a Solid pod | an always-on pod, a usually on local agent | — |
| FediPod Group | Host a discussion group of fediverse/ATProto users from a Solid pod | an always-on pod, a usually on local agent | — |
| FediPod Gateway | Solo or Group with spam filtering & optional community identity | same + gateway pass-through account | any always-on host, Netlify will do |
| FediPod Server | Full ActivityPub server as a CSS component | a pod on a CSS server implementing the FediPod component | a CSS server implementing the FediPod component |

## Installation & Setup

You may sign up for free for a solo, group, or gateway account at https://fedipod.net/ .  Wizards will walk you through install and setup. If you want to host a community, instructions are available for [Fediverse User Group](https://github.com/jeff-zucker/FediPod/blob/main/groups.md), the lightweight [FediPod Gateway](https://github.com/jeff-zucker/FediPod/blob/main/gateway.md) and for the full CSS component [FediPod Server](https://github.com/jeff-zucker/FediPod/blob/main/packages/fedipod-server/README.md). 

### Running the agent - 

From the install folder, run `npm start`. You may optionally add a port number (`npm start 8081`) to change your local agent's port (default is 8030).

Now point your browser (any) at `https://localhost:8030` — or your own port if you set one — and there you go!

### Running the agent as a service (recommended)

If you don't want to run the agent each time, you can install it as a system service. This is recommended as leaving the agent off causes your mail to pile up on the pod host.  To create a system service :
```
npm run install-service
```
It registers every identity on this machine, one service each, so all of your actors start at boot. An identity running in a terminal is stopped and taken over by its service.

`npm run uninstall-service` reverses it. 

## Managing your FediPod install

You can manage your posts, see logs, park, move, transfer your account and perform other actions. See the [GUI admin](https://github.com/jeff-zucker/FediPod/blob/main/gui.md) and [CLI admin](https://github.com/jeff-zucker/FediPod/blob/main/cli.md) pages.

You can also use the admin tools to create other actors, either groups or persons.  You may have as many as you want on the local machine, but each one needs a separate pod.

Every agent checks once a day whether a newer FediPod is published. When one
exists, the record page offers **Update**, and `node bin/fedipod.mjs update`
does the same from the terminal. `AP_UPDATE_CHECK=0` turns the check off.

## A FediPod.net Gateway account (reccommended)

Most of what a fediverse inbox receives is broadcast noise. A gateway is a
shared, always-on door that verifies each delivery, drops the junk, and
passes the rest to your pod — while your key and data stay on your own
pod. There is a free gateway at [fedipod.net](https://fedipod.net/). Attaching to it or detaching from it is a few wizard-guided clicks.

Users are recommended to associate with a gateway as it reduces the mail load on your pod host.

## Fediverse Clients

The UI is the bundled [Phanpy](https://github.com/cheeaun/phanpy)
client (MIT, by Chee Aun). It is served same-origin over the agent's Mastodon client-API facade. Log in with one click, using `https://localhost:8030` (or your own port) as the instance.

The agent federates for real: follow/unfollow, post, reply, favourite,
boost, media, delete; incoming boosts from people you follow and a
configurable public-hashtag feed (`POST /tagfeed`) fill the timeline.
Also: editing posts, content warnings, voting in polls, all four visibility
levels (followers-only and direct posts work only on a pod that enforces
WAC access control — on one that doesn't, the composer refuses and says why),
a conversations view for direct messages, bookmarks, favourites, lists,
keyword filters, scheduled posts, pinned posts (visible from other servers),
blocking and muting from the client, custom emojis, and web-push
notifications that reach you while the client is closed.

### Other clients

- **Web clients**: drop any static Mastodon client dist into `ui/<name>/`
  and it is served at `/<name>/`, same-origin — see `ui/README.md`.
- **Desktop clients** (Tuba, Whalebird, …): add `https://localhost:8030` (or other port for other agent) as a
  custom instance.
- **Streaming**: the agent serves the Mastodon streaming API
  (`/api/v1/streaming`, WebSocket) so clients update live instead of polling.

## Bluesky and ATProto

`FediPod` includes experimental support for ATProto. A Bluesky connection lets your `FediPod` agent drive an existing Bluesky (or other ATProto) account alongside your fediverse identity. When you post a public post from `FediPod`, it will be cross-posted to Bluesky as a mirror (a toggle you can turn off). Private DMs from `FediPod` to Bluesky are not currently supported.  Bluesky replies and activity flow into your timeline so you see, for example, a combined Bluesky and Mastodon feed.  You can like, boost, and reply to Bluesky posts from within `FediPod`.  None of these features require `Bridgy Fed`, however, fully joining a `FediPod` group from a Bluesky client other than `FediPod` does require a bridge.

## Architecture

`Activitypods` requires a server which provides both an ActivityPub server and a Solid server and thus requires a specific server setup.  `FediPod Solo & FediPod Group`, can be installed on any subdomained https-served pod without any modification to the server.  It does this by splitting the ActivityPub server into two parts.  The pod part provides discovery (webfinger) and stores mostly public data while the local agent provides the ActivityPub actions and storage for most private data. The exception is private direct messages which are stored on the pod protected by ACL resources. The same protected area also holds followers-only posts, and the pending-follow
and blocked collections. [`FediPod Gateway`](https://github.com/jeff-zucker/FediPod/blob/main/gateway.md) can be supported from any lightweight Internet-facing box including Netlify, it does not require a full server and can work with any FediPod-capable pod.  [`FediPod Server`](https://github.com/jeff-zucker/FediPod/blob/main/packages/fedipod-server/README.md) works as a CSS server component.  If the pod host installs it, anyone with a pod on that server can opt-in to using their pod as a FediPod account fed by the server itself.

![Fedipod Gateway flow](https://raw.githubusercontent.com/jeff-zucker/FediPod/main/architecture.svg)

### Protocol conformance

FediPod is a full ActivityPub server, on both of the spec's profiles:
server-to-server (§7) and client-to-server (§6) — `POST /ap/outbox` on the
agent takes an activity (or a bare Note) and does the id-minting,
side-effects and delivery, authenticated by a Solid-OIDC token whose WebID is
the owner's. The Mastodon REST API is the everyday client interface; C2S is
the spec's own.

Group actors follow FEP-1b12: a carried post names the group as its
`audience`, the moderator roster is published as the actor's `attributedTo`,
a followed group's announced `Delete` of a post it carried is honoured, and
the group's own moderation is announced to the membership. The FEP-4ccd
pending-follow collections and the FEP-c648 blocked collection are published
as owner-only documents. See [Groups](https://github.com/jeff-zucker/FediPod/blob/main/groups.md).

## Acknowledgements

This project is inspired by the fantastic [ActivityPods project](https://github.com/activitypods) and is meant to be a lightweight alternative rather than a replacement.  Thanks to [Sébastien](https://github.com/srosset81) and collaborators for all your work.  Thanks to [Damon](https://github.com/outlaw-dame), [Mikhal](https://github.com/mrkvon), [Alain](https://github.com/bourgeoa), [Sharon](https://github.com/SharonStrats), and [Vincent](https://github.com/Vinnl) for testing and encouragement.  Special thanks are due to [Joseph](https://github.com/jg10-mastodon-social) whose client-to-server authentication approach and the netlify/fronted-identity ideas I borrowed from [solid-activitypub-netlify](https://github.com/jg10-mastodon-social/solid-activitypub-netlify).

## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
