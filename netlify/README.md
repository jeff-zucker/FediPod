# The inbox gateway & multi-user front (optional, opt-in)

<!-- CLAUDE 2026-08-17 — status + model changed when fedipod.net went live; rework/trim, delete markers when done -->
A reference deployment runs at **https://fedipod.net/** — the multi-user
gateway, with signup. The usual attachment keeps a user's identity on their
own pod (`@me@my.pod`) and moves only the advertised inbox to the gateway's
door: sign up on the page, sign in with your pod to prove it, and run the one
`fedipod gateway … --inbox-only` command it hands you. Attach rows persist in
a Netlify Blobs store. The fronted-identity mode described below sits behind
an explicit flag.
<!-- /CLAUDE -->

A FediPod install works exactly as before without any gateway — deliveries go
straight to your pod inbox, which buffers them whether your agent is up or not.

Two things live here, sharing the same verify-at-the-door core
(`lib/gateway-core.mjs`):

- **`functions/inbox.mjs`** — a single-user gateway for identities one operator
  already controls (below).
- **`functions/front.mjs`** — a **multi-user front** (`lib/front-core.mjs`): one
  box a HOST runs to offer `@name@fedipod.net` accounts to many independent
  FediPod users, each keeping their own pod, agent and signing key. It answers
  WebFinger for every user, serves each user's public face by rewriting their
  pod's ids onto the shared domain (so `@me@fedipod.net` is a real handle whose
  data still lives on the user's own pod), and is the verifying inbox for all of
  them — routing each verified delivery into the right user's pod inbox. It holds
  no user key and no user data, only a directory (handle → that user's pod +
  public key) and the per-user Append credentials. Signup: a user proves control
  of their pod via Solid-OIDC, picks a free handle, and the host records
  `handle → their pod`. See `functions/front.mjs` for the directory record shape
  and env, and `claude/plans/parked-multi-user-front.md` for the full design.
  The agent-side "publish and sign under the fronted actor id" (so a user's own
  posts carry `@name@fedipod.net`) and the signup/attach flow are built too —
  see `functions/front.mjs`, `web/front/new-account.html`, and `fedipod front`.

  **A front never hosts pods.** It is only a doorway (directory + WebFinger +
  verify-and-forward). A host who wants to offer pods to users with none runs
  their own Community Solid Server separately — that pod hosting is its own
  server with its own data-custodian duties, not part of the front, and users
  may always bring their own pod instead. The gateway can be deployed
  standalone (this Netlify function, or any always-on box) OR — planned — as a
  **CSS component**, so a host already running a CSS for pods can add the
  gateway there instead of running a second box.

A gateway is an **always-on, internet-facing box** that becomes your advertised
inbox. It verifies each delivery's HTTP signature at the door (where the
headers still exist — your pod discards them), drops forgeries and obvious spam
before they ever touch your pod, and forwards the rest — with a signed
verification receipt — into your pod inbox for the normal drain.

**Any always-on box will do**: a VPS, a home server behind a tunnel, a
serverless host. The logic lives in `lib/gateway-core.mjs`, which is plain
runtime-agnostic Node; `functions/inbox.mjs` here is a ~40-line Netlify adapter
around it, included as the worked example. Another host needs only its own
thin adapter calling the same `handleDelivery`.

It is **keyless**: it never holds your RSA signing key. Its only secrets are an
Append-only credential for your inbox and the HMAC receipt secret (below). A
compromised gateway can inject inbox items — which still face the drain's own
verification — but cannot impersonate you, read your private data, or post.

## To set one up

1. **Deploy the function** to your box. On Netlify: this repo, with
   `netlify.toml` as-is. Elsewhere: any HTTPS endpoint that calls
   `handleDelivery` from `lib/gateway-core.mjs`.
2. **Provision a dedicated low-privilege pod account** for the gateway and
   grant its WebID Append on your inbox. Do NOT use your owner credential.
<!-- CLAUDE 2026-08-17 — the credential is optional and the panel is gone; delete markers when done -->
   (Optional for FediPod's default posture: the pod inbox is public-Append,
   and the gateway falls back to a plain PUT when no credential is on
   record.)
3. **Point your agent at it** with `POST /gateway {action:'configure', url,
   webId}` on the agent's API — it mints the shared HMAC secret and returns
   it **once**; copy it into the gateway's environment (or directory row).
   Users attaching through a multi-user gateway's signup page skip this:
   the page hands them the finished `fedipod gateway` command instead.
4. **Walk the lifecycle** with `POST /gateway {action:'mode', mode:…}`:
   **shadow** (advertise the gateway and measure how much real traffic
   verifies — nothing else changes) → **trust** (verified follows
   auto-accept) → **locked** (your inbox accepts writes only from the
   gateway). Every step is reversible; `fedipod gateway --detach` restores
   the pod's own inbox.
<!-- /CLAUDE -->

## What the HMAC secret is

A shared password between your agent and your gateway, used to stamp each
verification receipt. Your agent believes a receipt only when its stamp checks
out — so nobody else can drop a fake "verified" receipt beside a forged
delivery. You never obtain it from anywhere: the admin panel mints it when you
click **Save & get secret**, and you carry it to the gateway yourself.

The gateway reads only PUBLIC data to decide what concerns you — your published
followers/following and a small public `ap/gateway-policy.json` your agent
writes with your blocklist mirror. Nothing private leaves your pod. (That
mirror does make your blocklist public — a known part of running a gateway.)
