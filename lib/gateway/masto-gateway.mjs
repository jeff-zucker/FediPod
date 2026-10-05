// masto-gateway.mjs — Mastodon apps at the gateway's own address: elk.zone,
// Ivory, Tusky or any other app, signed in to an account the gateway keeps
// running, reading and writing it from its copy (copy.mjs), made from the pod
// when there is none while the hold is on; with the hold off, from the pod.
//
//   POST /api/v1/apps                   an app registers here, for every account
//   GET  /oauth/authorize               sends the person to the sign-in page
//                                       (/app-signin/, web/app-signin/), which
//                                       signs them in at their own pod
//   GET  /api/authorize?client_id=…     what the page shows: the app's name
//   GET  /api/authorize?address=…       the pod an address here, or a WebID, belongs to
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
// has been answered, at most every thirty seconds; with the hold off, the pod
// inbox is drained then instead, unless FediPod is open and drains it itself.
//
// Phone notifications: an app signs up for them through the account's own
// facade (/api/v1/push/subscription), with the one push key pair this gateway
// keeps for all its accounts, made the first time it is needed. When the door
// holds a delivery that becomes a notification (gateway-core: notifies), it
// starts a short run (push-background.mjs, pushHeld below) that reads the held
// mail into the copy and pushes each notification it makes. While FediPod is
// open in a browser, it reads the mail itself and names the notifications it
// made (held-mail.mjs: /api/push); those are pushed from the account as it
// reads (pushMade below).
import crypto from 'node:crypto';
import { MastoApi } from '../client/masto/index.mjs';
import { instanceConfig } from '../client/masto/instance.mjs';
import { TRANSPARENT_PNG } from '../client/masto/render.mjs';
import { bridge } from '../client/masto/bridge.mjs';
import { PodStore } from '../core/store.mjs';
import { apUrls } from '../core/wire.mjs';
import { Publisher } from '../core/publisher/index.mjs';
import { nextDue } from '../core/scheduled.mjs';
import { reachAccount, settle, stateAndLease, actingAgent } from './account-agent.mjs';
import { ensureCopy } from './state-api.mjs';
import { CopyStorage, lockCopy, keptNow, keptBefore, holdOn, waitOutClosing, GATEWAY_HOLDER } from './copy.mjs';
import { HttpStorage } from '../core/storage.mjs';
import * as podInbox from '../pod/inbox.mjs';
import { heldEntries } from './held-mail.mjs';
import { noteOpened } from './quiet.mjs';
import { Push } from '../client/webpush.mjs';
import webpush from 'web-push';

// An app stays signed in for ninety days from its last use; the mark of use
// moves at most once a day.
const TOKEN_TTL_MS = 90 * 86400_000;
const TOKEN_USE_MARK_MS = 86400_000;
const CODE_TTL_MS = 10 * 60_000;
const MAIL_EVERY_MS = 30_000;
const SIGNIN_PAGE = '/app-signin/';
const API_VERSIONS = { mastodon: 7 };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('base64url');
// A client id as this gateway makes them. Anything else is not looked up: an
// id is part of a storage key.
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/u;
const appOf = (kv, id) => (CLIENT_ID.test(String(id || '')) ? getJson(kv, `app/${id}`) : null);
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

/**
 * The account an address names: a Fediverse address here ("you", "@you",
 * "you@host", "@you@host", or a whole address on the person's own pod), or a
 * WebID, which names the browser account here that belongs to it. An account
 * FediPod has not finished setting up counts: the caller says it is not ready.
 * Returns { handle, rec }, or { error: [status, message] }.
 */
async function accountFor(ctx, address, host) {
  const a = String(address || '').trim();
  const here = (r) => !!r && !r.movedTo && !r.closedAt;
  if (/^https?:\/\//iu.test(a)) {
    const mine = Object.entries(await ctx.listDirectory?.() || {}).filter(([, r]) => r?.webId === a && here(r));
    // Kept running first: that is the one an app can use; then opened ones.
    const kept = mine.filter(([, r]) => r.openedAt && r.keeper);
    const opened = mine.filter(([, r]) => r.openedAt);
    const pick = kept.length ? kept : opened.length ? opened : mine;
    if (pick.length > 1) return { error: [409, 'this WebID has more than one account here; give the Fediverse address of the one to use'] };
    if (!pick.length) return { error: [404, 'there is no account here for that WebID'] };
    return { handle: pick[0][0], rec: pick[0][1] };
  }
  const handle = handleOf(a, host);
  // Read fresh: a person is signing in, perhaps a moment after signing up.
  const rec = handle ? await (ctx.lookupFresh || ctx.lookup)(handle) : null;
  if (!here(rec)) return { error: [404, 'there is no account with that address here'] };
  return { handle, rec };
}

