# Changes

## 2026-09-12 (a pod-hosted identity travels whole — version 1.1.0)

An account hosted inside a Solid server kept its signing key, the secret
guarding its own pages, and the credentials for any accounts its owner had
connected elsewhere on the server's disk rather than on its pod. Handing
somebody their pod handed over an account that could not sign, whose pages
would not open, and whose connections were left behind. All of it lives on the
pod now, and an account set up before this moves them the next time its server
starts.

An account run from your own machine is unchanged: its key and its tokens stay
on that machine, where the pod is somebody else's server.

New: **css-nextgraph**, a storage component that keeps every pod in NextGraph,
encrypted under a wallet of its own. Each wallet's record is sealed under one
key for the server, so a copy of the wallets directory opens nothing. A host
whose machine cannot hold that key for it pastes it into a page after each
restart.

## 2026-09-11 (fedipod.net accounts run in the browser — version 1.0.0)

The front page at fedipod.net signs you up for an account that runs in your
browser: one handle, one password, nothing installed. Your pod is created at
the provider you choose, your key lives on the pod encrypted under your
password, and the same account opens from any browser that has the password.

An account run by an agent on your own machine is still offered, at
fedipod.net/new-account, and fedipod.net/install still installs that agent.

## 2026-09-10 (mail arrives at once from a pod on your own machine)

A pod served from a subdomain of `localhost` — which is how a Solid server with
subdomain pods runs on your own machine — had its live connection refused, so
every arriving post waited up to two minutes for the next check instead. It now
arrives as it is delivered. Pods on ordinary domains were never affected.

## 2026-09-10 (three things the browser build could not do)

Driving the browser build in a real browser for the first time found three
faults, all of them in what it does rather than in what it stores.

**Nothing that arrived could be read.** A post mentioning you, a reply, a boost,
or anyone new following you was dropped. The account could publish, but its
inbox was effectively dead. Anything already in your timeline was unaffected.

**Notifications stopped after the first screen.** Scrolling back through them
led nowhere, because the address the account handed the client to continue from
was not a real one.

**A new browser could not open your account.** The password screen appeared and
its button did nothing, so an account made on one machine could not be reached
from another. Your password was never wrong — the screen simply never acted on
it. Nothing was lost; try again on that browser and it works.

## 2026-09-10 (any pod provider, in the browser)

The sign-up page asks which pod provider you want and takes any address you
type. It could only reach solidcommunity.net, so naming any other provider
failed with "Failed to fetch" and no explanation. Bring your own pod works.

## 2026-09-10 (the pod's RDF copy is gone)

FediPod kept a second copy of your posts on the pod, in RDF, under
`fediverse/`. It is no longer written, and nothing reads it.

It said nothing your pod did not already hold. A post you publish is stored as
ActivityStreams 2, which is JSON-LD, so any RDF reader can fetch it and parse
it. On an installed FediPod an arriving activity is kept whole in the inbox
archive. Followers, following and your handle are in the published collections
and in the actor document.

**What this means for you.** Nothing is deleted: a `fediverse/` container
already on your pod stays exactly as it is, and you can remove it yourself if
you want the space back. New posts stop adding to it. Moving your private half
between pods or directories no longer carries it.

**One case is no longer covered.** If you run FediPod in a browser and your
pod loses the container holding your timeline while keeping the rest, posts
other people sent you can no longer be recovered — your own posts still can,
from the notes the pod publishes. An installed FediPod keeps its inbox archive
and is unaffected.

## 2026-09-09 (a security review, and most of what it found)

A full read of the project turned up a long list. Everything serious in it is
fixed — the browser build's whole share, and every critical or high finding on
the installed agent, the gateway and the pod server. Nothing here is a new
feature except where it says so.

### Things another website could do to you, and now cannot

- **Any page you visited could drive the browser build's admin routes.** The
  service worker answered them on this origin with no password — the only
  interlock on the destructive ones was typing your handle, which is public. A
  page you merely opened in another tab could move every follower to somebody
  else's account, retire the identity, rotate the key, point your inbox at
  their gateway, or set a password you did not know. It now refuses anything
  that is not your own page asking.
