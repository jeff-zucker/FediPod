# Audit: pod load and security, 2026-08-03

What was looked at, what survived being argued with, and what is proposed. Companion to
`audit-2026-08-02.md`, which this does not repeat.

## What happened

The 2026-08-02 audit finished at `ca21a60`. **Thirteen commits landed after it and none had
been swept** — including the three that changed pod-load behaviour deliberately (`ab0734a`
profile-save digest gate, `b0b83a3` outbox paging, `47c873c` paging/revocation/`ports.mjs`)
and the dependency jump `0af8c38` (fedify 1 → 2, jose 5 → 6). HEAD `66894a6`, tree clean.

Six reading lenses over pod load and security produced 52 findings. Each was then handed to
an independent agent told to **refute** it, and to default to refuted when unsure. **44
survived**; 8 were killed. A completeness critic then confirmed 5 more by reading.

Nothing was run — no test suite, no agent, no network. Everything below is from reading the
code at `66894a6`.

The 08-02 lesson held again. Several findings filed as "high" came back with their mechanism
corrected, and the quiet tail was accurate. Severities here are the post-refutation ones.

## The two headlines

### 1. The park on `/admin/` authentication rests on a check that does not hold

`audit-2026-08-02.md` parks admin auth and says to revisit **if and only if** the agent is
deliberately exposed. It names the safety net that makes exposure survivable: `/shutdown`,
`/setup`, `/config`, `/new-actor` and `/start-actor` are local-only, and `/oauth/authorize`
refuses to mint a bearer for a non-local Host.

All of that is decided by `Authorities.isLocal(req.headers.host)` — **the client's own
header** (`lib/guard.mjs:84`, used at `lib/admin.mjs:512` and `lib/mastoapi.mjs:325`).
`curl -H 'Host: localhost:8030'` satisfies it. `req.socket.remoteAddress` is not consulted
anywhere in the tree.

The refuter made it worse than it was filed. Both listeners bind loopback only
(`lib/admin.mjs:973`, `:987`), so the documented `AP_ALLOWED_HOSTS` route *requires* a
same-host fronting proxy — and a stock `proxy_pass http://127.0.0.1:8030;` with no
`proxy_set_header Host $host` **rewrites Host to `127.0.0.1:8030` on every request**, which is
in `this.local`. No attacker header is needed; the operator's own proxy supplies it, for every
caller. On a password-less agent that opens `/oauth/authorize` and hands out a 90-day
full-authority bearer.

Beside it: `LOCAL_ONLY_POSTS` (`lib/admin.mjs:53`) holds only six paths. Every other POST
answers an exposed caller with **no credential at all** — `/post`, `/follow`, `/block`,
`/rotate-key`, `/move`, `/park`, `/drain`, `/rebuild`, `/publish-profile`, `/retire`, all
group moderation — plus unauthenticated reads of `/log`, `/deadletter`, `/config` and
`/profiles`. `run-agent.mjs:236` already computes exactly the "exposed and unprotected"
condition, and only warns.

### 2. `b0b83a3` made appending to the outbox cheap and removing from it O(total)

`outboxPages` anchors at the oldest end (`lib/wire.mjs:217`), which is right for appends: a
new post rewrites one page and the head, and the digest check at `lib/publisher.mjs:521` skips
the sealed ones. But **removal re-slices every later page**, so all their digests change and
all are re-PUT. One deletion went from 1 PUT to up to `ceil(N/20)+1`.

`onDelete`'s account branch (`lib/intake.mjs:916`) then calls `forget` per status, and `forget`
calls `retract` → `unrecordOutbox` → `publishOutbox` for each, so a **single inbound
`Delete{actor}` pays that cost M times**. Verified bounds: this is group-only (a person's
statuses carry no `announceActivity`), and the 1000-entry status cap bounds M — but at a
5000-entry outbox the oldest retained status still sits ~200 pages deep.

Third, and the sharpest of the three: **`force` never reaches the page digests**
(`lib/publisher.mjs:521`). A repair republish after a pod wipe rewrites the head and skips
every page whose digest still matches the local `published.json`. The head then advertises a
`first:` that 404s, `readPublishedOutbox` returns `[]`, `rebuildStatuses` recovers nothing,
`verifyPublicSurface` probes the head it just rewrote and reports clean — and the whole thing
logs success. It triggers for an actor with one post as surely as one with five thousand.