// An account here that an app cannot use. The forum and its categories are
// run by a server. A personal account set up in the last few minutes and not
// yet opened: FediPod has not finished its first start. An older one never
// opened in a browser: made before FediPod noted openings, or run by a server;
// the gateway cannot tell which. Opened but not kept: new, or its owner
// stopped keeping it running. The minute rests on a first start seen on
// 2026-09-26 (24 seconds from opening to kept).
const NEW_FOR_MS = 10 * 60_000;
const SERVER_RUN = 'This account is run by a server, not by FediPod in a browser, so apps can\'t sign in to it here.';
const NOT_READY_NEW = 'This account was set up moments ago, and FediPod is still getting it ready for apps. '
  + 'That usually takes under a minute. Leave FediPod open in your browser, then try again.';
const NOT_IN_BROWSER = 'An app can only sign in to an account that FediPod runs in your browser. '
  + 'If this is one, open it in FediPod first, then try again.';
const NOT_READY = 'This account can\'t be used from an app yet. If you set it up in the last few minutes, FediPod is '
  + 'still getting it ready: that usually takes under a minute, so leave FediPod open in your browser and try again. '
  + 'Otherwise, press "Keep my account running while I\'m away" on your account\'s manage page, then try again.';
function notReady(rec) {
  if (rec.kind === 'group' || rec.kind === 'application') return SERVER_RUN;
  if (rec.openedAt) return NOT_READY;
  const setUp = Date.parse(rec.attachedAt || '');
  return setUp && Date.now() - setUp < NEW_FOR_MS ? NOT_READY_NEW : NOT_IN_BROWSER;
}

// An account an app may sign in to: a browser account here, kept running, not
// moved or closed.
const usable = (ctx, rec) => !!(rec && rec.openedAt && keptNow(ctx, rec) && !rec.movedTo && !rec.closedAt);
// Kept under the gateway's former identity: it works again once its owner has
// opened FediPod in a browser, which moves it to the new one.
const MOVING = 'this account is moving to fedipod.net\'s new identity: open FediPod in a browser once, then try again';

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
function instanceV2(host, origin, vapidKey) {
  return {
    domain: host, title: host, version: '4.2.0 (compatible; fedipod)', api_versions: API_VERSIONS,
    source_url: 'https://github.com/jeff-zucker/FediPod',
    description: 'FediPod: Fediverse accounts whose home is a Solid pod.',
    usage: { users: { active_month: 0 } }, thumbnail: { url: TRANSPARENT_PNG }, languages: ['en'],
    urls: {}, configuration: { ...instanceConfig(), vapid: { public_key: vapidKey } },
    // Accounts are made on the front page, with a pod, not through an app.
    registrations: { enabled: false, approval_required: false, message: null, url: `${origin}/` },
    contact: { email: '', account: null }, rules: [],
  };
}

// ---- phone notifications ----

// The gateway's one push key pair, for every account here: an app asks for the
// key before it knows which account it will sign in to.
export async function vapidKeys(kv) {
  const had = await getJson(kv, 'vapid');
  if (had?.publicKey && had.privateKey) return had;
  await kv.set('vapid', JSON.stringify(webpush.generateVAPIDKeys()), { ifNew: true });
  return getJson(kv, 'vapid');
}

class GatewayPush extends Push {
  constructor({ keys, keep = true, ...o }) { super(o); this.keys = keys; this.keep = keep; }
  vapid() { return this.keys; }
  // Pushing from an account only read: a sign-up the push service has dropped
  // is let go by the next push that acts on the account.
  save(s) { if (this.keep) super.save(s); }
}

// ---- the account behind a token ----

// Loaded copies, kept while this running copy lives: a check that finds the
// copy unchanged costs one listing, not every document. With the hold off,
// the pod's state, read the same way.
const reading = new Map();   // handle (or pod:handle) -> PodStore
const noAuthorities = { has: () => false, isLocalRequest: () => false, isLocal: () => false, wsAuthorities: () => [] };

