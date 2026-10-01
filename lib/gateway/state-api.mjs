// state-api.mjs — the owner's browser reaching its account's copy at the
// gateway (copy.mjs).
//
//   POST /api/state/open             the owner, proved with the pod sign-in:
//                                    makes the copy if there is none yet, and
//                                    answers where it is and a token for it
//   GET  /api/state/<handle>/        what the copy holds
//   GET  /api/state/<handle>/<name>  one document (ETag, If-None-Match)
//   PUT  /api/state/<handle>/<name>  one document, from the lease's holder
//   DELETE …                         the same
//   GET/PUT /api/state/<handle>/lease.json   the copy's lease (If-Match)
//   POST /api/state/<handle>/leave   the copy written to the pod and given up,
//                                    before the owner stops the gateway keeping
//                                    the account running
//
// The token is the gateway's own, signed with a secret only it knows, and
// names the account and the WebID that asked; it lasts a day. The signing key
// and the passwords of accounts elsewhere are refused here: the copy does not
// hold them, and the browser reads them from the pod.
import crypto from 'node:crypto';
import { HttpStorage } from '../core/storage.mjs';
import { CopyStorage, copyMeta, fillCopy, dropCopy, forgetCopy, holds, lockCopy, kvDocFetch, podOnly, safeName, safeHandle, keptBefore,
  isPersonal, COPY_VERSION, currentSeq } from './copy.mjs';
import { appliedUpTo, inCopyFor } from './pod-mail.mjs';

const TOKEN_MS = 24 * 3600_000;
const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');

export function stateToken(secret, { handle, webId }, now = Date.now()) {
  const body = b64(JSON.stringify({ h: handle, w: webId, e: now + TOKEN_MS }));
  return { token: `${body}.${sign(secret, body)}`, expiresAt: now + TOKEN_MS };
}

export function readStateToken(secret, token, now = Date.now()) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString());
    return t.e > now ? { handle: t.h, webId: t.w } : null;
  } catch { return null; }
}

// Where an account's state is on its pod.
export const stateUrlOf = (rec) => `${rec.podHome.replace(/\/?$/u, '/')}ap-state/`;

// Whether this gateway can keep a copy for this account at all.
export const keepsCopies = (ctx) => !!(ctx.copyKv && ctx.keeperWebId && ctx.keeperFetch && ctx.stateSecret);

const FILL_RETRY_MS = 5 * 60_000;
// The gateway's own sign-in at its pod's issuer refused: nothing an account
// does changes that, so no account's copy is tried for this long. Held against
// the credential it failed with (ctx.keeperMark); a new one is tried at once.
const LOGIN_PAUSE_MS = 15 * 60_000;
const LOGIN_REFUSED = '_keeper/login-refused';
const refusedSignIn = (why) => /token request failed \(HTTP 40[01]\)/u.test(why || '');
async function loginRefused(ctx) {
  let r = null;
  try { r = JSON.parse((await ctx.copyKv.get(LOGIN_REFUSED))?.text || 'null'); } catch { /* none */ }
  return r && r.mark === (ctx.keeperMark || '') && Date.now() - r.at < LOGIN_PAUSE_MS ? r : null;
}

// The last failed attempt: { at, why }. Written as a bare time before 2026-09-26.
async function lastFailure(kv, handle) {
  const text = (await kv.get(`${handle}/fill-failed-at`))?.text || '';
  try { const f = JSON.parse(text); return typeof f === 'number' ? { at: f, why: null } : { at: Number(f?.at) || 0, why: f?.why || null }; }
  catch { return { at: 0, why: null }; }
}
const noteFailure = (kv, handle, why = null) => kv.set(`${handle}/fill-failed-at`, JSON.stringify({ at: Date.now(), why })).catch(() => {});

/**
 * The copy for an account, made from the pod when there is none: one maker at
 * a time, and after a failed attempt not again for five minutes, so an app
 * checking in every minute does not read the pod every minute. `owner`: the
 * owner asking, from their own browser or by signing in at the app sign-in
 * page, which is not made to wait. After the gateway's own sign-in is refused,
 * no account is tried for fifteen minutes, the owner's included, unless the
 * credential has changed since. Returns { ok } or { ok: false, status, why }.
 */