- **The same page could have a 90-day access token for your account delivered
  to itself**, because the OAuth mint accepted any address to send the code
  back to. It answers this origin alone now. Twenty of those mints also used to
  push your own working sessions out of the list and sign you out of every
  client you had.
- **Your signing key sat on your pod in the clear.** Three documents said it
  was locked under your account password. It was not, and now it is: your pod's
  host stores ciphertext and cannot post as you. Each browser opens it once and
  remembers, so nothing asks you again — a *new* browser asks for the password
  once. Rotating the key needs it too, for the same reason.
- **A page could read your token straight out of storage** — that part is how
  browsers work and no app escapes it. What changed is what runs on the page at
  all: the app and the gateway pages now say where scripts may come from, and
  nothing may frame them.
- **Signing out now tells your pod.** It used to clear the screen and leave the
  token alive at the pod for its full life, which mattered most on a borrowed
  computer.
- **Setup no longer leaves a key behind.** Creating an account minted a
  permanent full-access credential for your pod and then dropped it on the
  floor — nothing held it, so nobody would think to revoke it. It is deleted
  when setup finishes.

### Things a stranger could do by delivering to your inbox

- **Anyone with any valid fediverse key could act as anybody**, where a mail
  door was in trust mode: the door said "this signature checked out" and
  nothing asked *whose*. One delivery could evict a follower or get a follow
  accepted in someone else's name.
- **One message per account you follow could stop you following all of them.**
  A refusal only had to *look* like a refusal — it did not have to answer the
  request you actually sent — and neither side would ever notice, because the
  far end thinks the question was answered and never retries.
- **A stranger could withdraw somebody else's waiting follow request**, so that
  person simply never got followed and nothing said why.
- **Any public post could be put in your mentions as "X mentioned you"**, and a
  group could be made to carry a member's post the member never sent it. What
  the delivery *claimed* is no longer taken for what the post itself says.
- **Your account could be used as a signed relay.** Anything a stranger wrote
  could be re-delivered to all your followers over your signature. Only the
  kinds this agent actually fetched and checked are passed on now, only from
  someone it knows of, and at most twenty per sweep.
- **A hostile server could exhaust or bloat you**: an unbounded reply body, a
  post with thousands of emoji or poll options, or a half-megabyte activity
  filed whole into a document rewritten on every change. All bounded.
- **A single host could answer for everybody**, making `@anyone@that.host`
  resolve to one account, and an open redirect could make one server answer for
  another's documents. Both refused.
- `javascript:` and `data:` addresses in someone's emoji, mentions and
  attachments no longer reach your client. Avatars were already guarded.

### Things that were broken, or promised and absent

- **Pictures work.** Media and avatar upload always failed in the browser
  build — the image was mangled before anything could read it, twice over.
- **The notification bell goes out.** It stayed lit forever after the first
  look, and the mentions column showed favourites and boosts as mentions.
- **Follow requests reach every client.** They were visible on FediPod's own
  page and in no Mastodon client at all.
- **Keyword filters do something.** They were stored, listed, and applied by
  nobody.
- **GIFs show.** Every one rendered blank, being labelled as a kind of video.
- **CSV import works in the browser**, the same importer the installed agent
  runs. It used to answer "not available".
- **Park and revive work in the browser** — go quiet without giving up your
  name. This matters more here than on an install: close the tab and nothing
  collects your mail, but the gateway keeps delivering it to your pod. Related
  bug: transferring an account away reported that it had saved your follow
  list, and had not, so setting yourself back to active re-followed nobody.
- **A scheduled post is refused rather than lost.** The browser build accepted
  one, said "scheduled", and had nothing running to ever publish it.
- **The web-push toggle is gone from the browser build** rather than looking on
  and doing nothing.
- **Controls that could not work are gone**: a gateway handle this build does
  not offer (it told you the name was free and then refused it), and a
  "move private data" panel that no button had ever opened, in either build.
