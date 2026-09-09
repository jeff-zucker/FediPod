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

import crypto from 'node:crypto';
import { handleDelivery } from './gateway-core.mjs';
import { readCapped, safeFetch, isLoopbackHost } from './safefetch.mjs';
import { linkTargets, REL } from './links.mjs';

// The one WebFinger document, spelled out here rather than imported from
// wire.mjs: wire drags the agent's whole HTML pipeline (sanitize-html and
// friends), which a serverless front must never carry — it crashed the
// deployed function before it answered its first request.
const jrd = ({ handle, host, actor }) => ({
  subject: `acct:${handle}@${host}`,
  links: [{ rel: 'self', type: 'application/activity+json', href: actor }],
});

const AP_CT = 'application/activity+json';

// Verify a Solid-OIDC token (DPoP-bound) and return its WebID, or null. The
// verifier is injected so tests stub it; in production it is the same library
// the agent's own C2S auth uses.
async function verifyPodToken(request, pathname, verifier) {
  const authz = request.headers.get('authorization');
  if (!authz) return null;
  try {
    const v = verifier || (await import('@solid/access-token-verifier')).createSolidTokenVerifier();
    const dpop = request.headers.get('dpop');
    const url = request.url;
    const { webid } = await v(authz, dpop ? { header: dpop, method: request.method, url } : undefined);
    return webid || null;
  } catch { return null; }
}

// Is this WebID served by the claimed pod? A pod owner's WebID lives on the pod
// origin — that is the whole proof: a token for a WebID under podHome could
// only be minted by someone who controls that pod's identity provider.
// A pod that will not answer must not hold up the person opting in; without
// an answer the older check stands on its own.
const OWNER_LOOKUP_MS = 5_000;

/**
 * Who the pod server says owns the pod. The server that hosts it is the
 * authority on that, so when it answers, its answer decides. A server that
 * says nothing leaves where the WebID lives as the only evidence there is.
 */
async function podOwners(podBase, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(podBase, {
      method: 'HEAD', signal: AbortSignal.timeout(OWNER_LOOKUP_MS),
    });
    return linkTargets(res?.headers?.get?.('link'), REL.owner, podBase);
  } catch { return []; }
}

function webidUnderPod(webid, podHome) {
  try { return new URL(webid).origin === new URL(podHome).origin; } catch { return false; }
}

const RELAY_MAX_REQUESTS = 20;
const RELAY_MAX_BODY = 1024 * 1024;
const RELAY_TIMEOUT_MS = 8_000;
// The only headers a relayed request may carry to the remote server. Host
// comes from the URL; the user agent from safeFetch.
const RELAY_HEADERS = new Set(['date', 'digest', 'signature', 'content-type', 'accept']);

const keyIdOf = (signature) => (/keyId="([^"]+)"/.exec(signature || '') || [])[1] || null;

async function relayOne(item, rec, fetchImpl) {
  const url = String(item?.url || '');
  const method = String(item?.method || 'POST').toUpperCase();
  if (method !== 'GET' && method !== 'POST') return { url, status: 0, error: 'method must be GET or POST' };
  let u;
  try { u = new URL(url); } catch { return { url, status: 0, error: 'not a URL' }; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && process.env.AP_ALLOW_PRIVATE_TARGETS === '1')) {
    return { url, status: 0, error: 'https only' };
  }
  const headers = {};
  for (const [k, v] of Object.entries(item?.headers || {})) {
    const name = k.toLowerCase();
    if (RELAY_HEADERS.has(name) && typeof v === 'string') headers[name] = v;
  }
  const body = method === 'POST' ? String(item?.body ?? '') : undefined;
  if (body !== undefined && Buffer.byteLength(body) > RELAY_MAX_BODY) return { url, status: 0, error: 'body too large' };
  const keyId = keyIdOf(headers.signature);
  if (method === 'POST' && !keyId) return { url, status: 0, error: 'a delivery must be signed' };
  if (keyId && !keyId.startsWith(rec.actorUrl + '#')) return { url, status: 0, error: "signed with a key that is not this account's" };
  if (headers.digest) {
    const want = 'SHA-256=' + crypto.createHash('sha256').update(body || '').digest('base64');
    if (headers.digest !== want) return { url, status: 0, error: 'digest does not match the body' };
  }
  try {
    const res = await safeFetch(url, { method, headers, body, signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) }, fetchImpl);
    const out = { url, status: res.status };
    if (method === 'GET') {
      out.contentType = res.headers.get('content-type') || null;
      out.body = await readCapped(res, RELAY_MAX_BODY);
    }
    return out;
  } catch (e) { return { url, status: 0, error: e.message }; }
}

