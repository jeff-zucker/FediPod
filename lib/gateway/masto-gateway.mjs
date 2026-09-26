// masto-gateway.mjs — Mastodon apps at the gateway's own address: elk.zone,
// Ivory, Tusky or any other app, signed in to an account the gateway keeps
// running, reading and writing it from its copy (copy.mjs).
//
//   POST /api/v1/apps                   an app registers here, for every account
//   GET  /oauth/authorize               sends the person to the sign-in page
//                                       (/app-signin/, web/app-signin/), which
//                                       signs them in at their own pod
//   GET  /api/authorize?client_id=…     what the page shows: the app's name
//   GET  /api/authorize?address=…       the pod an address here belongs to
//   POST /api/authorize                 the pod sign-in, proved: a code for the app
//   POST /oauth/token, /oauth/revoke    the code for a token, and back
//   GET  /api/v1/instance, /api/v2/instance   fedipod.net itself
//   anything else under /api/v1, /api/v2 with a token: the account's own
//   Mastodon facade (lib/client/masto), over its copy
//
// Apps, codes and tokens are kept in `ctx.mastoKv` (the same kind of store as
// the copy); a token is kept only as its hash. Reading is answered from the
// copy without the lease. Acting takes the lease — an app acting outranks a
// browser sitting open, as one device does another — and reads the signing
// key from the pod for that one request. Mail that arrived while nobody was
// reading is read into the copy after an app's timeline or notification check
// has been answered, at most every thirty seconds.
import crypto from 'node:crypto';
import { MastoApi } from '../client/masto/index.mjs';
import { instanceConfig } from '../client/masto/instance.mjs';
import { TRANSPARENT_PNG } from '../client/masto/render.mjs';
import { bridge } from '../client/masto/bridge.mjs';
import { PodStore } from '../core/store.mjs';
import { apUrls } from '../core/wire.mjs';
import { Publisher } from '../core/publisher/index.mjs';
import { nextDue } from '../core/scheduled.mjs';
import { reachAccount, stateAndLease, actingAgent } from './account-agent.mjs';
import { ensureCopy } from './state-api.mjs';
import { CopyStorage, lockCopy, GATEWAY_HOLDER } from './copy.mjs';
import { heldEntries } from './held-mail.mjs';

const TOKEN_TTL_MS = 90 * 86400_000;
const CODE_TTL_MS = 10 * 60_000;
const MAIL_EVERY_MS = 30_000;
const SIGNIN_PAGE = '/app-signin/';
const API_VERSIONS = { mastodon: 7 };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
const rand = (n) => crypto.randomBytes(n).toString('base64url');
const json = (status, obj, headers = {}) => ({
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(obj),
});
// Mastodon apps call from their own pages: anyone may ask, the token is the credential.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
  'access-control-expose-headers': 'Link',
  'access-control-max-age': '86400',
};

async function getJson(kv, key) {
  const got = await kv.get(key);
  if (!got) return null;
  try { return JSON.parse(got.text); } catch { return null; }
}
const putJson = (kv, key, obj) => kv.set(key, JSON.stringify(obj));

// A body as a Mastodon app sends it: JSON, a form, or multipart fields.
async function formOf(request) {
  const ct = String(request.headers.get('content-type') || '');
  if (ct.includes('application/json')) return request.json().catch(() => ({}));
  if (ct.includes('multipart/form-data')) {
    const f = await request.formData().catch(() => null);
    return f ? Object.fromEntries([...f].filter(([, v]) => typeof v === 'string')) : {};
  }
  return Object.fromEntries(new URLSearchParams(await request.text()));
}

const parseRedirects = (v) => (Array.isArray(v) ? v : String(v || '').split(/\s+/)).map((s) => s.trim()).filter(Boolean);

// The directory key an address at this gateway names: "you", "@you",
// "you@host" or "@you@host".
function handleOf(address, host) {
  const a = String(address || '').trim().replace(/^@/u, '').toLowerCase();
  if (!a) return null;
  const [name, at] = a.split('@');
  return !at || at === String(host || '').toLowerCase() ? name : a;
}

