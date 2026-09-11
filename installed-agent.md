<!-- CLAUDE 2026-09-11 — new file: the device-based build, moved out of
     README.md. Review pending; delete this marker when done. -->
# The installed agent

FediPod can also run as a program on your own machine, in front of the same
kind of pod. It does everything the browser version at fedipod.net does, plus
what a browser tab cannot: it keeps running while no tab is open, so scheduled
posts go out and push notifications reach you; it serves the Mastodon streaming
API, so clients update live; any Mastodon client, phone app or desktop, can
connect to it; and it can host a [group](groups.md).

## Requirements

- Node 20 or newer.
- A Solid pod with a host name of its own, such as
  `https://alice.solidcommunity.net/`. A pod on a path of a shared host cannot
  be a Fediverse address.
- Followers-only and direct posts need a pod that enforces WAC access control;
  on one that does not, the composer refuses those two and says why.
- While the agent is off, your mail waits on your pod's host. Run it as a
  service, or attach to a gateway, so it does not pile up there.

## Installing

```
npm install -g fedipod
```

## Running

Run `fedipod start`. Add a port to change the local agent's port, for example
`fedipod start --port 8081`; the default is 8030. Then point any browser at
`https://localhost:8030`, or the port you chose, and the setup pages take it
from there.

## Running as a service

```
fedipod install-service
```

It registers every identity on this machine, one service each, so all of your
actors start at boot. An identity running in a terminal is stopped and taken
over by its service. `fedipod uninstall-service` reverses it.

## Managing

Posts, logs, parking, moving, transferring and the rest are on the
[admin interface](gui.md); starting, stopping and what a page cannot do are in
[CLI admin](cli.md). The admin tools also create other actors, groups or
persons. You may have as many as you want on one machine, each with a pod of
its own.

Every agent checks once a day whether a newer FediPod is published. When one
exists, the record page offers **Update**, and `fedipod update` does the same
from the terminal. `AP_UPDATE_CHECK=0` turns the check off.

## A gateway account

Most of what a Fediverse inbox receives is broadcast noise. A
[gateway](gateway.md) is a shared, always-on door that verifies each delivery,
drops the junk, and passes the rest to your pod, while your key and data stay
on your pod. There is a free one at [fedipod.net](https://fedipod.net/).
Attaching or detaching is a few wizard-guided clicks from your agent, and it
takes the mail load off your pod's host.

## Clients

The bundled client is [Phanpy](https://github.com/cheeaun/phanpy) (MIT, by
Chee Aun), served by the agent itself, and logging in is one click. If you
ever enter the instance by hand, use the address on the record's **local
host** row.

- **Other web clients**: drop any static Mastodon client dist into
  `ui/<name>/` and it is served at `/<name>/`; see `ui/README.md`.
- **Desktop and phone clients** (Tuba, Whalebird, and the like): add
  `https://localhost:8030`, or your agent's port, as a custom instance.
- **Streaming**: the agent serves the Mastodon streaming API at
  `/api/v1/streaming`, so clients update live instead of polling.
- **Web push**: notifications reach you while the client is closed.
- **Scheduled posts** go out at the time you picked.

Polls, content warnings, editing, all four visibility levels, direct
messages, bookmarks, favourites, lists, keyword filters, pinned posts,
blocking and muting, and custom emojis work as in the browser version.

## Bluesky, and your other Fediverse accounts

A Bluesky connection lets the agent drive an existing Bluesky, or other
ATProto, account alongside your Fediverse identity: public posts are
cross-posted as a mirror, with a toggle to turn it off; Bluesky replies and
activity flow into your timeline; you can like, boost and reply to Bluesky
posts. Direct messages to Bluesky are not supported.

An account on Mastodon or any server speaking the Mastodon API can be
connected from the **Other identities** row of the admin page. Its home
timeline and notifications join your feed, a post both accounts see appears
once, and favouriting, boosting and replying act as the account the post came
through. The token it hands back stays on this machine.