// What an app reads: the copy, or with the hold off, the pod.
const stateOf = (ctx, handle, at) => (at.inCopy
  ? new CopyStorage(ctx.copyKv, handle, { holder: GATEWAY_HOLDER })
  : new HttpStorage(at.urls.state, at.podFetch));

async function readingStore(ctx, handle, at, log) {
  const key = at.inCopy ? handle : `pod:${handle}`;
  let held = reading.get(key);
  if (!held) {
    held = { store: new PodStore({ storage: stateOf(ctx, handle, at), log }) };
    if (reading.size > 200) reading.clear();
    reading.set(key, held);
  }
  // This request's own sign-in at the pod; the same place, so what is held stays.
  else held.store.attach(stateOf(ctx, handle, at));
  held.at = Date.now();
  await held.store.load();
  return held.store;
}

// What this running copy remembers of an account, a loaded copy or an answer,
// goes once nobody has asked for fifteen minutes, as the copy itself does
// (copy.mjs: the hold).
const MEMORY_MS = 15 * 60_000;
function forgetOld(now = Date.now()) {
  for (const [k, v] of reading) if (now - v.at > MEMORY_MS) reading.delete(k);
  for (const [k, v] of answered) if (now - v.at > MEMORY_MS) { answeredBytes -= v.body.length; answered.delete(k); }
}
const forget = (handle) => { reading.delete(handle); reading.delete(`pod:${handle}`); };

// An app's repeated check: while the copy's list of documents is as it was
// and no mail waits, the same question gets the same answer, without opening
// the copy. Ten minutes at most, for what changes with the clock alone (a
// poll closing). Kept per token, while this running copy lives.
const REPEAT_MS = 10 * 60_000;
const REPEAT_MAX_BYTES = 32 * 1024 * 1024;
const REPEATABLE = /^\/api\/v[12]\/(timelines\/[^/]+(\/[^/]+)?|notifications(\/unread_count)?|markers|conversations|follow_requests|announcements|accounts\/verify_credentials|lists|filters|preferences)$/u;
const answered = new Map();   // handle, token hash and the question -> { tag, at, status, headers, body }
let answeredBytes = 0;

async function repeatAnswer(ctx, handle, key, at) {
  const had = answered.get(key);
  if (!had || Date.now() - had.at > REPEAT_MS) return null;
  const listing = await stateOf(ctx, handle, at).list('', { etag: had.tag }).catch(() => ({ notModified: false }));
  if (!listing.notModified) return null;
  if (ctx.listHeld && (await ctx.listHeld(handle)).length) return null;
  return { status: had.status, headers: { ...had.headers }, body: had.body };
}