- **Signing in as somebody else works.** The first identity's agent stayed live
  and went on answering as the wrong person.
- **Two devices no longer double-act.** A device handed the lease back kept
  delivering from the queue, and one taking it over could write stale state
  over newer.
- Third-party clients are now held to the access they were granted. Every
  token had full authority whatever it asked for.

### Gentler on your pod

The browser build ignored a pod asking it to slow down, polled every two
minutes while doing nothing, wrote a document on every timeline scroll,
rewrote its two largest documents once per incoming post, and re-created
containers that already existed each time the browser restarted it. All fixed;
a gateway now passes on how long a receiving server asked to be left alone.

### And on the installed agent, the gateway and the pod server

- **Any page you visited could take over an installed agent**, in three
  requests and with nothing typed. A site could register itself as a client
  pointing back at its own server, send your browser to the sign-in page, and
  collect a key to your account — the agent's certificate is trusted by your
  browser, so none of it looked unusual. A page in another tab can no longer
  reach that step, and where no password is set the agent will not send a key
  anywhere but back to itself. Connecting a third-party client from its own
  site now needs a password set first (`fedipod passwd`); that is the point of
  the password.
- **A gateway account could be pointed at the gateway itself**, and on the pod
  server that made it read the server's own internals — including the file
  holding every user's receipt secret. It could also make the server call
  itself over and over. A gateway is not a pod and now says so, and the
  server's reads are confined to the account's own pod.
- **Somebody else with an account on your pod server could take your gateway
  name** and be handed your receipt secret with it. The gateway asks your pod
  who owns it, rather than assuming that sharing an address means sharing an
  owner.
- **On a shared gateway, one account could speak for another** — post as them,
  rewrite their posts, delete them — because everyone's addresses live on the
  same domain. Being on the same domain is no longer enough; it has to be the
  same account.

### Also

`npm audit` reports nothing outstanding (an XML parser inside a dependency,
which the browser bundle carried too). The tests grew from 1,449 checks to
1,477, plus six new harnesses; the ones covering behaviour these fixes changed
were updated, and negative cases added beside them.

## 2026-09-06 (polls)
- **You can make a poll now, not only vote in one.** The composer in the
  client grows its poll button, because the instance stops saying polls are
  impossible. Up to four options, up to fifty characters each, single answer
  or several, running between five minutes and a month.
- **The answers are counted here.** A vote is not a special thing on the
  fediverse: it arrives as a reply naming the option it chose. Those are now
  taken as answers rather than filed in the thread — before this they would
  have shown as blank replies and rung you once per voter. One answer per
  person on a single-answer poll, an option the poll does not offer counts for
  nothing, and a poll that has shut takes no more.
- **The count goes back out.** Everyone holding the poll is told as it moves,
  and told once more when it closes. A run of votes costs one rewrite rather
  than one each, so a busy poll is not a steady stream of writes to your pod.
  The poll is not marked as edited when its numbers change, because it was not.
- **An app can post one too**, through the outbox, as a Question with its
  choices in `oneOf` or `anyOf`.
- **A form-encoded client no longer loses all but the last of a repeated
  field.** A list sent that way was read as a single value, which would have
  taken a poll's options down to one. Media ids were subject to the same.

## 2026-09-06 (later still)
- **Mail reaches an account under its own name straight away again.** An
  account that publishes under a name of its own asked its pod to watch the
  wrong address for arriving mail: the name it publishes under rather than the
  place on the pod the mail actually lands. The pod refused, because it cannot
  watch somewhere that is not on it, so nothing woke the agent and mail waited
  for the next sweep, up to two minutes. It now names the place on the pod.
  Accounts that publish under their pod's own name were never affected.

## 2026-09-06 (later)
- **An app you did not write can now find its way in.** Your actor says where
  a client signs in and where it collects its token, so an ActivityPub app
  needs nothing configured by hand to reach your account. It says so only
  where your account answers on an address a stranger can reach, which is a
  pod server; on a laptop the client surface is on your own machine and there
  is nothing useful to advertise.
