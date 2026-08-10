# The inbox gateway (optional, opt-in)

This directory is an **un-deployed artifact**. Nothing in FediPod runs it. A
FediPod install works exactly as before without it — deliveries go straight to
your pod inbox, which buffers them whether your agent is up or not.

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
3. **Point your agent at it**: on the admin page, open **Inbox gateway**,
   paste the gateway's URL and WebID, and click **Save & get secret**. Your
   agent generates the shared HMAC secret and shows it **once** — copy it into
   the gateway's environment as `FEDIPOD_HMAC_SECRET`, along with the other
   env vars named in `functions/inbox.mjs`.
4. **Walk the lifecycle** from the same panel: **shadow** (advertise the
   gateway and measure how much real traffic verifies — nothing changes yet)
   → **trust** (verified follows auto-accept) → **locked** (your inbox accepts
   writes only from the gateway). Every step has a one-click rollback.

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