const j = (status, obj, ct = 'application/json') =>
  ({ status, headers: { 'content-type': ct, 'cache-control': 'no-store' }, body: JSON.stringify(obj) });
const notFound = () => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found\n' });

// A user's public base on the front, a 1:1 mirror of their pod home.
// The directory key is the FULL fediverse address — handle@host — never the
// bare handle, which is not unique: two different pods can each have a "me".
// A fronted identity answers at this front's host; a mail-door identity at its
// own pod's host. The `/u/` path segment carries that same key.
export const addressKey = (handle, host) => `${handle}@${host}`;
export const userBase = (frontOrigin, key) => `${frontOrigin}/u/${encodeURIComponent(key)}/`;

// Rewrite every occurrence of the pod home to the front base (or back). The
// bodies are JSON, so a whole-string swap rewrites ids wherever they appear —
// actor id, collection ids, note ids — keeping the whole space self-consistent.
const swap = (text, from, to) => text.split(from).join(to);

// Which handle a /u/<handle>/... path names, and the pod path under it.
function parseUserPath(pathname) {
  const m = /^\/u\/([^/]+)\/(.*)$/.exec(pathname);
  return m ? { handle: decodeURIComponent(m[1]), rest: m[2] } : null;
}

// Top-level paths a handle may not take, so a name never shadows a route.
const RESERVED = new Set(['u', 'api', 'signup', 'new-account', 'run', 'admin', 'roster', 'gateway',
  'gw', 'well-known', 'inbox', 'outbox', 'actor', 'install']);

// Why a handle is unusable, or null when it is fine. Lowercase letters, digits
// and hyphens; 2–30 chars; not edge-hyphenated; not a reserved route.
function handleProblem(h) {
  if (!h) return 'empty';
  if (!/^[a-z0-9-]{2,30}$/.test(h)) return 'letters, digits and hyphens only, 2–30 characters';
  if (h.startsWith('-') || h.endsWith('-')) return 'cannot start or end with a hyphen';
  if (RESERVED.has(h)) return 'that name is reserved';
  return null;
}

// The person's own filtering policy, published on their pod and readable by
// anyone: their accepted following list and a mirror of their blocklist. A
// directory row carries neither — the row is written at attach time, before
// the agent has published anything — so without this the door would judge by
// addressing alone and forward the junk a blocklist exists to stop.
//
// Cached briefly: a delivery flood must not become a read per delivery on the
// person's pod, which is the load this whole door exists to spare them.
const POLICY_TTL_MS = 5 * 60_000;
const policyCache = new Map();              // podHome -> { at, policy }

async function policyFor(rec, fetchImpl = fetch) {
  const key = rec.podHome;
  const hit = policyCache.get(key);
  if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.policy;
  let policy = null;
  try {
    const res = await fetchImpl(rec.podHome + 'ap/gateway-policy.json',
      { headers: { accept: 'application/json' } });
    if (res && res.status < 400) policy = JSON.parse(await readCapped(res, 256 * 1024));
  } catch { /* unpublished or unreachable: the row's own fields stand */ }
  policyCache.set(key, { at: Date.now(), policy });
  return policy;
}

// The verified-delivery identity for a directory record: what gateway-core
// needs to check what concerns the user and to append to their pod inbox.
// `policy` is the person's published filtering policy when there is one.
function identFor(rec, policy = null) {
  return {
    inboxUrl: rec.podHome + 'ap/inbox/',
    actorUrl: rec.actorUrl,                 // the FRONT actor id (what mail is addressed to)
    followersUrl: rec.actorUrl.replace(/actor$/, 'followers'),
    notesPrefix: rec.actorUrl.replace(/ap\/actor$/, 'ap/notes/'),
    following: policy?.following || rec.following || [],
    blocklist: policy?.blocklist || rec.blocklist || { domains: [], actors: [] },
    kind: policy?.kind || rec.kind || 'person',
    gatewayWebId: rec.gatewayWebId,
    hmacSecret: rec.hmacSecret,
  };
}