// An account an app may sign in to: a browser account here, kept running, not
// moved or closed.
const usable = (rec) => !!(rec && rec.openedAt && rec.keeper && !rec.movedTo && !rec.closedAt);

function instanceV1(host) {
  return {
    uri: host, title: host, short_description: 'FediPod: Fediverse accounts whose home is a Solid pod.',
    description: 'FediPod: Fediverse accounts whose home is a Solid pod.', email: '',
    version: '4.2.0 (compatible; fedipod)', api_versions: API_VERSIONS, urls: {},
    stats: { user_count: 0, status_count: 0, domain_count: 0 },
    languages: ['en'], registrations: false, approval_required: false, invites_enabled: false,
    configuration: instanceConfig(), contact_account: null, rules: [],
  };
}
function instanceV2(host, origin) {
  return {
    domain: host, title: host, version: '4.2.0 (compatible; fedipod)', api_versions: API_VERSIONS,
    source_url: 'https://github.com/jeff-zucker/FediPod',
    description: 'FediPod: Fediverse accounts whose home is a Solid pod.',
    usage: { users: { active_month: 0 } }, thumbnail: { url: TRANSPARENT_PNG }, languages: ['en'],
    urls: {}, configuration: instanceConfig(),
    // Accounts are made on the front page, with a pod, not through an app.
    registrations: { enabled: false, approval_required: false, message: null, url: `${origin}/` },
    contact: { email: '', account: null }, rules: [],
  };
}

// ---- the account behind a token ----

// Loaded copies, kept while this running copy lives: a check that finds the
// copy unchanged costs one listing, not every document.
const reading = new Map();   // handle -> PodStore
const noAuthorities = { has: () => false, isLocalRequest: () => false, isLocal: () => false, wsAuthorities: () => [] };

async function readingStore(ctx, handle, log) {
  let store = reading.get(handle);
  if (!store) {
    store = new PodStore({ storage: new CopyStorage(ctx.copyKv, handle, { holder: GATEWAY_HOLDER }), log });
    if (reading.size > 200) reading.clear();
    reading.set(handle, store);
  }
  await store.load();
  return store;
}

// What an app reading needs of an agent: the store, the account's addresses
// and a publisher that only answers for them. Anything that must act — a
// search that fetches a remote account, say — gets the acting agent then.
function readingAgent(at, store, acting, log) {
  const config = store.getConfig();
  if (!config) return null;
  const publicBase = config?.gateway?.frontActor ? config.gateway.frontActor.replace(/ap\/actor\/?$/u, '') : null;
  if (publicBase) at.remote.setUrlMap(apUrls(at.pod, config.root || at.root, { publicBase }).toPod);
  const publisher = new Publisher({ config, remote: at.remote, store, deliverer: null, publicKeyPem: null, log });
  return {
    store, publisher, remote: at.remote, config, viewer: false, copy: null,
    configured: () => !!store.getConfig(), requestTakeover: async () => true, onScheduled: () => {},
    intake: { fetchAP: async (u) => (await acting()).intake.fetchAP(u) },
  };
}

function facade(agent, token, log) {
  const api = new MastoApi({ agent, log, scheme: 'https', streaming: false, webPush: false, scheduling: true, allowed: noAuthorities });
  api.tokenOf = () => token;
  return api;
}

/**
 * Read what was held for an account while nobody was reading into its copy,
 * for an app checking in. Only when no browser holds the account, and at most
 * every thirty seconds.
 */