function rememberAnswer(key, tag, status, headers, body) {
  if (body.length > REPEAT_MAX_BYTES / 64) return;
  if (answeredBytes + body.length > REPEAT_MAX_BYTES) { answered.clear(); answeredBytes = 0; }
  answeredBytes += body.length - (answered.get(key)?.body.length || 0);
  answered.set(key, { tag, at: Date.now(), status, headers, body });
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

// Who a push service is told sends the pushes: the gateway itself, as a
// contact address push services accept (https or mailto).
const pushContact = (ctx) => (/^https:\/\//u.test(ctx.frontOrigin || '') ? `${ctx.frontOrigin.replace(/\/$/u, '')}/` : `mailto:postmaster@${ctx.host || 'localhost'}`);

function facade(agent, token, log, keys = null, contact = null, { keep = true } = {}) {
  const api = new MastoApi({ agent, log, scheme: 'https', streaming: false, webPush: !!keys, scheduling: true, allowed: noAuthorities });
  api.tokenOf = () => token;
  if (keys) api._push = new GatewayPush({ store: agent.store, keys, log, subject: () => contact, keep });
  return api;
}

// How many push subscriptions an account has, kept beside the tokens so the
// door can ask without reading the account.
async function notePushSubs(ctx, handle, store) {
  const n = Object.keys(store.read('webpush.json', { subs: {} }).subs || {}).length;
  await ctx.mastoKv.set(`push/${handle}`, String(n));
}
export async function pushWanted(ctx, handle) { return Number((await ctx.mastoKv?.get(`push/${handle}`))?.text || 0) > 0; }

// With the hold off, mail is in the pod inbox, not held here: whether any is
// waiting, from one listing.
async function inboxWaiting(at) {
  const items = await podInbox.list(at.remote, at.urls).catch(() => []);
  return items.some((e) => !e.url.endsWith('.keep') && !e.url.endsWith('.receipt.json'));
}

/**
 * Read what was held for an account into its copy, and push each notification
 * that makes to the owner's phones and browsers. With the hold off, what waits
 * in the pod inbox is drained instead. `takeover`: act even when a browser
 * that went quiet still holds the lease (a push run); otherwise leave the mail
 * to whoever holds it (an app's check).
 */
async function readHeld(ctx, handle, rec, { log = console.log, takeover = false, waitMs = 1000 } = {}) {
  const held = async () => !!(ctx.listHeld && (await ctx.listHeld(handle)).length);
  if (holdOn(ctx) && !await held()) return 0;
  const unlock = await lockCopy(ctx.copyKv, handle, { waitMs });
  if (!unlock) return 0;
  try {
    const at = await reachAccount(ctx, handle, rec, { log });
    if (at.skipped) return 0;
    if (!(await settle(ctx, handle, rec, at, { log })).ok) return 0;
    const drains = !at.inCopy;
    if (drains && !await inboxWaiting(at) && !await held()) return 0;
    const { store, lease } = stateAndLease(ctx, handle, at, { log });
    if (!await lease.acquire() && !(takeover && await lease.takeover())) return 0;
    await store.load();
    const agent = await actingAgent(at, store, lease, { log });
    if (agent.skipped) return 0;
    const pushes = [];
    if (await pushWanted(ctx, handle)) {
      const api = facade(agent, null, log, await vapidKeys(ctx.mastoKv), pushContact(ctx));
      store.onEvent = (type, n) => {
        if (type !== 'notification') return;
        // Named in the push by who they are: a sender only a note named is
        // fetched first, as the app would when it showed the notification.
        pushes.push((async () => {
          if (n.actor && !store.getActors()[n.actor]) await agent.intake.fetchAP(n.actor).catch(() => null);
          await api.pushNotify(n);
        })().catch((e) => log(`push @${handle}: ${e.message}`)));
      };
    }
    const entries = ctx.listHeld ? await heldEntries(ctx, handle) : [];
    const done = new Set(await agent.intake.takeHeld(entries));
    for (const e of entries) if (done.has(e.name)) for (const n of e.held) await ctx.dropHeld(handle, n);
    if (drains) await agent.intake.drain();
    await Promise.all(pushes);
    await store.commit();
    await lease.release().catch(() => {});
    await ctx.noteNext?.(handle, nextDue(store)).catch(() => {});
    forget(handle);
    if (done.size || drains) log(`@${handle}: ${drains ? 'the pod inbox drained' : `${done.size} held deliveries read into the copy`}, ${pushes.length} pushed`);
    return done.size || (drains ? 1 : 0);
  } finally { await unlock(); }
}

/** For an app checking in: at most every thirty seconds, never over a browser. */
export async function readHeldForApp(ctx, handle, rec, { log = console.log } = {}) {
  if (!ctx.listHeld && holdOn(ctx)) return 0;
  const key = `${handle}/mail-read-at`;
  const last = Number((await ctx.copyKv.get(key))?.text || 0);
  if (Date.now() - last < MAIL_EVERY_MS) return 0;
  await ctx.copyKv.set(key, String(Date.now()));
  return readHeld(ctx, handle, rec, { log });
}

/**
 * For the door, when a delivery that becomes a notification was held. The
 * door starts one run at a time for an account and notes each arrival
 * (`pushwant/`); the run goes round again while arrivals keep coming, so a
 * burst of likes is a run or two, not one each.
 */
export async function pushHeld(ctx, handle, rec, { log = console.log } = {}) {
  if ((!ctx.listHeld && holdOn(ctx)) || !await pushWanted(ctx, handle)) return 0;
  const kv = ctx.mastoKv;
  const wanted = async () => (await kv.get(`pushwant/${handle}`))?.text || null;
  let n = 0;
  let seen = null;
  for (let round = 0; round < 6; round++) {
    seen = await wanted();
    n += await readHeld(ctx, handle, rec, { log, takeover: true, waitMs: 20_000 });
    if ((await wanted()) !== seen) continue;
    // Finished: the run is over. An arrival that came in just now saw this run
    // still going and started none, so it is looked for once more after.
    await kv.delete(`pushrun/${handle}`).catch(() => {});
    if ((await wanted()) === seen) return n;
    await kv.set(`pushrun/${handle}`, String(Date.now())).catch(() => {});
  }
  await kv.delete(`pushrun/${handle}`).catch(() => {});
  return n;
}

/**
 * For FediPod open in a browser, which read mail that went straight to the pod
 * and names the notifications it made: each is read from the account as it is
 * now, without acting, and pushed once, while it is new. One that came from
 * another network (Bluesky, a connected account) is not pushed, as it is not
 * while FediPod is closed.
 */
const PUSH_FRESH_MS = 15 * 60_000;
const PUSHED_KEPT = 200;
export async function pushMade(ctx, handle, rec, ids, { log = console.log, now = Date.now() } = {}) {
  if (!ids?.length || !await pushWanted(ctx, handle)) return 0;
  const key = `pushed/${handle}`;
  const done = (await getJson(ctx.mastoKv, key)) || [];
  const want = new Set(ids.filter((id) => !done.includes(id)));
  if (!want.size) return 0;
  await waitOutClosing(ctx.copyKv, handle);
  const at = await reachAccount(ctx, handle, rec, { log });
  if (at.skipped) return 0;
  const store = await readingStore(ctx, handle, at, log);
  const agent = readingAgent(at, store, async () => { throw new Error('only reading'); }, log);
  if (!agent) return 0;
  // On the pod, a rewritten document leaves the listing as it was: what the
  // push reads is asked for again, if it changed.
  if (!at.inCopy) await store.refresh(['notifications.json', 'actors.json', 'statuses.json', 'webpush.json'], { ifChanged: true });
  const fresh = store.getNotifications()
    .filter((n) => want.has(n.id) && !n.bsky && !n.via && now - Date.parse(n.at) < PUSH_FRESH_MS);
  if (!fresh.length) return 0;
  const api = facade(agent, null, log, await vapidKeys(ctx.mastoKv), pushContact(ctx), { keep: false });
  for (const n of fresh) await api.pushNotify(n).catch((e) => log(`push @${handle}: ${e.message}`));
  await ctx.mastoKv.set(key, JSON.stringify([...fresh.map((n) => n.id), ...done].slice(0, PUSHED_KEPT)));
  log(`@${handle}: ${fresh.length} made in FediPod pushed`);
  return fresh.length;
}

// A request from an app, answered by the account's facade over its copy, or
// with the hold off, over the pod.
async function answerForAccount(request, url, ctx, tok, rec, log, tokenHash) {
  const handle = tok.handle;
  forgetOld();
  const repeatKey = request.method === 'GET' && REPEATABLE.test(url.pathname) ? `${handle}\n${tokenHash}\n${url.pathname}${url.search}` : null;
  // The copy's listing as it was: the same answer, without opening the copy.
  // A copy written to the pod and deleted since lists differently.
  if (repeatKey && holdOn(ctx)) {
    const again = await repeatAnswer(ctx, handle, repeatKey, { inCopy: true });
    if (again) return again;
  }
  // A copy the round is writing to the pod and deleting is waited out; it is
  // made again below.
  await waitOutClosing(ctx.copyKv, handle);
  const at = await reachAccount(ctx, handle, rec, { log });
  if (at.skipped) return json(503, { error: `this account cannot be reached now: ${at.skipped}` });
  const token = { token: 'gateway', scope: tok.scope };
  const writes = request.method !== 'GET' && request.method !== 'HEAD';
  if (!writes && !at.inCopy && holdOn(ctx)) {
    const made = await ensureCopy(ctx, handle, rec, log);
    if (!made.ok) return json(made.status === 409 ? 503 : made.status, { error: made.why });
    at.inCopy = true;
  }
  // New mail read in beside this answer, for the app's next check.
  if (!writes && /^\/api\/v[12]\/(timelines\/home|notifications)$/u.test(url.pathname)) {
    ctx.waitUntil?.(readHeldForApp(ctx, handle, rec, { log }).catch((e) => log(`app @${handle}: held mail: ${e.message}`)));
  }
  // With the hold off, the pod's listing, after the inbox has been looked at.
  if (repeatKey && !holdOn(ctx)) {
    const again = await repeatAnswer(ctx, handle, repeatKey, at);
    if (again) return again;
  }
  const b = await bridge(request, url);
  if (!writes) {
    const store = await readingStore(ctx, handle, at, log);
    // The copy as this answer reads it: a later check finding the same list repeats it.
    const tag = store.etags.get('');
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
    const api = facade(agent, token, log, await vapidKeys(ctx.mastoKv), pushContact(ctx));
    const handled = await api.handle(b.req, b.res, url.pathname, url);
    if (!handled) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const res = b.response();
    // An answer that had to act (a fetch from another server) is not repeated.
    if (!repeatKey || actingP || res.status !== 200 || !tag) return res;
    const headers = Object.fromEntries(res.headers);
    const body = await res.text();
    rememberAnswer(repeatKey, tag, res.status, headers, body);
    return { status: res.status, headers, body };
  }
  // Acting: this app outranks a browser sitting open, as one device does another.
  const unlock = await lockCopy(ctx.copyKv, handle);
  if (!unlock) return json(503, { error: 'this account is busy; try again' });
  let lease = null;
  try {
    // Decided under the lock, so the round cannot delete the copy meanwhile.
    const settled = await settle(ctx, handle, rec, at, { log });
    if (!settled.ok) return json(settled.status === 409 ? 503 : settled.status || 503, { error: settled.why });
    const s = stateAndLease(ctx, handle, at, { log });
    if (!await s.lease.acquire() && !await s.lease.takeover()) return json(503, { error: 'could not take this account over; try again' });
    lease = s.lease;
    const store = s.store;
    await store.load();
    const agent = await actingAgent(at, store, lease, { log });
    if (agent.skipped) return json(503, { error: agent.skipped });
    const api = facade(agent, token, log, await vapidKeys(ctx.mastoKv), pushContact(ctx));
    const handled = await api.handle(b.req, b.res, url.pathname, url);
    await store.commit();
    if (url.pathname === '/api/v1/push/subscription') await notePushSubs(ctx, handle, store);
    agent.publisher.stopPolls?.();
    await ctx.noteNext?.(handle, nextDue(store)).catch(() => {});
    forget(handle);
    return handled ? b.response() : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  } finally {
    // Done acting, however it went: the lease goes back, so a browser sitting
    // open takes it up again rather than staying a viewer for its whole term.
    await lease?.release().catch(() => {});
    await unlock();
  }
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
  if (pathname === '/api/v2/instance') return json(200, instanceV2(host, origin, (await vapidKeys(kv)).publicKey));
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

  // Apps sign in only where the gateway can keep accounts running.
  if (!ctx.keeperWebId) return json(501, { error: 'Mastodon apps cannot sign in at this server yet' });

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
      vapid_key: (await vapidKeys(kv)).publicKey,
    });
  }

  // The app sends the person here; the sign-in page does the rest.
  if (pathname === '/oauth/authorize' && request.method === 'GET') {
    return { status: 302, headers: { location: `${SIGNIN_PAGE}${url.search}`, 'cache-control': 'no-store' }, body: null };
  }

  if (pathname === '/api/authorize' && request.method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    if (clientId) {
      const app = await appOf(kv, clientId);
      if (!app) return json(404, { error: 'this app has not registered here' });
      const redirect = url.searchParams.get('redirect_uri') || '';
      if (redirect !== 'urn:ietf:wg:oauth:2.0:oob' && !app.redirectUris.includes(redirect)) {
        return json(400, { error: 'this app asked to be sent somewhere it did not register' });
      }
      let where = null; try { where = redirect.startsWith('urn:') ? null : new URL(redirect).host || null; } catch { /* a custom scheme */ }
      return json(200, { name: app.name, website: app.website || null, sendsTo: where });
    }
    const found = await accountFor(ctx, url.searchParams.get('address'), host);
    if (found.error) return json(found.error[0], { error: found.error[1] });
    const { handle, rec } = found;
    if (keptBefore(ctx, rec)) return json(503, { error: MOVING });
    if (!rec.openedAt || !rec.keeper) return json(409, { error: notReady(rec) });
    return json(200, { handle, webId: rec.webId });
  }

  // The pod sign-in, proved: a code for the app.
  if (pathname === '/api/authorize' && request.method === 'POST') {
    const body = await request.clone().json().catch(() => ({}));
    const found = await accountFor(ctx, body.address, host);
    if (found.error) return json(found.error[0], { error: found.error[1] });
    const { handle, rec } = found;
    // A token for anyone but this account's owner is refused before it is
    // checked: checking fetches the addresses it names.
    const webid = await deps.verifyPodToken(request, pathname, ctx.verifier, { only: (w) => w === rec.webId });
    if (!webid) return json(401, { error: 'sign in at your pod first' });
    if (keptBefore(ctx, rec)) return json(503, { error: MOVING });
    if (!usable(ctx, rec)) return json(409, { error: notReady(rec) });
    if (rec.webId !== webid) return json(403, { error: `you signed in as ${webid}, and this account belongs to ${rec.webId}` });
    // Signing an app in is the owner being here, as signing in to FediPod is.
    await noteOpened(ctx, handle, rec, { always: true }).catch((e) => log(`@${handle}: stamp not written: ${e?.message || e}`));
    const app = await appOf(kv, body.client_id);
    if (!app) return json(400, { error: 'this app has not registered here' });
    const redirect = body.redirect_uri || 'urn:ietf:wg:oauth:2.0:oob';
    if (redirect !== 'urn:ietf:wg:oauth:2.0:oob' && !app.redirectUris.includes(redirect)) {
      return json(400, { error: 'this app asked to be sent somewhere it did not register' });
    }
    // The owner, proved: not an app checking in, so not made to wait. With
    // the hold off there is no copy to make; the app reads the pod.
    const made = holdOn(ctx) ? await ensureCopy(ctx, handle, rec, log, { owner: true }) : { ok: true };
    if (!made.ok) return json(made.status === 409 ? 503 : made.status, { error: made.why });
    const code = rand(24);
    await putJson(kv, `code/${sha(code)}`, {
      handle, webId: webid, clientId: app.clientId, redirect, scope: String(body.scope || 'read'), at: Date.now(),
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
    const app = await appOf(kv, body.client_id);
    if (!app) return json(401, { error: 'invalid_client' });
    const secretOk = body.client_secret && body.client_secret.length === app.clientSecret.length
      && crypto.timingSafeEqual(Buffer.from(body.client_secret), Buffer.from(app.clientSecret));
    const mint = async (handle, scope, webId = null) => {
      const token = rand(32);
      await putJson(kv, `token/${sha(token)}`, { handle, webId, scope, clientId: app.clientId, at: Date.now() });
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
    return mint(rec.handle, rec.scope, rec.webId);
  }

  if (pathname === '/oauth/revoke' && request.method === 'POST') {
    const body = await formOf(request);
    if (body.token) await kv.delete(`token/${sha(body.token)}`);
    return json(200, {});
  }

  // Everything else needs a token.
  const bearer = /^Bearer (.+)$/u.exec(request.headers.get('authorization') || '')?.[1];
  const tokenHash = bearer ? sha(bearer) : null;
  const tok = tokenHash ? await getJson(kv, `token/${tokenHash}`) : null;
  const lastUse = tok ? tok.usedAt || tok.at : 0;
  if (!tok || Date.now() - lastUse > TOKEN_TTL_MS) {
    // A page of this site asking with a token the gateway never gave out is
    // FediPod's own client in a browser whose worker is not answering yet:
    // told to try again, not that it is signed out.
    if (request.headers.get('sec-fetch-site') === 'same-origin') return json(503, { error: 'FediPod is starting in this browser; try again' });
    return json(401, { error: 'The access token is invalid' });
  }
  if (Date.now() - lastUse > TOKEN_USE_MARK_MS) await putJson(kv, `token/${tokenHash}`, { ...tok, usedAt: Date.now() }).catch(() => {});
  if (pathname === '/api/v1/apps/verify_credentials') {
    const app = await appOf(kv, tok.clientId);
    return json(200, { name: app?.name || 'an app', website: app?.website || null, scopes: String(tok.scope).split(/\s+/u) });
  }
  if (!tok.handle) return json(403, { error: 'this token names no account' });
  const rec = await ctx.lookup(tok.handle);
  // The token is for the owner who signed in; an address given up and taken
  // by somebody else is not theirs.
  if (rec && rec.webId === tok.webId && keptBefore(ctx, rec)) return json(503, { error: MOVING });
  if (!usable(ctx, rec) || rec.webId !== tok.webId) return json(401, { error: 'this account is not kept running here any more' });
  // Using an app is being here: no pause, no closing, for want of opening
  // FediPod. Hourly at most; see noteOpened.
  const here = await noteOpened(ctx, tok.handle, rec).catch((e) => { log(`@${tok.handle}: stamp not written: ${e?.message || e}`); return rec; });
  return answerForAccount(request, url, ctx, tok, here, log, tokenHash);
}
