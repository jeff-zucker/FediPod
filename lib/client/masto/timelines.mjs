// timelines.mjs — what a client reads by the page: the home and public
// timelines, hashtags and the tag feed, lists and their timelines, the v2
// filters, conversations, notifications, and search.

import crypto from 'node:crypto';
import * as social from '../../core/social.mjs';
import { sanitizeHtml } from '../../core/wire.mjs';
import { authorOf } from '../../core/intake/index.mjs';
import { readBody } from './body.mjs';

export async function handle(api, ctx) {
  const { req, res, pathname, url, send } = ctx;   // eslint-disable-line no-unused-vars

  // home + public = everything known (follows, boosts, tag feed, own);
  // public?local=true = own posts; trends/statuses = the same activity (a
  // single-actor instance has no firehose — what it knows IS its public
  // face). Sorted by publish time so tag-feed backfill interleaves.
  if (pathname === '/api/v1/timelines/home' || pathname === '/api/v1/timelines/public'
    || pathname === '/api/v1/trends/statuses') {
    const localOnly = pathname === '/api/v1/timelines/public' && url.searchParams.get('local') === 'true';
    // The UNFILTERED list, both as the source and as the reply-count corpus:
    // a reply can be a mention, and mentions are filtered out of timelines
    // below — counting against the filtered set would undercount them.
    const all = api.store.getStatuses();
    const muted = new Set(api.store.getMuted().actors);
    let items = all
      // search ingests and strangers' mentions stay out of the timelines
      // (mentions remain in notifications and /api/v1/statuses); direct
      // posts belong to the conversations view, not a timeline; and the
      // local/public view shows only what is actually public-facing.
      .filter(s => s.kind !== 'remote' && s.kind !== 'mention')
      .filter(s => !s.direct && s.visibility !== 'direct')
      .filter(s => !muted.has(s.actor) && !muted.has(s.via))
      .filter(s => !localOnly || (s.kind === 'post' && s.visibility !== 'private'))
      .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    const { items: page, headers } = api.page(items, url);
    return send(200, page.map(s => api.statusOrBoost(s, { all })), headers);
  }

  // --- hashtags: the client's Followed Hashtags surface drives the tag feed ---
  // followed_tags is what the feed currently pulls; follow/unfollow add and
  // remove a hashtag (unfollow the last and the topical feed goes quiet); the
  // tag timeline is the mirrored notes carrying that tag.
  if (pathname === '/api/v1/followed_tags') {
    const tags = api.agent.tagfeed?.config().tags || [];
    return send(200, tags.map(t => api.tagObject(t, true, req)));
  }
  const mTagFollow = pathname.match(/^\/api\/v1\/tags\/([^/]+)\/(follow|unfollow)$/);
  if (mTagFollow && req.method === 'POST') {
    const name = decodeURIComponent(mTagFollow[1]).replace(/^#/, '').toLowerCase();
    const follow = mTagFollow[2] === 'follow';
    const tf = api.agent.tagfeed;
    if (tf) {
      const cur = tf.config().tags;
      tf.setConfig({ tags: follow ? [...new Set([...cur, name])] : cur.filter(t => t !== name) });
    }
    return send(200, api.tagObject(name, follow, req));
  }
  const mTagGet = pathname.match(/^\/api\/v1\/tags\/([^/]+)$/);
  if (mTagGet && req.method === 'GET') {
    const name = decodeURIComponent(mTagGet[1]).replace(/^#/, '').toLowerCase();
    const following = (api.agent.tagfeed?.config().tags || []).includes(name);
    return send(200, api.tagObject(name, following, req));
  }
  const mTagTl = pathname.match(/^\/api\/v1\/timelines\/tag\/([^/]+)$/);
  if (mTagTl && req.method === 'GET') {
    const name = decodeURIComponent(mTagTl[1]).replace(/^#/, '').toLowerCase();
    const all = api.store.getStatuses();
    const items = all.filter(s => s.kind === 'tag' && s.tag === name)
      .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    const { items: page, headers } = api.page(items, url);
    return send(200, page.map(s => api.statusOrBoost(s, { all })), headers);
  }

  // Lists, filters and scheduled posts are the client's own arrangements —
  // kept in local state, nothing federates.
  const listJson = (l) => ({ id: l.id, title: l.title, replies_policy: l.repliesPolicy || 'list', exclusive: false });
  if (pathname === '/api/v1/lists' && req.method === 'GET') {
    return send(200, api.store.getLists().map(listJson));
  }
  if (pathname === '/api/v1/lists' && req.method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    if (!title) return send(422, { error: 'a title is required' });
    const lists = api.store.getLists();
    const l = { id: crypto.randomBytes(8).toString('hex'), title, repliesPolicy: body.replies_policy || 'list', members: [] };
    lists.push(l);
    api.store.setLists(lists);
    return send(200, listJson(l));
  }
  const mList = /^\/api\/v1\/lists\/([a-f0-9]+)$/.exec(pathname);
  if (mList) {
    const lists = api.store.getLists();
    const l = lists.find(x => x.id === mList[1]);
    if (!l) return send(404, { error: 'Record not found' });
    if (req.method === 'DELETE') {
      api.store.setLists(lists.filter(x => x.id !== mList[1]));
      return send(200, {});
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.title) l.title = String(body.title);
      if (body.replies_policy) l.repliesPolicy = body.replies_policy;
      api.store.setLists(lists);
    }
    return send(200, listJson(l));
  }
  const mListAcc = /^\/api\/v1\/lists\/([a-f0-9]+)\/accounts$/.exec(pathname);
  if (mListAcc) {
    const lists = api.store.getLists();
    const l = lists.find(x => x.id === mListAcc[1]);
    if (!l) return send(404, { error: 'Record not found' });
    if (req.method === 'GET') return send(200, (l.members || []).map(a => api.account(a)));
    const body = await readBody(req).catch(() => ({}));
    const ids = [].concat(body.account_ids || body['account_ids[]'] || url.searchParams.getAll('account_ids[]')).filter(Boolean);
    const actors = ids.map(id => api.store.urlFor(id)).filter(Boolean);
    if (req.method === 'POST') l.members = [...new Set([...(l.members || []), ...actors])];
    if (req.method === 'DELETE') l.members = (l.members || []).filter(a => !actors.includes(a));
    api.store.setLists(lists);
    return send(200, {});
  }
  const mListTl = /^\/api\/v1\/timelines\/list\/([a-f0-9]+)$/.exec(pathname);
  if (mListTl) {
    const l = api.store.getLists().find(x => x.id === mListTl[1]);
    if (!l) return send(404, { error: 'Record not found' });
    const members = new Set(l.members || []);
    const all = api.store.getStatuses();
    const items = all.filter(s => members.has(s.actor) || members.has(s.via))
      .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    const { items: page, headers } = api.page(items, url);
    return send(200, page.map(s => api.statusOrBoost(s, { all })), headers);
  }

  // v2 filters: stored, served, and APPLIED — every status carries what it
  // matched in `filtered` (see filtersFor), because no client matches
  // keywords for itself.
  const filterJson = (f) => ({
    id: f.id, title: f.title, context: f.context || ['home'],
    expires_at: f.expiresAt || null, filter_action: f.action || 'warn',
    keywords: (f.keywords || []).map((k, i) => ({ id: `${f.id}-${i}`, keyword: k.keyword, whole_word: !!k.wholeWord })),
    statuses: [],
  });
  const keywordsOf = (attrs) => [].concat(attrs || [])
    .filter(k => k?.keyword && !(k._destroy === true || k._destroy === 'true'))
    .map(k => ({ keyword: String(k.keyword), wholeWord: k.whole_word === true || k.whole_word === 'true' }));
  if (pathname === '/api/v2/filters' && req.method === 'GET') {
    return send(200, api.store.getFilters().map(filterJson));
  }
  if (pathname === '/api/v2/filters' && req.method === 'POST') {
    const body = await readBody(req);
    const title = String(body.title || '').trim();
    if (!title) return send(422, { error: 'a title is required' });
    const filters = api.store.getFilters();
    const f = {
      id: crypto.randomBytes(8).toString('hex'), title,
      context: [].concat(body.context || ['home']),
      action: body.filter_action || 'warn', expiresAt: null,
      keywords: keywordsOf(body.keywords_attributes),
    };
    filters.push(f);
    api.store.setFilters(filters);
    return send(200, filterJson(f));
  }
  const mFilter = /^\/api\/v2\/filters\/([a-f0-9]+)$/.exec(pathname);
  if (mFilter) {
    const filters = api.store.getFilters();
    const f = filters.find(x => x.id === mFilter[1]);
    if (!f) return send(404, { error: 'Record not found' });
    if (req.method === 'DELETE') {
      api.store.setFilters(filters.filter(x => x.id !== mFilter[1]));
      return send(200, {});
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.title) f.title = String(body.title);
      if (body.context) f.context = [].concat(body.context);
      if (body.filter_action) f.action = body.filter_action;
      if (body.keywords_attributes) f.keywords = keywordsOf(body.keywords_attributes);
      api.store.setFilters(filters);
    }
    return send(200, filterJson(f));
  }

  // Conversations: direct posts, grouped by who is in them.
  if (pathname === '/api/v1/conversations' && req.method === 'GET') {
    const all = api.store.getStatuses();
    const me = api.urls.actor;
    const convos = new Map();
    for (const s of all) {
      if (!(s.direct || s.visibility === 'direct')) continue;
      const others = [...new Set([
        ...(s.actor !== me ? [s.actor] : []),
        ...((s.mentions || []).map(m => m.href).filter(a => a && a !== me)),
      ])];
      const key = others.sort().join(' ') || me;
      const c = convos.get(key) || { accounts: new Set(), last: s };
      for (const o of others) c.accounts.add(o);
      if (String(s.published || '') > String(c.last.published || '')) c.last = s;
      convos.set(key, c);
    }
    const items = [...convos.entries()]
      .sort((a, b) => String(b[1].last.published || '').localeCompare(String(a[1].last.published || '')));
    return send(200, items.map(([key, c]) => ({
      id: api.store.idFor('conversation:' + key),
      unread: false,
      accounts: [...(c.accounts.size ? c.accounts : [me])].map(a => api.account(a)),
      last_status: api.status(c.last, { all }),
    })));
  }

  if (pathname === '/api/v1/notifications') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 60);
    const q = url.searchParams;
    // Newest first, which is what every id rule below assumes.
    let items = api.store.getNotifications();

    // Which KINDS. A client that asks for mentions and is handed favourites
    // and boosts renders them as mentions — Phanpy's Mentions column did
    // exactly that, and re-pilled on every poll. Both spellings: clients send
    // `types[]=mention` and some send bare `types=mention`.
    const listParam = (name) => {
      const all = [...q.getAll(`${name}[]`), ...q.getAll(name)]
        .flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
      return all.length ? new Set(all) : null;
    };
    const want = listParam('types');
    const skip = listParam('exclude_types');
    // Mastodon spells the type with an underscore; ours is stored with a
    // hyphen, and notification() translates on the way out — so match on what
    // the client would have been given, not on what is on disk.
    const shown = (n) => api.notificationType(n.type);
    if (want) items = items.filter((n) => want.has(shown(n)));
    if (skip) items = items.filter((n) => !skip.has(shown(n)));

    // Which SLICE. `max_id` walks backwards into history; `since_id` and
    // `min_id` both mean "newer than this", which is how a client asks
    // "anything since I last looked?". Ignoring them meant every poll
    // returned the whole list, so the client always saw unread items and the
    // bell never went out.
    const cut = (id, keepNewer) => {
      const i = items.findIndex((n) => n.id === id);
      if (i < 0) return;
      items = keepNewer ? items.slice(0, i) : items.slice(i + 1);
    };
    const maxId = q.get('max_id');
    if (maxId) cut(maxId, false);
    const sinceId = q.get('since_id') || q.get('min_id');
    if (sinceId) cut(sinceId, true);
    // min_id asks for the ones IMMEDIATELY newer, i.e. the oldest end of
    // what is newer; since_id asks for the newest. Only the window differs.
    const page = q.get('min_id') && !q.get('since_id')
      ? items.slice(Math.max(0, items.length - limit))
      : items.slice(0, limit);

    // A client pages by following these rather than by guessing ids.
    if (page.length) {
      const base = `${api.scheme || (req.socket?.encrypted ? 'https' : 'http')}://${req.headers.host}${pathname}`;
      const link = (params) => {
        const u = new URL(base);
        for (const [k, v] of q) if (k !== 'max_id' && k !== 'since_id' && k !== 'min_id') u.searchParams.append(k, v);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        return u.href;
      };
      return send(200, page.map((n) => api.notification(n)), {
        link: `<${link({ max_id: page[page.length - 1].id })}>; rel="next", `
          + `<${link({ min_id: page[0].id })}>; rel="prev"`,
      });
    }
    return send(200, []);
  }

  // Search: @user@host → webfinger resolve; URL → actor or note ingest;
  // plain text → local mirror + actor-cache scan.
  if (pathname === '/api/v2/search' || pathname === '/api/v1/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    const type = url.searchParams.get('type');
    const out = { accounts: [], statuses: [], hashtags: [] };
    const asHandle = /^@?[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(q);
    if (asHandle && type !== 'statuses') {
      try {
        const doc = await social.resolveHandle(api.agent, q);
        out.accounts.push(api.account(doc.id));
      } catch (e) { api.log(`search resolve ${q}: ${e.message}`); }
    } else if (/^https?:\/\//.test(q)) {
      const doc = await api.agent.intake.fetchAP(q).catch(() => null);
      if (doc?.type === 'Person' && doc.id) out.accounts.push(api.account(doc.id));
      else if (doc?.type === 'Note' && doc.id) {
        let s = api.store.getStatuses().find(x => x.noteId === doc.id);
        // Third site of the same rule: the note's own origin has to vouch for
        // the author before we store one. The owner chose the URL, but the
        // document at it still names whoever it likes.
        const author = authorOf(doc);
        if (!s && author) {
          s = {
            noteId: doc.id, actor: author, content: sanitizeHtml(doc.content),
            published: doc.published, inReplyTo: doc.inReplyTo, kind: 'remote',
          };
          api.store.addStatus(s);
        }
        if (s) out.statuses.push(api.status(s));
      }
    } else if (q) {
      const needle = q.toLowerCase();
      if (type !== 'accounts') {
        const all = api.store.getStatuses();
        out.statuses = all
          .filter(s => (s.content || '').toLowerCase().includes(needle)).slice(0, 20)
          .map(s => api.status(s, { all }));
      }
      if (type !== 'statuses') out.accounts = await api.accountSearch(q);
    }
    return send(200, out);
  }

  return false;
}
