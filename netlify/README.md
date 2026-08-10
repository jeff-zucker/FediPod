# The inbox gateway (optional, opt-in)

This directory is an **un-deployed artifact**. Nothing in FediPod runs it. A
FediPod install works exactly as before without it — deliveries go straight to
your pod inbox, which buffers them whether your agent is up or not.

Deploy this only if you want **door-side HTTP-Signature verification**: an
always-on endpoint that verifies each delivery's signature where the headers
still exist, drops forgeries and obvious spam before they ever touch your pod,
and forwards the rest — with a signed verification receipt — into your pod inbox
for the normal drain. See `claude/plans/inbox-gateway-sig-verify.md`.

It is **keyless**: it never holds your RSA signing key. Its only secrets are an
Append-only credential for your inbox and an HMAC secret shared with your agent.

## To use one

1. Deploy `functions/inbox.mjs` to Netlify (it imports `lib/gateway-core.mjs`
   and `lib/httpsig.mjs` from this repo).
2. Provision a **dedicated low-privilege pod account** for the gateway and grant
   its WebID Append on your inbox. Do NOT use your owner credential.
3. Set the env vars named in `functions/inbox.mjs` (policy URL, inbox URL,
   append token, HMAC secret, gateway WebID).
4. On your FediPod admin page, open the **Inbox gateway** section, paste the
   gateway's URL and WebID and the HMAC secret, and walk the lifecycle:
   **Advertise** (shadow — measures how much real traffic verifies, changes
   nothing) → **Trust** (verified Follows auto-accept) → **Lock** (inbox
   accepts writes only from the gateway). Every step has a one-click rollback.

The gateway reads only PUBLIC data to decide what concerns you — your published
followers/following and a small public `ap/gateway-policy.json` your agent
writes with your blocklist mirror. Nothing private leaves your pod.
