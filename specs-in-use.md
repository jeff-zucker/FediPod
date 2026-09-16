# Specs FediPod follows

Which standards FediPod implements, where each one lives, and where FediPod
stops short. FediPod comes in four builds: the **BrowserAgent** (fedipod.net,
the agent in a service worker), the **DeviceAgent** (the agent on your own
machine), the **Gateway** (a shared front that verifies mail and hosts
addresses, holding no key), and the **Server** (the agent inside a Community
Solid Server). Where a line differs by build, it says so.

## The shape of the system

A Mastodon client (Phanpy or any other) talks to the agent through a Mastodon
REST API facade. Federation with other servers happens over ActivityPub
server-to-server. The pod serves the public ActivityPub documents (actor,
outbox, collections) as static read-only resources.

FediPod also implements ActivityPub's client-to-server protocol (§6). The
DeviceAgent and the Server take `POST /ap/outbox` on the agent: an activity,
or a bare object wrapped in a Create per §6.2.1, authenticated by a Solid-OIDC
token, DPoP-bound, whose WebID must be this identity's owner, or by the
facade's own bearer (`lib/client/c2s.mjs`, `lib/client/oidc-auth.mjs`). The
Gateway takes the same POST at the account's outbox address on its own origin
(`lib/gateway/front-core.mjs`, `lib/gateway/gateway-core.mjs`
handleOwnerPost): it checks the owner's token, writes the post into the pod
inbox with a receipt marking it as the owner's, and the agent's inbox drain
hands it to the same dispatcher — so a BrowserAgent or DeviceAgent account
behind a Gateway is posted to from any client, and the post goes out when the
agent next runs. Every verb routes to the same helpers the facade uses, so
client-to-server adds no second write path. The Mastodon facade is the
everyday client interface; client-to-server is the spec's own.

## Federation side (talking to other servers)

- **ActivityPub server-to-server** — inbox delivery and intake; the agent
  sends activities to remote inboxes (`lib/core/deliver.mjs`) and receives and
  verifies incoming ones (`lib/core/intake/`).
- **ActivityStreams 2.0** — the vocabulary and JSON-LD shapes for actors,
  Notes, collections, and `as:Public` addressing (`lib/core/wire.mjs`).
- **HTTP Signatures, draft-cavage flavor** — request signing with RSA keys
  (`lib/core/keys.mjs`); this is the draft version Mastodon verifies, not
  RFC 9421. Inbound verification differs by build. Server: verified — a POST
  to the pod's own inbox container is claimed by the component, checked with
  `lib/gateway/httpsig.mjs` while the headers exist, and written with an HMAC
  receipt the drain trusts (`lib/server/embed.mjs`,
  `packages/fedipod-server/src/handler.ts`, the receipt itself in
  `lib/gateway/gateway-core.mjs`). Both the cavage draft and RFC 9421
  (`Signature-Input`, `Content-Digest`) are accepted at the door.

BrowserAgent and DeviceAgent:
  verified only when the owner attaches to a Gateway
  (`lib/gateway/gateway-core.mjs`, `netlify/`), which verifies at the door and
  forwards with the receipt. Without a receipt, authenticity is
  verify-by-dereference at the drain.
- **WebFinger** — account discovery. Published to the pod's `.well-known` for
  an address on the pod; answered by the Gateway for an address at the Gateway.
- **Account migration (Move + alsoKnownAs)** — both directions: outbound via
  `publishMove`, and inbound — the actor lists old accounts elsewhere as
  aliases (`config.aliases` → `alsoKnownAs`), which is what a Mastodon-family
  server checks before sending its Move here; the follower wave lands via
  auto-accept (`autoAcceptFollows`) or bulk admit. A Move from an account
  you follow is checked at its origin and shown as a notification; following
  the new account is your choice.
Mastodon-format CSV exports
  (follows, blocks, mutes, lists, domain blocks) import through a paced worker
  (`lib/connections/import.mjs`).
- **NodeInfo 2.0** — server self-description at `.well-known/nodeinfo`.
- **FEP-1b12** — the group-actor pattern, hosted by the DeviceAgent: a group
  actor Announce-wraps member activity to fan it out to followers. The carry
  names the group as its `audience`, a configured moderator roster publishes
  as the actor's `attributedTo` collection, and a followed group's announced
  `Delete` of a post it carried to us is honored (the carrier unsaying its
  carry — no new party is trusted). A group's own moderation is broadcast to
  the membership as Announce-wrapped activities — the ban (Block) on eject or
  block, the unban (Undo{Block}), and roster changes (Add/Remove targeting the
  moderators collection); a person's blocks never go on the wire. Inbound
  moderation from a LISTED moderator (Block, Undo{Block}, Delete of a carried
  post, roster Add/Remove) is **queued, not run** — a delivery proves nothing
  about its sender, so the ask waits for the operator to apply or dismiss
  (`GET /modqueue`, `POST /modqueue {id, action}`).