## Verified findings

### Security — reachable when the agent is exposed

| sev | where | what |
|---|---|---|
| high | `lib/guard.mjs:84` | `isLocal` trusts the Host header, so every local-only POST and the passwordless OAuth mint open up. A normal reverse proxy supplies the forgery for free. |
| high | `lib/admin.mjs:53` | Only six paths are local-only; everything else answers an exposed caller with no credential, reads included. |
| medium | `lib/guard.mjs:34` | `loopbackAuthorities` pushes bare `localhost`/`127.0.0.1` beside `name:port`, so a page served from **any** local :80/:443 listener has an Origin the firewall accepts. `readBody` (`lib/admin.mjs:153`) JSON-parses regardless of content-type, so a preflight-free form POST reaches every write route, and `redirectAllowed` accepts `http://localhost/cb` as an OAuth target. The two chain: clear `uiPassword` through `/config`, then mint. |

### Security — reachable by anyone who can Append to the public inbox

| sev | where | what |
|---|---|---|
| high | `lib/intake.mjs:820` | **Forged attribution.** `const author = note.attributedTo \|\| actor`, with no check that the author's origin matches the note's. A document at `evil.example` claiming `attributedTo: <someone you follow>` passes everything: `sameOrigin` tests the *envelope* (both at evil.example), `concernsUs` is satisfied by addressing it to you, `note.id === objectId` holds. It lands in the home timeline and in pod RDF as them. For a **group** worse still — `amplify` gates on the spoofed author's membership, so the group signs an `Announce` and federates the forgery to every member. |
| high | `lib/intake.mjs:507` | **Actor-cache poisoning.** `fetchAP` caches under `doc.id` — the id the document claims — never comparing it to the URL fetched, and the id-mismatch checks in `onFollow`/`ingestNote` run *after* the cache write without undoing it. One appended Follow lets a stranger own the displayed name, bio, avatar and Person/Group flag of any account you interact with, and plants a `known()` entry. Fields are sanitized at the boundary, so this is impersonation, not XSS, and `inbox` is not among the stored fields. |
| high | `lib/intake.mjs:664-672` | **Follower eviction.** The documented no-`followId` carve-out lets an object-form `Undo` naming anything evict such a record. Those records are not only produced by restore/`reconcileFollowers`: an id-less inbound Follow yields `followId: undefined` (`lib/intake.mjs:606`), so an attacker can *manufacture* an evictable record. `dropFollower` leaves a permanent mark, so the next reconcile does not bring them back. |
| high | `lib/intake.mjs:1001-1014` | **`addReply` writes wherever the stranger points.** The only check is `inReplyTo.startsWith(urls.notes)` — the parent is never required to exist or to be ours (contrast the group branch at `:699`). A stranger replying to an invented `/ap/notes/<anything>` makes us create a new pod document there and then grow and re-PUT it whole per reply: 4 pod requests each, cumulative bytes quadratic, no cap, no expiry. |
| medium | `lib/intake.mjs:547` | A forged `Like`/`Announce` on one of our own notes records a notification from a wholly unverified actor; the 500-entry cap makes ~500 appends a notification-history eraser. |
| medium | `lib/mastoapi.mjs:143` | That unvalidated actor string becomes `account.url`/`uri`. A `javascript:` actor parses, so `isBlocked` lets it through. The refuter would not certify script execution — React and the CSP both stand in the way — so this is defence in depth, not a proven XSS. |
| medium | `lib/mastoapi.mjs:735` | Media upload PUTs the **client-supplied Content-Type verbatim** into the public-Read container. `text/html` is then served at the pod origin — same origin as the WebID, `ap-state/` and every ACL. |
| medium | `lib/intake.mjs:752-758` | A group's review queue caps at 500 with `unshift`+`slice(0,500)`, so one auto-accepted member posting 500 notes silently discards everything the operator had waiting. Drop at the head, not the tail. |
| low | `lib/social.mjs:37` | `resolveHandle` never checks the JRD `subject`, so a remote-authored mention can point our reply at an unrelated actor. |
| low | `lib/wire.mjs:279` | `attachmentsOf` does not scheme-check `a.url`, unlike `safeUrl` for icons. It reaches the client as media `src` and `$rdf.sym()` in pod Turtle. |
| low | `lib/mastoapi.mjs:700` | The URL branch of `/api/v2/search` ingests and caches with no blocklist check. |
| low | `lib/intake.mjs:318`, `lib/tagfeed.mjs:107` | Two remote reads use `res.json()` with no byte budget — the exact cap the drain path was given. |