export async function readHeldForApp(ctx, handle, rec, { log = console.log } = {}) {
  if (!ctx.listHeld) return 0;
  const key = `${handle}/mail-read-at`;
  const last = Number((await ctx.copyKv.get(key))?.text || 0);
  if (Date.now() - last < MAIL_EVERY_MS) return 0;
  await ctx.copyKv.set(key, String(Date.now()));
  if (!(await ctx.listHeld(handle)).length) return 0;
  const unlock = await lockCopy(ctx.copyKv, handle, { waitMs: 1000 });
  if (!unlock) return 0;
  try {
    const at = await reachAccount(ctx, handle, rec, { log });
    if (at.skipped || !at.inCopy) return 0;
    const { store, lease } = stateAndLease(ctx, handle, at, { log });
    if (!await lease.acquire()) return 0;                  // a browser is acting: it reads its own mail
    await store.load();
    const agent = await actingAgent(at, store, lease, { log });
    if (agent.skipped) return 0;
    const entries = await heldEntries(ctx, handle);
    const done = new Set(await agent.intake.takeHeld(entries));
    for (const e of entries) if (done.has(e.name)) for (const n of e.held) await ctx.dropHeld(handle, n);
    await ctx.noteNext?.(handle, nextDue(store)).catch(() => {});
    reading.delete(handle);
    if (done.size) log(`app @${handle}: ${done.size} held deliveries read into the copy`);
    return done.size;
  } finally { await unlock(); }
}

// A request from an app, answered by the account's facade over its copy.
async function answerForAccount(request, url, ctx, tok, rec, log) {
  const handle = tok.handle;
  const at = await reachAccount(ctx, handle, rec, { log });
  if (at.skipped) return json(503, { error: `this account cannot be reached now: ${at.skipped}` });
  if (!at.inCopy) {
    const made = await ensureCopy(ctx, handle, rec, log);
    if (!made.ok) return json(made.status === 409 ? 503 : made.status, { error: made.why });
    at.inCopy = true;
  }
  const token = { token: 'gateway', scope: tok.scope };
  const writes = request.method !== 'GET' && request.method !== 'HEAD';
  const b = await bridge(request, url);
  if (!writes) {
    const store = await readingStore(ctx, handle, log);
    let actingP = null;
    const acting = () => (actingP ||= (async () => {
      const s = stateAndLease(ctx, handle, at, { log });
      await s.store.load();
      const a = await actingAgent(at, s.store, s.lease, { log });
      if (a.skipped) throw new Error(a.skipped);
      return a;
    })());
    const agent = readingAgent(at, store, acting, log);
    if (!agent) return json(503, { error: 'this account\'s copy holds no account' });
    const api = facade(agent, token, log);
    const handled = await api.handle(b.req, b.res, url.pathname, url);
    // New mail read in after this answer, for the app's next check.
    if (/^\/api\/v[12]\/(timelines\/home|notifications)$/u.test(url.pathname)) {
      ctx.waitUntil?.(readHeldForApp(ctx, handle, rec, { log }).catch((e) => log(`app @${handle}: held mail: ${e.message}`)));
    }
    return handled ? b.response() : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }
  // Acting: this app outranks a browser sitting open, as one device does another.
  const unlock = await lockCopy(ctx.copyKv, handle);
  if (!unlock) return json(503, { error: 'this account is busy; try again' });
  try {
    const { store, lease } = stateAndLease(ctx, handle, at, { log });
    if (!await lease.acquire() && !await lease.takeover()) return json(503, { error: 'could not take this account over; try again' });
    await store.load();
    const agent = await actingAgent(at, store, lease, { log });
    if (agent.skipped) return json(503, { error: agent.skipped });
    const api = facade(agent, token, log);
    const handled = await api.handle(b.req, b.res, url.pathname, url);
    await store.commit();
    agent.publisher.stopPolls?.();
    await ctx.noteNext?.(handle, nextDue(store)).catch(() => {});
    reading.delete(handle);
    return handled ? b.response() : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  } finally { await unlock(); }
}

// ---- the routes ----

export async function routeMastoGateway(request, pathname, ctx, deps, { log = console.log } = {}) {
  const isOurs = pathname.startsWith('/api/v1/') || pathname.startsWith('/api/v2/') || pathname.startsWith('/oauth/')
    || pathname === '/api/authorize' || pathname === '/.well-known/oauth-authorization-server';
  if (!isOurs) return null;
  if (request.method === 'OPTIONS') return { status: 204, headers: CORS, body: null };
  const out = await route(request, pathname, ctx, deps, log);
  if (out instanceof Response) {
    const headers = Object.fromEntries(out.headers);
    return { status: out.status, headers: { ...headers, ...CORS }, body: out.status === 204 ? null : await out.text() };
  }
  return { ...out, headers: { ...(out.headers || {}), ...CORS } };
}

