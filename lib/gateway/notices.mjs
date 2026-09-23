// notices.mjs — notices from whoever runs the front, to every account here.
//
// The operator writes them on the /notices page, proved as the admin the way
// the roster is; every page of ours asks GET /api/notices once per load and
// shows a bell when there are any. A notice is a title, a plain-text body and
// a time. The body is never markup: the pages render it as text.
//
// Kept beside the directory, in a store the adapter supplies:
//   listNotices() -> { id: notice }     putNotice(id, notice)     deleteNotice(id)
// A front that supplies none has no notices to offer, and says so.

import crypto from 'node:crypto';

const TITLE_MAX = 120;
const BODY_MAX = 4000;
const NOTICES_EDGE_SECONDS = 60;

const clean = (v, max) => String(v ?? '').replace(/\r\n?/gu, '\n').trim().slice(0, max);
const newest = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));

export async function listNotices(ctx) {
  const all = ctx.listNotices ? await ctx.listNotices() : {};
  return Object.values(all || {}).filter(Boolean).sort(newest);
}

// GET is public: what every account is shown. POST is the admin's alone. The
// /notices page is where the admin writes them; it signs in like the roster.
// Returns a response, or null when the path is neither.
export async function routeNoticesApi(request, pathname, ctx, { j, verifyPodToken, publicFor, notFound }) {
  // The two admin pages: the roster (who has accounts here) and the notices.
  // Each signs in and calls its API; a deploy with no admin supplies no page.
  const page = pathname === '/notices' ? ctx.noticesPage : pathname === '/roster' ? ctx.adminPage : undefined;
  if (page !== undefined) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: {}, body: '' };
    if (!page) return notFound();
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page };
  }
  if (pathname !== '/api/notices') return null;
  const open = { 'access-control-allow-origin': '*' };
  if (request.method === 'OPTIONS') {
    return { status: 204, headers: { ...open, 'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Accept', allow: 'GET, POST, OPTIONS' }, body: null };
  }
  if (request.method === 'GET') {
    if (!ctx.listNotices) return j(501, { error: 'this front keeps no notices' });
    const out = j(200, { notices: await listNotices(ctx) });
    Object.assign(out.headers, open, publicFor(NOTICES_EDGE_SECONDS));
    return out;
  }
  if (request.method !== 'POST') return { status: 405, headers: {}, body: '' };
  if (!ctx.putNotice || !ctx.deleteNotice || !ctx.adminWebId) return j(501, { error: 'this front keeps no notices' });
  const webid = await verifyPodToken(request, pathname, ctx.verifier);
  if (!webid) return j(401, { error: 'a Solid-OIDC token is required' });
  if (webid !== ctx.adminWebId) return j(403, { error: 'that WebID is not the admin of this front' });
  let body;
  try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
  const action = String(body.action || '');
  const all = (ctx.listNotices ? await ctx.listNotices() : {}) || {};
  if (action === 'delete') {
    const id = String(body.id || '');
    if (!all[id]) return j(404, { error: 'no such notice' });
    await ctx.deleteNotice(id);
    console.log(`front: notice ${id} deleted by the admin`);
    return j(200, { ok: true, id, deleted: true });
  }
  if (action !== 'create' && action !== 'update') return j(400, { error: 'action must be create, update or delete' });
  const title = clean(body.title, TITLE_MAX);
  const text = clean(body.body, BODY_MAX);
  if (!title) return j(400, { error: 'a title is required' });
  if (!text) return j(400, { error: 'a body is required' });
  const now = new Date().toISOString();
  let notice;
  if (action === 'create') {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    notice = { id, title, body: text, at: now, updatedAt: now };
  } else {
    const prior = all[String(body.id || '')];
    if (!prior) return j(404, { error: 'no such notice' });
    notice = { ...prior, title, body: text, updatedAt: now };
  }
  await ctx.putNotice(notice.id, notice);
  console.log(`front: notice ${notice.id} ${action}d by the admin`);
  return j(action === 'create' ? 201 : 200, { ok: true, notice });
}
