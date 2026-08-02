# Every identity is a named folder

Built 2026-08-02, replacing a layout where the root was both the container for
every identity and the home of one of them.

## What was wrong with it

The first identity lived at the top of the root — its credential, keys,
`agent.json`, log and `private/` all directly in `~/.solid-activitypub/` — and
every other one in `profiles/<name>/`. Three things followed:

- **It had no name.** `identityHomes()` invented `(default)` for it at display
  time, in parentheses because it was not real. That was the tell: something you
  have to name when you show it has a position, not an identity.
- **One identity's directory contained all the others.** Back it up and you
  backed up everyone; delete it and you deleted everyone. `rootOf()` had to walk
  *up* looking for a directory literally called `profiles` to know where it was.
- **The default could not be changed** without moving a private key, because the
  default *was* a place.

## The layout now

```
~/.solid-activitypub/
  root.json              { "default": "jeff", "at": "…" }
  profiles/
    jeff/   credential.json  keys.json  agent.json  agent.log  private/
    group/  …
```

`(default)` is gone from the codebase — grep returns nothing.

## The default is whatever you last STARTED

Nobody sets it. `recordLastUsed` writes `root.json` when an agent starts for an
identity and when setup makes one, so `--profile group start` today is what a
plain command means tomorrow. The configured answer cannot drift from the
identity you actually work in, because working in it is what sets it.

Deliberately **not** on every read: `--profile other status` should ask a
question, not move the machine's idea of who you are.

One identity needs no pointer. Several with none ever started is a real question
and the CLI asks, because guessing means guessing which fediverse account you
meant. A pointer naming an identity that is not there says so rather than
falling back — silently picking a different account is the worst of the three.

**A `default <name>` command was built and removed.** It is the right shape for
a setting and this is not one: a setting you must maintain is a second source of
truth that drifts from the one that matters.

## What it cost

Setup could no longer know its home in advance — an identity is named after its
handle, and the handle is the first thing setup asks. So `HOME` is a `let`,
decided once the name exists, and the existing-identity refusal moved there.
`--profile` still names it up front and is still refused up front.

That surfaced a real hole: **the handle becomes a directory name and was never
validated before becoming one.** `--handle ../escape` would have climbed out of
`profiles/`. Checked first now, with a test.

An explicit `AP_HOME` / `--home` stays an explicit identity directory and does
not consult the machine's root at all — which is what `rootOf` already
documented, and what kept the test blast radius to three fixtures instead of
fifteen.

## Migrating

`activitypod home --restructure` moves the root identity's OWN files down into
`profiles/<its handle>/`: credential, keys, `agent.json`, log, token, backoff,
`private/`. `profiles/` stays where it is. The pidfile is dropped rather than
carried — it names a process that was told to stop. `privateRoot` is rewritten.
It refuses while any agent answers, and refuses to merge into a non-empty
directory.

Run on this machine 2026-08-02: `jeff` moved from the root down to
`profiles/jeff`, all three identities federating from their own trees
afterwards.
