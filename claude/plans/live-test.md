# Live test: groups, end to end

Nothing in the group work has crossed a network. The suite is 240 offline checks;
this is the list of things only a real run can tell you.

Two stages. Stage 1 needs no public host and no Mastodon, and catches our own bugs.
Stage 2 is the only thing that can catch an interop bug, and two items in it are
riskier than the rest — they are marked.

---

## Stage 1 — local, two pods, no Mastodon

Start the local CSS (subdomain-capable, on :4000):

```
~/css/pivot-4000.sh
```

Both agents need `AP_ALLOW_PRIVATE_TARGETS=1` or `lib/safefetch.mjs` refuses loopback
targets — that guard is doing its job, this is the documented way past it for local work.

```
AP_ALLOW_PRIVATE_TARGETS=1 AP_PASSWORD=<pw> bin/activitypod.mjs setup \
  --group --profile birds --new-account --issuer http://localhost:4000 \
  --email birds@example.org --handle birds --pod-name birds --name "Birds" --port 8031

AP_ALLOW_PRIVATE_TARGETS=1 AP_PASSWORD=<pw> bin/activitypod.mjs setup \
  --profile mei --new-account --issuer http://localhost:4000 \
  --email mei@example.org --handle mei --pod-name mei --name "Mei" --port 8032

AP_ALLOW_PRIVATE_TARGETS=1 AP_PASSWORD=<pw> bin/activitypod.mjs setup \
  --profile kofi --new-account --issuer http://localhost:4000 \
  --email kofi@example.org --handle kofi --pod-name kofi --name "Kofi" --port 8033
```

`setup` ends by *starting* the agent, so each of those keeps running on its port.

### What stage 1 cannot test, and the way round it

**WebFinger requires https**, and fedify's `lookupWebFinger` honours that — so over
plain-http localhost a handle never resolves. Mentions are how a member addresses a
group, so **the deliver-to-the-group step cannot be exercised locally at all**. The log
line is `mention @… did not resolve — left as text`.

Everything downstream of delivery still can be, by putting the activity into the group's
inbox yourself — which is exactly what a real delivery does, the inbox being public-Append:

```
curl -X POST -H 'content-type: application/ld+json' --data-binary @create.json \
  http://finches.localhost:4000/activitypods-js/ap/inbox/
```

with `create.json` a `Create` naming the member as `actor`, the note URL as `object`, and
the group's actor in `cc`. Then `POST /drain` on the group. Two other things that bit:

- `--new-account` is **not idempotent after a crash** — the pod exists, and the retry
  fails `pod create failed (HTTP 400): … already registered to this account`. Use
  `--pod <url>` on the second attempt, or a fresh `--pod-name`.
- Deleting the profile directory after the actor was published trips the key guard
  (`this actor already publishes a signing key`). That is the guard working; use
  `--rotate-key` or a fresh pod name.

What to prove, in order:

1. **The group publishes as a Group.** `bin/activitypod.mjs status --port 8031` → `kind:
   group`, and `curl -H 'accept: application/activity+json' http://birds.localhost:4000/activitypods-js/ap/actor`
   → `"type": "Group"`.
2. **Joining works.** From mei (`localhost:8032`) and kofi (`localhost:8033`), follow
   `@birds@birds.localhost:4000`. `bin/activitypod.mjs members --port 8031` lists both.
3. **Carry.** From mei's client, post `@birds@birds.localhost:4000 hello`. The group's log
   shows `amplified … → N inbox(es)`.
4. **The property the whole design exists for:** kofi sees mei's post **without following
   mei**. If only this one works, the thing works.
5. **Threading.** kofi replies. mei should see the reply — again without following kofi.
6. **Moderation.** `mute` mei → her next post is not carried. `unmute`. `retract` a
   carried post → it leaves kofi's timeline. `review on` → next post is held, `pending`
   lists it, `approve` releases it. `joins approve` → a fresh follow from a fourth
   identity waits in `requests` until `admit`.
7. **Delete and update.** Delete one of mei's posts from her client → the group retracts
   and kofi drops it. Edit one → kofi's copy changes.

---

## Stage 2 — public, with Mastodon

Needs a subdomain-capable public pod host (teamid.live has worked) and a Mastodon account.
**Never dk's pod** — two agents draining one inbox is a race.

Same `setup` lines without the localhost issuer and without `AP_ALLOW_PRIVATE_TARGETS`.

### The two that are riskiest — do these first

**Does the wrapped Announce render in Mastodon?** The group now emits
`Announce{Create{Note}}` per FEP-1b12 rather than `Announce{note-url}`. Mastodon resolves
an Announce's object by *dereferencing its id*, which is why the `Create` is published as
its own document — see `group-actor.md`, "The wire shape". If the group logs `amplified`
and nothing appears in Mastodon, this is what failed. Check:

```
curl -H 'accept: application/activity+json' <note-url>-create
```

It must return a `Create` whose `id` is exactly the URL you asked for.

**Does a reply thread back?** Reply from Mastodon to a carried post. This rests on
Mastodon copying the group's `Mention` into your reply — reasoned from how Mastodon
composes replies, never observed. The group's log should show the reply ingested and
amplified, and the other member should see it.

Then send one more reply with the `@birds@…` **deleted from the text**. That one *should*
fail to thread: it is the known residue, and seeing the boundary is worth the thirty
seconds.

### Then

- Mastodon renders the group as a **Group**, not a person.
- `describe --summary "…" --icon <url>` → bio and avatar on the profile.
- `joins approve` → Mastodon offers "Request to follow".
- `eject <actor>` → Mastodon shows you no longer follow it.
- Delete a post from Mastodon → the group retracts; members drop it.
- Edit a post in Mastodon → members' copies update. Change your Mastodon display name →
  the cached profile refreshes.
- `curl localhost:8031/api/v1/instance` → 404, while `/status` still answers.

**Mastodon caches actor documents hard.** `manuallyApprovesFollowers`, the icon and the
summary may not show until it refetches. That is Mastodon, not us; `publish-profile` on
our side cannot force their cache.

---

## Where to look when something does not work

- `~/.activitypod/profiles/<name>/agent.log` — the instrument for everything. `unhandled`
  lines are the Mastodon-facade punch list.
- `bin/activitypod.mjs deadletter --port <p>` — rejected inbound items **with the reason**.
  Usually the fastest answer to "why did that not arrive". A reply that reached us and was
  refused shows here; a reply that never reached us shows nothing, and that distinction is
  the whole diagnosis.
- `bin/activitypod.mjs status --port <p>` — `podRequests` is what a pod operator would see
  in their access log.

## Tear-down

Local pods are disposable — stop the agents, drop the CSS data. Public throwaways deserve
better: `retire` them so their followers are told, rather than leaving actors that answer
nothing. `identities.md` has the park/retire/move matrix.