### Security — other

| sev | where | what |
|---|---|---|
| high | `bin/activitypod.mjs:782` | **`state --to` copies first and validates after.** Every state document — `masto-tokens.json` included — and every RDF note is written to the target, and only *then* does line 782 test whether the target was `http://` and exit 2. A typo'd `http://nas.local/…` ships the whole private half in cleartext, and the surrounding output says nothing was moved. |
| low | `lib/safefetch.mjs:150` | DNS-rebinding pinning depends on `undici` resolving. It is an undeclared four-level transitive dependency and its absence is swallowed: validation still runs, pinning quietly does not. |
| low | `lib/intake.mjs:236` | The push socket URL comes out of the pod's subscription response straight into `new WebSocket()` with no scheme or address check — the one outbound path that bypasses the SSRF gate. |
| low | `lib/admin.mjs:285` | The Host/Origin refusal logs the full request target, so any visited page can flood `agent.log` and roll the `/log` ring; a rejected streaming request would park an `?access_token=` in it. |
| low | `lib/mastoapi.mjs:286` | The facade writes its own headers and skips `securityHeaders`, so the OAuth password form is served with no CSP, no nosniff and no framing protection. |
| low | `lib/admin.mjs:697` | `/new-actor` never passes the gate token to the child it spawns, so with `AP_GATE_TOKEN` set every attempt fails and orphans a detached agent. |
| low | `vendor/idp-grant.cjs:182` | `0af8c38` made only the *generate* branch `extractable`, so a DPoP key restored from `token.json` is non-extractable and the token file silently stops being written. |

**Refuted — do not re-raise.** Streaming sockets are re-checked on revoke (the token list is
consulted per broadcast). OAuth `scope` is theatre for one local user and the park covers it.
`GET /profiles` is not a useful CSRF amplifier. `reconcileFollowers`' uncapped `res.json()`
needs a position the attacker cannot have. The `token_endpoint` is operator-supplied. The
`Link` header host is correct. `PodStore.write`'s missing equality check is real but only
bites through `deliver.mjs` (below), not on its own.

### Pod load

**Read this first.** Since `bbba587` both setup paths default `privateRoot` to
`file://$AP_HOME/private/`, so on a **new** install the state documents are local disk, not
pod. `privateRoot` absent still means "on the pod" (`run-agent.mjs:58`), and **there is no
migration** — every CLI-created install predating that commit still pays a pod PUT for every
state write, and keeps its timeline, contacts, blocklist and notifications there. Rows marked
⚑ are pod requests only on those installs; the rest hit the pod for everyone.

