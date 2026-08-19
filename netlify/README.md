# Running the gateway on Netlify

What a gateway is, and how someone attaches their pod to one, is in
[gateway.md](../gateway.md). This is the deployment: what is here, and what a
host has to set.

A reference deployment runs at **https://fedipod.net/**.

## What is here

Both functions are thin adapters around FediPod's own logic, which is plain
runtime-agnostic Node:

| File | What it serves | Around |
|---|---|---|
| `functions/inbox.mjs` | One person's door: verify a delivery, forward it to their pod. | `lib/gateway-core.mjs` |
| `functions/front.mjs` | A door for many people: WebFinger, each public face, per-person delivery routing, and the signup and attach flow. | `lib/front-core.mjs` |

Another host needs only its own adapter calling the same `handleDelivery`. A
Community Solid Server can run the same door as a component of itself instead
— see [packages/fedipod-server](../packages/fedipod-server/README.md).

## Deploying

This repo, with `netlify.toml` as it stands. The functions read these
environment variables:

| Variable | What it is |
|---|---|
| `FEDIPOD_FRONT_HOST` | The host the door answers on. |
| `FEDIPOD_FRONT_ORIGIN` | Its origin. |
| `FEDIPOD_GATEWAY_WEBID` | The WebID stamped on verification receipts. |
| `FEDIPOD_DIRECTORY_JSON` | The starting directory, as JSON: which handles exist and which pod each belongs to. |

Attachments people make through the signup page are kept in a Netlify Blobs
store named `directory`, and take precedence over the rows in
`FEDIPOD_DIRECTORY_JSON`.

## What the door needs from a pod

Permission to write into that person's inbox, and nothing else. FediPod's
default inbox is public-Append, in which case the door needs no credential at
all and writes with a plain PUT. Where an inbox is closed, give the door's own
low-privilege WebID Append on it — never an owner credential.

The door holds no signing key, so it cannot post as anyone. It reads only
public data to decide what concerns a given person: their published followers
and following, and a small public policy document their agent writes with a
mirror of their blocklist.

## The two shapes of attachment

Most people keep their identity on their own pod and move only the advertised
inbox to the door, so they stay `@me@their.pod` and the door is just mail
handling. A person can instead take a handle on the door's own domain, which
makes their public addresses read `@name@this-host` while their data stays on
their pod; that mode is chosen explicitly, per person, at attach time.