- **FEP-4ccd** — `pendingFollowers` / `pendingFollowing` collections: the
  follows in limbo, published as owner-only documents in the private container
  and advertised on the actor — only where the pod provably enforces the
  private ACL, the same bar private posts clear.
- **FEP-c648** — the `blocked` collection: blocked actor IRIs, owner-only, same
  ACL bar. Domain blocks stay local; the FEP's `blocks` activity-log half is
  not implemented (a person mints no Block activities; a group's Block
  travels inside its moderation Announce). A Block that arrives verified
  drops the sender's follow of you and yours of them.

<!-- CLAUDE 2026-09-15 — quote posts and emoji reactions; delete these markers when done -->
- **FEP-044f (quote posts)** — both directions. A note that quotes carries
  `quote`, with Fedibird's `quoteUri` and Misskey's `_misskey_quote` beside it,
  and a `QuoteRequest` goes to the quoted author; their `Accept` names a
  `QuoteAuthorization`, which is fetched at their origin and compared before
  the note is restated with `quoteAuthorization`. Inbound: a `QuoteRequest` on a
  public or unlisted post is answered with a `QuoteAuthorization` written beside
  the post and an `Accept` carrying it; on a followers-only or direct post, a
  `Reject`. Every note carries an `interactionPolicy` (GoToSocial's terms, as
  Mastodon writes them) with `canQuote`. A received quote is read from any of
  the four spellings in use, FEP-e232's tag link included, and its
  authorization is checked at the quoted origin rather than believed
  (`lib/core/wire.mjs`, `lib/core/wire-quotes.mjs`, `lib/core/intake/activities.mjs`).
- **Emoji reactions** — inbound only: `EmojiReact` (litepub) and a `Like`
  carrying the emoji as `content`, from Misskey, Sharkey, Pleroma and Akkoma;
  custom emoji images ride the `Emoji` tag. `Undo` withdraws one. Read through
  the litepub schema those servers name per instance, held here
  (`lib/core/contexts/litepub-0.1.json`). Nothing outbound: the client has no
  reaction control.
<!-- /CLAUDE -->

<!-- CLAUDE 2026-09-15 — FediPod-BB, the forum package; delete these markers when done -->
- **FEP-7888 (conversation contexts)** — in FediPod-BB (`packages/fedipod-bb`):
  a topic is an `OrderedCollection` owned by its category (`attributedTo`),
  named on every post as `context`; a post is placed by its `context`, else
  by its reply chain, else opens a topic. Not read by FediPod's own timeline,
  which threads by `inReplyTo` alone.
- **FEP-f15d (context relocation and removal)** — FediPod-BB announces
  `Remove{topic, target: category}` and `Move{topic, origin, target}`, and a
  `Delete{post, origin: topic}` for a post taken out of a topic; the same
  three arriving from a listed moderator are queued as asks.
- **FEP-11dd (context ownership)** — a topic holds what its category carried
  and nothing else; a non-member's post is neither carried nor placed.
- **FEP-4f05 (soft deletion)** — a removed copy or topic is a `Tombstone`
  with `formerType`.
- **Group actors as forum categories (FEP-1b12)** — FediPod-BB runs one
  FediPod group per category, unchanged; the forum adds one inbox above them
  and routes by addressing. Not yet: FEP-f228 backfilling of a remote
  context; `postingRestrictedToMods` and the other Lemmy terms.
<!-- /CLAUDE -->

## Client side (talking to the user's app)

- **Mastodon REST API** — the facade clients log into and post through
  (`lib/client/masto/`), including OAuth for client sign-in. All four builds
  except the Gateway.
<!-- CLAUDE 2026-09-15 — what the API version claim covers; delete these markers when done -->
  The instance document claims `api_versions.mastodon: 7`: grouped
  notifications (`/api/v2/notifications`, one group per notification), the
  filter blur action, and quote posts (`quoted_status_id` on compose, `quote`
  and `quote_approval` on a status, `quote` and `emoji_reaction` notification
  types). Nothing past 7 is claimed.
<!-- /CLAUDE -->
- **Mastodon streaming API** — live timeline updates
  (`lib/client/streaming.mjs`), on the DeviceAgent and the Server. The
  BrowserAgent has no socket to hold and says so in its instance document, so
  a client polls.
- **Web Push** — notifications to the client (`lib/client/webpush.mjs`), on
  the DeviceAgent and the Server; not on the BrowserAgent, declared the same
  way.
- **`toot:` namespace** — Mastodon's ActivityStreams extensions where clients
  expect them, e.g. `toot:featured` for pinned posts.