| sev | where | what |
|---|---|---|
| high | `lib/publisher.mjs:516`, `lib/wire.mjs:217` | Removal re-slices every later page: one deletion or unboost costs up to `ceil(N/20)+1` PUTs where it used to cost 1. |
| high | `lib/intake.mjs:916` | `Delete{actor}` pays that cost once per status. Group-only, bounded by the 1000-status cap, still hundreds to thousands of PUTs from one inbox item. |
| high | `lib/publisher.mjs:521` | `force` never reaches the page digests, so the repair republish leaves the pages missing and reports success. |
| high ⚑ | `lib/store.mjs:334` | Remote names, bios and content enter the store with no length bound. A 4 MB `summary` on a planted Follow permanently inflates `actors.json`; because `cacheActor` always rewrites `fetchedAt`, a Follow flood dirties it every item and re-PUTs it whole per commit batch. |
| high | `lib/intake.mjs:1012` | `addReply` — unbounded whole-document read-modify-write at an attacker-chosen URL. |
| medium | `lib/publisher.mjs:546` | `reconcileOutbox` walks **every** published page on each real profile save: `1 + ceil(N/20)` GETs where `b0b83a3` left 1. The `ab0734a` digest gate does suppress no-op saves, so this is per real edit, rename or key rotation — not per start. |
| medium | `lib/intake.mjs:610` | `publishCollections({followers:true})` fires per drained Follow/Undo/Accept/Reject: 1 full GET + 1 PUT of the followers collection each, ~98 avoidable requests in a 50-event sweep. The Follow burst needs group mode or `autoAcceptFollows`. |
| medium ⚑ | `lib/deliver.mjs:224` | `_drainQueueOnce` returns early only when the queue is *empty*, then calls `setQueue(keep)` unconditionally, and `PodStore.write` has no equality check — **1440 byte-identical writes/day** while any item waits. The ordinary ladder reaches hours-long `nextAt` by attempt 6, so any peer that fails a few times triggers it, not just one sending `Retry-After`. |
| medium ⚑ | `lib/intake.mjs:859` | The 300 ms debounce cannot coalesce a drain: every handler awaits a remote fetch that takes longer, so `statuses.json` is rewritten whole once per item where the existing `DELETE_BATCH=10` boundaries would do 5. |
| medium | `lib/mastoapi.mjs:118` | `account()` deep-clones the whole `actors.json` per rendered item on the routes a client polls forever. One clone per remote account, not three — the counts are behind a `self ?` ternary. |
| medium | `lib/mastoapi.mjs:175` | `page()`'s cursor scan calls `idFor` per item, and `idFor` clones the whole uncapped `ids.json` on every call: ~25M object copies to serve one page of 20 on a 5000-status timeline, synchronous, on the event loop. |
| low | `lib/publisher.mjs:120` | `publishProfile` records its digest even when `verifyPublicSurface` came back unreachable, so the *next* save is skipped as a no-op — the digest gate swallowing the repair it was warned about. |
| low | `lib/publisher.mjs:516` | Pages orphaned when the outbox shrinks are never deleted, so a stale page keeps publicly listing a removed activity. |
| low ⚑ | `lib/storage.mjs:73`, `:80` | No `If-Match` on state writes (the lease is the only guard); `Retry-After` parsed by hand, uncapped, and slept inside the serialized write chain. |
| low | `run-agent.mjs:382` | `park`/`revive` publish the whole following collection once per account — 300 sequential PUTs for an actor following 300. |
| low | `lib/store.mjs:344` | `cacheActor` rewrites all 2000 entries per actor; the tag feed calls it up to 12× a sweep. |
| low | `lib/intake.mjs:327` | Inbox prune commits per item instead of batching like the drain. |
| low | `lib/account.mjs:66` | `createAccountWithPod` GETs the pod list twice back to back, three times on failure — against exactly the struggling public IdP this project has a retry-storm postmortem about. |
| low | `lib/publisher.mjs:528` | `publishOutbox` PUTs the head even when no page changed. |

## Migration: the private half off the pod, on every identity, and staying current

`bbba587` fixed the CLI's *default* for new installs. It did nothing for installs that already
exist, and `privateRoot` absent still means "on the pod" (`run-agent.mjs:58`). So every
identity set up before 2026-08-03 keeps its timeline, contacts, blocklist, notifications and
`masto-tokens.json` on the pod, and pays a pod PUT for every state write — which is what makes
the ⚑ rows above real rather than theoretical. **This migration is therefore the single
largest pod-load fix available**, and it is a data-layout correction rather than a code fix.

The goal is stronger than one migration: **every local actor should be operating at the
current shape of s-ap, and should stay there as the shape changes.** `bbba587` is the archetype
of what goes wrong — two setup paths diverged, existing installs silently kept the old layout,
and nothing anywhere said so.

### What already exists, and what is missing

`activitypod state --to <path>` (`bin/activitypod.mjs:685`) already does the per-identity move
in the right order: copy the state documents, copy `settings`/`contacts` and every note under
`posts/` and `timeline/`, verify with `commit()`, and only then repoint `credential.json`. It
refuses to run while an agent answers on the port. `home --restructure`
(`bin/activitypod.mjs:873`) is the precedent for the root-wide half: it enumerates identities
with `identityHomes(AP_ROOT)`, refuses while **any** of them answers, moves, and repoints a
`privateRoot` that its own move invalidated.

