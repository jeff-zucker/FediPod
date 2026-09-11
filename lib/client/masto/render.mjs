// render.mjs — Mastodon's JSON shapes out of the agent's records: accounts,
// statuses and the carry that wraps one, notifications, polls, media,
// relationships, filters, and the cursor paging with its Link header. Also
// the three actions that answer as a connected account rather than the pod
// actor (a Bluesky reply, a connected-account reply, a like or boost there).

import * as social from '../../core/social.mjs';
import { sanitizeHtml, followsNeedApproval, publicHandle } from '../../core/wire.mjs';
import { profileUrl, postUrl } from '../../connections/bskyfeed.mjs';
import { htmlToText } from './body.mjs';

// 1x1 transparent PNG — placeholder avatar/header for accounts without icons.
export const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const selfIcon = (api, self, cached) =>
  (self ? api.store.getConfig()?.icon : null) || cached.icon;

export function selfAccount(api) {
  // No fallback handle. `account()` already reads config for self, so a
  // literal here only ever supplies a name that is not this actor's — and it
  // was a real person's, so every install with no handle called itself jeff.
  return api.account(api.urls.actor, { selfAcct: publicHandle(api.store.getConfig()) });
}

export function account(api, actorUrl, { selfAcct } = {}) {
  const cached = api.store.getActors()[actorUrl] || {};
  let host = '', user = cached.preferredUsername || '';
  try { host = new URL(actorUrl).host; if (!user) user = new URL(actorUrl).pathname.split('/').pop(); } catch {}
  const self = actorUrl === api.urls?.actor;
  if (self) user = selfAcct || publicHandle(api.store.getConfig()) || user;
  return {
    id: api.store.idFor(actorUrl),
    username: user,
    // Self gets the FULL acct (Mastodon proper returns the bare local part
    // here): the client's login domain is the loopback agent, so the bare
    // form would display as user@127.0.0.1 — the full form shows the real
    // fediverse identity, and every client renders @-containing accts as-is.
    acct: `${self ? (selfAcct || user) : user}@${host}`,
    // Our own profile is not in the actor cache — the cache is for other
    // people — so read it from config, or the editor opens empty and saving
    // wipes what was there.
    display_name: (self ? api.store.getConfig()?.name : cached.name) || cached.name || user,
    locked: self ? followsNeedApproval(api.store.getConfig() || {}) : false,
    // Read from config for self, like the fields above it: our own actor is
    // not in the actor cache — the cache is for other people — so a group
    // asking about itself would be told it was a person.
    bot: false, discoverable: true,
    group: self ? api.store.getConfig()?.kind === 'group' : cached.type === 'Group',
    created_at: '2026-01-01T00:00:00.000Z',
    note: (self ? api.store.getConfig()?.summary : cached.summary) || '',
    url: actorUrl, uri: actorUrl,
    avatar: selfIcon(api, self, cached) || TRANSPARENT_PNG,
    avatar_static: selfIcon(api, self, cached) || TRANSPARENT_PNG,
    header: (self ? api.store.getConfig()?.image : null) || TRANSPARENT_PNG,
    header_static: (self ? api.store.getConfig()?.image : null) || TRANSPARENT_PNG,
    // A remote actor's counts are whatever its own collections said when we
    // last asked; unknown stays 0 because the API has no way to say "unknown".
    followers_count: self ? api.store.getContacts().followers.length : (cached.counts?.followers ?? 0),
    // Accepted only, matching both the published `following` collection and
    // the list this number opens — a pending Follow is not yet a following.
    following_count: self ? api.store.getContacts().following.filter(f => f.accepted).length : (cached.counts?.following ?? 0),
    statuses_count: self ? api.store.getStatuses().filter(s => s.kind === 'post').length : 0,
    last_status_at: null, emojis: [],
    fields: (self ? api.store.getConfig()?.fields : cached.fields) || [],
  };
}