export async function ensureCopy(ctx, handle, rec, log = console.log, { owner = false } = {}) {
  if (await copyMeta(ctx.copyKv, handle)) return { ok: true };
  // A person's copy is never read from the pod here: it starts empty, and the
  // owner's FediPod, or the app sign-in page, fills it (POST …/fill).
  if (isPersonal(rec)) return makeEmptyCopy(ctx, handle, rec, log);
  // The owner too: it is the gateway's credential that has to change.
  const refused = await loginRefused(ctx);
  if (refused) return { ok: false, status: 503, why: `this account could not be opened: ${refused.why}. Try again later` };
  const failed = await lastFailure(ctx.copyKv, handle);
  if (!owner && Date.now() - failed.at < FILL_RETRY_MS) {
    return { ok: false, status: 503,
      why: `this account could not be opened a moment ago${failed.why ? `: ${failed.why}` : ''}. Try again in a few minutes` };
  }
  const podFetch = await ctx.keeperFetch();
  if (!podFetch) return { ok: false, status: 501, why: 'this gateway cannot reach pods for accounts' };
  const unlock = await lockCopy(ctx.copyKv, handle);
  if (!unlock) return { ok: false, status: 503, why: 'the gateway is busy with this account; try again' };
  try {
    if (await copyMeta(ctx.copyKv, handle)) return { ok: true };
    // Marked failed before it starts and cleared when it is done, so an attempt
    // cut off part way (a request's time running out) counts as failed too.
    await noteFailure(ctx.copyKv, handle);
    const stateUrl = stateUrlOf(rec);
    const made = await fillCopy(ctx.copyKv, handle, { pod: new HttpStorage(stateUrl, podFetch), podFetch, stateUrl, webId: rec.webId, log })
      .catch((e) => ({ ok: false, why: e.message }));
    if (made.ok) { await ctx.copyKv.delete(`${handle}/fill-failed-at`).catch(() => {}); return { ok: true }; }
    await noteFailure(ctx.copyKv, handle, made.why);
    log(`copy @${handle}: not made: ${made.why}`);
    if (refusedSignIn(made.why)) {
      await ctx.copyKv.set(LOGIN_REFUSED, JSON.stringify({ at: Date.now(), mark: ctx.keeperMark || '', why: made.why })).catch(() => {});
    }
    return { ok: false, status: /active on another device/.test(made.why) ? 409 : 502, why: made.why };
  } finally { await unlock(); }
}

/** Whether an outside app is signed in to this account now. */
export async function appsSignedIn(ctx, handle) {
  if (!ctx.mastoKv?.list) return false;
  return (await ctx.mastoKv.list(`signedin/${handle}/`)).length > 0;
}

// A person's copy, made empty for its owner to fill. Full when an outside app
// is signed in.
async function makeEmptyCopy(ctx, handle, rec, log) {
  const unlock = await lockCopy(ctx.copyKv, handle);
  if (!unlock) return { ok: false, status: 503, why: 'the gateway is busy with this account; try again' };
  try {
    if (await copyMeta(ctx.copyKv, handle)) return { ok: true };
    const full = await appsSignedIn(ctx, handle);
    await ctx.copyKv.set(`${handle}/meta`, JSON.stringify({ v: COPY_VERSION, full, filledAt: null, webId: rec.webId,
      stateUrl: stateUrlOf(rec), podOnly: ['keys.json'] }));
    await ctx.copyKv.set(`_copies/${handle}`, String(Date.now()));
    log(`copy @${handle}: made empty, for FediPod to fill${full ? ' (an outside app is signed in)' : ''}`);
    return { ok: true };
  } finally { await unlock(); }
}

/** Set whether a person's copy is full, dropping what only a full copy holds. */
export async function setFull(ctx, handle, full, log = console.log) {
  const unlock = await lockCopy(ctx.copyKv, handle);
  if (!unlock) return false;
  try {
    const got = await ctx.copyKv.get(`${handle}/meta`);
    const meta = got ? JSON.parse(got.text) : null;
    if (!meta || meta.v !== COPY_VERSION) return false;
    if (!!meta.full === !!full) return true;
    await ctx.copyKv.set(`${handle}/meta`, JSON.stringify({ ...meta, full: !!full, ...(full ? {} : { filledFull: null }) }));
    if (!full) {
      // Everything in them is on the pod, or waiting in its inbox.
      const slim = inCopyFor({ full: false });
      let n = 0;
      for (const b of await ctx.copyKv.list(`${handle}/d/`)) {
        const name = b.key.slice(`${handle}/d/`.length);
        if (!slim(name) && name !== 'config-public.json') { await ctx.copyKv.delete(b.key); n++; }
      }
      log(`copy @${handle}: the last outside app has gone; ${n} document(s) deleted here`);
    }
    return true;
  } finally { await unlock(); }
}