Missing:
- **No sweep.** `state --to` is one identity at a time, with the right `AP_HOME` set by hand.
- **No cleanup.** "The old copy was left where it was" — so the private data stays on the pod
  indefinitely, which is the opposite of what moving it was for.
- **No record of layout.** Nothing marks an identity as migrated, so there is no way to ask
  which ones are behind, and nothing to hang the next migration off.
- **The insecure-URL check runs after the copy** (the confirmed high finding, step B10). Fix
  that first, since the sweep reuses this code path.

### Constraints this migration must respect

- **Stop every agent for the identity first.** A running agent loads pod state once at connect
  and holds it write-through, so a copy taken underneath it is clobbered by the next write.
  `home --restructure`'s "still answering: …" refusal is the right shape — refuse the whole
  sweep, not just the current identity.
- **`lease.json` does not move.** `run-agent.mjs:247` builds the lease from `this.urls.state` —
  the remote pod's `ap-state/` — never from `privateRoot`, deliberately: "a lease that only one
  machine can reach is not a lease." The pod's `ap-state/` container therefore stays in use
  after migration, along with the `.keep` and owner-only `.acl` that `run-agent.mjs:121-125`
  writes there.
- **Cleanup needs a deny-list, not a container delete.** Remove only the state documents this
  migration copied. Never the `ap-state/` container itself, never `lease.json`, `.keep` or
  `.acl` — and never anything covered by the standing rule in
  `claude/plans/never-delete-pod-infrastructure.md`. The pod's `fediverse/` tree *is* fully
  orphaned once `privateRoot` is set, so it can go, under the same deny-list.
- **Verify before deleting anything**, and make deletion a separate opt-in step, not part of
  the move. The move is reversible while both copies exist; that is the property to keep.

### The work

**F1 — `activitypod state --all` (or `upgrade --state`).** A root-wide sweep: enumerate with
`identityHomes(AP_ROOT)`, refuse if any identity answers on its port, then run the existing
`state --to` body per identity with the destination defaulting to that identity's own
`$AP_HOME/private/`. Default to a **dry run** that reports, per identity, where its private
half currently is and what would move — so the first thing anyone sees is the inventory, not
a mutation. `--apply` performs it.

**F2 — `activitypod state --drop-remote`.** Separate, explicit, run after F1 and after the
operator is satisfied. Deletes the migrated state documents and the orphaned `fediverse/` tree
from the pod, through a deny-list that protects the container, `lease.json`, `.keep`, `.acl`
and everything the standing rule names. Refuses if `privateRoot` is absent or still points at
the pod.

**F3 — record the layout.** A `layout: <n>` (or `installVersion`) in `credential.json`, written
by both setup paths and by every migration step. Without it there is no way to answer "which
identities are behind", and F4 has nothing to branch on.

**F4 — one upgrade runner, and a report at start.** `activitypod upgrade` sweeps every identity
under the root, reports the layout each is on against the current one, and applies the pending
numbered steps in order — F1 being step 1. Then have the agent **say at startup** when its
identity is behind, rather than running old-shaped in silence. The standing rule that follows
from `bbba587`: **a change to install shape ships as a numbered migration step, not as a new
default in `setup`.** A new default only ever fixes the installs that do not exist yet.

**F5 — smoke coverage.** A fixture identity with `privateRoot` absent and seeded pod state:
assert the sweep moves it, that `lease.json` survives, that the deny-list refuses the
container, and that a second run is a no-op. Assert the two setup paths agree on `layout`, the
way `bbba587` made them agree on `privateRoot`.

### Sequencing note

F belongs **after B10** (which fixes the copy-before-validate ordering in the code F1 reuses)
and **before D**, because most of the ⚑ steady-state waste in D stops being pod traffic at all
once the sweep has run — D is then about local disk and CPU, which changes how much it is
worth.

Which identities are actually affected is a question for the dry run on the machine; the
inventory is F1's first output.

## Proposed sequence

Ordered by what a stranger can do to you, then by what the last round's own fixes broke. One
commit per step, smoke checks with each, pause for review between.