// `all` is not an optimisation, it is the difference between one clone and
// one per status: store.getStatuses() structuredClones the entire array, so
// rendering a 40-status timeline without it cloned a 1000-entry array 40
// times purely to count replies. Every caller that renders more than one
// status passes it; this fallback is for the single-status paths.
// Mastodon's cursor paging, over an array already in newest-first order.
// Clients do not read a `next` out of the body — they follow the Link header,
// which nothing here emitted, so a client could only ever see the first page.
// `idOf` is what a cursor names. Statuses are cursored by note, account lists
// by actor, so the caller says which field carries the id.
export function page(api, items, url, { limit = 20, max = 40, idOf = (s) => api.store.idFor(s.noteId) } = {}) {
  const n = Math.min(Number(url.searchParams.get('limit')) || limit, max);
  // The cursor scan is linear over every status, and `idOf` defaults to
  // store.idFor, which structuredClones the whole uncapped ids.json on every
  // call. Scrolling a 5000-status timeline was therefore millions of object
  // copies of synchronous, event-loop-blocking work to serve one page of 20,
  // and it ran again for since_id and min_id. The id is a pure function of
  // the URL, so remembering it per item within one call is free and exact.
  const ids = new Map();
  const idAt = (s) => {
    if (!ids.has(s)) ids.set(s, idOf(s));
    return ids.get(s);
  };
  const cut = (param) => {
    const v = url.searchParams.get(param);
    if (!v) return null;
    const i = items.findIndex(s => idAt(s) === v);
    return i < 0 ? null : i;
  };
  const maxAt = cut('max_id');
  if (maxAt != null) items = items.slice(maxAt + 1);          // older than this one
  for (const p of ['since_id', 'min_id']) {
    const at = cut(p);
    if (at != null) items = items.slice(0, at);               // newer than this one
  }
  const pageItems = items.slice(0, n);
  if (!pageItems.length) return { items: pageItems, headers: {} };
  const base = `http://${api.host}${url.pathname}`;
  const q = (extra) => {
    const u = new URL(base);
    for (const [k, v] of url.searchParams) if (!['max_id', 'since_id', 'min_id'].includes(k)) u.searchParams.set(k, v);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.href;
  };
  const links = [`<${q({ max_id: idOf(pageItems[pageItems.length - 1]) })}>; rel="next"`];
  if (pageItems.length) links.push(`<${q({ min_id: idOf(pageItems[0]) })}>; rel="prev"`);
  return { items: pageItems, headers: { link: links.join(', ') } };
}

// A reply to a mirrored Bluesky post: a native reply from the connected
// account, threaded under the original. It exists only on Bluesky, so the
// row added here is its one local copy.
export async function bskyReply(api, send, body, parent, visibility) {
  const at = api.agent.atproto;
  if (!at?.connected()) return send(422, { error: 'this is a Bluesky post — no Bluesky account is connected to reply from' });
  if (visibility !== 'public' && visibility !== 'unlisted') {
    return send(422, { error: 'a Bluesky reply is public — pick public visibility' });
  }
  if (body.scheduled_at) return send(422, { error: 'a Bluesky reply cannot be scheduled' });
  if ([].concat(body.media_ids || body['media_ids[]'] || []).filter(Boolean).length) {
    return send(422, { error: 'images on a Bluesky reply are not supported' });
  }
  try {
    const out = await at.reply(body.status, parent.noteId);
    const rec = at.read();
    const actor = profileUrl(rec.did);
    if (!api.store.getActors()[actor]) {
      api.store.cacheActor(actor, { name: rec.handle, preferredUsername: rec.handle, type: 'Person' });
    }
    const text = String(body.status).trim();
    api.store.addStatus({
      noteId: out.uri, actor, inReplyTo: parent.noteId,
      content: `<p>${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`,
      published: new Date().toISOString(), kind: 'bsky',
      ...(out.cid ? { cid: out.cid } : {}), link: postUrl(out.uri),
    });
    return send(200, api.status(api.store.getStatuses().find(x => x.noteId === out.uri)));
  } catch (e) { return send(422, { error: e.message }); }
}

// Which account acts: the one that saw the post, and the first of them when
// several did. Undo inverts that — a like fans IN to one account, an unlike
// fans OUT to every account holding one, because a stray like left behind
// after the owner asked for it to go is the worse failure.
export async function acctAction(api, send, s, verb) {
  const accounts = api.agent.fediaccts;
  const held = s.sourceAccts || [];
  if (!accounts || !held.length) {
    return send(422, { error: 'this post came from a connected account, and none is connected now' });
  }
  const flag = verb.endsWith('favourite') ? 'favourited' : 'reblogged';
  const undo = verb.startsWith('un');
  const targets = (undo ? held.filter(v => v[flag]) : [held[0]]).filter(v => v?.remoteId);
  if (!targets.length) return send(200, api.status(s));
  try {
    const acted = new Set();
    for (const v of targets) {
      await accounts.api(v.acct,
        `/api/v1/statuses/${encodeURIComponent(v.remoteId)}/${verb}`, { method: 'POST' });
      acted.add(v.acct);
    }
    const next = held.map(v => (acted.has(v.acct) ? { ...v, [flag]: !undo } : v));
    return send(200, api.status(api.store.updateStatus(s.noteId, { sourceAccts: next }) || s));
  } catch (e) { return send(e.status === 401 ? 401 : 422, { error: e.message }); }
}