- **A token now says which account it is for**, so an app knows whose it holds
  without asking a second time.
- **Being turned away for asking too often says so.** Too many sign-in
  attempts answered as though the password were wrong, which made apps ask you
  to type it again — the one thing that could not help. It now says to wait,
  and for how long.
- **The address your actor gives for its outbox is one an app can write to.**
  It named the collection on your pod, which answers reads and refuses
  writes, so an app following it was turned away when it tried to post.
  Reading that address now goes on to the same collection as before, and
  writing reaches your agent. Your inbox is unchanged and still names the pod,
  because that is what holds your mail when nothing is running.
- **An app can be known by the document it publishes about itself**, instead
  of registering here first. It names itself by a URL, that URL says who it is
  and where it may be sent back to, and it proves each sign-in with a
  challenge because such an app keeps no secret. An app that listens on your
  own machine may use whatever port it was given, as the standard for those
  expects.
- **There is now a document saying how to sign in**, at the address clients
  look for it, and an app can read it without being handed your door secret
  first, so an app on your own machine can set itself up. It names where to ask, where to collect a token, where to
  register, and that an app keeping no secret is welcome.
- **An app that runs in a browser can sign in.** A browser cannot keep a
  secret, so such an app proves instead that it is the same caller that asked,
  by answering a challenge it set when it started. Until now the token step
  demanded a secret and refused them. An app that does hold a secret still
  uses it, and a challenge, once set, cannot be stepped around with one.
- **You can read your own inbox.** `GET /ap/inbox`, yours alone, holding what
  arrived rather than what is left. Deliveries land in a container on your pod
  and the drain empties it as it handles each item, so the archive is the only
  place your mail is still whole. It is paged a month at a time. Apps still
  deliver to the address your actor names; nothing about receiving changed.

## 2026-09-06
- **A server running more than one worker says an identity cannot be reached,
  instead of answering as though it were not there.** An identity runs in one
  process, and with several workers that process is the one serving no
  requests. Every process now knows which addresses belong to an identity, so
  a request for one is answered with the reason rather than handed to plain
  pod serving. The identity goes on federating; what it cannot do is answer a
  client. Running one worker is what makes it reachable, and the server says
  so at startup.

## 2026-09-05
- **A shared-domain handle the server fronts itself now receives its mail.**
  Where a server runs an identity and is also its door, the record the door
  keeps names the identity's own place on the pod, which is where deliveries
  are written and where the identity is watching. Mail addressed to such a
  handle reaches it. A record made by attaching a pod yourself is untouched;
  one this server wrote itself is corrected as the identity starts.
- **A pod is asked where its access rules live, rather than being assumed.**
  Every pod server states, on the resource itself, where access to it is
  controlled, and that is now what is read and written. A pod that states
  nothing keeps the name it always had. A pod that states its rules as ACP
  policies is left exactly as it is: this agent writes authorizations, and
  putting them over policies would take away the rules protecting the pod.
- **A pod is asked where it describes the services it offers**, instead of
  only looking at the one path where such a description has always been found.
- **Your profile is changed by adding the account statements to it**, rather
  than by writing the whole document back. A profile says things that are not
  this agent's to restate, and a server is entitled to refuse a write that
  would restate them. A pod that cannot take such a change is sent the whole
  document as before.
- **A pod server that names the pod's owner decides who may opt in.** Where a
  pod publishes its owner, the token has to prove that owner. Where it does
  not, the older rule stands: the WebID must live under the pod.

## 2026-09-04
- **The sign-in on the run-your-identity and accounts pages uses a smaller,
  pinned Solid-OIDC client.** `/run` and `/admin` now load
  `@uvdsl/solid-oidc-client-browser` (vendored worker-free, sha512-pinned by
  `scripts/pin-solid-oidc.mjs`) in place of the old unversioned auth bundle.
  Signing in is unchanged for you: sign in at your provider, come back, and the
  page acts with your proof. The accounts page (`/admin`) now also works on the
  CSS-component deployment, not only the hosted front.

