# Changes

## 2026-09-25 (your account keeps running, and any Mastodon app can use it — not yet released)

**Mail sent to a browser account waits at fedipod.net while FediPod is
closed**, and reaches your pod in batches of up to a hundred when you open it,
or every fifteen minutes otherwise. Your pod is written once a batch instead of
twice a delivery. While FediPod is open, mail goes straight to your pod as
before.

**fedipod.net keeps your account running while FediPod is closed.** It
accepts follows, tries again what failed to go out, and publishes your
scheduled posts. To do that it can read your signing key on your pod, so it can
post as you, as any Fediverse server can. The manage page turns it off.

**Scheduled posts work in the browser version** while the gateway keeps your
account running.

**Any Mastodon app can use your account.** Give `fedipod.net` as the server in
elk.zone, Ivory, Tusky or any other app, sign in at your own pod on the page it
sends you to, and the app reads, posts, boosts, likes and follows as you. No
password is typed on fedipod.net. It works while fedipod.net keeps your
account running.

**Notifications reach your phone.** An app that offers notifications can
sign up for them: a mention, reply, direct message, follow, like, boost or
reaction reaches your phone as it arrives, with FediPod and the app closed.

**Your account's working data is kept at fedipod.net** while it keeps your
account running, and written to your pod every fifteen minutes. FediPod in
your browser, the gateway and your apps all work from that one copy, so they
never disagree; whichever you act in takes over, as between two browsers. Your
signing key and connected-account passwords stay on your pod only. Your pod is
asked far less: a restart of FediPod in the browser, or a run of the gateway's
keeper, reads the copy instead of the pod.

**A poll in the browser version shuts when its time is up**, and everyone
holding it is told, as a DeviceAgent's always did.

**fedipod.net answers other servers' repeated requests for your account's
public documents from its own cache for an hour**, and forgets them whenever
your account sends anything out.

## 2026-09-25 (your pod is asked far less while FediPod is open — version 1.39.1)

**Your pod is asked about fifty times less while FediPod sits open in a tab.**
A browser stops FediPod's background worker whenever it is idle, and a client
open in a background tab wakes it about once a minute. Each wake used to start
from scratch against your pod. Now a wake a few minutes after the last one
carries on from a copy of your account's state kept in this browser, and asks
your pod about twice instead of about fifty times. Signing out deletes that
copy.

**New mail in a background tab can take up to two minutes to appear**, instead
of about one.

**The hashtag feed and the Bluesky and connected-account mirrors refresh at
their set interval**, instead of on every wake.

**fedipod.net pages check for a new version every ten minutes**, instead of
every minute, and tell fedipod.net you are still around once an hour instead
of every minute.

**On the forum, a member signed in with only a WebID has their posts kept in a
`fedipod-bb` container on their pod**, instead of loose at its root.

## 2026-09-25 (choose where on your pod your account lives — version 1.39.0)

**You choose where on your pod your data goes.** Sign-up asks "Store your
data in a container named fedipod, inside this container", prefilled with
your pod's root, on fedipod.net, the DeviceAgent (its setup page, the new
actor form and the command line), and the Server's opt-in page. Anything
outside your own pod, or in its profile or settings, is refused.

**Where it lives is recorded in your public type index**, as an
ActivityStreams actor, which is how FediPod and other Solid apps find your
account again. If your pod has no public type index, you're asked whether to
create one, and saying no stops the sign-up before anything is written.
Accounts made before this are found where they always were, and gain the
record when your pod has an index.

**Changes to your profile and type index are checked first**, and never leave
either of them broken: an N3 Patch of just the statements where the server
can patch, and nothing written at all if the result wouldn't be valid RDF. A
profile that can't be written to has the statements written to the document
its `rdfs:seeAlso` names. The Server now patches RDF in-process instead of
rewriting it.

**On a server whose pods are suffixed, only you can attach a place inside
your pod.**

## 2026-09-25 (apps can read your full outbox — version 1.38.2)

**An app signed in as you can read everything your account has done**, on
fedipod.net too. Your profile names where your full outbox and your liked list
live on your pod, and the app reads them there with your own sign-in.

## 2026-09-24 (the last outbox gaps — version 1.38.1)

**The Server answers the spec's own media type**, `application/ld+json` with
the ActivityStreams profile, as well as `application/activity+json`. On the
Server, your full outbox is answered at your outbox address when you're
signed in. Boosts, edits, deletions and undos on your public outbox can each
be fetched on their own. A deleted post's Create answers "gone". Likes and
undos say who they're for, and forwarded posts drop their blind copies.

## 2026-09-24 (the outbox review's fixes — version 1.38.0)

**Private things stay private.** A private forum category no longer lists
its members' posts in its public outbox, and a category turned private takes
back what it carried. Blocking someone, or a whole domain, stops your posts
reaching them. A post an app sends only to blind copies is a direct message,
not a public post. Deleting a post you had edited takes its old words off
your public outbox. Deleting a followers-only or direct post tells only the
people who had it. Your full outbox and liked list are published only once
your pod has shown it keeps them private.

**Nothing goes out twice.** A post an app sent through fedipod.net is
published once, even if your pod is slow to clear it or the request is
replayed. A refused post is reported to you once. A server sending the same
follow over and over no longer makes your pod write each time.

**Apps are understood as the spec means.** An app's edit changes only what it
sends, so editing a poll or an annotation keeps it what it is. "To alice,
copied to my followers" reaches your followers. fedipod.net refuses up front
what your account would refuse, instead of saying "created".

**Smaller things.** Followers, following and liked list their newest first.
A deleted post answers "gone", and fedipod.net stops showing it within
moments, not up to fifty minutes. Mentioning yourself no longer delivers to
your own inbox.

## 2026-09-24 (the outbox, filtered by who reads it — version 1.37.0)

**Signed in, your outbox shows everything you've done**: likes, follows,
undos, followers-only and direct posts, blocks, pins and follower decisions.
Everyone else still sees only your public posts and boosts. You also get a
`liked` list only you can read, seeded with the posts you'd already liked.
This works for accounts on fedipod.net and on the Server.

**The public outbox now says when something was withdrawn.** A deleted post
leaves a Delete, an edit an Update, a withdrawn boost an Undo, so a server
catching up from your outbox stops showing what you took back.

**An app posting through your outbox always learns the address of what it
made**, for every kind of action, not only new posts. When your account
refuses something an app sent through fedipod.net, you get a direct message
from yourself saying what and why.

