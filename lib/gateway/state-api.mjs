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
import { CopyStorage, copyMeta, fillCopy, dropCopy, lockCopy, kvDocFetch, podOnly } from './copy.mjs';

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

/**
 * The copy for an account, made from the pod when there is none. Returns
 * { ok } or { ok: false, status, why }.
 */
export async function ensureCopy(ctx, handle, rec, log = console.log) {
  if (await copyMeta(ctx.copyKv, handle)) return { ok: true };
  const podFetch = await ctx.keeperFetch();
  if (!podFetch) return { ok: false, status: 501, why: 'this gateway cannot reach pods for accounts' };
  const stateUrl = stateUrlOf(rec);
  const made = await fillCopy(ctx.copyKv, handle, { pod: new HttpStorage(stateUrl, podFetch), podFetch, stateUrl, webId: rec.webId, log })
    .catch((e) => ({ ok: false, why: e.message }));
  if (made.ok) return { ok: true };
  return { ok: false, status: /active on another device/.test(made.why) ? 409 : 502, why: made.why };
}

/** Write the copy to the pod and give it up. Returns { ok } or { ok: false, why }. */
export async function leaveCopy(ctx, handle, rec, log = console.log) {
  if (!await copyMeta(ctx.copyKv, handle)) return { ok: true };
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
    let rec = handle ? await ctx.lookup(handle) : null;
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
    const made = await ensureCopy(ctx, handle, rec);
    if (!made.ok) return j(made.status, { error: made.why, busy: made.status === 409 });
    const origin = new URL(request.url).origin;
    const { token, expiresAt } = stateToken(ctx.stateSecret, { handle, webId: webid });
    return j(200, { ok: true, handle, base: `${origin}/api/state/${encodeURIComponent(handle)}/`, token, expiresAt,
      podHome: rec.podHome });
  }

  const m = /^\/api\/state\/([^/]+)\/(.*)$/u.exec(pathname);
  if (!m) return j(404, { error: 'no such route' });
  const handle = decodeURIComponent(m[1]).toLowerCase();
  const name = decodeURIComponent(m[2] || '');
  const bearer = /^Bearer (.+)$/u.exec(request.headers.get('authorization') || '')?.[1];
  const who = readStateToken(ctx.stateSecret, bearer);
  if (!who || who.handle !== handle) return j(401, { error: 'a token for this account is required' });
  if (!await copyMeta(ctx.copyKv, handle)) return j(404, { error: 'the gateway keeps no copy of this account now', gone: true });
  const kv = ctx.copyKv;
  const noStore = { 'cache-control': 'no-store' };

  if (name === 'leave') {
    if (request.method !== 'POST') return j(405, { error: 'POST' });
    const rec = await ctx.lookup(handle);
    if (!rec) return j(404, { error: 'no such account' });
    const left = await leaveCopy(ctx, handle, rec).catch((e) => ({ ok: false, why: e.message }));
    return left.ok ? j(200, { ok: true }) : j(502, { error: `the copy could not be written to the pod: ${left.why}` });
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