/** Write the copy to the pod and give it up. Returns { ok } or { ok: false, why }. */
export async function leaveCopy(ctx, handle, rec, log = console.log) {
  const meta = await copyMeta(ctx.copyKv, handle);
  if (!meta) return { ok: true };
  // A person's copy has been on the pod all along (FediPod writes what it
  // changes there, and what the gateway changed is in the pod inbox).
  if (meta.v === COPY_VERSION) { await forgetCopy(ctx.copyKv, handle, { log }); return { ok: true }; }
  const podFetch = await ctx.keeperFetch();
  if (!podFetch) return { ok: false, why: 'this gateway cannot reach the pod now' };
  const release = await lockCopy(ctx.copyKv, handle);
  if (!release) return { ok: false, why: 'the gateway is busy with this account; try again' };
  try {
    const stateUrl = stateUrlOf(rec);
    return await dropCopy(ctx.copyKv, handle, { pod: new HttpStorage(stateUrl, podFetch), podFetch, stateUrl, log });
  } finally { await release(); }
}

const j = (status, obj) => ({ status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(obj) });

export async function routeStateApi(request, pathname, ctx, deps) {
  if (!pathname.startsWith('/api/state/')) return null;
  if (!keepsCopies(ctx)) return j(501, { error: 'this gateway keeps no copies of accounts' });

  if (pathname === '/api/state/open') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    const webid = await deps.verifyPodToken(request, pathname, ctx.verifier);
    if (!webid) return j(401, { error: 'a Solid-OIDC token proving the pod is required' });
    let body = {};
    try { body = JSON.parse((await request.clone().text()) || '{}'); } catch { return j(400, { error: 'bad JSON' }); }
    // The account: named, or the one browser account kept here for this WebID.
    let handle = String(body.handle || '').toLowerCase();
    // Read fresh: FediPod asks this the moment it has turned keeping on, and a
    // row read a minute earlier would still say the account is not kept.
    let rec = handle ? await (ctx.lookupFresh || ctx.lookup)(handle) : null;
    if (!handle) {
      const rows = Object.entries(await ctx.listDirectory?.() || {})
        .filter(([, r]) => r?.webId === webid && r.openedAt && r.keeper && !r.movedTo && !r.closedAt);
      if (rows.length > 1) return j(409, { error: 'more than one account here for this sign-in; name one', handles: rows.map(([h]) => h) });
      if (rows.length === 1) [[handle, rec]] = rows;
    }
    if (!rec) return j(404, { error: 'no account kept here for this sign-in' });
    if (rec.webId !== webid) return j(403, { error: "the token proves a different pod than this account's" });
    if (rec.movedTo || rec.closedAt) return j(410, { error: 'this address is not here any more' });
    if (!rec.keeper) return j(409, { error: 'the gateway does not keep this account running' });
    // Kept under a former identity: a copy that is still here is opened so its
    // owner can hand it over; none is made under the new identity until the
    // owner's rules name it.
    const before = keptBefore(ctx, rec);
    if (before && !await copyMeta(ctx.copyKv, handle)) return j(409, { error: 'kept under the gateway\'s former identity', moving: true });
    const made = before ? { ok: true } : await ensureCopy(ctx, handle, rec, console.log, { owner: true });
    if (!made.ok) return j(made.status, { error: made.why, busy: made.status === 409 });
    const origin = new URL(request.url).origin;
    const { token, expiresAt } = stateToken(ctx.stateSecret, { handle, webId: webid });
    const meta = await copyMeta(ctx.copyKv, handle);
    return j(200, { ok: true, handle, base: `${origin}/api/state/${encodeURIComponent(handle)}/`, token, expiresAt,
      podHome: rec.podHome, moving: before, v: meta?.v || 1, full: !!meta?.full, seq: await currentSeq(ctx.copyKv, handle),
      filledAt: meta?.filledAt || null, filledFull: meta?.filledFull || null });
  }

  const m = /^\/api\/state\/([^/]+)\/(.*)$/u.exec(pathname);
  if (!m) return j(404, { error: 'no such route' });
  let handle; let name;
  try { handle = decodeURIComponent(m[1]).toLowerCase(); name = decodeURIComponent(m[2] || ''); } catch { return j(400, { error: 'bad path' }); }
  // Plain names only: a name is part of a storage key, and a path in it would
  // reach outside the account (copy.mjs).
  if (!safeHandle(handle) || (name && !['leave', 'forget', 'lease.json', 'fill', 'applied', 'reset', 'meta', 'mail'].includes(name) && !safeName(name))) return j(400, { error: 'not a state document' });
  const bearer = /^Bearer (.+)$/u.exec(request.headers.get('authorization') || '')?.[1];
  const who = readStateToken(ctx.stateSecret, bearer);
  if (!who || who.handle !== handle) return j(401, { error: 'a token for this account is required' });
  // The token is the owner's who asked for it; an address given up and taken
  // by somebody else is not theirs any more.
  const owned = await ctx.lookup(handle);
  if (!owned || owned.webId !== who.webId) return j(401, { error: 'this token is not for this account' });
  if (!await copyMeta(ctx.copyKv, handle)) return j(404, { error: 'the gateway keeps no copy of this account now', gone: true });
  const kv = ctx.copyKv;
  const noStore = { 'cache-control': 'no-store', 'access-control-expose-headers': 'etag, x-fedipod-full' };

  // Where the copy stands: its version, whether it is full, and how many items
  // the gateway has handed the pod.
  if (name === 'meta') {
    const meta = await copyMeta(kv, handle);
    return j(200, { v: meta.v || 1, full: !!meta.full, seq: await currentSeq(kv, handle), filledAt: meta.filledAt || null, filledFull: meta.filledFull || null });
  }
  // The owner filling a person's copy: each document only where the copy has
  // none, so a fill never writes over what an app or FediPod wrote since.
  if (name === 'fill') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    const meta = await copyMeta(kv, handle);
    if (meta.v !== COPY_VERSION) return j(409, { error: 'this copy is not filled this way' });
    let body;
    try { body = JSON.parse(await request.text()); } catch { return j(400, { error: 'bad JSON' }); }
    const docs = body?.docs && typeof body.docs === 'object' ? body.docs : {};
    const wanted = inCopyFor(meta);
    let put = 0;
    for (const [n, text] of Object.entries(docs)) {
      if (!safeName(n) || podOnly(n) || typeof text !== 'string') continue;
      if (n !== 'config-public.json' && !wanted(n)) continue;
      // The public part of the settings is the owner's to keep current.
      const r = n === 'config-public.json' ? await kv.set(`${handle}/d/${n}`, text) : await kv.set(`${handle}/d/${n}`, text, { ifNew: true });
      if (r.ok) put++;
    }
    const got = await kv.get(`${handle}/meta`);
    const now = JSON.parse(got.text);
    await kv.set(`${handle}/meta`, JSON.stringify({ ...now, filledAt: now.filledAt || Date.now(), ...(body.full && now.full ? { filledFull: Date.now() } : {}) }));
    return j(200, { ok: true, put, full: !!now.full });
  }
  // Mail the owner's pod inbox held that FediPod has not read, handed over by
  // the app sign-in page (app-fill.mjs) so the app shows it: kept here as held
  // mail, which is read into the copy for the app (masto-gateway.mjs).
  if (name === 'mail') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    if (!ctx.holdMail) return j(501, { error: 'this gateway holds no mail' });
    let body;
    try { body = JSON.parse(await request.text()); } catch { return j(400, { error: 'bad JSON' }); }
    const items = Array.isArray(body?.items) ? body.items.slice(0, 2000) : [];
    let held = 0;
    for (const it of items) {
      const n = String(it?.name || '');
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(n) || typeof it.body !== 'string' || it.body.length > 512 * 1024) continue;
      await ctx.holdMail(handle, n, it.body, 'application/activity+json');
      if (it.receipt && typeof it.receipt === 'object') await ctx.holdMail(handle, `${n}.receipt.json`, JSON.stringify(it.receipt), 'application/json');
      held++;
    }
    return j(200, { ok: true, held });
  }
  // The owner's FediPod has applied the gateway's items up to `seq`.
  if (name === 'applied') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    let body;
    try { body = JSON.parse(await request.text()); } catch { return j(400, { error: 'bad JSON' }); }
    const seq = Number(body?.seq) || 0;
    const dropped = await appliedUpTo(ctx, handle, seq).catch(() => 0);
    return j(200, { ok: true, dropped });
  }
  // A copy from before version 2, which the owner's FediPod has just written
  // to the pod: started again as a person's copy is now. `etag` is the copy's
  // listing as FediPod copied it; changed since, nothing is done, so nothing
  // written here in between is lost.
  if (name === 'reset') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    let body;
    try { body = JSON.parse(await request.text()); } catch { return j(400, { error: 'bad JSON' }); }
    const unlock = await lockCopy(kv, handle);
    if (!unlock) return j(503, { error: 'the gateway is busy with this account; try again' });
    try {
      const meta = await copyMeta(kv, handle);
      if (meta.v === COPY_VERSION) return j(200, { ok: true, already: true });
      const listing = await new CopyStorage(kv, handle, { holder: null }).list('');
      if (!body?.etag || listing.etag !== body.etag) return j(409, { error: 'the copy changed since it was copied to the pod; copy it again' });
      const full = await appsSignedIn(ctx, handle);
      const keep = inCopyFor({ full });
      for (const b of await kv.list(`${handle}/d/`)) {
        const n = b.key.slice(`${handle}/d/`.length);
        if (!keep(n)) await kv.delete(b.key);
      }
      await kv.delete(`${handle}/flushed`).catch(() => {});
      await kv.set(`${handle}/meta`, JSON.stringify({ v: COPY_VERSION, full, filledAt: null, webId: owned.webId,
        stateUrl: stateUrlOf(owned), podOnly: ['keys.json'] }));
      console.log(`copy @${handle}: started again as version ${COPY_VERSION}`);
      return j(200, { ok: true, full });
    } finally { await unlock(); }
  }
  if (name === 'leave') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    const left = await leaveCopy(ctx, handle, owned).catch((e) => ({ ok: false, why: e.message }));
    return left.ok ? j(200, { ok: true }) : j(502, { error: `the copy could not be written to the pod: ${left.why}` });
  }
  // The owner's browser has written the copy to the pod itself (a copy kept
  // under the gateway's former identity, which cannot write it back now).
  // Only the lease's holder may say so, and only for such a copy.
  if (name === 'forget') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    if (!keptBefore(ctx, owned)) return j(409, { error: 'this copy is written back by the gateway; ask to leave instead' });
    const holder = request.headers.get('x-fedipod-holder') || '';
    if (!holder || !await holds(kv, handle, holder)) return j(409, { error: 'only the agent holding this account may say so' });
    await forgetCopy(kv, handle, { log: console.log });
    return j(200, { ok: true });
  }
  if (name === 'lease.json') {
    if (request.method !== 'GET' && request.method !== 'PUT') return j(405, { error: 'GET or PUT' });
    const res = await kvDocFetch(kv, `${handle}/lease`)(null, {
      method: request.method,
      headers: { 'if-match': request.headers.get('if-match') || undefined },
      body: request.method === 'PUT' ? await request.text() : undefined,
    });
    return { status: res.status, headers: { ...noStore, ...(res.headers.get('etag') ? { etag: res.headers.get('etag') } : {}),
      ...(res.status === 200 ? { 'content-type': 'application/json' } : {}) }, body: res.status === 200 ? await res.text() : null };
  }
  if (name && podOnly(name)) return j(403, { error: 'this document is kept on the pod only' });

  const holder = request.headers.get('x-fedipod-holder') || null;
  const copy = new CopyStorage(kv, handle, { holder });
  // Whether the copy is full, on every answer, so the owner's FediPod knows at
  // once when an app signs in or the last one signs out.
  const shape = await copyMeta(kv, handle);
  noStore['x-fedipod-full'] = shape?.full ? '1' : '0';
  const ifNone = request.headers.get('if-none-match') || null;
  if (!name) {
    if (request.method !== 'GET') return j(405, { error: 'GET' });
    const l = await copy.list('', { etag: ifNone });
    if (l.notModified) return { status: 304, headers: { ...noStore, etag: l.etag }, body: null };
    return { status: 200, headers: { ...noStore, 'content-type': 'application/json', etag: l.etag }, body: JSON.stringify({ names: l.names }) };
  }
  if (request.method === 'GET') {
    const r = await copy.read(name, { etag: ifNone });
    if (r.notModified) return { status: 304, headers: { ...noStore, etag: r.etag }, body: null };
    if (!r.ok) return j(404, { error: 'no such document' });
    return { status: 200, headers: { ...noStore, 'content-type': 'application/json', etag: r.etag }, body: r.body };
  }
  if (request.method === 'PUT') {
    if (!holder) return j(400, { error: 'x-fedipod-holder is required' });
    const w = await copy.write(name, await request.text());
    if (w.lost) return j(409, { error: w.why });
    if (!w.ok) return j(503, { error: w.why });
    return { status: 204, headers: { ...noStore, etag: w.etag }, body: null };
  }
  if (request.method === 'DELETE') {
    if (!holder) return j(400, { error: 'x-fedipod-holder is required' });
    return (await copy.remove(name)) ? { status: 204, headers: noStore, body: null } : j(409, { error: 'another agent holds this account now' });
  }
  return j(405, { error: 'GET, PUT or DELETE' });
}