async function route(request, pathname, ctx, deps, log) {
  const kv = ctx.mastoKv;
  const url = new URL(request.url);
  const origin = url.origin;
  const host = ctx.host || url.host;
  if (!kv || !ctx.copyKv) return json(501, { error: 'this gateway does not sign in apps' });

  if (pathname === '/api/v1/instance') return json(200, instanceV1(host));
  if (pathname === '/api/v2/instance') return json(200, instanceV2(host, origin));
  if (['/api/v1/custom_emojis', '/api/v1/instance/peers', '/api/v1/instance/rules'].includes(pathname) && request.method === 'GET') return json(200, []);
  if (pathname === '/.well-known/oauth-authorization-server') {
    return json(200, {
      issuer: `${origin}/`, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      revocation_endpoint: `${origin}/oauth/revoke`, registration_endpoint: `${origin}/api/v1/apps`,
      scopes_supported: ['read', 'write', 'follow', 'push', 'profile'], response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'client_credentials'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
    });
  }

  // An app registering, for every account here.
  if (pathname === '/api/v1/apps' && request.method === 'POST') {
    const body = await formOf(request);
    const redirectUris = parseRedirects(body.redirect_uris);
    const app = {
      clientId: rand(24), clientSecret: rand(32), name: String(body.client_name || 'an app').slice(0, 200),
      website: String(body.website || '').slice(0, 500), redirectUris, scopes: String(body.scopes || 'read'), createdAt: Date.now(),
    };
    await putJson(kv, `app/${app.clientId}`, app);
    return json(200, {
      id: app.clientId, name: app.name, website: app.website || null, client_id: app.clientId, client_secret: app.clientSecret,
      redirect_uri: redirectUris.join(' ') || 'urn:ietf:wg:oauth:2.0:oob', redirect_uris: redirectUris, scopes: app.scopes.split(/\s+/u),
    });
  }

  // The app sends the person here; the sign-in page does the rest.
  if (pathname === '/oauth/authorize' && request.method === 'GET') {
    return { status: 302, headers: { location: `${SIGNIN_PAGE}${url.search}`, 'cache-control': 'no-store' }, body: null };
  }

  if (pathname === '/api/authorize' && request.method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    if (clientId) {
      const app = await getJson(kv, `app/${clientId}`);
      if (!app) return json(404, { error: 'this app has not registered here' });
      const redirect = url.searchParams.get('redirect_uri') || '';
      if (redirect !== 'urn:ietf:wg:oauth:2.0:oob' && !app.redirectUris.includes(redirect)) {
        return json(400, { error: 'this app asked to be sent somewhere it did not register' });
      }
      let where = null; try { where = redirect.startsWith('urn:') ? null : new URL(redirect).host || null; } catch { /* a custom scheme */ }
      return json(200, { name: app.name, website: app.website || null, sendsTo: where });
    }
    const handle = handleOf(url.searchParams.get('address'), host);
    const rec = handle ? await ctx.lookup(handle) : null;
    if (!rec?.openedAt || rec.movedTo || rec.closedAt) return json(404, { error: 'there is no account with that address here' });
    if (!rec.keeper) {
      return json(409, { error: 'this account works only while FediPod is open. To use it from an app, turn on '
        + '"Keep my account running while I\'m away" on its manage page first.' });
    }
    return json(200, { handle, webId: rec.webId });
  }

  // The pod sign-in, proved: a code for the app.
  if (pathname === '/api/authorize' && request.method === 'POST') {
    const webid = await deps.verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return json(401, { error: 'sign in at your pod first' });
    const body = await request.clone().json().catch(() => ({}));
    const handle = handleOf(body.address, host);
    const rec = handle ? await ctx.lookup(handle) : null;
    if (!usable(rec)) return json(404, { error: 'there is no account kept running with that address here' });
    if (rec.webId !== webid) return json(403, { error: `you signed in as ${webid}, and this account belongs to ${rec.webId}` });
    const app = await getJson(kv, `app/${body.client_id || ''}`);
    if (!app) return json(400, { error: 'this app has not registered here' });
    const redirect = body.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob';
    if (redirect !== 'urn:ietf:wg:oauth:2.0:oob' && !app.redirectUris.includes(redirect)) {
      return json(400, { error: 'this app asked to be sent somewhere it did not register' });
    }
    const made = await ensureCopy(ctx, handle, rec, log);
    if (!made.ok) return json(made.status === 409 ? 503 : made.status, { error: made.why });
    const code = rand(24);
    await putJson(kv, `code/${sha(code)}`, {
      handle, clientId: app.clientId, redirect, scope: String(body.scope || 'read'), at: Date.now(),
      ...(body.code_challenge ? { challenge: body.code_challenge, challengeMethod: body.code_challenge_method || 'plain' } : {}),
    });
    log(`app "${app.name}" signed in to @${handle}`);
    if (redirect === 'urn:ietf:wg:oauth:2.0:oob') return json(200, { code });
    const to = new URL(redirect);
    to.searchParams.set('code', code);
    if (body.state) to.searchParams.set('state', body.state);
    return json(200, { redirect: to.href });
  }

  if (pathname === '/oauth/token' && request.method === 'POST') {
    const body = await formOf(request);
    const basic = /^Basic (.+)$/u.exec(request.headers.get('authorization') || '')?.[1];
    if (basic) { const [id, secret] = Buffer.from(basic, 'base64').toString().split(':'); body.client_id ||= decodeURIComponent(id); body.client_secret ||= decodeURIComponent(secret || ''); }
    const app = await getJson(kv, `app/${body.client_id || ''}`);
    if (!app) return json(401, { error: 'invalid_client' });
    const secretOk = body.client_secret && body.client_secret.length === app.clientSecret.length
      && crypto.timingSafeEqual(Buffer.from(body.client_secret), Buffer.from(app.clientSecret));
    const mint = async (handle, scope) => {
      const token = rand(32);
      await putJson(kv, `token/${sha(token)}`, { handle, scope, clientId: app.clientId, at: Date.now() });
      return json(200, { access_token: token, token_type: 'Bearer', scope, created_at: Math.floor(Date.now() / 1000) });
    };
    if (body.grant_type === 'client_credentials') {
      if (!secretOk) return json(401, { error: 'invalid_client' });
      return mint(null, String(body.scope || 'read'));
    }
    if (body.grant_type && body.grant_type !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
    const key = `code/${sha(body.code || '')}`;
    const rec = await getJson(kv, key);
    if (!rec || Date.now() - rec.at > CODE_TTL_MS || rec.clientId !== app.clientId
      || (body.redirect_uri && body.redirect_uri !== rec.redirect)) return json(400, { error: 'invalid_grant' });
    // A code made with a challenge is only redeemed with its answer; one made
    // without needs the app's secret.
    if (rec.challenge ? !MastoApi.provesCode(rec, body.code_verifier) : !secretOk) return json(400, { error: 'invalid_grant' });
    await kv.delete(key);
    return mint(rec.handle, rec.scope);
  }

  if (pathname === '/oauth/revoke' && request.method === 'POST') {
    const body = await formOf(request);
    if (body.token) await kv.delete(`token/${sha(body.token)}`);
    return json(200, {});
  }

  // Everything else needs a token.
  const bearer = /^Bearer (.+)$/u.exec(request.headers.get('authorization') || '')?.[1];
  const tok = bearer ? await getJson(kv, `token/${sha(bearer)}`) : null;
  if (!tok || Date.now() - tok.at > TOKEN_TTL_MS) return json(401, { error: 'The access token is invalid' });
  if (pathname === '/api/v1/apps/verify_credentials') {
    const app = await getJson(kv, `app/${tok.clientId}`);
    return json(200, { name: app?.name || 'an app', website: app?.website || null, scopes: String(tok.scope).split(/\s+/u) });
  }
  if (!tok.handle) return json(403, { error: 'this token names no account' });
  const rec = await ctx.lookup(tok.handle);
  if (!usable(rec)) return json(401, { error: 'this account is not kept running here any more' });
  return answerForAccount(request, url, ctx, tok, rec, log);
}