## 2026-09-03
- **Creating a pod picks its provider from a dropdown.** The setup page's
  "Create a Solid account and pod" mode offers the providers that give each
  pod its own subdomain — the shape a Fediverse address needs to resolve
  everywhere — instead of a free URL field. "Use a pod I already have" keeps
  the free identity-provider field, and a gateway-arranged signup's own
  provider joins the list pre-selected.

## 2026-09-02
- **Fediverse accounts you hold elsewhere can be connected.** Connecting one
  works on any server speaking the Mastodon API — Mastodon, GoToSocial,
  Pleroma, Akkoma, Pixelfed, Friendica. You sign in at that server, and its
  home timeline and notifications join the feed you already read,
  interleaved by time. Favouriting, boosting and
  replying act as that account on its own server, and a post you wrote there
  can be deleted from here. The token is kept beside the signing key on this
  machine and never reaches the pod; what arrives is a view cache and is never
  written to the pod either.
- **A post two of your accounts both see is one row.** The statuses index
  merges a repeat sighting instead of dropping it, recording which accounts saw
  it — so the favourite control reflects any of them holding it, and undoing
  removes it from every account that does. A note the hashtag feed saw first is
  raised to a followed post when your own inbox delivers it, instead of staying
  a tag row without its slug.
- **The record gathers every account elsewhere under one row.** **Other
  identities** carries the button that connects one, and each account already
  connected — Bluesky and Fediverse alike — is a row of its own beneath it with
  its own Disconnect. Your own Fediverse identity keeps its own row above.

## 2026-08-31
- **The front has a roster page.** `/admin` on a front (fedipod.net) lists
  every account the server answers for — the address, person or group,
  whether the identity lives on the front or only gateways through it, and
  the pod behind it. Reading it requires signing in as the WebID the deploy
  names in `FEDIPOD_ADMIN_WEBID`; the roster API strips every secret from
  the rows it returns. Env-seeded rows and attach-created rows appear alike.
- **The admin can remove an account.** Each roster row has a Remove button:
  the server drops the row and stops answering for the name; nothing on the
  user's pod is touched. A row seeded in the deploy environment cannot be
  dropped from the page — the answer says to remove it from
  `FEDIPOD_DIRECTORY_JSON` and redeploy.

## 2026-08-23
- **Attaching to a gateway happens from your own agent.** The record's new
  **gateway** row (and `fedipod gateway --attach`) creates the gateway
  account itself: the agent proves the pod with its own credential, the
  gateway answers with the door and the receipt secret, and a pod-based
  attach applies without a restart. No browser sign-in, and no password ever
  near the gateway. The popup offers the handle choice — keep your pod-based
  handle, or type a handle straight into the blank of `@____@the-gateway`,
  checked as you type — and taking or leaving a gateway handle restarts the
  agent by itself, signing key carried along. Hint text across the record is
  full-size and higher-contrast.
- **A gateway-based handle is the identity, everywhere.** The published actor
  document, the client's own account, the record's Fediverse identity row,
  the actors dropdown and the journal all name `@you@the-gateway` — never the
  pod handle. That also makes federated profile Updates stick: receivers
  re-verify a changed username by WebFinger and silently drop the update when
  it does not resolve, which is exactly what a pod-handle username did. A
  forced republish now always federates its Update.
- **fedipod.net's page slims to words and one command.** The install command
  is the whole signup: setup creates your pod locally (or uses one you have),
  and attach, detach and transfers all live in the agent's admin page.
- The signup page's sign-in reports its failures instead of showing a silent,
  reset form, and its `/api/attach` call works again (v0.9.1).

## 2026-08-21
- The **software row** on the record page names the version your agent is
  actually running, and says so when the copy on your machine is further
  ahead: "0.9.0; 0.9.1 is on disk — restart to run it". An agent serves the
  code it started with until it is restarted, and the row now tells you when
  that has drifted. It also appears for an agent that cannot reach the update
  check, which previously showed no version at all.

