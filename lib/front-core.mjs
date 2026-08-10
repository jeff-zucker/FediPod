// front-core.mjs — the multi-user front: one always-on box, run by a host, that
// fronts many independent FediPod users under a shared domain (@name@fedipod.net).
// It answers name lookups, serves each user's public face, and is the verifying
// inbox for all of them — routing every verified delivery into that user's own
// pod inbox. It is KEYLESS and holds no user data: only a directory (handle →
// where that user's pod is + their public key) and the per-user secrets needed
// to append verified mail to their inbox.
//
// The identity trick is rewrite-on-read (jg10's pattern): a user's public IRI
// space at `<front>/u/<handle>/` is a 1:1 path map of their pod's own tree, so
// the actor id and every id under it live on the shared domain while the bytes
// still come from the user's pod. The inbox maps the same way, so delivery to
// the fronted inbox is delivery this box verifies, then forwards to the pod.
//
// Runtime-agnostic: `netlify/functions/front.mjs` is one adapter; any always-on
// HTTPS box is another. UN-DEPLOYED — nothing in FediPod runs it.

import { handleDelivery } from './gateway-core.mjs';
import { jrd } from './wire.mjs';
import { readCapped } from './safefetch.mjs';

const AP_CT = 'application/activity+json';

const j = (status, obj, ct = 'application/json') =>
  ({ status, headers: { 'content-type': ct, 'cache-control': 'no-store' }, body: JSON.stringify(obj) });
const notFound = () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found\n' });

// A user's public base on the front, a 1:1 mirror of their pod home.
export const userBase = (frontOrigin, handle) => `${frontOrigin}/u/${handle}/`;

// Rewrite every occurrence of the pod home to the front base (or back). The
// bodies are JSON, so a whole-string swap rewrites ids wherever they appear —
// actor id, collection ids, note ids — keeping the whole space self-consistent.
const swap = (text, from, to) => text.split(from).join(to);

// Which handle a /u/<handle>/... path names, and the pod path under it.
function parseUserPath(pathname) {
  const m = /^\/u\/([^/]+)\/(.*)$/.exec(pathname);
  return m ? { handle: decodeURIComponent(m[1]), rest: m[2] } : null;
}

// The verified-delivery identity for a directory record: what gateway-core
// needs to check what concerns the user and to append to their pod inbox.
function identFor(rec) {
  return {
    inboxUrl: rec.podHome + 'ap/inbox/',
    actorUrl: rec.actorUrl,                 // the FRONT actor id (what mail is addressed to)
    followersUrl: rec.actorUrl.replace(/actor$/, 'followers'),
    notesPrefix: rec.actorUrl.replace(/ap\/actor$/, 'ap/notes/'),
    following: rec.following || [],
    blocklist: rec.blocklist || { domains: [], actors: [] },
    kind: rec.kind || 'person',
    gatewayWebId: rec.gatewayWebId,
    hmacSecret: rec.hmacSecret,
  };
}

// The single entry point. `ctx`:
//   host        the front's own host, e.g. "fedipod.net" (for WebFinger subjects)
//   frontOrigin "https://fedipod.net"
//   lookup(handle) -> record | null       the directory
//   podPut(url, body, ct) -> boolean      append to a user's pod (per-user cred inside)
//   podGet(url) -> Response                read a user's pod (public reads; plain fetch is fine)
export async function routeFront(request, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  // WebFinger: acct:<handle>@<host> → the fronted actor. This is what makes
  // @name@fedipod.net a real handle the fediverse can look up.
  if (pathname === '/.well-known/webfinger') {
    const resource = url.searchParams.get('resource') || '';
    const m = /^acct:([^@]+)@(.+)$/.exec(resource);
    if (!m || m[2] !== ctx.host) return notFound();
    const rec = await ctx.lookup(m[1]);
    if (!rec) return notFound();
    return j(200, jrd({ handle: m[1], host: ctx.host, actor: rec.actorUrl }),
      'application/jrd+json');
  }

  const up = parseUserPath(pathname);
  if (!up) return notFound();
  const rec = await ctx.lookup(up.handle);
  if (!rec) return notFound();
  const base = userBase(ctx.frontOrigin, up.handle);

  // Inbox: verify at the door, forward to the user's pod inbox. This is the
  // gateway, per user.
  if (up.rest === 'ap/inbox/' || up.rest === 'ap/inbox') {
    if (request.method !== 'POST') return { status: 405, headers: {}, body: '' };
    const { status } = await handleDelivery(request, identFor(rec),
      { podPut: (u, b, ct) => ctx.podPut(up.handle, u, b, ct), fetchImpl: ctx.fetchImpl });
    return { status, headers: {}, body: '' };
  }

  // Everything else is a public GET, served by reading the user's pod and
  // rewriting pod ids to the front. The actor also gets its handle and inbox
  // fixed to the front so a consumer cross-checks it consistently.
  if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: {}, body: '' };
  const podTarget = rec.podHome + up.rest;
  const res = await (ctx.podGet ? ctx.podGet(podTarget) : fetch(podTarget, { headers: { accept: AP_CT } }));
  if (!res || res.status >= 400) return { status: res?.status || 502, headers: {}, body: '' };
  let text = await readCapped(res, 1024 * 1024);
  text = swap(text, rec.podHome, base);
  if (up.rest === 'ap/actor') {
    try {
      const doc = JSON.parse(text);
      doc.preferredUsername = up.handle;               // so @handle@front cross-checks
      doc.inbox = base + 'ap/inbox/';                  // deliveries come to the front to be verified
      doc.endpoints = { ...(doc.endpoints || {}), sharedInbox: base + 'ap/inbox/' };
      text = JSON.stringify(doc);
    } catch { /* leave the rewritten text as-is if it will not parse */ }
  }
  return { status: 200, headers: { 'content-type': AP_CT, 'cache-control': 'no-store' }, body: text };
}

export const _internal = { parseUserPath, identFor, swap };
