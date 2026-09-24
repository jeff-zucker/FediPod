# fediverse-account

The library lets an app take a Fediverse handle or a WebID and act as that
account.

- **`login`** — sends the person to wherever their account signs in, their
  Mastodon server or their pod, and brings them back to where they were.
- **`resume`** — on every page load, finishes a sign-in they are coming back
  from. Otherwise does nothing.
- **`current`** — the signed-in account, or nothing.
- **`signOut`** — signs them out, at their server or pod as well as in the
  browser.
- **`describe`** — says what an address is without signing in: a Mastodon
  account or a pod account, and its handle.

Once signed in, the account gives you:

- **`post`** — publishes a post as them, public, unlisted or followers-only.
- **`reply`** — answers a post.
- **`timeline`** — their home timeline, newest first.
- **`outbox`** — their own posts, newest first. Pass `rdf: true` to also get
  the real thing as RDF, for an app that wants to work with it as linked
  data rather than as this library's own shape.
- **`follow`** — follows someone by handle.
- **`favourite`**, **`boost`** — as they say.
- **`profile`** — who they are as their server or pod shows them: name,
  handle, picture, bio, counts, profile page, and the WebID for a pod
  account.
- **`notice`** — a sentence to show them, or nothing. A browser-based
  FediPod account gets: "Because you have a browser-based account, your
  posts and interactions will only go out to the Fediverse when your browser
  is opened to your account."
- **`handle`, `name`, `kind`** — who they are, and whether the account is on
  Mastodon or a pod, for an app that wants to know.
- **`signOut`** — the same as above.

The app never asks which kind it has. A Mastodon account acts at once. A
pod account's actions are carried out by its own agent, at once for a
DeviceAgent or Server account, and when fedipod.net is next open for a
browser-based one.

Three files, no dependencies. It runs in a page and in a service worker.
The one exception: `outbox({ rdf: true })` needs the `jsonld` package, and
only loads it when that flag is actually used.

[The demo](https://jeff-zucker.github.io/FediPod/) shows the sign-in and
the profile that comes back.

## Get it

From a CDN, with nothing to install:

```js
import { fediAccount } from 'https://cdn.jsdelivr.net/npm/fediverse-account@0.1.0/fedi-account.mjs';
```

Or from npm:

```bash
npm install fediverse-account
```

```js
import { fediAccount } from 'fediverse-account';
```

## Use

```js
import { fediAccount } from 'fediverse-account';
const accounts = fediAccount({ dbName: 'my-app', clientName: 'My app' });

await accounts.resume();                                   // on every page load

signInButton.onclick = () => accounts.login(addressField.value);

const me = await accounts.current();                       // null when nobody is signed in
if (me?.notice) show(me.notice);
await me.post({ text: 'Hello from my app' });
for (const p of await me.timeline({ limit: 20 })) render(p);
for (const p of await me.outbox({ limit: 20 })) render(p);
await me.follow('@aisha@her.server');
await me.reply(p.url, 'Well said');
await me.signOut();
```

## The details

- **`fediAccount({ dbName, clientName })`** — sets the library up for your
  app, once. `dbName` keeps this app's sign-ins apart from another app's on
  the same origin. `clientName` is what the person sees on the consent
  screen.
- **`login(address, { returnTo, redirectUri })`** — `@kwame@mastodon.social`
  goes to Mastodon; `@mei@fedipod.net`, or a WebID, goes to the pod. They
  come back to this page unless `redirectUri` says otherwise, and are
  returned to where they were unless `returnTo` says otherwise.
- **`post({ text, inReplyTo, visibility })`** — `visibility` is `public`,
  `unlisted` or `followers`.
- **`reply(post, text)`** — the post is named by its address or its id.
- **`timeline({ limit })`** — each post as `{ id, url, author: { id, handle,
  name }, html, published, inReplyTo }`.
- **`outbox({ limit, rdf })`** — the same shape as `timeline`, but only this
  account's own posts. With `rdf: true`, the returned array also carries
  `.rdf`: the real outbox parsed into an RDF/JS quad array — for a Mastodon
  account too, since a Mastodon server is itself an ActivityPub server with
  a real actor and outbox, same as a pod's. It comes back empty on a server
  that requires a signed request just to read that document, which some
  do. Reading it needs the `jsonld` package available to your app; without
  `rdf: true` nothing changes and nothing extra loads.
- **`fetch`** — the raw authenticated fetch, for anything the above does not
  cover.
- **`actor`** — the account's ActivityPub id.

Every action answers `{ sent: true }` when the server did it, or `{ queued:
true }` when the account's own agent will carry it out.

## What it cannot do

- **An address whose server is neither a Mastodon-family server nor a Solid
  pod** is refused with a sentence naming the host.
- **A browser-based FediPod account acts when its browser is open.** Posts,
  follows and replies wait at the account's outbox until fedipod.net is next
  open in some browser, and its timeline is the one that browser last built.
  The account's `notice` says so; show it.
- **A Mastodon account has no pod.** An app that keeps things on a pod has
  nowhere to keep them for such a person.

## Where the sign-in goes, and what stays in the browser

A Mastodon account signs in at its own server, which asks the person to
approve your app once. The token it grants stays in their browser and is
handed back to the server at sign-out.

A pod account signs in at the pod's login provider. The key that proves the
sign-in is made in the browser and cannot be read out of it, even by a
script on the page. The person stays signed in across browser restarts
until they sign out, and sign-out is reported to the provider.
