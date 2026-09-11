<!-- CLAUDE 2026-09-11 — new file: the architecture and protocol sections
     moved out of README.md. Review pending; delete this marker when done. -->
# Architecture

FediPod splits an ActivityPub server into two parts. The pod provides
discovery and stores the public record: the actor, its outbox, followers and
posts, and the inbox that receives deliveries. The agent provides the
ActivityPub actions: it drains the inbox, builds the timeline, signs and
delivers, and answers the Mastodon client. The agent runs either in your
browser, served by fedipod.net, or as [the installed agent](installed-agent.md)
on your own machine. Private direct messages, followers-only posts and the
pending-follow and blocked collections live on the pod in an area protected by
access control.

A [gateway](gateway.md) can stand in front of the pod: an always-on door that
verifies each delivery where the signature can still be checked, drops spam,
and forwards the rest to the pod inbox with a receipt. It holds no key. The
browser version always has one; the installed agent may use one. Any
lightweight host will do, Netlify included.

[FediPod Server](packages/fedipod-server/README.md) puts the agent inside a
Community Solid Server, so anyone with a pod on that server can opt in to a
Fediverse account fed by the server itself.

![The browser version](https://raw.githubusercontent.com/jeff-zucker/FediPod/main/browser.svg)

![The installed agent, with a gateway](https://raw.githubusercontent.com/jeff-zucker/FediPod/main/architecture.svg)

## Protocol conformance

FediPod is a full ActivityPub server, on both of the spec's profiles:
server-to-server (§7) and client-to-server (§6). `POST /ap/outbox` on the
installed agent takes an activity, or a bare Note, and does the id-minting,
side-effects and delivery, authenticated by a Solid-OIDC token whose WebID is
the owner's. The Mastodon REST API is the everyday client interface; C2S is
the spec's own.

Group actors follow FEP-1b12: a carried post names the group as its
`audience`, the moderator roster is published as the actor's `attributedTo`,
a followed group's announced `Delete` of a post it carried is honoured, and
the group's own moderation is announced to the membership. The FEP-4ccd
pending-follow collections and the FEP-c648 blocked collection are published
as owner-only documents. See [Groups](groups.md).