// The reply exists only on that account's server, so the row added here is
// its one local copy — the same shape bskyReply uses for the same reason.
export async function acctReply(api, send, body, parent, visibility) {
  const accounts = api.agent.fediaccts;
  const held = (parent.sourceAccts || [])[0];
  if (!accounts || !held?.remoteId) {
    return send(422, { error: 'this post came from a connected account, and none is connected now' });
  }
  if (visibility !== 'public' && visibility !== 'unlisted') {
    return send(422, { error: 'a reply from a connected account is public — pick public or unlisted' });
  }
  if (body.scheduled_at) return send(422, { error: 'a reply from a connected account cannot be scheduled' });
  if ([].concat(body.media_ids || body['media_ids[]'] || []).filter(Boolean).length) {
    return send(422, { error: 'images on a reply from a connected account are not supported' });
  }
  try {
    const out = await accounts.apiJson(held.acct, '/api/v1/statuses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: body.status, in_reply_to_id: held.remoteId, visibility,
        ...(body.spoiler_text ? { spoiler_text: String(body.spoiler_text) } : {}),
      }),
    });
    if (!out?.uri) return send(502, { error: 'that server accepted the reply but did not say where it is' });
    const rec = accounts.read(held.acct);
    const actor = out.account?.uri || out.account?.url || rec?.actorUrl;
    if (actor && !api.store.getActors()[actor]) {
      api.store.cacheActor(actor, {
        name: out.account?.display_name || rec?.name,
        preferredUsername: out.account?.username || rec?.acct, type: 'Person',
      });
    }
    api.store.addStatus({
      noteId: out.uri, actor, inReplyTo: parent.noteId,
      content: sanitizeHtml(out.content || ''),
      published: out.created_at || new Date().toISOString(), kind: 'acct',
      sourceAccts: [{ acct: held.acct, remoteId: String(out.id) }],
      ...(out.url && out.url !== out.uri ? { link: out.url } : {}),
    });
    return send(200, api.status(api.store.getStatuses().find(x => x.noteId === out.uri)));
  } catch (e) { return send(422, { error: e.message }); }
}

export function status(api, s, { all } = {}) {
  const replies = (all || api.store.getStatuses()).filter(x => x.inReplyTo === s.noteId).length;
  return {
    id: api.store.idFor(s.noteId),
    created_at: s.published || new Date().toISOString(),
    in_reply_to_id: s.inReplyTo ? api.store.idFor(s.inReplyTo) : null,
    in_reply_to_account_id: null,
    sensitive: !!s.spoiler, spoiler_text: s.spoiler || '',
    visibility: s.visibility || 'public', language: null,
    edited_at: s.editedAt || null,
    uri: s.noteId, url: s.link || s.noteId,
    replies_count: replies, reblogs_count: 0, favourites_count: 0,
    // True when ANY of the owner's accounts holds it. The flag is really
    // what the next tap will do: an empty star on a post one account has
    // already liked invites a second outward like from a second identity.
    favourited: !!s.favourited || (s.sourceAccts || []).some(v => v.favourited),
    reblogged: !!s.reblogged || (s.sourceAccts || []).some(v => v.reblogged),
    muted: false, bookmarked: !!s.bookmarked, pinned: !!s.pinned,
    content: s.content || '',
    reblog: null, application: null,
    account: api.account(s.actor),
    media_attachments: (s.attachments || []).map(a => api.mediaJson(a)),
    // The mention entities are how a client knows a link is an ACCOUNT —
    // without them, clicking a mentioned group lands on the raw actor doc.
    mentions: (s.mentions || []).map((m) => {
      const bare = String(m.name || '').replace(/^@/, '');
      const user = bare.split('@')[0];
      let host = '';
      try { host = new URL(m.href).host; } catch { /* keep bare */ }
      return {
        id: api.store.idFor(m.href),
        username: user || bare,
        url: m.href,
        acct: bare.includes('@') ? bare : (host ? `${user}@${host}` : bare),
      };
    }),
    tags: [],
    emojis: (s.emojis || []).map(e => ({
      shortcode: e.shortcode, url: e.url, static_url: e.url, visible_in_picker: false,
    })),
    card: null, poll: s.poll ? api.pollJson(s) : null,
    // What a filter matched, if any. Mastodon's clients read this and do the
    // hiding or warning; they do NOT match keywords themselves — Phanpy does
    // not — so filters that were stored and served but never applied were a
    // setting that did nothing. The README named them as a feature.
    filtered: api.filtersFor(s),
  };
}