**A. Exposure — first, because it is the park's stated revisit condition.**
1. Decide locality from the connection, not the header: `req.socket.remoteAddress` in
   `Authorities.isLocal`, keeping the Host test as a weaker second check. Because a same-host
   proxy also connects from loopback, make `run-agent.mjs:236`'s existing computation
   **refuse to start** rather than warn, unless a `uiPassword` or `AP_GATE_TOKEN` exists.
2. Require that credential on the read routes and the non-`LOCAL_ONLY` writes whenever
   `AP_ALLOWED_HOSTS` is set.
3. Emit the bare authority in `loopbackAuthorities` only for port 80/443, and make `readBody`
   refuse a body that is not `application/json`.

**B. Inbound trust.**
4. `ingestNote`: require `sameOrigin(note.id, author)` before an `attributedTo` is believed —
   the same test already used on the envelope.
5. `fetchAP`: `doc.id === url` before `cacheActor`, keyed on the URL actually dereferenced.
6. `handle()`: reject an `activity.actor` whose protocol is not http/https (closing the
   `javascript:` route at source), and require the named note to exist before a Like/Announce
   notification is recorded.
7. `addReply`: require the parent to be one of our statuses, and cap the collection the way
   statuses, notifications, dead letters and removed followers already are.
8. `reconcileFollowers` writes an unmatchable sentinel rather than a bare missing `followId`,
   so the Undo carve-out cannot reach recovered records.
9. Allow-list the stored Content-Type on media upload. Drop at the head when the group review
   queue is full.
10. Move `insecureUrlReason` in `state --to` up beside the `already there` guard
    (`bin/activitypod.mjs:724`), before any store is constructed.

**C. The paging regression.**
11. Stop re-slicing on removal: keep per-page item lists in `published.json` (it already holds
    per-page digests) and rewrite only the page that held the entry. A short sealed page is
    legal AS2 — the newest page is already partial.
12. Coalesce the `onDelete` loop — collect ids, call `unrecordOutbox` once. Needs a
    `{ publish: false }` flag on `forget`/`retract` so the single-status path is unchanged.
13. Thread `force` through `publishCollections` → `publishOutbox`, and only record the digest
    when `verifyPublicSurface` came back clean.
14. Walk `readPublishedOutbox` newest-first and stop once a page adds nothing.

**F. The state migration** (detailed in the section above, and it runs here — after B10, whose
ordering bug is in the code it reuses, and before D). F1 root-wide dry-run sweep then `--apply`;
F2 opt-in removal of the pod copy behind a deny-list; F3 a recorded layout version; F4 one
`upgrade` runner over every identity plus a startup report when one is behind; F5 smoke
coverage. This is the largest pod-load fix available for identities that already exist.

**D. Steady-state waste.** A `changed` flag in `_drainQueueOnce` (a length compare is not
enough — `getQueue()` returns a clone, so in-place mutations keep the length equal); a
`store.hold()`/`release()` pair around a drain sweep; per-sweep rather than per-item
`publishCollections`; hoist the ids map out of `page()`; length caps on remote text at the
store boundary.

**E. Deliberately not here.** Inbound signature verification stays on its own plan
(`inbound-verification.md`) — but that plan predates fedify 2 and its API assumptions are
unre-checked. Nothing above depends on it: every fix is a check we can make without a
signature.

## Verification

`npm test` after each step, plus new checks per fix. Three need more than a unit check:

- **A1/A2** — an agent with `AP_ALLOWED_HOSTS` set and no password, then
  `curl -H 'Host: localhost:<port>' -X POST …/shutdown` from another interface. It must be
  refused now, and must have succeeded before.
- **C11/C13** — seed an outbox past three pages, delete an entry from page 1, assert exactly
  one page plus the head was PUT; then `publishProfile({force:true})` with `published.json`
  intact and assert every page was rewritten.
- **B4/B5** — fixtures serving a note whose `attributedTo` is another origin, and an actor
  document whose `id` differs from its URL. Neither may reach the store.
- **F1/F2** — a fixture identity with `privateRoot` absent and seeded pod state: the sweep
  moves it, `lease.json` survives, the deny-list refuses the container, a second run is a
  no-op. Then, on the real machine, `state --all` dry run first and read the inventory before
  `--apply`; `--drop-remote` only after the moved copy has been confirmed good.

Nothing in this audit was tested against a live pod or a live federation partner.