**The forum says when its pod is down** instead of saying there is no forum.

`fediverse-account` reads an outbox given in object form as well as by
address (still 0.2.0, which is not yet on npm).

## 2026-09-24 (a WebID with no Fediverse account can post to the forum — version 1.36.7)

**Signing into the forum now also accepts a bare WebID**, not just a
Fediverse handle. Someone with a Solid pod and no Fediverse account can
post, reply, join a category and vote — visible on the forum's own page,
though it never reaches anyone's Mastodon feed, since nothing vouches for
who wrote it there. The sign-in box says so before anyone types anything,
and names a FediPod account as the way to get both.

## 2026-09-24 (an app can read an account's own posts as RDF — version 1.36.6, fediverse-account 0.2.0)

**`fediverse-account` gets an `outbox` call**, beside `timeline`: an
account's own posts, newest first, in the same shape as before. Passed
`rdf: true`, it also hands back the real outbox as RDF — genuine linked
data, for an app that wants to work with AP data directly rather than
through this library's own shape, for a Mastodon account as well as a pod
account. Nothing extra loads unless that flag is used, and it comes back
empty on a server that will not hand over its actor document without a
signed request.

## 2026-09-24 (the outbox door answers as the spec expects — version 1.36.5)

**A post through the Gateway's outbox door gets a 201 Created**, with the
post's future address in Location, matching what the ActivityPub spec
requires and what a client such as dokieli expects — not the 202 it answered
before.

## 2026-09-23 (the queue shows what a moderator can act on — version 1.36.4)

**The Queue lists only what needs a moderator:** a report, a held post, a
join request, and an ask that did not take. A moderator's own request on
its way through no longer appears there for everyone with nothing to press.

## 2026-09-23 (moderators are the forum's — version 1.36.3)

**Adding a moderator from Settings makes them a moderator of the whole
forum, at once.** The ask names the forum's list, the forum takes a
moderator ask as its own whichever list it names, and every category's
moderator list is written from the forum's the moment it is applied rather
than at the next start. A forum with no gateway no longer mistakes one
address for another when reading an ask.

## 2026-09-23 (a republish keeps the pinned topics — version 1.36.2)

**A forum's pinned topics survive a forced republish.** A republish let the
category's own publisher write its pinned posts, of which a forum has none,
over the pinned topics; the pinned topics are now written back after it.

## 2026-09-23 (a forum copied to another pod comes up readable — version 1.36.1)

**A forum moved to a new pod publishes its lists with their rules.** After
a copy, the host is asked to reprovision once and now states the rule on
the newest-posts, categories and administrators lists as well as on its
containers; before, those three stayed private on the new pod.

## 2026-09-23 (the forum page reads the down count from the post — version 1.36.0)

**Opening the forum asks the pod for half as many documents.** The number
of people who voted a post down is carried in the forum's copy of the post,
beside the number who liked it, and the page reads it there. Until now the
page asked for a separate count document beside every post it showed, and
for most posts there was none. An edited post keeps its counts.

## 2026-09-23 (a quiet forum leaves its pod alone — version 1.35.0)

**A forum nobody is posting to no longer writes to its pod every minute.**
The moderation queue is written when its rows change, not on every sweep,
and its access rule when the moderators change. The heartbeat still says
every ten minutes that the forum is hosted, but no longer restates its rule
each time. A post, an edit, a deletion or a vote republishes the newest-posts
list only when the list changed, and never rewrites its rule. A batch of
posts arriving together reaches the pod as one upload per document instead
of one per post.

## 2026-09-23 (the pod is asked for less — version 1.34.0)

**Every account's pod does less work for the same result.** A like, a
bookmark, a follow or a sweep that found nothing new no longer uploads the
whole timeline index and the whole people cache again unchanged; only what
changed goes to the pod. An account says "I'm here" to its pod every five
minutes instead of every ninety seconds, so an idle account costs twelve
writes an hour instead of forty; if the active device dies, another takes
over within fifteen minutes, and a person acting on a second device still
takes over at once. The browser reads the account once at each start, not
twice, and writes its containers and the inbox's rule only when they are
missing or differ. The receipt a gateway leaves beside each delivery is
removed with the delivery, is read only where there is one, and the strays
earlier versions left behind are swept a few at a time. The Bluesky feed
writes once per sweep rather than once per notification.

## 2026-09-23 (the site does less for the same result — version 1.33.0)

**Fewer calls to fedipod.net for the same mail and the same pages.** A
delivery the site refuses because it has no such account is dropped, not
retried every minute for three days. A page at another origin is answered
when it asks whether it may open, pause or close an account. The edge keeps
one copy of every public answer for all regions, and keeps it across a
deploy. A closed address, a handle nobody holds, a path nothing answers and
a picture link are each held at the edge too, so the servers and scanners
that keep asking are answered there. A post to many followers goes through
the relay twenty at a time instead of one at a time. The pod-token check
and the senders' keys are built once per process, not once per call. An
account is looked up by its name in the directory rather than by reading
every account. Nothing a person sees changes.

## 2026-09-23 (what the log showed — version 1.32.1)