## 2026-08-20
- Activities you send carry a **signed proof** (FEP-8b32), so a server that
  meets one of your posts second-hand — carried by a group, or forwarded by a
  follower's server — can tell it is yours without asking your pod. Your actor
  publishes an Ed25519 key beside the RSA one; HTTP signatures are unchanged.
  An activity you forward for somebody else keeps their proof and never gets
  yours.
- Posts that have a **headline** show it: Lemmy posts, blog articles, PeerTube
  videos and Bookwyrm reviews arrive with a title above the body instead of
  losing it.
- A delivery whose sender's key could not be fetched is no longer discarded as
  a forgery. Servers that require signed fetches — Threads, and Mastodon in
  secure mode — were being dropped at the gateway door in silence.
- Only the activities that make up a conversation are carried to your followers
  on someone else's behalf. Anything of a type FediPod does not read was being
  re-delivered to every follower over your signature.
- A blocked domain stays blocked on a non-default port at the gateway, as it
  already did at the agent.
- Signatures over an address that carries a query string are now ones a
  receiver can check, which covers paged collections and inboxes that live at
  `?rest_route=…`.
- An actor typed as a list (`["Person","Service"]`) is an ordinary actor, and a
  post typed as a list is ordinary content. Both were being refused.
- A link post whose attachment carries `href` and no `url` keeps its link.
- Your actor document says whether follows wait for you. A person's follows
  have always waited by default; other servers were told the account was open
  and showed people as following you when they were still queued.
- The installer puts `fedipod` on your PATH, so a machine set up from a signup
  page runs the same commands as one installed from npm.
- **FediPod installs from npm**: `npm install -g fedipod`, and every command is
  `fedipod <something>` rather than a path into a checkout. `fedipod update`
  updates through npm; on a checkout it still fast-forwards. The signup page
  hands out the same short command.
- Moderation another server asked for has a place on the group's admin page:
  **Moderation requests**, with carry-out and turn-down beside each one. It
  appears when something is waiting. `fedipod modqueue` does the same from the
  terminal.
- Transferring an account away records the follow graph it tears down, so
  setting the status back to active re-follows everyone the way parking always
  has. It used to unfollow everyone and keep no snapshot, leaving a transfer
  one-way in practice while the page still offered to undo it.
- A gateway account made through the signup page now filters properly: the
  front reads each person's published policy — their accepted following list
  and their blocklist mirror — from their pod, cached for a few minutes, in
  place of the empty fields its directory row carried. Until an agent has
  published one, the door still filters on addressing alone.
- A FediPod Server answers on its own address out of the box. The shipped
  config carried `fedipod.net` as the front's apex, so an operator who
  installed it unchanged got a server where sign-up silently never routed;
  `frontHost` now defaults to the server's own base URL.
- Discarding a backlog keeps its promise: every item the drain could handle is
  read, so a follow, unfollow or deletion is applied whatever its size, and
  only content is dropped. Items past the drain's own byte cap are still
  removed unread — reading them could not help.
- Attaching to a gateway now starts in **shadow**, not trust: the door filters
  from the first delivery, and the agent measures how much verifies before it
  believes any receipt. Move to trust when you are ready.
- `locked` is refused unless the gateway's WebID is on record, and the pod's
  access control is written before the mode is, so a failure can no longer
  leave your config saying locked while the pod still accepts anyone's writes.
- Declining `rotate-key --force` no longer leaves the rotation armed. It used
  to say "key unchanged" and then rotate at the next ordinary start, without
  telling other servers.
- The single-person Netlify door sends no authorization header when it has no
  append token, so the documented credential-free deployment against a
  public-append inbox works.
- **The agent serves https and nothing else, on the port you name.** `npm start
  8081` means `https://localhost:8081` — there is no second listener and no
  `port + 1000` mirror, and `AP_HTTPS_PORT` is gone. The well-known door
  answers https on 8030. Anything bookmarked at a `+1000` address, or at a
  plain `http://` one, needs changing to the port you gave the agent.
- A certificate problem now stops the start with a message instead of falling
  back to serving the UI and the API in the clear.