## Storage side

- **Solid** — the pod holds the public ActivityPub documents and is the
  account's durable home; discovery (WebFinger) and public data live there.
  The agent's own state (timeline index, contacts, queue) lives in an
  owner-only container on the pod as well.

## Bluesky side

- **ATProto XRPC** — the agent is an API client of an existing Bluesky account
  (bsky.social or any PDS): app-password sessions with refresh,
  `app.bsky.feed.post` records with rich-text facets, blob uploads for images,
  reposts, and graph blocks. Public posts cross-post (never unlisted,
  followers-only, or direct); the account's timeline and notifications mix
  into the home feed read-only. The agent never hosts ATProto — no PDS, no
  firehose.
- **Bridgy Fed** — the bridge is the assumed path for Bluesky accounts joining
  a group: a bridged account is a plain AP actor and takes the normal FEP-1b12
  paths. Unbridged accounts get a degraded Bluesky-only membership through the
  group's own account (follow = join, mention = submission, repost = carry)
  and a one-time nudge toward the bridge.

## Capability rundown

Item-by-item answers to the Solid/ActivityPub interop checklist.

### Receiving activities

- **LDN inboxes** — yes in practice: the inbox is a public-Append LDP
  container on the pod that remote servers POST to (the LDN receiver
  pattern); discovered via the actor doc's `inbox`, which the
  ActivityStreams context maps to `ldp:inbox`.
  With a
  Gateway attached, or on the Server, the advertised inbox is the door that
  verifies and forwards into that container.
- **ActivityPub Actors** — yes; full actor doc (Person or Group) on the pod
  with keys, endpoints, and collections.
- **Webfinger** — yes; at the pod's `.well-known/webfinger`, or at the
  Gateway's for an address there.
- **Actor and webid relationships** — yes, both directions: the WebID profile
  lists the actor as a `foaf:account` (typed `foaf:OnlineAccount` and
  `as:Person` or `as:Group`, with the handle as `foaf:accountName`), and the
  actor doc names the WebID in `alsoKnownAs`. Retiring the account leaves
  the profile's link in place.

### Authentication and authorisation

- **Webid with WAC or ACP** — WAC yes: the agent writes `.acl` docs (public
  Read on published docs, public Append-only on the inbox, owner full
  control). ACP: detected and left alone — on a pod whose access control is
  ACP nothing is written, so public documents are not made readable there
  and private posts stay off.

- **Post signing** — outbound yes (draft-cavage, RSA-SHA256). Inbound: see
  HTTP Signatures above — verified on the Server and behind a Gateway;
  otherwise intake verifies by re-fetching the claimed object and actor from
  their origin.

### Inbox processing requirements

- **Shape validation** — SHACL, against `lib/core/shapes/activitystreams.ttl`:
  an actor must have one `ldp:inbox`, and Create/Follow/Accept/Undo must each
  name one actor and one object. Nothing is rejected for failing — the failure
  is recorded as a dead letter marked `shapeOnly` and the activity is handled,
  because a shape strict enough to catch something real is strict enough to
  reject some implementation's quirk, and which one is learned from the record
  rather than guessed. Structural checks on type and required fields do the
  deciding.
- **Verification of post actors** — yes, by dereference: actor and object are
  re-fetched from their origin, which must vouch for them.
- **Side effects** — yes; each activity type applies its effects (followers,
  timelines, notifications, Undo/Delete honored). An Undo of a Like or an
  Announce takes back what it left; a carried post leaves the timeline when
  its carrier unsays the carry.
- **json-ld context caching** — yes. Every ActivityStreams document is read as
  JSON-LD (`lib/core/as2.mjs`): expanded to a graph, which is what a shape is
  checked against, and compacted against the standard context, which is what
  the handlers read — so a document whose terms are aliased means the same
  thing as one written the usual way. The contexts Fediverse documents name
  are held as files in `lib/core/contexts/`; a document naming any other
  context URL is read against the contexts held, and the URL is never fetched,
  so reading a stranger's activity never dereferences an address they chose.
  A document that cannot be read as JSON-LD is read as plain JSON rather than
  lost, and the reason recorded.

### Sending activities

- **Actor public key** — yes, in the actor doc (`publicKey`). The DeviceAgent
  and the Server also publish an Ed25519 key as `assertionMethod`
  (FEP-521a), which signs their activities (FEP-8b32); the BrowserAgent has
  none.
- **Handling of private key** — never in a public document. BrowserAgent: on
  the pod, in an owner-only container, encrypted under the account password;
  an opened copy stays in that browser's storage as a non-extractable key.
  DeviceAgent: PEM on disk with 0600 permissions, or in the owner-only pod
  state. Server: in the owner-only pod state. Gateway: holds no key.
