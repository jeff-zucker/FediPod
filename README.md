# Solid ActivityPub

- access the fediverse from a Solid pod

`Solid ActivityPub` is a standalone, single-user ActivityPub agent that stores your public data on almost any subdomained Solid Pod and runs on any device that supports node >20. The agent can be moved from one device to another without any change to your account. There is support for fediverse group formation and management, see [Groups](groups.md).

This project is inspired by the fantastic [ActivityPods project](https://github.com/activitypods) and is meant to be a lightweight alternative rather than a replacement.

## Requirements

* a web browser
* node 20 or greater
* a local or remote Solid pod that
  * supports subdomains and https
  * has a domain name
  * is almost always on

Note : if you don't have a pod account, setup will easily create one for you.

## Installation

In a terminal :

```
git clone https://github.com/jeff-zucker/solid-activitypub;
cd solid-activitypub;
npm install
```

## Setup

You only have to do setup once per device. Just run `npm start` from the project folder. From nothing — no fediverse account, no pod — one command creates the account, the pod, the actor, and leaves you in the client looking at your fediverse home with a pre-stocked home feed. Setup will prompt you for needed information. If you already have a pod, you'll be offered the opportunity to either create a new pod for your ActivityPub data or to store it on your existing pod.

### Running the agent

From the install folder, run `npm start`. You may optionally add a port number (`npm start 8081`) to change your local agent's port (default is 8030).

Now point your browser (any) at http://localhost:8030 — or your own port if you set one — and there you go!

### Running the agent as a service

If you don't want to run the agent each time, you can install it as a system service. This is recommended as leaving the agent off causes your mail to pile up on the pod host.  To create a system service :
```
npm run install-service
```
It registers every identity on this machine, one service each, so all of your actors start at boot. An identity running in a terminal is stopped and taken over by its service.

`npm run uninstall-service` reverses it. 

## Managing your Solid-ActivityPub install

You can manage your posts, see logs, park, move, transfer your account and perform other actions. See the [GUI admin](gui.md) and [CLI admin](cli.md) pages.

You can also use the admin tools to create other actors, either groups or persons.  You may have as many as you want on the local machine, but each one needs a separate pod.

## Fediverse Clients

The UI is the bundled [Phanpy](https://github.com/cheeaun/phanpy)
client (MIT, by Chee Aun); patched to allow the loopback http origin. It is served same-origin over the agent's Mastodon client-API facade. Log in with one
click, using `localhost:8030` (or your own port) as the instance.

The agent federates for real: follow/unfollow, post, reply, favourite,
boost, media, delete; incoming boosts from people you follow and a
configurable public-hashtag feed (`POST /tagfeed`) fill the timeline.
Also: editing posts, content warnings, polls and voting, all four visibility
levels (followers-only and direct posts work only on a pod that enforces
access control — on one that doesn't, the composer refuses and says why),
a conversations view for direct messages, bookmarks, favourites, lists,
keyword filters, scheduled posts, pinned posts (visible from other servers),
blocking and muting from the client, custom emojis, and web-push
notifications that reach you while the client is closed.


### Other clients

- **Web clients**: drop any static Mastodon client dist into `ui/<name>/`
  and it is served at `/<name>/`, same-origin — see `ui/README.md`.
- **Desktop clients** (Tuba, Whalebird, …): add `http://localhost:8030` (or other port for other agent) as a
  custom instance.
- **Streaming**: the agent serves the Mastodon streaming API
  (`/api/v1/streaming`, WebSocket) so clients update live instead of polling.


## Architecture

`Activitypods` requires a server which provides both an ActivityPub server and a Solid server and thus requires a specific server setup.  `Solid ActivityPub`, on the other hand, can be installed on any subdomained https-served pod.  It does this by splitting the ActivityPub server into two parts.  The pod part provides discovery (webfinger) and stores public data while the local server provides the ActivityPub actions and storage for private data.

![Solid ActivityPub flow](architecture.svg)


## Transparency

This package was created using a heavily hectored claude.

## License

(c) Jeff Zucker, 2026; may be freely used with an MIT license.