**Mail was not landing, and the site was answering questions nobody needed
asked.** A DeviceAgent now re-opens its inbox door every time it starts:
the group's inbox had come back from a root move without public Append,
so every delivery to it was refused for nine days and its followers were
talking to a wall. A page no longer asks the site once a minute whether
there is a new build when the build file has already said no — a third of
everything the site was doing. A public document the pod would not give
(an old account's pinned posts, a forum count nobody wrote) is held at the
edge for two minutes, so the servers that keep asking are answered there.
And a page on the test alias talks to the alias, not to the real site.

## 2026-09-23 (the bar, and notices — version 1.32.0)

**The bar reads as two groups.** The client group is as it was; the account
group now sits to its right in the same style — *account:* then *visit*,
*manage* and, in the browser build, *sign out* — and the word "account" is
said once. **A notices bell** stands at the right end of the bar, filled when
there is something new. It lists the notices whoever runs the site has
written, and each title opens that notice. What this browser has already
opened stays in this browser. **The operator writes notices** on the
`/notices` page, linked from the roster and signed in the same way: title and
plain text, changed or removed later. They are kept beside the directory and
read by every page through `GET /api/notices`. A DeviceAgent's own pages
have no such bell: nothing there answers for a site.

## 2026-09-23 (accounts that go quiet — version 1.31.0)

**An account nobody opens is paused, then closed.** The gateway holds no
mail: every delivery it accepts is written into the owner's pod, read only
while their browser is open. It now keeps two facts about each browser
account — when its owner last signed in or posted, and how much content has
arrived since — and acts on them. After about 5,000 posts, replies, likes,
boosts and edits since the owner was last here the account is **paused**:
content is accepted and discarded, follows, unfollows, moves, deletions and
blocks still land, and the owner's next sign-in ends it. After six months
without a sign-in the address is **closed** for good: its handle, actor and
door answer 410 Gone, the name stays taken, and nothing on the pod is
touched. The manage page has **Pause my account**, **Resume my account** and
**Close this address**; a pause the owner sets lasts until they lift it.
Only accounts opened from a browser are counted — a DeviceAgent drains its
own inbox as it runs — and accounts from before this release are counted
from their next sign-in. A gateway operator sets the cap and the window with
`FEDIPOD_PAUSE_ITEMS` and `FEDIPOD_CLOSE_DAYS`.

## 2026-09-23 (a DeviceAgent moves in; the forum speaks Lemmy's terms — version 1.30.0)

**A DeviceAgent moves an address from another gateway.** Setting up with a
pod that already holds an account, and asking for an address at a gateway,
is a move rather than a refusal when that account's address lives at a
different gateway. Setup reads the account with the credential it minted,
keeps the account's state and key on the pod where they are, attaches at the
new gateway, publishes the new address with the old one as an alias, tells
the old gateway, and sends a Move to every follower from the old address,
signed under the old key. A move the old gateway could not be told of is
tried again when the agent next starts acting. An address on the pod itself
is still a sign-in, and a group still cannot move.

**A titled forum post is a Page.** Lemmy's own posts are Pages; Mastodon
converts a Page and an Article alike to the title and a link, so nothing is
lost there. **A category says whether only its moderators may post**
(`postingRestrictedToMods`, Lemmy's term, declared through Lemmy's context),
and **a pin or a lock reaches Lemmy** as an Update of the opening post from
the category, carrying `stickied` and `commentsEnabled`. Mastodon drops an
Update from anyone but the author, which is right for it.

**The bundle-driven agent harness no longer stalls.** Its request shim
fired the body's events before a late listener could hear them; it now
replays them, as the service worker does.

## 2026-09-23 (Sengi's emoji come from the CDN — version 1.29.2)

**3,828 emoji pictures leave the deploy.** Sengi's emoji are JoyPixels,
which the jsdelivr CDN serves; Sengi rewrote that address to its own folder
and shipped every picture, 20 MB, in each build. The rewrite is gone (Sengi
patch 10), the composer's emoji button names the CDN picture directly, and
the folder is no longer vendored. The deploy tree is 316 files instead of
4,144, and 22 MB instead of 42. A reader whose browser cannot reach
jsdelivr sees text emoji in Sengi; Phanpy is unaffected.

## 2026-09-23 (the record page says how to sign in — version 1.29.1)

**A browser with no sign-in is told where to go.** The record page at
`/admin/`, opened in a browser that is not signed in, printed the worker's
own line about the agent not being booted and stopped there. It now says
"Not signed in on this browser. Sign in here." with the link to the front
page, where a saved sign-in is restored or the sign-in form is shown.

## 2026-09-23 (an address moves to another gateway — version 1.29.0)

**An address at a gateway can move to another gateway.** Open the new
gateway, choose "create an account", and sign in with the same pod: the new
gateway reads the account on the pod, sees its address lives elsewhere, and
offers a move in place of a new account, with the old handle or a new one.
The pod, the posts, the followers and the key stay where they are. The
agent's first boot under the new address publishes it with the old one as an
alias, tells the old gateway, and sends a Move to every follower from the
old address, signed under the old key through the old gateway's relay.

**A gateway serves a moved address as a stub.** Told by its owner
(`POST /api/move`), it answers the old actor under the old id with the same
key and `movedTo` the new address, so the Move verifies; every other old id
redirects to its new one, and the door for the old address is shut. The
move and relay APIs answer a browser at another gateway's origin, since the
move is driven from the new gateway's page.

**The manage page says how.** An address at a gateway shows, in its gateway
panel, that moving means creating an account at the other gateway with this
pod. Browser build only; the DeviceAgent's setup does not yet read a pod
that already holds an account.

## 2026-09-22 (no password on fedipod.net — version 1.28.0)

**fedipod.net never sees a pod password.** The sign-up form no longer asks
for an email or a password. A person who needs a pod makes one on their
provider's own sign-up page, linked from the form; then they sign in at
their pod, and the identity screen on the way back sets the account up on
that session. The credential sign-up used to mint, and revoke, is gone with
the form.

**The signing key is stored on the pod as it is.** It sits in the owner-only
state container, reachable through the pod's own login and by nobody else,
the same rule every private document on the pod lives under. A new browser
reads it with its session and asks for nothing; rotating the key asks for
nothing. Until now the pod's copy was sealed under the sign-up password, so
that the pod's host could not sign as the owner; the host is now trusted
the way it is for every other document. An account from before this
version is asked once for the password it was made with, and its key is
stored as it is from then on; someone who no longer has that password
makes a new key from the same screen.

## 2026-09-21 (version 1.27.4)

**The same as 1.27.3, under a number npm will take.** A publish of 1.27.3
uploaded its tarball and then failed at the one-time code, and npm keeps
such an upload as a staged version that nothing can publish over.

## 2026-09-21 (a DeviceAgent writes the featured collection it lacks — version 1.27.3)

**An account already running gets its featured collection at start.** 1.27.2
said an account already running would write the collection on its next
start; that was true of a browser account, which republishes its profile
when its tab goes active, and not of a DeviceAgent, which republishes at
start only when the actor document itself is missing. The DeviceAgent now
makes one read for the collection at start and writes the empty one when
the pod has none.

## 2026-09-21 (every account has a featured collection — version 1.27.2)

**The pinned-posts collection exists before anything is pinned.** The actor
has always named its featured collection, and a server showing the profile
reads it whether or not the owner ever pinned a post. Until now the
document was written only on the first pin, so an account with no pins had
none at all; the pod refused every reader, a refusal nothing caches, and
every server asked again. The empty collection is now written with the
rest of the surface, and an account already running writes it the next
time its agent starts. The public-surface check reports it with the others.

## 2026-09-21 (the edge answers for the pod — version 1.27.1)

**The edge holds a public document for ten minutes, and a handle for an
hour.** Every read of an actor, a post or a collection from a Gateway was a
function call once it was half a minute old, and a handle's WebFinger answer
after five; on Netlify's plan those calls are what the account is charged
for, and one server that had heard of an account asked for its actor over
and over. The edge now holds a public document for ten minutes and a
WebFinger answer for an hour, and serves the copy it has while it fetches a
fresh one. A browser is still told to keep nothing for more than a minute,
so a profile you have just edited does not stay stale in front of you.
Anything signed in, anything posted, and the site's own APIs are unchanged.

**The Gateway's log says what each request was.** One line per request:
method, path, status, how long it took and who asked. Until now the log
held only how long the function ran, and a rise in calls could not be traced
to a route or a caller. The path is logged without its query, which on some
routes carries a token.

## 2026-09-20 (the pod server's opt-in page knows who you are — version 1.27.0, fedipod-server 0.26.0)

**On a pod server, the opt-in page asks for nothing.** Signed in at the
server, you open `/.fediverse-account` and it says who you are, which pod
is yours and what its Fediverse address will be, with one button. A pod
already running here shows its address, a button for a new door secret and
one to stop. Not signed in, one button takes you to the server's login.
Own more than one pod and each gets its block. The two boxes, the pod's
address and the identity provider, remain only on a Gateway, which holds no
session and cannot know.

**The page's own script was never served by the server.** Since the script
left the page for a file of its own, `/run.js` fell through to the pod and
answered 404, so the page's buttons never woke up on a pod server. The
server now hands out the three page scripts itself.

**No credit line on served pages.** The `(cc)` line is gone from the opt-in,
admin and sign-up pages.

**A client signs you in through your pod, not a password.** A Mastodon
client, the account's own or a phone app, sends you to the account's
sign-in page; it has one button, you sign in at your pod, and you come back
signed in and are handed on to the client. Nothing of ours asks for a
password. Coming through the account's management page also counts as
signed in. The page uses `fediverse-account` to do it.

**The DeviceAgent's certificate is trusted even beside old ones.** A
machine that has run several agents holds several "FediPod Local CA"
certificates of the same name, and Chrome, matching by name, picked the
wrong one and refused the page. Every certificate the agent mints now
names the key that signed it, and an older one is re-minted at the next
start.

**The management page keeps you in.** Its door's cookie used to be lost on
the way from the server's own page to the pod's address, so the door forgot
you the moment it had let you in.

## 2026-09-20 (an account run from a device is called that — version 1.26.1)

**Signing in at fedipod.net with a pod whose account a DeviceAgent runs no
longer says the account does not exist.** The browser opens an account by
reading its record from the pod; a DeviceAgent keeps that record on the
device, so the pod holds the account's public documents and no record. The
page now sees the account's actor there and says so: the account is run by
a DeviceAgent, and opens from that device's admin page.

## 2026-09-20 (an account any app can act with — version 1.26.0)

**A library other apps can use: `fediverse-account`, in `lib/session/`.** A
person types a Fediverse handle or a WebID into any web page; they are sent
to wherever that account signs in, their Mastodon-family server or their
Solid pod, and come back to where they were with an account the page can
act with: post, reply, read the home timeline, follow, favourite, boost,
and show the profile. The page never asks which kind it got. A Mastodon
account acts at once through its own server. A FediPod account acts
through its outbox door, and one made in the browser at fedipod.net carries
a notice for the page to show: its posts and follows go out the next time
fedipod.net is open. Three files, no dependencies, ready to publish to npm
and so to any CDN. A demo page sits beside it.

**The browser's own sign-in became that library's engine.** The Solid-OIDC
session the BrowserAgent and the forum sign in with moved to
`lib/session/oidc-session.mjs`, with the app's database name and client
name as parameters; `web/app/oidc-session.mjs` binds them, so every
signed-in browser keeps its session and nothing else changed. The guard
script now holds the library to the pod library's rules: no imports above
itself, no Node built-ins, no FediPod in its code.

## 2026-09-20 (a follow from another server lands somewhere — version 1.25.0)

**Pressing Follow and naming this host used to end in "not found".** Every
Fediverse server asks a reader who is not signed in which server they are on,
and hands them to that server's own follow page; this one had no such page,
and its accounts' WebFinger answers named none — so following anybody from a
profile page, the form on your own profile page included, ended in a 404. Both
halves are there now: **`/authorize_interaction`** names who you are about to
follow and sends the follow from the browser you are signed in to, and the
WebFinger answer tells other servers where to find it.

**A sign-in that could not read your account fixes itself where it can.** The
browser agent reads its record from your pod; when that read failed it dropped
whatever the pod had said and reported one thing — "no account config on this
pod — sign up first" — to somebody who had just signed in, with their account
sitting on the pod unread. Now nothing is handed to you to press unless
pressing it is the only thing left. A token the pod refuses is renewed and the
read is made again, in the session itself, which is where most of these
started and ended. If the pod will not renew it either, the page takes you to
your pod's own login. A pod that is busy, broken or out of reach has already
been retried by the transport, and the page then waits and asks again on its
own, counting down where you can see it. What is left — the pod refusing a
freshly renewed sign-in, or a pod that genuinely holds no account — is said in
a sentence that names what the pod did, what it means for your account, and
the one thing that helps. The stack trace under it is gone.

## 2026-09-19 (a public document is read once, not once per reader — version 1.24.0)

**What the front hands over from a pod may be held by a cache.** Every read of
an actor, a topic, a post or a card came back "do not store", so each one was
answered from the pod: a single visit to a forum is twenty of them, and every
visitor and every refresh paid again. Public documents are now held for half a
minute, and a handle's WebFinger answer for five, with a stale copy served
while a fresh one is fetched. Anything signed in, anything posted, and the
site's own APIs are unchanged.

**A pod server leaves signing up alone.** Making an account and a pod is the
server's own, exactly as it was before FediPod was installed: the component no
longer answers `/`, `/signup` or `/new-account`. What it adds is the page where
somebody who already has a pod turns it into a Fediverse account, and that page
has moved to **`/.fediverse-account`** — an operator can name it with `runPath`.
The path it takes is one the pod no longer serves, which is why it is theirs to
choose.

## 2026-09-19 (a forum is an account like the others — version 1.23.0)

**A forum lives with your other accounts and starts with them.** Its home goes
under `profiles/`, and the runner that starts an account starts a forum where
the home holds one — same unit, same startup, and `fedipod profiles` lists it
as a forum, active or not. Its console keeps one address instead of a new one
each restart, and opening that address once leaves the key in the browser, so
the link from your own account's page works afterwards.

**The opt-in page's button wakes up for a form it did not watch you fill.** A
browser putting back what was in the boxes — a reload, the back button, its own
remembered values — fills them without anybody typing, and the button stayed
grey over a filled-in form with nothing to say why.

## 2026-09-19 (the forum has a window on the machine running it — version 1.22.0)

**`fedipod-bb start` serves a console on this machine.** It says whether the
forum is hosting or watching, which pod it is on, each category with its topics
and members, who moderates, what is waiting for a moderator — including an ask
that failed and why — and the last of what the forum has said. It refreshes
itself.

It reads and changes nothing: moderating is done at the website, where an ask
is published at the asker's own pod and can be checked. The address is
loopback, https, and carries a key minted for that run, since the queue holds
reports and held posts; the forum prints the address when it starts. `start`
takes `--console-port N`, or `--no-console`.

## 2026-09-19 (a sign-in that cannot be renewed says so — version 1.21.0)

**A failure while renewing your sign-in names itself.** Everything you do from
a page with your pod renews its token first, and a server refusing that under
load reaches the browser as a bare "failed to fetch" — which the action then
reported as its own step, sending you to look at your pod. It now says it was
renewing your sign-in, and names the server that refused; a server asking us to
slow down says that instead.

**Opting in on a pod server uses the session you already have.** `/run` asked
you to sign in again because the call behind it wanted a token, while a pod
login is a cookie. Where the server being asked is the one that issued the
session, it reads that session — same-origin requests only, and only the WebID
that owns the pod being claimed. A Gateway fronting somebody else's pod holds
no such session and still sends you to sign in.

## 2026-09-19 (a settings change that cannot be kept is refused — version 1.20.0)

**A change to the forum is written to its pod before anything is published.**
A pod that refuses the write — under load it answers "back off" — used to leave
the change in the running forum's memory: the new moderator was published,
announced, and then wiped by the next start, which reads the pod and republishes
from it. Nothing said so.

Now the record is written first. If the pod will not keep it, the forum is left
exactly as it was, nothing is published, and the ask stays in the moderators'
queue carrying why it did not take. The queue page shows that line, and the
forum tries the ask again on its next sweep.

## 2026-09-19 (posting to somebody's timeline reaches the Fediverse — version 1.19.1)

The post goes out signed, so Mastodon and every other server that requires
signed mail accepts it. The page does not deliver it: it hands the post to your
own account's door at the Gateway, proved with the pod login you are already
using, and your agent publishes and delivers it.

Two things follow, and the box says both before you type: it needs an account
with a door at this Gateway, and the post goes out when your agent next reads
its inbox.

## 2026-09-19 (post to somebody's timeline — version 1.19.0)

The box on a person's page posts to their timeline. What you write is a post of
your own that names them, written in your public container like any other post
and handed to their inbox, so it reaches them and anyone who reads either of
you. It is public, and the box says so before anything is typed.

It replaces the private message that was there, which could not be delivered:
a message nobody but its author may read cannot be checked by the server
receiving it, and a page holds no key to prove it another way.

## 2026-09-19 (a message is named where it lives — version 1.18.3)

A message carries its own address on the sender's pod. It used to be named at
the address the account publishes under, which cannot hand it over: the
message is readable by its owner and nobody else, so that address answered
nobody.

## 2026-09-19 (a message reaches somebody at a Gateway — version 1.18.2)

A message to somebody whose address is at a Gateway is handed to the pod
behind it. Their account names the Gateway's door as its inbox, and that door
takes mail between servers rather than from a page, so the message was refused
before it left the browser.

## 2026-09-19 (a message that fails says where — version 1.18.1)

Sending a message makes three requests to two hosts, and any of them failing
used to arrive as the browser's bare *Failed to fetch*, which names neither.
Each now says which address would not answer and what was being done there,
and a pod that refuses says so with its status and the address it refused.

## 2026-09-19 (a word with one person — version 1.18.0)

**You can write to somebody from their page.** Signed in with a pod, there is a
box on a person's page in the forum. What you type is kept on your own pod
where nobody else can read it and handed to that person's inbox; the forum is
never told and keeps no copy. A server that accepts only signed mail will
refuse it, and the refusal names the host that refused.

The footer says what the site runs on.

## 2026-09-19 (every handle leads to the same page — version 1.17.5)

A handle anywhere in the forum — a byline, the index's *Latest by*, the
moderators under the line — opens that person's posts here. The moderators are
underlined. On that page, **their profile** opens the page their account
publishes for a person to read, and it is offered only where their account
names one; somebody the forum has kept nothing about is read from their own
account instead of coming up blank.

## 2026-09-19 (a button that worked now says so — version 1.17.4)

**A settings change says what came of it, where the button is.** Adding a
moderator worked and told you nothing you could see: the confirmation went to
the line that reads aloud for a screen reader, which is invisible on the
screen. It now appears in the panel, in green, and a refusal appears there too
instead of in a box to dismiss. An empty field says so rather than doing
nothing.

**Your own vote shows the moment you cast it.** The arrows take your vote
straight away; the forum's own count follows when it has taken it.

**A moderator added while the forum is running appears in the list.** The
forum's own list of who moderates is written when it changes, rather than at
the next start, and the line under the rule follows the categories' lists as
the page reads them.

**Long handles keep to their column.** A handle as long as an address is cut
with an ellipsis in the index, so the topic's name gets the width; the whole
handle is on the cell to read.

## 2026-09-19 (search asks for its room — version 1.17.3)

Search is a button beside New topic, and opens into a box when it is pressed;
left empty, it goes back to being a button. Both sit flush right on the line
that names who moderates, above whatever is being read. Join stays with the
categories.

## 2026-09-19 (the forum's own colours in its top row — version 1.17.1)

Who you are signed in as, and the button beside it, are in the site's green;
who moderates sits directly under the line, with the word *moderators* in the
same green and each name linking to that account's page.

## 2026-09-19 (posting into a forum joins it — version 1.17.0)

**A post from somebody who has not joined an open category joins them, and is
carried.** Posting from the forum's own website always did that; a post
arriving from another server had no Follow in front of it and waited for a
moderator, so every first post from the Fediverse sat in the queue. A category
that is private still waits for a moderator, because membership there is the
right to read what members write. `fedipod-bb init --reply-policy review` puts
the holding back.

**The buttons in a settings panel work.** A panel is a box in front of the
page and sits outside it, where the page's own click handling never reached —
so Add in Manage moderators did nothing at all. The panel is also wide enough
for the field and its buttons to sit on one row.

**The top row.** It reads *signed in as @you@your.server*, and who moderates
the forum is listed under the line rather than who hosts it.

## 2026-09-19 (a moderator sees the Queue and Settings again — version 1.16.3)

**The forum's Queue and Settings links come back.** The row of links is drawn
when the page knows who moderates, rather than a moment before it finds out, so
a moderator arriving at the forum sees their own links on the first screen.
Opening Settings straight from a link works too: the page asks who moderates
before deciding a reader is not one.

The top row names what it is showing: *Signed in as @you@your.server*.

## 2026-09-19 (a way in from the top row — version 1.16.2)

**The forum's top row says who you are, and signs you in.** At the far right:
your handle and Sign out when you are signed in, Sign in when you are not.
Signing in used to be something only the reply box offered, so a reader the
page no longer recognised had no way back to the moderator's Queue and
Settings.

## 2026-09-19 (a moderator is named by their handle — version 1.16.1)

**The forum's Moderators panel takes a handle.** Type `@mei@their.server` and
press Add: the page asks that server who it means, and the forum is told both
things that follow from it — who may ask for moderation, and whose pod the rule
on the moderators' queue names. One field does both, where there were two
asking for addresses you had to know. A handle whose server does not know it is
refused at the panel rather than accepted and quietly ignored.

An account with no pod behind it, a Mastodon one for instance, can moderate and
have its asks acted on, but cannot open the queue: that queue is held under the
pod's own access rule, and a rule names a person by the WebID of their pod. The
panel says so.

The list of who moderates now asks each account what it calls itself instead of
reading a name out of its web address, so a pod moderator reads as
`@mei@mei.pod.example`.

**A setting asked for through a Gateway is acted on.** The forum reads the
address an ask names in the same space as its own, so asking from a page served
at fedipod.net means what asking at the pod means.

## 2026-09-18 (a choice of clients, and a forum that takes a moderator's word — version 1.16.0)

**Two clients.** Sengi joins Phanpy, and it is the one you get by default. The
links at the top right of the page switch between them and your browser keeps
the choice; each client has its own shell page naming the app it frames, so
nothing is ever loaded into the frame by script. A first visit says so, once.
Sengi is signed in for you the way Phanpy always was, lands on a Home column
rather than a screen telling you to right-click your avatar, and its columns
are wider. It is a patched build — `sengi/PATCHES.md` lists the nine changes
and warns that two of them fail silently if an upgrade drops them.

**Something to read on the first morning.** The tag feed's defaults went from
three tags to twelve, two from each of six subjects, and a sweep now takes four
of them in turn rather than all of them at once: a sweep holds its writes until
it finishes, the browser kills a service worker whenever it likes, and twelve
tags ran long enough to be killed and contribute nothing. Trending tags are
answered for the first time, counted from the notes the feed has actually
brought in — seven days each, distinct people per day, busiest first.

**A restart is the same device coming back.** The lease that stops two agents
acting at once identified its holder by an id minted per process, so every
restart looked like a second device and asked the owner to take over their own
account. Switching clients did it every time, being a navigation. Both the
browser and the forum host now keep an id: the browser on its origin, the host
beside its credential.

**The forum takes a moderator's word.** An Update says what to change inside
its object, and the moderation queue kept only the object's id — so close,
reopen and rename all arrived saying nothing but which topic, and did nothing.
Reopening is now valid ActivityPub: `closed` is a time, so closing carries the
moment and reopening removes it, which §6.3.1 spells as `null`. A shape for
Update watches it, and JSON-LD's inability to carry a null no longer loses the
removal. Close topic has moved beside Delete topic and both are red; the index
column counts posts rather than replies; signing in is offered for anything
that needs an account, not only for posting, and finishes what you pressed.

**Booleans are booleans.** An RDF literal's value is its lexical form, so every
boolean and number arriving in an activity was a string — `!!"false"` is true,
which is how a reopen was applied as another close. Converted by datatype now;
dates are left as the strings everything here carries them as.

**Smaller things.** Favicons: a door for the gateway's pages, a house for your
own, speech bubbles for the forum. An account with no icon gets a visible
avatar rather than a transparent pixel. A client registering with a FormData
is understood — multipart bodies were read as query strings, so every field
arrived undefined. Switching a forum category no longer refetches the whole
forum: 6–12ms rather than ~900.

## 2026-09-16 (FediPod-BB, a forum on a pod — version 1.15.0, fedipod-server 0.25.0)

A discussion forum whose record lives on a Solid pod, as ActivityPub
documents in the shapes Lemmy, NodeBB and Discourse use. Each category is a
FediPod group, so people on Mastodon or Lemmy follow a category and take
part from where they are; the topics, their pages and a readable copy of
every post are documents on the forum's pod. The host is the DeviceAgent,
run by the moderators from their own machines: several may run it, one acts
and the rest watch and take over when it stops, and the forum knows nothing
that is not on the pod. The website reads the pod from the visitor's
browser: categories, topics newest first, threads in order. Anyone reads;
to reply, a reader signs in once with a Mastodon account and the reply goes
out from that account, showing in the thread once the forum has placed it.
A moderator removes a post, deletes, moves, pins or locks a topic, and
members' servers are told in the shapes the FEPs give for it; a moderator's
own Remove, Move, Delete or Flag arriving from elsewhere is held in the
queue, never run on arrival. It is the package `packages/fedipod-bb`, with
`fedipod-bb init | start | status | attach`, and the page is served at
`/bb/` on the site, or at `https://bb.<domain>/<forum>/` where the site
has that alias. A Gateway directory row can name the inbox deliveries are
written into, which is what lets every category of a forum share one.

The front page is what has just been said: every post newest first across
every category, one line each, with the topic it is in, who wrote it, when,
and how many replies the topic has had. Picking a category filters it, and
a topic's name opens the thread at that post. Pinned topics come first,
marked with a star when a moderator pinned them across the forum and a pin
when it was within one category.

A thread reads as a thread: each reply sits under the post it answers.
Posts are written in Markdown — bold, italic, links, lists, quotes, code —
and what you typed is kept beside what it became, so editing reopens your
words rather than a guess at them. A topic has a name, given when it is
opened; posts have no titles of their own.

On each post: Reply, Share, Report, and on your own Edit and Delete. A
report from any reader is queued for the forum's moderators. A moderator
sees, under a topic's title: rename, pin here, pin across the forum, and
delete. A moderator's request is published at their own pod first, and the
forum acts on it only after fetching it back there — a delivery into a
public inbox proves nothing about who sent it.

Posts can be voted for, and the index sorted by votes or by time and
searched. A name opens that person's posts in the forum. Moderators get a
queue of reports and held posts, with a record of what was done, readable by
them alone: from it a held post can be let through or turned away, and its
author banned. A category can be made readable only by the people named for
it, which the pod itself enforces.

The page is built to be read by whoever is reading it. Every control names
what it acts on, so a screen reader hears "Reply to Mei" rather than a
thread of identical Reply buttons; there is a skip link, the landmarks and
the table headers are named, and the category you are in is marked as the
current one rather than only coloured. What the page has just done — what
is loading, how many posts arrived, that a link was copied — is said as
well as shown, and the reply box takes the keyboard when it opens and hands
it back when it closes.

A topic whose newest post arrived since you last opened it is marked `New`
on the index. That mark is yours: one entry per topic in your own browser,
written nowhere else and sent nowhere. A forum you are opening for the
first time is not a page of them — everything before that moment is read.
A reply you have just sent shows as your own copy, marked as waiting and
written the way it will read once the forum has placed it.

## 2026-09-16 (quote posts and emoji reactions — version 1.14.0, fedipod-server 0.24.0)

A post can quote another post. In the client, choose Quote on a post whose
author allows it, write yours, and it goes out naming theirs; the quoted post
shows inside yours. The quoted author's server is asked, the way Mastodon
asks, and the quote is marked pending until they answer, accepted when they
allow it, and taken off your post if they refuse. Quotes of your own posts
need no asking. Every post you publish says that anyone may quote it when the
world can read it, and nobody when it is followers-only or direct, which is
what lets Mastodon offer its Quote button on your posts; when someone quotes
one, their post is kept, the permission is published beside yours, and you
get a notification. Posts that quote, arriving from any server that writes
the quote in one of the ways in use, show the quoted post inside them.

Emoji reactions from Misskey, Sharkey, Pleroma and Akkoma reach you as
notifications showing the emoji, custom ones included. Taking a reaction back
removes it.

The client is told the server speaks Mastodon API version 7, so it offers
quoting, reads notifications in grouped form, and offers the blur action on a
filter.

## 2026-09-16 (fedipod.net refreshes itself — version 1.13.0, fedipod-server 0.23.0)

A fedipod.net page that is open when a newer build goes up reloads itself,
once, on its own. If you are in the middle of writing a post it shows a
line with a reload button instead and waits for you. No more refreshing
twice to be sure.

## 2026-09-15 (the screens that used to be empty — version 1.12.0, fedipod-server 0.22.0)

In any Mastodon client, the directory, suggestions and trends screens
answer instead of failing; a profile's "add to list" knows which lists the
account is on; the muted accounts, blocked accounts and blocked domains
pages list them, and a domain can be blocked and unblocked from there; the
direct-messages timeline answers; tapping a notification opens it, and
notifications can be dismissed one at a time or cleared; and a profile's
post list honours its filters: without replies, without boosts, media only,
or one hashtag.

## 2026-09-15 (the profile page says more — version 1.11.0, fedipod-server 0.21.0)

Your profile page, the one anyone can open, now shows your header image,
your profile fields, when you joined, and your pinned posts, beside your
name, address and bio. The page is rewritten only when one of those
changes. When you joined is recorded from now on; an account made before
this is dated by its oldest post, and your client shows that date too.

The gateway's roster names a pod on a path of a shared host by its host and
path, so two pods on one host can be told apart.

## 2026-09-15 (a profile anyone can open — version 1.10.0, fedipod-server 0.20.0)

Someone who knows your address can open your profile without a Fediverse
account. `https://fedipod.net/@handle` opens the profile page of an account
at fedipod.net, and the same short address works on the host of an account
whose address is its pod's, on the DeviceAgent and the Server. For an
account attached to fedipod.net with its address on its pod,
`https://fedipod.net/@handle@pod-host` opens the page too. The WebFinger
answer for every account links that page, which is where other software
looks for it.

## 2026-09-15 (replies reach their thread, and what other servers say is acted on — version 1.9.0, fedipod-server 0.19.0)

A reply now reaches the server of the person it answers whether or not their
handle is in the text, so the thread is whole where they read it. Their
notification is still the text's to decide: retype the handle and they are
told, trim it and they are not.

A content warning marks the post sensitive, which is what other servers hide
it behind; media marked sensitive is hidden the same way. A `#word` in a post
is a hashtag other servers file it under.

The outbox lists each post's Create activity and each boost, as ActivityPub
describes an outbox.

A server that answers that an account is gone is believed: the delivery is
not retried and the follower is dropped. A withdrawn favourite or boost
leaves your notifications; a post someone stopped boosting leaves your
timeline. A block from a sender the door verified drops their follow of you
and yours of them.

Moving the account to another server keeps everything the actor advertised:
its gateway inbox, its outbox door, its moderators and its private
collections.

A client paging through a timeline is sent to the address it reached, not to
the pod's host. Deliveries signed with RFC 9421 verify at the door.

An app posting through the outbox address must show the proof that goes
with its Solid sign-in token; a token on its own is refused. The people such
a post names in `bto` or `bcc` receive it and are never listed on it, and
the people it names in `to` or `cc` receive it and are. A fedipod.net
address can be looked up from a page on any site, and the server's NodeInfo
document is served under the media type its schema names.

## 2026-09-14 (posting from other apps, a new key from the unlock screen, the timeline that keeps its posts — version 1.8.0, fedipod-server 0.18.0)

Any app that speaks ActivityPub client-to-server, dokieli for one, can post as
you. Your actor document and your WebID profile name your outbox: the agent's
own endpoint on the DeviceAgent and the Server, the Gateway's outbox door for
an account behind a Gateway. The door checks your pod sign-in, keeps the post
in your inbox marked as yours, and your agent publishes and delivers it the
next time it runs. A post that is not a note, a Web Annotation say, is kept as
the app sent it, under your name. A post with no audience stated is public.

On the unlock screen, someone who has changed or lost the password they signed
up with makes a new signing key locked under the password they use now, and
is in. The old key is replaced on the pod and the new public key published.

A post, poll or boost is answered as done only once its row on your own
timeline is on the pod, and an agent becoming active puts back any own post
its timeline index lacks. The manage page says which state documents could not
be read on the last load, when any.

`specs-in-use.md`, which specs FediPod follows and where it stops short, is
at the repository root and linked from the README.

## 2026-09-14 (the DeviceAgent takes a suffix-based pod too — version 1.6.0, fedipod-server 0.16.0)

Setting up the DeviceAgent — the version you install on your own machine —
now takes a pod on a suffix-based host, like `https://server.example/alice/`,
the same way the browser does. Its address lives at a gateway,
`@handle@fedipod.net`, and the posts, key and data stay on the pod. A pod at
its own host chooses at setup between its own address and a gateway's.

## 2026-09-14 (a pod on a suffix-based host can be an account — version 1.5.0, fedipod-server 0.15.0)

Sign-up in the browser takes a pod on a suffix-based host, like
`https://server.example/alice/`, as well as a pod at its own host. Such a pod's
address is `@handle@fedipod.net`, because nothing at the suffix-based host can
answer for the handle; the posts, key and data stay on the pod. A pod at its
own host chooses at sign-up where its address lives: on the pod, as before, or
at fedipod.net. The choice is permanent.

The provider list on the sign-up page is the Community Solid Server providers
from solidproject.org, with "Other…" for any other. The form asks the chosen
provider where it puts new pods and fixes the address to fedipod.net for one
that keeps them on paths.

Sign-in on a new browser by a fedipod.net address finds the pod through the
address's WebFinger. Pictures under a fedipod.net address are answered by
pointing at the pod. An access rule written for a fedipod.net address now
guards the pod resource it was meant for; before, it guarded nothing and
locked the owner out of the container.

## 2026-09-14 (private messages between FediPod accounts arrive — version 1.4.1, fedipod-server 0.14.1)

A direct or followers-only post from one FediPod account to another was
thrown away on arrival: the receiver insisted on fetching the note from the
sender's private container, which nobody else can read. A delivery the door
verified is now read from the copy it carries.

From the browser build, the people a post names are now looked up at all,
and looked up through fedipod.net rather than by a direct request to the
other pod's host. A direct message from the browser therefore reaches its
addressee.

An account whose row at fedipod.net named the wrong place can correct it by
attaching again from the same account on the same pod. The door also records
the pod's answer when a delivery cannot be written.

## 2026-09-14 (conversations under Bluesky posts, and direct messages that say so — version 1.4.0, fedipod-server 0.14.0)

Opening a Bluesky post now shows the conversation under it, with the
pictures in the replies, in quotes and in link cards. Nothing is written to
the pod for it.

A direct message to someone the agent cannot find is refused with the
reason, naming who could not be found, instead of being kept and sent to
nobody. The same for a direct poll.

A direct message, or any post that names you, raises a notification whoever
sent it. Before, one from someone you follow arrived silently.

## 2026-09-14 (a search result can be opened — version 1.3.3, fedipod-server 0.13.2)

In the browser build, clicking an account or post you had just been shown
could answer "Record not found". The browser stops the agent whenever it
idles, and the table that turned an id back into an address went with it.
An id is now worked out from what the agent holds, so a fresh agent answers
for ids an earlier one handed out. An account on a non-default port is also
found when a client asks for it without the port.

## 2026-09-14 (people with profile fields can be found again — version 1.3.2, fedipod-server 0.13.1)

Looking someone up by handle found nobody when their profile carried fields
such as a website or pronouns, and a follow from such a person could not be
read. The reader that turns an actor document into an account was picking
one of the fields instead of the account. It reads the account now, on every
build.

From the browser build, reads sent through fedipod.net were also refused as
"no such account", because the browser named the account by its bare handle
and fedipod.net files it by its full address. The browser uses the full
address now. Search and follow from the browser work against mastodon.social.

## 2026-09-13 (the browser can look people up again — version 1.3.1)

Searching for someone by handle from the browser build found nobody on
mastodon.social, and following them failed the same way. The browser signs
its reads and hands them to fedipod.net to send, and one signed header was
left behind on the way. It travels now. Reload the page and search again.

## 2026-09-13 (a Server account checks who is knocking — version 1.3.0, fedipod-server 0.13.0)

FediPod Server now verifies every delivery at the pod's own inbox. The
signature on a post, follow or reply from another server is checked as it
arrives, and the account acts only on what checked out. A delivery signed with
the wrong key is dropped at the door. One with no signature still lands and is
answered after the account confirms the sender through the sender's own actor
document, as before. Nothing about an account's address changes, and there is
no setting: every account on the server gets this from its next start.

## 2026-09-13 (the browser keeps a key it cannot hand over)

The browser build keeps an opened copy of your signing key on the device so
the agent can start on its own. That copy is now held as a WebCrypto key that
can sign but cannot be read out, where before it was the key text itself. A
script that reaches the browser's storage gets nothing it can carry away. A
copy stored by an earlier build is converted the next time the agent starts.

## 2026-09-12 (an activity means what it says, however it was written — version 1.2.0)

ActivityStreams documents are read as the JSON-LD they are. Two servers can
write the same Follow in different ways — one spelling the terms out, one
naming them through a prefix — and until now only the first was understood; the
second was quietly ignored. Both arrive now.

Nothing is fetched to do it. The contexts that fediverse documents name are
held here, and an activity naming anything else is read the old way rather than
sending this software off to an address a stranger chose.

Each document is also checked against a description of what that kind of
document is. Nothing is turned away for failing the check — the mismatch is
recorded where you can see it, on the dead letters page.

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
the DeviceAgent, the gateway and the pod server. Nothing here is a new
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
- **CSV import works in the browser**, the same importer the DeviceAgent
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

### And on the DeviceAgent, the gateway and the pod server

- **Any page you visited could take over an DeviceAgent**, in three
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