// v2 filters against one status. `context` is the timeline the client is
// showing, which we do not know here, so every non-expired filter is offered
// and the client drops the ones whose context does not match — the same
// information it uses to decide anyway.
export function filtersFor(api, s) {
  const now = Date.now();
  const hay = `${s.content || ''} ${s.spoiler || ''}`
    .replace(/<[^>]*>/gu, ' ')            // the text, not the markup around it
    .toLowerCase();
  if (!hay.trim()) return [];
  const out = [];
  // `status()` renders on every timeline read, including from the Bluesky and
  // connected-account paths whose stores are narrower than the pod's. A
  // missing filter list means no filters, never a thrown render.
  for (const f of api.store.getFilters?.() || []) {
    if (f.expiresAt && Date.parse(f.expiresAt) <= now) continue;
    const hit = (f.keywords || []).filter((k) => {
      const word = String(k.keyword || '').toLowerCase().trim();
      if (!word) return false;
      if (!k.wholeWord) return hay.includes(word);
      // A whole word, by the same rule Mastodon uses: a boundary that is not
      // itself a word character, at both ends.
      const esc = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${esc}(?:[^\\p{L}\\p{N}_]|$)`, 'u').test(hay);
    }).map((k) => k.keyword);
    if (!hit.length) continue;
    out.push({
      filter: {
        id: f.id, title: f.title, context: f.context || ['home'],
        expires_at: f.expiresAt || null, filter_action: f.action || 'warn',
      },
      keyword_matches: hit,
      status_matches: [],
    });
  }
  return out;
}

// A timeline row's id may name the CARRY rather than the post — statusOrBoost
// mints `via:<noteId>` for the envelope. A client that asks about a row it
// was served has to get an answer: a 404 there makes it drop the row, which
// is how carried posts vanished from the home column while every other view
// still had them.
export function lookup(api, id) {
  const raw = api.store.urlFor(id);
  if (typeof raw !== 'string') return { s: null, wrapped: false };
  const wrapped = raw.startsWith('via:');
  const noteId = wrapped ? raw.slice(4) : raw;
  return { s: api.store.getStatuses().find(x => x.noteId === noteId) || null, wrapped };
}

// A carried post, the way clients expect to see one: the carrier "boosts"
// the inner post, so the feed says who brought it. Timeline views only —
// fetching the post by its own id still returns the post itself.
export function statusOrBoost(api, s, opts = {}) {
  if (!s.via || s.via === s.actor) return api.status(s, opts);
  const inner = api.status(s, opts);
  return {
    id: api.store.idFor('via:' + s.noteId),
    created_at: s.announcedAt || s.published || inner.created_at,
    in_reply_to_id: null, in_reply_to_account_id: null,
    sensitive: false, spoiler_text: '', visibility: inner.visibility, language: null,
    edited_at: null,
    uri: s.announceActivity?.id || s.noteId + '#announce',
    url: inner.url,
    replies_count: 0, reblogs_count: 0, favourites_count: 0,
    favourited: false, reblogged: false, muted: false, bookmarked: false, pinned: false,
    content: '', reblog: inner, application: null,
    account: api.account(s.via),
    media_attachments: [], mentions: [], tags: [], emojis: [], card: null, poll: null,
  };
}

// A notification, pushed. Fire-and-forget from the store's event hook.
export function pushNotify(api, n) {
  const acct = api.account(n.actor);
  const verbs = {
    mention: 'mentioned you', favourite: 'favourited your post',
    reblog: 'boosted your post', follow: 'followed you',
    'follow-request': 'asked to follow you', move: 'moved account',
  };
  const s = n.noteId && api.store.getStatuses().find(x => x.noteId === n.noteId);
  return api.push.notify(n, {
    notification_id: n.id, notification_type: n.type, preferred_locale: 'en',
    title: `${acct.display_name || acct.acct} ${verbs[n.type] || n.type}`,
    body: s ? htmlToText(s.content || '').slice(0, 140) : '',
    icon: acct.avatar || '',
  });
}

export function scheduledJson(api, e) {
  return {
    id: e.id, scheduled_at: e.scheduledAt,
    params: {
      text: e.params.status, visibility: e.params.visibility || 'public',
      spoiler_text: e.params.spoilerText || null, sensitive: !!e.params.spoilerText,
      in_reply_to_id: e.params.inReplyTo ? api.store.idFor(e.params.inReplyTo) : null,
      media_ids: (e.params.attachments || []).map(a => a.id),
      poll: null, idempotency: null, scheduled_at: e.scheduledAt, application_id: null,
    },
    media_attachments: (e.params.attachments || []).map(a => api.mediaJson(a)),
  };
}

export function pollJson(api, s) {
  const opts = s.poll.options || [];
  const votes = opts.reduce((n, o) => n + (o.votes || 0), 0);
  return {
    id: api.store.idFor(s.noteId),
    expires_at: s.poll.expiresAt || null,
    expired: !!s.poll.closed || (!!s.poll.expiresAt && Date.parse(s.poll.expiresAt) < Date.now()),
    multiple: !!s.poll.multiple,
    votes_count: votes, voters_count: s.poll.votersCount ?? null,
    options: opts.map(o => ({ title: o.title, votes_count: o.votes || 0 })),
    voted: !!s.poll.voted, own_votes: s.poll.ownVotes || [],
    emojis: [],
  };
}

export function mediaJson(api, a) {
  const kind = /^video\//.test(a.mediaType) ? 'video'
    : /^audio\//.test(a.mediaType) ? 'audio'
      // NOT 'gifv'. Mastodon uses gifv for a silent MP4 it transcoded a GIF
      // into, and a client renders one with <video src>; handed the raw .gif
      // URL, every GIF came out blank. Nothing here transcodes, so what we
      // have is an image and saying so is what makes it show.
      : 'image';
  return {
    id: a.id || api.store.idFor(a.url),
    type: kind, url: a.url, preview_url: a.url, remote_url: null,
    description: a.description || null, blurhash: null, meta: {},
  };
}

export function relationship(api, actorUrl) {
  const c = api.store.getContacts();
  const fol = c.following.find(f => f.actor === actorUrl);
  return {
    id: api.store.idFor(actorUrl),
    following: !!fol?.accepted, requested: !!fol && !fol.accepted,
    followed_by: c.followers.some(f => f.actor === actorUrl),
    showing_reblogs: true, notifying: false, languages: null,
    blocking: api.store.getBlocklist().actors.includes(actorUrl),
    blocked_by: false, domain_blocking: false,
    muting: api.store.getMuted().actors.includes(actorUrl),
    muting_notifications: false, endorsed: false, note: '',
  };
}

// Ours is stored with a hyphen; Mastodon's API spells it with an underscore,
// and a client that does not know the type shows "Unknown notification type"
// — which is what every Mastodon client did with a follow request here. The
// stored spelling is left alone so existing state keeps reading.
export function notificationType(api, t) { return t === 'follow-request' ? 'follow_request' : t; }

export function notification(api, n) {
  const out = { id: n.id, type: api.notificationType(n.type), created_at: n.at, account: api.account(n.actor) };
  if (n.noteId) {
    const s = api.store.getStatuses().find(x => x.noteId === n.noteId);
    if (s) out.status = api.status(s);
  }
  return out;
}

// Every account this instance knows whose handle or name matches: self,
// contacts, cached actor docs. Handle-shaped queries resolve via webfinger.
export async function accountSearch(api, q) {
  const needle = String(q || '').replace(/^@/, '').toLowerCase().trim();
  if (!needle) return [];
  if (/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(needle)) {
    try {
      const doc = await social.resolveHandle(api.agent, needle);
      return [api.account(doc.id)];
    } catch (e) { api.log(`account search resolve ${needle}: ${e.message}`); }
    return [];
  }
  const cfg = api.store.getConfig();
  const seen = new Set();
  const out = [];
  const add = (actorUrl) => {
    if (actorUrl && !seen.has(actorUrl)) { seen.add(actorUrl); out.push(api.account(actorUrl)); }
  };
  if ((cfg?.handle || '').toLowerCase().includes(needle)
    || (cfg?.name || '').toLowerCase().includes(needle)) add(api.urls.actor);
  const contacts = api.store.getContacts();
  for (const rec of [...contacts.followers, ...contacts.following]) {
    if ((rec.handle || rec.actor || '').toLowerCase().includes(needle)) add(rec.actor);
  }
  for (const [u, a] of Object.entries(api.store.getActors())) {
    if ((a.preferredUsername + ' ' + a.name + ' ' + u).toLowerCase().includes(needle)) add(u);
  }
  return out.slice(0, 20);
}