## 2026-08-19
- **The owner's pages on a FediPod Server move from `/app/` to `/fedipod/`.**
  `app` is a name a pod owner may well want for themselves. Set
  `agentUiPath` to keep the old address. The pod paths an identity takes over
  are now `api`, `oauth` and `fedipod`.
- A FediPod Server answers three routes it was serving pages for but never
  claiming: `/run` (the opt-in page), the sign-in library both pages load, and
  `/install`. The component also serves its own packaged copies of the signup
  and run pages, so neither has to be pasted into a server config.
- The FediPod Server diagram ships with the package as `fedipod-server.svg`,
  so its README image resolves on npm and in an installed copy.
- The record page is redesigned: the actions live in a collapsible rail
  beside the facts; the actor dropdown rides the top bar in place of the
  static handle, with "add a new account" as its last item; migration
  aliases moved into a "Transfer an account here" panel beside "Transfer
  this account away" (the renamed outbound transfer); controls share one
  style in both color schemes; Move data is off the page for now
  (`fedipod state --to` still does it).
- The agent notices when a newer FediPod is published (one GET of the repo's
  package.json, daily; `AP_UPDATE_CHECK=0` turns it off) and offers the
  update: an Update button on the record page's software row, or
  `fedipod update`. Either pulls the latest into the checkout and restarts
  every agent; local changes are refused rather than overwritten.
- Whalebird (and other megalodon-based clients) can sign in. Two changes:
  nodeinfo names the software `hometown` — a Mastodon fork those clients'
  server detection accepts; FediPod's own name was refused before sign-in
  could start — and a registered client using the out-of-band authorization
  flow now gets a code its secret can actually redeem.
- Agent addresses are https: `https://<handle>.localhost:<port+1000>`
  everywhere an address is printed, opened or linked, and the well-known door
  answers at `https://localhost:9030/`. The plain listeners remain for
  compatibility.
- The certificate is trusted automatically: the first agent start mints a
  local certificate authority carrying a critical name constraint — it can
  only ever vouch for localhost names and loopback addresses — signs the
  server certificate with it, and installs the authority in the browser
  trust store (NSS). `fedipod https --trust` remains for the system-wide
  store and odd setups; `AP_TRUST_INSTALL=0` disables the automatic step.
- On a FediPod Server, sign-up is the only way an account is made: a pod
  becomes an identity when its owner opts in at `/run` (or `POST /api/agent`)
  and stops when they opt out. The `agentPods` setting — operator-listed pods
  provisioned at boot — is gone; existing configs using it must drop it and
  have each owner sign up.
- The CSS component is renamed `fedipod-server` (was `fedipod-css-gateway`):
  the folder is `packages/fedipod-server`, the npm package `fedipod-server`,
  the config type `FediPodServerHandler` on `urn:fedipod:server:Handler`, and
  the shipped snippet `fps:config/server.json`. Existing configs need those
  four names updated.
- A signup carry-over now works on a machine that already has identities:
  `npm start` after the installer brings the new identity up beside the
  existing ones, on its own port, with setup pre-filled. A carried name that
  already exists locally is refused rather than adopted. An explicitly named
  profile or home is never overridden.
- Signup-first onboarding: fedipod.net's create panels sign you up before
  anything is installed — sign in with your pod, pick your handle and your
  address shape (`@you@your.pod` or `@you@fedipod.net`), and the success
  screen hands one install command carrying the gateway, secret, pod, issuer,
  handle and kind. The installer saves them; the first `npm start` skips the
  terminal question, opens setup pre-filled, and attaching happens at first
  publish. The plain no-flag installer is unchanged.
- The "Run your identity on this server" flow moved off the signup page to its
  own page at `/run`, served only where a host supplies it (`runPage`).
- First run of `up` records the handle before spawning the agent, so the
  `<handle>.localhost` setup page answers instead of refusing.

## 2026-08-18
- Each server-hosted identity's owner door has its own secret, minted beside
  its signing key; the shared `agentGateToken` setting is gone. Proving pod
  control again mints a fresh secret and retires the old — lost-secret
  recovery with no restart.