- **Sending a signed activity** — yes; every delivery is signed. A reply is
  delivered to the author of the post it answers, mentioned or not; an inbox
  that answers 410 is not retried and the follower behind it is dropped.

### Following activities

- **Sending Follow / Undo / Accept** — yes, all three.
- **Follower and following collections** — yes, published to the pod and
  updated on change.

### Outbox endpoint

- **Posting to outbox** — yes. Actors the client addresses by id in `to`
  and `cc` are listed and delivered to; those in `bto` and `bcc` are
  delivered to and never listed. The dispatcher (`lib/client/c2s.mjs`) takes
  Create of any object (a Note, a Question, or anything else — a Web
  Annotation is stored as sent, its own context kept, under this actor),
  Update, Delete, Follow, Like, Announce, Undo, Block, Add/Remove (pins),
  Accept/Reject (held requests); a bare object is wrapped in a Create; an
  object with no `to`/`cc` is a public post; the client's `Slug` names the new
  document when the name is free. A Question's choices are read from `oneOf`
  (one answer) or `anyOf` (several) and its close time from `endTime`
  (`lib/core/polls.mjs`). Move and Delete-of-actor stay on the admin surface,
  which asks twice. Where the POST lands differs by build: on the DeviceAgent
  and the Server, `POST /ap/outbox` on the agent answers 201 with the
  `-create` document's id in Location; the Server advertises that endpoint in
  its actor document, the DeviceAgent's is on loopback. Behind a Gateway (a
  BrowserAgent or DeviceAgent account), the actor document and the WebID
  profile (`as:outbox`) name the Gateway's door, which answers 202 with the
  object's future address in Location, and the post goes out when the agent
  next runs. The door answers a CORS preflight and `Accept-Post`, so a browser
  client on another origin can use it. The advertised pod outbox document is
  the read collection.
- **Outbox processing / sending** — yes, decoupled: the agent builds the
  activity, writes the outbox (a static paged collection on the pod), and fans
  deliveries out to follower inboxes itself. Nothing watches the outbox
  document on the pod for activities written there by another client; a
  client posts through the endpoint or the door instead.

### Serving activities

- **Inbox and outbox collections** — outbox and followers served as paged
  AS2 collections; following, featured and the private collections as flat
  ones. The outbox lists the Create of each post and every Announce.
<!-- /CLAUDE --> The
  inbox is never public: the pod's container takes deliveries append-only and
  the agent drains it, and the owner reads what arrived at `GET /ap/inbox` on
  the agent, authenticated as themselves.
- **Relation to endpoints and LDP containers** — collections are plain pod
  resources; the inbox is the one container other servers write to.
- **Conformance with activity+json** — yes; the ActivityStreams documents are
  stored and served as `application/activity+json`,
<!-- /CLAUDE --> and the agent sends and accepts the standard
  AP content types.
- **Direct messages** — yes; direct posts are addressed only to the named
  actors and delivered straight to their inboxes. They and followers-only
  posts live in the pod's owner-only private container, never appear on the
  public surface or in the outbox collection, and are never re-broadcast by
  group fan-out.

### Inbox and outbox processing architectures

- **Agent processing LDP container** — yes; this is the architecture — the
  agent drains the pod's inbox container (WebSocket push + polling + startup
  drain). An owner's post taken at the Gateway's outbox door travels the same
  container, marked by its receipt, and is published rather than read.
- **How a client signs in** — the actor names the authorization and token
  endpoints (ActivityPub 4.1), and `/.well-known/oauth-authorization-server`
  says the same at the address clients look for first, in front of the door so
  an app can read it without being handed a secret. Both only where the agent
  is reachable, which is the Server. A client registers the Mastodon way, or
  publishes an OAuth Client ID Metadata Document and is known by its address —
  the form BOX and the WordPress plugin use, not FEP-d8c2's ActivityPub-object
  form. A client keeping no secret proves itself with PKCE (RFC 7636); a
  challenge, once made, must be answered even by a client holding a secret.
  Loopback redirects match on any port (RFC 8252). Token responses carry
  `activitypub_actor_id`, and the authorize throttle answers 429 with
  Retry-After.
- **Agent providing an endpoint** — DeviceAgent and Server, three:
  `POST /ap/outbox` is the write API, `GET /ap/actor` and `GET /ap/outbox`
  redirect to the pod's canonical documents, and `GET /ap/inbox` is the
  owner's view of what arrived. The Mastodon API and the setup pages sit
  beside them. The Gateway provides the outbox door for every account
  attached to it.
- **Server support** — none required; runs against a stock Community Solid
  Server pod with no server-side modifications, on a subdomain or on a
  suffix-based host (a path pod is fronted: its address lives at the Gateway,
  `@handle@fedipod.net`).