// The single entry point. `ctx`:
//   host        the front's own host, e.g. "fedipod.net" (for WebFinger subjects)
//   frontOrigin "https://fedipod.net"
//   lookup(handle) -> record | null       the directory
//   listDirectory() -> { handle: record }  every row, for the admin roster
//   removeDirectory(handle) -> boolean     drop a row; false when a seeded row remains
//   podPut(url, body, ct) -> boolean      append to a user's pod (per-user cred inside)
//   podGet(url) -> Response                read a user's pod (public reads; plain fetch is fine)
export async function routeFront(request, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;

  // The new-account page: the host's front door, forking solo / group /
  // manage. Served as a static page the adapter supplies; the page itself
  // calls the availability API below. It only COLLECTS intent — creating an
  // account is the Solid-OIDC attach step (proving the pod is the user's).
  if (pathname === '/' || pathname === '/signup' || pathname === '/new-account') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: {}, body: '' };
    if (!ctx.signupPage) return notFound();
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: ctx.signupPage };
  }

  // The run page: a pod owner opting their identity in or out of being run by
  // this server. Meaningful only on a host that embeds the agent; a host that
  // does not simply supplies no page.
  if (pathname === '/run') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: {}, body: '' };
    if (!ctx.runPage) return notFound();
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: ctx.runPage };
  }

  // The roster page: the host reading who has accounts here. The page signs in
  // and calls the roster API below; a deploy with no admin supplies no page.
  // Off /admin, which is the owner's own record page on every agent.
  if (pathname === '/roster') {
    if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: {}, body: '' };
    if (!ctx.adminPage) return notFound();
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: ctx.adminPage };
  }

  // The roster: every directory row, secrets stripped, for the host's own
  // eyes. The reader proves themself the way attach proves a pod — a
  // Solid-OIDC token — and must be the WebID the deploy names as admin.
  if (pathname === '/api/roster') {
    if (!ctx.listDirectory || !ctx.adminWebId) return j(501, { error: 'this front has no roster to offer' });
    const webid = await verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return j(401, { error: 'a Solid-OIDC token is required' });
    if (webid !== ctx.adminWebId) return j(403, { error: 'that WebID is not the admin of this front' });
    const rows = await ctx.listDirectory();
    const accounts = Object.values(rows)
      .map((r) => ({
        handle: r.handle, kind: r.kind || 'person', fronted: !r.inboxOnly,
        podHome: r.podHome, webId: r.webId || null, actorUrl: r.actorUrl,
        address: r.address || `@${r.handle}@${ctx.host}`,
      }))
      .sort((a, b) => (a.address || a.handle).localeCompare(b.address || b.handle));
    return j(200, { host: ctx.host, accounts });
  }

  // Revoke: the admin removes an account's row, so the server stops answering
  // for the name. Nothing on the user's pod is touched. Attach-created rows go
  // for good; a row seeded in the deploy's environment can only be removed there.
  if (pathname === '/api/revoke' && request.method === 'POST') {
    if (!ctx.removeDirectory || !ctx.adminWebId) return j(501, { error: 'this front cannot revoke accounts' });
    const webid = await verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return j(401, { error: 'a Solid-OIDC token is required' });
    if (webid !== ctx.adminWebId) return j(403, { error: 'that WebID is not the admin of this front' });
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    // Revoke by full address (what the roster lists); a bare handle still works
    // for any legacy row keyed that way.
    const key = String(body.address || body.handle || '').replace(/^@/, '').toLowerCase();
    if (!key || !(await ctx.lookup(key))) return j(404, { error: 'no such account' });
    const removed = (await ctx.removeDirectory(key)) === true;
    return j(200, removed ? { account: key, removed }
      : { account: key, removed: false,
          reason: 'this row is seeded in the deploy environment (FEDIPOD_DIRECTORY_JSON) — remove it there and redeploy' });
  }

  // Live handle check for the page: valid shape AND not already in the
  // directory. Also tells the page whether this host offers pods.
  if (pathname === '/api/handle') {
    const h = (url.searchParams.get('handle') || '').toLowerCase();
    const problem = handleProblem(h);
    if (problem) {
      return j(200, { handle: h, available: false, reason: problem,
        offersPods: !!ctx.offersPods, version: ctx.version || null });
    }
    const taken = !!(await ctx.lookup(h));
    return j(200, { handle: h, available: !taken, reason: taken ? 'that name is taken' : null,
      offersPods: !!ctx.offersPods, version: ctx.version || null });
  }

  // Attach: create the account. The user proves control of the pod they claim
  // by presenting a Solid-OIDC token whose WebID lives on that pod — no
  // password reaches the front. On success the directory gets a row and the
  // agent gets a one-time HMAC secret to stamp the receipts its front writes.
  if (pathname === '/api/attach' && request.method === 'POST') {
    if (!ctx.putDirectory) return j(501, { error: 'this front does not accept signups' });
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    const handle = String(body.handle || '').toLowerCase();
    const podHome = String(body.podHome || '');
    const problem = handleProblem(handle);
    if (problem) return j(400, { error: problem });
    const podLoopback = (() => { try { return isLoopbackHost(new URL(podHome).hostname); } catch { return false; } })();
    if (!(/^https:\/\/\S+\/$/.test(podHome) || (/^http:\/\/\S+\/$/.test(podHome) && podLoopback))) {
      return j(400, { error: 'podHome must be an https URL ending in /' });
    }
    const webid = await verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return j(401, { error: 'a Solid-OIDC token proving the pod is required' });
    if (!webidUnderPod(webid, podHome)) {
      return j(403, { error: 'the token proves a different pod than the one you listed' });
    }
    // The usual attachment keeps the user's identity on their pod and moves
    // only the mail door here (@me@mypod). Fronted identity — actor ids on
    // this domain — remains available to an explicit `fronted: true`.
    const fronted = body.fronted === true;
    // The full address is the key: a fronted name answers at this front's host,
    // a mail-door name at its pod's host. The same handle on two pods is two
    // distinct addresses, so it never collides.
    let addressHost; try { addressHost = fronted ? ctx.host : new URL(podHome).host; } catch { return j(400, { error: 'bad podHome' }); }
    // A fronted name answers at this front's host, where the handle alone is the
    // whole address and is unique — so it keeps keying by bare handle (and its
    // actor id stays /u/<handle>/, unchanged for existing accounts). A mail-door
    // name answers at its own pod, where "me" is not unique, so it keys by the
    // full address handle@podhost, which the /u/ segment then carries.
    const key = fronted ? handle : addressKey(handle, addressHost);
    const address = `@${handle}@${addressHost}`;
    // "Taken" only when this exact address already belongs to a DIFFERENT pod.
    // Re-attaching your own pod — a retry, a re-provision, a second browser — is
    // idempotent: it updates the row in place and keeps the same door secret.
    const prior = await ctx.lookup(key);
    if (prior && prior.podHome !== podHome) return j(409, { error: 'that name is taken' });
    // The pod's actor lives under its AP root container, which the pod owner
    // knows and the front does not — so take the caller's actorUrl when it is on
    // this pod, and fall back only when none is given.
    const claimedActor = typeof body.actorUrl === 'string' && body.actorUrl.startsWith(podHome) ? body.actorUrl : null;
    const actorUrl = fronted ? `${userBase(ctx.frontOrigin, key)}ap/actor` : (claimedActor || podHome + 'ap/actor');
    const hmacSecret = prior?.hmacSecret || crypto.randomBytes(32).toString('base64');
    const record = {
      handle, address, podHome, webId: webid, actorUrl,
      kind: body.kind === 'group' ? 'group' : 'person',
      gatewayWebId: ctx.gatewayWebId || null, hmacSecret,
      ...(fronted ? {} : { inboxOnly: true }),
    };
    await ctx.putDirectory(key, record);
    // The secret is returned ONCE, with the one command the user runs to
    // point their agent at this gateway.
    const doorInbox = `${userBase(ctx.frontOrigin, key)}ap/inbox/`;
    if (fronted) {
      return j(201, { ok: true, handle, address, actorUrl, frontActor: actorUrl, hmacSecret,
        command: `fedipod gateway ${actorUrl} --secret ${hmacSecret}` });
    }
    return j(201, { ok: true, handle, address, doorInbox, hmacSecret,
      command: `fedipod gateway ${doorInbox} --secret ${hmacSecret} --inbox-only` });
  }

  // The relay: the front sends requests a browser has already signed. A page
  // may not set the Date or Host header, and both are inside an HTTP
  // signature, so a browser-run agent signs and hands the request here; the
  // front sends it with exactly the headers that were signed. It can forward
  // a signature and cannot make one. Only the account's own key may sign,
  // only the account's own pod may call, and nothing unsigned-for reaches
  // the remote server.
  if (pathname === '/api/relay' && request.method === 'POST') {
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    const handle = String(body.handle || '').toLowerCase();
    const rec = await ctx.lookup(handle);
    if (!rec) return j(404, { error: 'no such account' });
    const webid = await verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return j(401, { error: 'a Solid-OIDC token proving the pod is required' });
    const owner = rec.webId ? webid === rec.webId : webidUnderPod(webid, rec.podHome);
    if (!owner) return j(403, { error: "the token proves a different pod than this account's" });
    const items = Array.isArray(body.requests) ? body.requests : [];
    if (!items.length) return j(400, { error: 'requests must be a non-empty list' });
    if (items.length > RELAY_MAX_REQUESTS) return j(400, { error: `at most ${RELAY_MAX_REQUESTS} requests per call` });
    const results = await Promise.all(items.map((it) => relayOne(it, rec, ctx.fetchImpl || fetch)));
    return j(200, { results });
  }

  // Runtime opt-in: a pod owner asks the server this front sits on to RUN
  // their identity. Same proof as attach — a Solid-OIDC token — but the
  // ownership check is stricter: the WebID must live UNDER the pod base, not
  // merely on its origin, or on a path-pod server one user could opt in
  // another's pod. Offered only where the deployment wired agentControl in
  // (a pod server running the CSS component); everywhere else it is 501.
  if (pathname === '/api/agent' && request.method === 'POST') {
    if (!ctx.agentControl) return j(501, { error: 'this server does not run identities' });
    let body;
    try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
    const action = String(body.action || '');
    const podBase = String(body.podBase || '');
    if (!/^https?:\/\/\S+\/$/.test(podBase)) {
      return j(400, { error: 'podBase must be a URL ending in /' });
    }
    // An identity needs an origin of its own, so only an origin root may opt
    // in. Anything deeper would also let one path-pod user claim an ancestor
    // of another's pod.
    try {
      if (new URL(podBase).pathname !== '/') {
        return j(403, { error: 'podBase must be a pod origin root, like https://mei.example.org/' });
      }
    } catch { return j(400, { error: 'podBase is not a URL' }); }
    const webid = await verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return j(401, { error: 'a Solid-OIDC token proving the pod is required' });
    // The pod's own server names its owner when it can. Where it does, that is
    // the proof; where it does not, the WebID must at least live under the pod.
    const owners = await podOwners(podBase, ctx.fetchImpl || fetch);
    const proven = owners.length ? owners.includes(webid) : webid.startsWith(podBase);
    if (!proven) {
      return j(403, { error: 'the token proves a different pod than the one you listed' });
    }
    if (action === 'opt-in') {
      const { httpStatus, ...reply } = await ctx.agentControl.optIn({ podBase, webId: webid });
      if (reply.doorSecret) {
      // The secret appears here and nowhere else; the command is the
      // paste-and-run way to open the owner door once.
        reply.command = `curl -H 'x-dk-token: ${reply.doorSecret}' ${podBase.replace(/\/$/, '')}${reply.doorPath}status`;
      }
      return j(httpStatus, reply);
    }
    if (action === 'opt-out') {
      const { httpStatus, ...reply } = await ctx.agentControl.optOut({ podBase });
      return j(httpStatus, reply);
    }
    return j(400, { error: 'action must be opt-in or opt-out' });
  }

  // The vendored Solid-OIDC browser library the /run and /admin pages load —
  // served here because this function owns every path on the domain.
  if (pathname === '/solid-oidc-client.js') {
    if (!ctx.authBundle) return notFound();
    return { status: 200, headers: { 'content-type': 'text/javascript' }, body: ctx.authBundle };
  }

  // The installer:  curl -fsSL https://<host>/install | sh
  if (pathname === '/install') {
    if (!ctx.installScript) return notFound();
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: ctx.installScript };
  }

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
    const policy = await policyFor(rec, ctx.fetchImpl || fetch);
    const { status } = await handleDelivery(request, identFor(rec, policy),
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

export const _internal = { parseUserPath, identFor, swap, handleProblem, policyFor, policyCache };