- Runtime opt-in: with `agentRuntimeOptIn` on, a pod owner can sign in with
  their pod and the server starts (or stops) an identity for it while
  running — `POST /api/agent`, or "Run your identity on this server" on the
  signup page. Opted-in pods survive a server restart.
- Browser-based Mastodon clients can now sign in, the way any Mastodon server
  serves them: the client API answers any origin, an app registers for its own
  id and secret, and the sign-in screen names what is asking and where the code
  will be sent before you approve it with the password. The authorization code
  is bound to that client's registered address and is not usable until the
  client exchanges it with its secret.
- `agentAutoFront`: when one server runs both the door and its identities,
  each identity gets a `@handle@<frontHost>` address on startup automatically,
  resolving to the identity on its own pod. Off by default.
- Clearing a clogged inbox keeps what matters: `POST /inbox/prune` with
  `keepConcerning` discards the firehose but keeps posts addressed to you,
  mentions, replies to your posts, and people you follow. Follows are applied
  as always.
- Opting a pod in to run on a server accepts only a pod origin root, so on a
  server that hosts several pods on one domain no owner can claim another's.
- Hardening from a security and server-load review: the store transport is
  confined to the pod it acts for, inbound bodies and the inbox listing read
  are size-capped, the live feed caps its connections, the delivery queue has a
  ceiling, and a busy inbox no longer sweeps unpaced. None changes how the
  component is used.
- Stopping the server flushes each identity's state and releases its lease
  before exiting, even under a plain `systemctl stop`.
- The `fedipod-css-gateway` package installs standalone from npm — it ships the
  agent tree it needs and declares its dependencies.
- Opening `http://localhost:8030/` always reaches a configured identity's
  record page (which lists every identity), never an unconfigured agent's
  setup form.

## 2026-08-17
- FediPod runs inside a Community Solid Server, as a component of it. A server
  that already hosts pods can take delivery for them at its own door, and — for
  each pod named in its configuration — run the whole agent: the pod accepts
  follows, delivers posts, empties its inbox and serves its owner's Mastodon
  client on the pod's own address, with no agent process anywhere. Signing keys
  are held by the server, and sign-in needs a password per identity. See
  `packages/css-gateway`.
- One-line install: `curl -fsSL https://fedipod.net/install | sh` — checks
  git and node 20+, clones or updates `~/FediPod` (`FEDIPOD_DIR` overrides),
  installs dependencies, and prints the start command. The script is served
  at `/install` on any gateway deploy and lives at `web/front/install.sh`.
- https served beside http on every agent (port + 1000), with a certificate
  minted per machine; `fedipod https --trust` adds a local CA for clients
  that refuse self-signed certificates.
- The multi-user gateway is live at fedipod.net: signup with Solid-OIDC
  proof of pod control, attach rows in a durable directory. Attaching now
  defaults to inbox-only (`@me@my.pod` identity stays on the pod; only the
  advertised inbox moves); fronted identity sits behind an explicit flag.
- New CLI commands: `gateway` (attach/detach; `front` kept as an alias),
  `keys` (move the signing key between machine and pod), `https`, `import`,
  `alias`, `admit --all`.

## 2026-08-16
- Account migration into FediPod: migration aliases (`alsoKnownAs`),
  auto-accepted follower waves, and a paced importer for Mastodon-format
  CSV exports (follows, blocks, mutes, lists, domain blocks).

## 2026-08-09 / 2026-08-10
- The client-to-server protocol (ActivityPub §6) on the agent: `POST
  /ap/outbox` with Solid-OIDC (DPoP) auth and an owner check.
- Fuller FEP-1b12 for groups: carried posts name the group as `audience`,
  the moderator roster publishes as `attributedTo`, announced moderation to
  members, a carrier's announced Delete honoured, inbound moderation held
  for review.
- FEP-4ccd pending-follow collections and the FEP-c648 blocked collection,
  published owner-only.
- The verify-at-the-door inbox gateway and multi-user front cores.
