// mastoapi.mjs — Mastodon client-API facade over ap-agent (M1: read + post).
// Modeled on snac2's approach: real implementations for the endpoints
// clients actually exercise, empty-collection stubs for the rest. Reached
// through the router (/api/*, /oauth/* → this port), so requests carry the
// gate; OAuth here is theater for a single already-trusted local user.
//
// Surface: oauth trio · instance v1/v2 · verify_credentials · timelines/home
// (M1) · notifications, relationships, lookup, follow/unfollow, thread
// context, /v2/search (M2) · favourite/reblog, media upload, markers,
// DELETE status (M3) · stub farm. Unknown /api/* GETs 404 and are LOGGED —
// that log is the running punch list.

import crypto from 'node:crypto';
import * as social from './social.mjs';
import { isCrossSiteNavigation } from './guard.mjs';
import { sanitizeHtml } from './wire.mjs';
import { authorOf } from './intake.mjs';
import { Push } from './webpush.mjs';

// What an attachment is allowed to BE. Anything else is stored as bytes, which
// a browser downloads rather than runs.
const ATTACHMENT_KINDS = new Set(['image', 'video', 'audio']);
// image/* with an exception: an SVG is a document, it carries script, and a
// browser renders it rather than showing it. Mastodon does not take them as
// media either.
const NEVER = new Set(['image/svg+xml', 'image/svg']);
const OPAQUE = 'application/octet-stream';

export function attachmentType(claimed) {
  const t = String(claimed || '').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) || NEVER.has(t)) return OPAQUE;
  return ATTACHMENT_KINDS.has(t.split('/')[0]) ? t : OPAQUE;
}

// From the TYPE we accepted, not from the name the client sent — an `.html`
// suffix on a file stored as octet-stream is what a pod would serve from, and
// a filename is the client's to choose.
export function extensionFor(mediaType, filename = '') {
  if (mediaType === OPAQUE) return 'bin';
  const sub = mediaType.split('/')[1].replace(/[^a-z0-9]/g, '');
  const given = String(filename || '').includes('.')
    ? filename.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  // Keep the client's suffix only when it plainly belongs to the accepted type,
  // so jpg/jpeg and mp4/m4v survive without a table of every media type.
  return given && (given === sub || sub.startsWith(given) || given.startsWith(sub)) ? given : (sub || 'bin');
}

const STUBS = new Map(Object.entries({
  '/api/v1/filters': [],
  '/api/v1/custom_emojis': [],
  '/api/v1/announcements': [],
  '/api/v1/follow_requests': [],
  '/api/v1/instance/peers': [],
  '/api/v1/trends/tags': [], '/api/v1/trends/links': [],
  '/api/v2/suggestions': [],
  '/api/v1/preferences': {},
  '/api/v1/followed_tags': [],
}));

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;   // tokens age out after 90 days
const AUTHZ_WINDOW_MS = 60_000;
const AUTHZ_MAX_ATTEMPTS = 5;

export class MastoApi {
  constructor({ agent, log = console.log, allowed = null }) {
    this.agent = agent;
    this.log = log;
    this.allowed = allowed;             // authorities a redirect_uri may name
    this.authzAttempts = [];            // password-attempt timestamps
  }

  get store() { return this.agent.store; }
  get urls() { return this.agent.publisher?.urls; }
  get push() {
    this._push ||= new Push({
      store: this.store,
      subject: () => this.urls?.actor || 'https://localhost/',
      log: this.log,
    });
    return this._push;
  }
  get host() { return this.urls ? new URL(this.urls.base).host : 'unconfigured.invalid'; }

  // ---- tokens ----
  // Tokens are records {token, createdAt} and expire; legacy bare strings
  // are read as undated and treated as expired-on-sight only if older
  // formats can't be dated (they get an epoch of now on first migration).
  tokenRecords() {
    const raw = this.store.read('masto-tokens.json', []);
    return raw.map(r => (typeof r === 'string' ? { token: r, createdAt: Date.now() } : r));
  }
  tokens() {
    const now = Date.now();
    return this.tokenRecords().filter(r => now - (r.createdAt || 0) < TOKEN_TTL_MS).map(r => r.token);
  }
  mintToken() {
    const t = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const kept = this.tokenRecords().filter(r => now - (r.createdAt || 0) < TOKEN_TTL_MS);
    this.store.write('masto-tokens.json', [...kept, { token: t, createdAt: now }].slice(-20));
    return t;
  }
  authed(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return !!m && this.tokens().includes(m[1]);
  }

  // A redirect_uri must name an authority this agent answers on — otherwise
  // a visited page could navigate to /oauth/authorize and have the freshly
  // minted code delivered to itself.
  redirectAllowed(redirect) {
    if (!redirect || redirect === 'urn:ietf:wg:oauth:2.0:oob') return true;
    if (!this.allowed) return true;                       // no policy configured (tests)
    try {
      const u = new URL(redirect);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      return this.allowed.has(u.host.toLowerCase());
    } catch { return false; }
  }

  rateLimited() {
    const now = Date.now();
    this.authzAttempts = this.authzAttempts.filter(t => now - t < AUTHZ_WINDOW_MS);
    if (this.authzAttempts.length >= AUTHZ_MAX_ATTEMPTS) return true;
    this.authzAttempts.push(now);
    return false;
  }

  // Every agent used to report title 'solid-activitypub', so a client holding two
  // of them showed two identical instances and you had to read the acct to tell
  // them apart. The title is free text no client parses — make it say who.
  instanceTitle() {
    const cfg = this.store.getConfig();
    return cfg?.handle ? `@${cfg.handle}@${this.host}` : 'Solid ActivityPub';
  }

  instanceBlurb() {
    const kind = this.store.getConfig()?.kind === 'group' ? 'group' : 'actor';
    return `Solid pod ActivityPub ${kind}`;
  }

  // ---- object rendering ----
  selfAccount() {
    // No fallback handle. `account()` already reads config for self, so a
    // literal here only ever supplies a name that is not this actor's — and it
    // was a real person's, so every install with no handle called itself jeff.
    return this.account(this.urls.actor, { selfAcct: this.store.getConfig()?.handle || null });
  }

  account(actorUrl, { selfAcct } = {}) {
    const cached = this.store.getActors()[actorUrl] || {};
    let host = '', user = cached.preferredUsername || '';
    try { host = new URL(actorUrl).host; if (!user) user = new URL(actorUrl).pathname.split('/').pop(); } catch {}
    const self = actorUrl === this.urls?.actor;
    if (self) user = selfAcct || this.store.getConfig()?.handle || user;
    return {
      id: this.store.idFor(actorUrl),
      username: user,
      // Self gets the FULL acct (Mastodon proper returns the bare local part
      // here): the client's login domain is the loopback agent, so the bare
      // form would display as user@127.0.0.1 — the full form shows the real
      // fediverse identity, and every client renders @-containing accts as-is.
      acct: `${self ? (selfAcct || user) : user}@${host}`,
      // Our own profile is not in the actor cache — the cache is for other
      // people — so read it from config, or the editor opens empty and saving
      // wipes what was there.
      display_name: (self ? this.store.getConfig()?.name : cached.name) || cached.name || user,
      locked: self ? !!this.store.getConfig()?.approveJoins : false,
      // Read from config for self, like the fields above it: our own actor is
      // not in the actor cache — the cache is for other people — so a group
      // asking about itself would be told it was a person.
      bot: false, discoverable: true,
      group: self ? this.store.getConfig()?.kind === 'group' : cached.type === 'Group',
      created_at: '2026-01-01T00:00:00.000Z',
      note: (self ? this.store.getConfig()?.summary : cached.summary) || '',
      url: actorUrl, uri: actorUrl,
      avatar: selfIcon(this, self, cached) || TRANSPARENT_PNG,
      avatar_static: selfIcon(this, self, cached) || TRANSPARENT_PNG,
      header: (self ? this.store.getConfig()?.image : null) || TRANSPARENT_PNG,
      header_static: (self ? this.store.getConfig()?.image : null) || TRANSPARENT_PNG,
      // A remote actor's counts are whatever its own collections said when we
      // last asked; unknown stays 0 because the API has no way to say "unknown".
      followers_count: self ? this.store.getContacts().followers.length : (cached.counts?.followers ?? 0),
      // Accepted only, matching both the published `following` collection and
      // the list this number opens — a pending Follow is not yet a following.
      following_count: self ? this.store.getContacts().following.filter(f => f.accepted).length : (cached.counts?.following ?? 0),
      statuses_count: self ? this.store.getStatuses().filter(s => s.kind === 'post').length : 0,
      last_status_at: null, emojis: [],
      fields: (self ? this.store.getConfig()?.fields : cached.fields) || [],
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
  page(items, url, { limit = 20, max = 40, idOf = (s) => this.store.idFor(s.noteId) } = {}) {
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
    const base = `http://${this.host}${url.pathname}`;
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

  status(s, { all } = {}) {
    const replies = (all || this.store.getStatuses()).filter(x => x.inReplyTo === s.noteId).length;
    return {
      id: this.store.idFor(s.noteId),
      created_at: s.published || new Date().toISOString(),
      in_reply_to_id: s.inReplyTo ? this.store.idFor(s.inReplyTo) : null,
      in_reply_to_account_id: null,
      sensitive: !!s.spoiler, spoiler_text: s.spoiler || '',
      visibility: s.visibility || 'public', language: null,
      edited_at: s.editedAt || null,
      uri: s.noteId, url: s.link || s.noteId,
      replies_count: replies, reblogs_count: 0, favourites_count: 0,
      favourited: !!s.favourited, reblogged: !!s.reblogged,
      muted: false, bookmarked: !!s.bookmarked, pinned: !!s.pinned,
      content: s.content || '',
      reblog: null, application: null,
      account: this.account(s.actor),
      media_attachments: (s.attachments || []).map(a => this.mediaJson(a)),
      // The mention entities are how a client knows a link is an ACCOUNT —
      // without them, clicking a mentioned group lands on the raw actor doc.
      mentions: (s.mentions || []).map((m) => {
        const bare = String(m.name || '').replace(/^@/, '');
        const user = bare.split('@')[0];
        let host = '';
        try { host = new URL(m.href).host; } catch { /* keep bare */ }
        return {
          id: this.store.idFor(m.href),
          username: user || bare,
          url: m.href,
          acct: bare.includes('@') ? bare : (host ? `${user}@${host}` : bare),
        };
      }),
      tags: [],
      emojis: (s.emojis || []).map(e => ({
        shortcode: e.shortcode, url: e.url, static_url: e.url, visible_in_picker: false,
      })),
      card: null, poll: s.poll ? this.pollJson(s) : null,
    };
  }

  // A timeline row's id may name the CARRY rather than the post — statusOrBoost
  // mints `via:<noteId>` for the envelope. A client that asks about a row it
  // was served has to get an answer: a 404 there makes it drop the row, which
  // is how carried posts vanished from the home column while every other view
  // still had them.
  lookup(id) {
    const raw = this.store.urlFor(id);
    if (typeof raw !== 'string') return { s: null, wrapped: false };
    const wrapped = raw.startsWith('via:');
    const noteId = wrapped ? raw.slice(4) : raw;
    return { s: this.store.getStatuses().find(x => x.noteId === noteId) || null, wrapped };
  }

  // A carried post, the way clients expect to see one: the carrier "boosts"
  // the inner post, so the feed says who brought it. Timeline views only —
  // fetching the post by its own id still returns the post itself.
  statusOrBoost(s, opts = {}) {
    if (!s.via || s.via === s.actor) return this.status(s, opts);
    const inner = this.status(s, opts);
    return {
      id: this.store.idFor('via:' + s.noteId),
      created_at: s.announcedAt || s.published || inner.created_at,
      in_reply_to_id: null, in_reply_to_account_id: null,
      sensitive: false, spoiler_text: '', visibility: inner.visibility, language: null,
      edited_at: null,
      uri: s.announceActivity?.id || s.noteId + '#announce',
      url: inner.url,
      replies_count: 0, reblogs_count: 0, favourites_count: 0,
      favourited: false, reblogged: false, muted: false, bookmarked: false, pinned: false,
      content: '', reblog: inner, application: null,
      account: this.account(s.via),
      media_attachments: [], mentions: [], tags: [], emojis: [], card: null, poll: null,
    };
  }

  // A notification, pushed. Fire-and-forget from the store's event hook.
  pushNotify(n) {
    const acct = this.account(n.actor);
    const verbs = {
      mention: 'mentioned you', favourite: 'favourited your post',
      reblog: 'boosted your post', follow: 'followed you',
      'follow-request': 'asked to follow you', move: 'moved account',
    };
    const s = n.noteId && this.store.getStatuses().find(x => x.noteId === n.noteId);
    return this.push.notify(n, {
      notification_id: n.id, notification_type: n.type, preferred_locale: 'en',
      title: `${acct.display_name || acct.acct} ${verbs[n.type] || n.type}`,
      body: s ? htmlToText(s.content || '').slice(0, 140) : '',
      icon: acct.avatar || '',
    });
  }

  scheduledJson(e) {
    return {
      id: e.id, scheduled_at: e.scheduledAt,
      params: {
        text: e.params.status, visibility: e.params.visibility || 'public',
        spoiler_text: e.params.spoilerText || null, sensitive: !!e.params.spoilerText,
        in_reply_to_id: e.params.inReplyTo ? this.store.idFor(e.params.inReplyTo) : null,
        media_ids: (e.params.attachments || []).map(a => a.id),
        poll: null, idempotency: null, scheduled_at: e.scheduledAt, application_id: null,
      },
      media_attachments: (e.params.attachments || []).map(a => this.mediaJson(a)),
    };
  }

  pollJson(s) {
    const opts = s.poll.options || [];
    const votes = opts.reduce((n, o) => n + (o.votes || 0), 0);
    return {
      id: this.store.idFor(s.noteId),
      expires_at: s.poll.expiresAt || null,
      expired: !!s.poll.closed || (!!s.poll.expiresAt && Date.parse(s.poll.expiresAt) < Date.now()),
      multiple: !!s.poll.multiple,
      votes_count: votes, voters_count: null,
      options: opts.map(o => ({ title: o.title, votes_count: o.votes || 0 })),
      voted: !!s.poll.voted, own_votes: s.poll.ownVotes || [],
      emojis: [],
    };
  }

  mediaJson(a) {
    const kind = /^video\//.test(a.mediaType) ? 'video'
      : /^audio\//.test(a.mediaType) ? 'audio'
        : /^image\/gif/.test(a.mediaType) ? 'gifv' : 'image';
    return {
      id: a.id || this.store.idFor(a.url),
      type: kind, url: a.url, preview_url: a.url, remote_url: null,
      description: a.description || null, blurhash: null, meta: {},
    };
  }

  relationship(actorUrl) {
    const c = this.store.getContacts();
    const fol = c.following.find(f => f.actor === actorUrl);
    return {
      id: this.store.idFor(actorUrl),
      following: !!fol?.accepted, requested: !!fol && !fol.accepted,
      followed_by: c.followers.some(f => f.actor === actorUrl),
      showing_reblogs: true, notifying: false, languages: null,
      blocking: this.store.getBlocklist().actors.includes(actorUrl),
      blocked_by: false, domain_blocking: false,
      muting: this.store.getMuted().actors.includes(actorUrl),
      muting_notifications: false, endorsed: false, note: '',
    };
  }

  notification(n) {
    const out = { id: n.id, type: n.type, created_at: n.at, account: this.account(n.actor) };
    if (n.noteId) {
      const s = this.store.getStatuses().find(x => x.noteId === n.noteId);
      if (s) out.status = this.status(s);
    }
    return out;
  }

  // Every account this instance knows whose handle or name matches: self,
  // contacts, cached actor docs. Handle-shaped queries resolve via webfinger.
  async accountSearch(q) {
    const needle = String(q || '').replace(/^@/, '').toLowerCase().trim();
    if (!needle) return [];
    if (/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(needle)) {
      try {
        const doc = await social.resolveHandle(this.agent, needle);
        return [this.account(doc.id)];
      } catch (e) { this.log(`account search resolve ${needle}: ${e.message}`); }
      return [];
    }
    const cfg = this.store.getConfig();
    const seen = new Set();
    const out = [];
    const add = (actorUrl) => {
      if (actorUrl && !seen.has(actorUrl)) { seen.add(actorUrl); out.push(this.account(actorUrl)); }
    };
    if ((cfg?.handle || '').toLowerCase().includes(needle)
      || (cfg?.name || '').toLowerCase().includes(needle)) add(this.urls.actor);
    const contacts = this.store.getContacts();
    for (const rec of [...contacts.followers, ...contacts.following]) {
      if ((rec.handle || rec.actor || '').toLowerCase().includes(needle)) add(rec.actor);
    }
    for (const [u, a] of Object.entries(this.store.getActors())) {
      if ((a.preferredUsername + ' ' + a.name + ' ' + u).toLowerCase().includes(needle)) add(u);
    }
    return out.slice(0, 20);
  }

  // ---- request handling; returns true when handled ----
  async handle(req, res, pathname, url) {
    const send = (status, obj, headers = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
      return true;
    };

    // --- oauth ---
    // With no UI password configured this is "theater": whoever can reach the
    // loopback surface IS the trusted user, and authorize redirects at once.
    // With a password set (required before any non-loopback exposure), the
    // authorize step becomes a real login form.
    if (pathname === '/api/v1/apps' && req.method === 'POST') {
      const body = await readBody(req);
      return send(200, {
        id: '1', name: body.client_name || 'client',
        client_id: 'dk-ap-client', client_secret: 'dk-ap-secret',
        redirect_uri: body.redirect_uris || 'urn:ietf:wg:oauth:2.0:oob', vapid_key: this.push.publicKey(),
      });
    }
    if (pathname === '/oauth/authorize' && (req.method === 'GET' || req.method === 'POST')) {
      // A cross-site navigation into the credential-minting endpoint is
      // never a legitimate client flow — our clients are same-origin.
      if (isCrossSiteNavigation(req)) {
        this.log('authorize refused: cross-site navigation');
        return send(403, { error: 'cross-site authorization is not allowed' });
      }
      const pw = this.store.getConfig()?.uiPassword;   // { saltHex, hashHex } scrypt record
      let params = url.searchParams;
      if (req.method === 'POST') {
        const body = await readBody(req);
        params = new URLSearchParams(body);
        if (this.rateLimited()) {
          this.log('authorize rate limited');
          return sendLoginForm(res, params, 'too many attempts — wait a minute');
        }
        if (!pw || !checkPassword(pw, body.password || '')) {
          return sendLoginForm(res, params, 'wrong password — try again');
        }
      } else if (pw) {
        return sendLoginForm(res, params);
      } else if (this.allowed && !this.allowed.isLocalRequest(req)) {
        // No password set, and this request did not come from this machine.
        //
        // The instant-authorize path is honest theatre on loopback: whoever can
        // reach it IS the trusted user. It stops being theatre the moment an
        // operator takes the documented AP_ALLOWED_HOSTS route and puts the
        // agent on a tailnet name or behind a reverse proxy, because anyone who
        // reaches that name is then handed a 90-day bearer for the whole facade
        // — update_credentials included, which is precisely the authority the
        // isLocal check on /setup and /config exists to withhold. /oauth is
        // dispatched before that check ever runs, so it needs its own.
        this.log(`authorize refused: no UI password, and "${req.headers.host}" is not this machine`);
        return send(403, {
          error: 'this agent answers on an address outside this machine and has no password set — '
            + 'run `solid-activitypub passwd` before logging in over that address',
        });
      }
      const redirect = params.get('redirect_uri') || '';
      if (!this.redirectAllowed(redirect)) {
        this.log(`authorize refused: redirect_uri "${redirect}" is not this agent`);
        return send(400, { error: 'redirect_uri must be an address of this agent' });
      }
      const code = this.mintToken();          // code doubles as the token seed
      if (!redirect || redirect === 'urn:ietf:wg:oauth:2.0:oob') return send(200, { code });
      const target = new URL(redirect);
      target.searchParams.set('code', code);
      if (params.get('state')) target.searchParams.set('state', params.get('state'));
      res.writeHead(302, { location: target.href });
      res.end();
      return true;
    }
    if (pathname === '/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      // The code IS a token, minted by /oauth/authorize after whatever gate that
      // endpoint applies. Minting one here for an unrecognised code handed a
      // bearer to anyone who could reach the port — and a non-browser client
      // sends no Origin, so the firewall never saw it. That defeated `passwd`
      // on any agent deliberately exposed through AP_ALLOWED_HOSTS.
      if (!body.code || !this.tokens().includes(body.code)) {
        this.log('token refused: code is not a live authorization');
        return send(400, { error: 'invalid_grant' });
      }
      return send(200, { access_token: body.code, token_type: 'Bearer', scope: body.scope || 'read write follow push', created_at: Math.floor(Date.now() / 1000) });
    }
    if (pathname === '/oauth/revoke' && req.method === 'POST') {
      // It used to answer 200 and keep the token, so logging out of a client
      // left a working 90-day bearer behind. Mastodon's endpoint takes `token`;
      // an unknown one is still a 200, which is what the spec asks for.
      const body = await readBody(req).catch(() => ({}));
      const gone = body?.token;
      if (gone) {
        const kept = this.tokenRecords().filter(r => r.token !== gone);
        this.store.write('masto-tokens.json', kept);
        this.log('client token revoked');
      }
      return send(200, {});
    }

    if (!pathname.startsWith('/api/')) return false;

    // --- instance (public) ---
    if (pathname === '/api/v1/instance') {
      return send(200, {
        uri: this.host, title: this.instanceTitle(), short_description: this.instanceBlurb(),
        description: this.instanceBlurb(), email: '', version: '4.2.0 (compatible; solid-activitypub)',
        urls: {}, stats: { user_count: 1, status_count: this.store.getStatuses().length, domain_count: 1 },
        languages: ['en'], registrations: false, approval_required: false, invites_enabled: false,
        configuration: instanceConfig(),
        contact_account: null, rules: [],
      });
    }
    if (pathname === '/api/v2/instance') {
      return send(200, {
        domain: this.host, title: this.instanceTitle(), version: '4.2.0 (compatible; solid-activitypub)',
        source_url: 'https://github.com/jeff-zucker/solid-activitypub', description: this.instanceBlurb(),
        usage: { users: { active_month: 1 } },
        thumbnail: { url: TRANSPARENT_PNG },
        languages: ['en'],
        configuration: { ...instanceConfig(), urls: { streaming: '' }, vapid: { public_key: this.push.publicKey() } },
        registrations: { enabled: false, approval_required: false, message: null },
        contact: { email: '', account: null }, rules: [],
      });
    }

    const stub = STUBS.get(pathname);
    if (stub !== undefined && req.method === 'GET') return send(200, stub);

    // --- everything below needs a bearer token + a configured agent ---
    if (!this.authed(req)) return send(401, { error: 'The access token is invalid' });
    if (!this.agent.configured()) return send(503, { error: 'agent not configured' });
    // A viewer-mode agent (another agent holds the drain lease) may not act —
    // but a user acting HERE outranks the idle active agent elsewhere, so a
    // write attempt claims the lease and proceeds. Only a failed claim 503s.
    if (this.agent.viewer && req.method !== 'GET' && req.method !== 'HEAD') {
      const took = await this.agent.requestTakeover?.();
      if (!took) return send(503, { error: 'another agent is active for this pod — takeover failed, try again' });
    }

    if (pathname === '/api/v1/accounts/verify_credentials') {
      const cfg0 = this.store.getConfig() || {};
      return send(200, {
        ...this.selfAccount(),
        // `source` is what the editor fills its inputs from: the raw text it
        // will send back, not the HTML the profile renders.
        source: {
          privacy: 'public', sensitive: false, language: 'en',
          note: cfg0.summary || '',
          fields: (cfg0.fields || []).map(f => ({ name: f.name, value: f.value })),
        },
      });
    }

    // The profile editor. Everything it can send is carried: the name and bio,
    // both pictures, and the extra fields. An avatar or header arrives as file
    // bytes, so it goes to the pod's media container first and the actor gets
    // the URL — the same path a posted attachment takes.
    if (pathname === '/api/v1/accounts/update_credentials') {
      if (req.method !== 'PATCH' && req.method !== 'POST') return send(405, { error: 'PATCH expected' });
      const ct = String(req.headers['content-type'] || '');
      // readBody already covers JSON and urlencoded; only the file case differs.
      let form = {}, files = {};
      if (ct.includes('multipart/form-data')) ({ fields: form, files } = await readMultipart(req));
      else form = await readBody(req);

      const cfg = { ...this.store.getConfig() };
      const putImage = async (f) => {
        const ext = (f.filename || '').includes('.')
          ? f.filename.split('.').pop().replace(/[^\w]/g, '') : 'bin';
        const slug = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
        const url = this.urls.media + slug;
        await this.agent.publisher.ensureMediaContainer();
        await this.agent.remote.put(url, f.data, f.contentType);
        return url;
      };

      if ('display_name' in form) cfg.name = String(form.display_name).trim() || cfg.handle;
      if ('note' in form) cfg.summary = String(form.note) || undefined;
      if ('locked' in form) cfg.approveJoins = form.locked === 'true' || form.locked === true;
      if (files.avatar?.data?.length) cfg.icon = await putImage(files.avatar);
      if (files.header?.data?.length) cfg.image = await putImage(files.header);

      // fields_attributes arrives as fields_attributes[0][name] etc. A row with
      // no name is how the editor says "delete this one", so it is dropped.
      const rows = [];
      for (const [k, v] of Object.entries(form)) {
        const m = /^fields_attributes\[(\d+)\]\[(name|value)\]$/.exec(k);
        if (!m) continue;
        (rows[Number(m[1])] ||= {})[m[2]] = String(v);
      }
      if (rows.length) cfg.fields = rows.filter(r => r && r.name?.trim())
        .map(r => ({ name: r.name.trim(), value: (r.value || '').trim() }));

      this.store.setConfig(cfg);
      Object.assign(this.agent.publisher.config, {
        name: cfg.name, summary: cfg.summary, icon: cfg.icon, image: cfg.image,
        fields: cfg.fields, approveJoins: !!cfg.approveJoins,
      });
      await this.store.flush();
      // publishProfile says whether the world can actually read the actor it
      // just wrote. Discarding that reported success for a save that left the
      // account undiscoverable — the one outcome the caller needed to hear.
      const published = await this.agent.publisher.publishProfile();
      const unreachable = published?.unreachable;
      if (unreachable?.length) {
        this.log(`profile saved but NOT publicly readable: ${unreachable.join(', ')}`);
      }
      this.log(`profile updated from a client: ${Object.keys(form).join(', ') || '(files only)'}`);
      return send(200, this.selfAccount());
    }

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
      const all = this.store.getStatuses();
      const muted = new Set(this.store.getMuted().actors);
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
      const { items: page, headers } = this.page(items, url);
      return send(200, page.map(s => this.statusOrBoost(s, { all })), headers);
    }

    if (pathname === '/api/v1/statuses' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.status) return send(422, { error: 'status text required' });
      const visibility = body.visibility || 'public';
      if (!['public', 'unlisted', 'private', 'direct'].includes(visibility)) {
        return send(422, { error: `unknown visibility "${visibility}"` });
      }
      // Private and direct posts live in an owner-only pod container — and
      // only on a pod that provably enforces it.
      if (visibility === 'private' || visibility === 'direct') {
        const ready = await this.agent.publisher.privateReady();
        if (ready !== true) return send(422, { error: ready });
      }
      const spoilerText = String(body.spoiler_text || '').trim() || null;
      const inReplyTo = body.in_reply_to_id ? this.store.urlFor(body.in_reply_to_id) : undefined;
      // A mirrored Bluesky post is not an AP object; a reply has nowhere to go.
      if (inReplyTo && this.store.getStatuses().find(x => x.noteId === inReplyTo)?.kind === 'bsky') {
        return send(422, { error: 'this is a Bluesky post — open it on Bluesky to reply' });
      }
      const mediaIds = [].concat(body.media_ids || body['media_ids[]'] || []).filter(Boolean);
      const media = this.store.getMedia();
      const attachments = mediaIds.map(id => media[id] && { id, ...media[id] }).filter(Boolean);
      if (body.scheduled_at) {
        const at = Date.parse(body.scheduled_at);
        if (!Number.isFinite(at) || at < Date.now() + 60_000) {
          return send(422, { error: 'scheduled_at must be at least a minute from now' });
        }
        const sched = this.store.getScheduled();
        const entry = {
          id: crypto.randomBytes(8).toString('hex'), scheduledAt: new Date(at).toISOString(),
          params: { status: body.status, visibility, spoilerText, inReplyTo, attachments },
        };
        sched.push(entry);
        this.store.setScheduled(sched);
        return send(200, this.scheduledJson(entry));
      }
      const note = await this.agent.publisher.publishNote(body.status,
        { inReplyTo, attachments, visibility, spoilerText });
      const s = this.store.getStatuses().find(x => x.noteId === note.id);
      return send(200, this.status(s));
    }

    // The composer reads the raw text back before an edit.
    const mSource = /^\/api\/v1\/statuses\/([a-f0-9]+)\/source$/.exec(pathname);
    if (mSource && req.method === 'GET') {
      const noteUrl = this.store.urlFor(mSource[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s) return send(404, { error: 'Record not found' });
      return send(200, { id: mSource[1], text: s.text ?? htmlToText(s.content || ''), spoiler_text: s.spoiler || '' });
    }

    // One entry — the current version. Enough for the client's history view;
    // past versions are not kept.
    const mHistory = /^\/api\/v1\/statuses\/([a-f0-9]+)\/history$/.exec(pathname);
    if (mHistory && req.method === 'GET') {
      const noteUrl = this.store.urlFor(mHistory[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s) return send(404, { error: 'Record not found' });
      return send(200, [{
        content: s.content || '', spoiler_text: s.spoiler || '', sensitive: !!s.spoiler,
        created_at: s.editedAt || s.published, account: this.account(s.actor),
        media_attachments: (s.attachments || []).map(a => this.mediaJson(a)),
        emojis: [], poll: null,
      }]);
    }

    const mStatus = /^\/api\/v1\/statuses\/([a-f0-9]+)$/.exec(pathname);
    if (mStatus && req.method === 'GET') {
      const { s, wrapped } = this.lookup(mStatus[1]);
      if (!s) return send(404, { error: 'Record not found' });
      return send(200, wrapped ? this.statusOrBoost(s) : this.status(s));
    }
    if (mStatus && req.method === 'PUT') {
      const noteUrl = this.store.urlFor(mStatus[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s) return send(404, { error: 'Record not found' });
      if (s.actor !== this.urls.actor) return send(403, { error: 'not your status' });
      const body = await readBody(req);
      if (!body.status) return send(422, { error: 'status text required' });
      const mediaIds = [].concat(body.media_ids || body['media_ids[]'] || []).filter(Boolean);
      const media = this.store.getMedia();
      const attachments = mediaIds.length
        ? mediaIds.map(id => media[id] && { id, ...media[id] }).filter(Boolean)
        : null;                                   // null: keep what the post has
      const spoilerText = String(body.spoiler_text || '').trim() || null;
      const patched = await this.agent.publisher.updateNote(s,
        { content: body.status, spoilerText, attachments });
      return send(200, this.status(patched || s));
    }
    if (mStatus && req.method === 'DELETE') {
      const noteUrl = this.store.urlFor(mStatus[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s) return send(404, { error: 'Record not found' });
      if (s.actor !== this.urls.actor) return send(403, { error: 'not your status' });
      const rendered = this.status(s);
      // 502, because the refusal is the pod's: the client asked correctly and
      // the post is still up. Reporting 200 here is what let a deleted post
      // stay publicly readable with nothing to show for it.
      const gone = await social.deleteNote(this.agent, s);
      if (!gone.ok) return send(502, { error: gone.error });
      return send(200, { ...rendered, text: s.content || '' });
    }

    // Threads from the mirror's inReplyTo chains.
    const mContext = /^\/api\/v1\/statuses\/([a-f0-9]+)\/context$/.exec(pathname);
    if (mContext) {
      const noteUrl = this.lookup(mContext[1]).s?.noteId;
      const all = this.store.getStatuses();
      const byId = new Map(all.map(s => [s.noteId, s]));
      const ancestors = [];
      let cur = noteUrl && byId.get(noteUrl)?.inReplyTo;
      while (cur && byId.has(cur) && ancestors.length < 40) {
        const s = byId.get(cur);
        ancestors.unshift(s);
        cur = s.inReplyTo;
      }
      const descendants = [];
      const queue = noteUrl ? [noteUrl] : [];
      while (queue.length && descendants.length < 60) {
        const id = queue.shift();
        for (const s of all) if (s.inReplyTo === id) { descendants.push(s); queue.push(s.noteId); }
      }
      return send(200, {
        ancestors: ancestors.map(s => this.status(s, { all })),
        descendants: descendants.map(s => this.status(s, { all })),
      });
    }

    // Who reacted: only what our own store witnessed, so the lists are the
    // reactions we were notified of, not the whole fediverse's count.
    const mWho = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(reblogged_by|favourited_by)$/.exec(pathname);
    if (mWho && req.method === 'GET') {
      const noteUrl = this.store.urlFor(mWho[1]);
      if (!noteUrl) return send(404, { error: 'Record not found' });
      const type = mWho[2] === 'reblogged_by' ? 'reblog' : 'favourite';
      const actors = [...new Set(this.store.getNotifications()
        .filter(n => n.noteId === noteUrl && n.type === type).map(n => n.actor))];
      return send(200, actors.map(a => this.account(a)));
    }

    // Pinning republishes the featured collection, so a visitor's server
    // shows the pins too; the actor document names the collection.
    const mPin = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(pin|unpin)$/.exec(pathname);
    if (mPin && req.method === 'POST') {
      const noteUrl = this.store.urlFor(mPin[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s) return send(404, { error: 'Record not found' });
      if (s.actor !== this.urls.actor) return send(403, { error: 'not your status' });
      const updated = this.store.updateStatus(s.noteId, { pinned: mPin[2] === 'pin' });
      await this.agent.publisher.publishFeatured().catch(e => this.log(`featured: ${e.message}`));
      this.agent.publisher.publishProfile().catch(() => {});   // skips itself when unchanged
      return send(200, this.status(updated || s));
    }

    if (pathname === '/api/v1/reports' && req.method === 'POST') {
      return send(422, {
        error: 'this is your own single-user server, so there is no moderation team to receive a report. Blocking the account is the action that takes effect here.',
      });
    }

    // Bookmarks are this machine's own list: nothing federates, nothing is
    // told, which is what a bookmark means everywhere.
    const mBookmark = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(bookmark|unbookmark)$/.exec(pathname);
    if (mBookmark && req.method === 'POST') {
      const noteUrl = this.store.urlFor(mBookmark[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s) return send(404, { error: 'Record not found' });
      const updated = this.store.updateStatus(s.noteId, { bookmarked: mBookmark[2] === 'bookmark' });
      return send(200, this.status(updated || s));
    }
    if (pathname === '/api/v1/bookmarks' || pathname === '/api/v1/favourites') {
      const key = pathname.endsWith('bookmarks') ? 'bookmarked' : 'favourited';
      const all = this.store.getStatuses();
      const items = all.filter(s => s[key])
        .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
      const { items: page, headers } = this.page(items, url);
      return send(200, page.map(s => this.status(s, { all })), headers);
    }

    // Lists, filters and scheduled posts are the client's own arrangements —
    // kept in local state, nothing federates.
    const listJson = (l) => ({ id: l.id, title: l.title, replies_policy: l.repliesPolicy || 'list', exclusive: false });
    if (pathname === '/api/v1/lists' && req.method === 'GET') {
      return send(200, this.store.getLists().map(listJson));
    }
    if (pathname === '/api/v1/lists' && req.method === 'POST') {
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      if (!title) return send(422, { error: 'a title is required' });
      const lists = this.store.getLists();
      const l = { id: crypto.randomBytes(8).toString('hex'), title, repliesPolicy: body.replies_policy || 'list', members: [] };
      lists.push(l);
      this.store.setLists(lists);
      return send(200, listJson(l));
    }
    const mList = /^\/api\/v1\/lists\/([a-f0-9]+)$/.exec(pathname);
    if (mList) {
      const lists = this.store.getLists();
      const l = lists.find(x => x.id === mList[1]);
      if (!l) return send(404, { error: 'Record not found' });
      if (req.method === 'DELETE') {
        this.store.setLists(lists.filter(x => x.id !== mList[1]));
        return send(200, {});
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (body.title) l.title = String(body.title);
        if (body.replies_policy) l.repliesPolicy = body.replies_policy;
        this.store.setLists(lists);
      }
      return send(200, listJson(l));
    }
    const mListAcc = /^\/api\/v1\/lists\/([a-f0-9]+)\/accounts$/.exec(pathname);
    if (mListAcc) {
      const lists = this.store.getLists();
      const l = lists.find(x => x.id === mListAcc[1]);
      if (!l) return send(404, { error: 'Record not found' });
      if (req.method === 'GET') return send(200, (l.members || []).map(a => this.account(a)));
      const body = await readBody(req).catch(() => ({}));
      const ids = [].concat(body.account_ids || body['account_ids[]'] || url.searchParams.getAll('account_ids[]')).filter(Boolean);
      const actors = ids.map(id => this.store.urlFor(id)).filter(Boolean);
      if (req.method === 'POST') l.members = [...new Set([...(l.members || []), ...actors])];
      if (req.method === 'DELETE') l.members = (l.members || []).filter(a => !actors.includes(a));
      this.store.setLists(lists);
      return send(200, {});
    }
    const mListTl = /^\/api\/v1\/timelines\/list\/([a-f0-9]+)$/.exec(pathname);
    if (mListTl) {
      const l = this.store.getLists().find(x => x.id === mListTl[1]);
      if (!l) return send(404, { error: 'Record not found' });
      const members = new Set(l.members || []);
      const all = this.store.getStatuses();
      const items = all.filter(s => members.has(s.actor) || members.has(s.via))
        .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
      const { items: page, headers } = this.page(items, url);
      return send(200, page.map(s => this.statusOrBoost(s, { all })), headers);
    }

    // v2 filters: stored and served; the client applies them to what it shows.
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
      return send(200, this.store.getFilters().map(filterJson));
    }
    if (pathname === '/api/v2/filters' && req.method === 'POST') {
      const body = await readBody(req);
      const title = String(body.title || '').trim();
      if (!title) return send(422, { error: 'a title is required' });
      const filters = this.store.getFilters();
      const f = {
        id: crypto.randomBytes(8).toString('hex'), title,
        context: [].concat(body.context || ['home']),
        action: body.filter_action || 'warn', expiresAt: null,
        keywords: keywordsOf(body.keywords_attributes),
      };
      filters.push(f);
      this.store.setFilters(filters);
      return send(200, filterJson(f));
    }
    const mFilter = /^\/api\/v2\/filters\/([a-f0-9]+)$/.exec(pathname);
    if (mFilter) {
      const filters = this.store.getFilters();
      const f = filters.find(x => x.id === mFilter[1]);
      if (!f) return send(404, { error: 'Record not found' });
      if (req.method === 'DELETE') {
        this.store.setFilters(filters.filter(x => x.id !== mFilter[1]));
        return send(200, {});
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (body.title) f.title = String(body.title);
        if (body.context) f.context = [].concat(body.context);
        if (body.filter_action) f.action = body.filter_action;
        if (body.keywords_attributes) f.keywords = keywordsOf(body.keywords_attributes);
        this.store.setFilters(filters);
      }
      return send(200, filterJson(f));
    }

    if (pathname === '/api/v1/scheduled_statuses' && req.method === 'GET') {
      return send(200, this.store.getScheduled().map(e => this.scheduledJson(e)));
    }
    const mSched = /^\/api\/v1\/scheduled_statuses\/([a-f0-9]+)$/.exec(pathname);
    if (mSched) {
      const sched = this.store.getScheduled();
      const e = sched.find(x => x.id === mSched[1]);
      if (!e) return send(404, { error: 'Record not found' });
      if (req.method === 'DELETE') {
        this.store.setScheduled(sched.filter(x => x.id !== mSched[1]));
        return send(200, {});
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const at = Date.parse(body.scheduled_at || '');
        if (!Number.isFinite(at)) return send(422, { error: 'scheduled_at required' });
        e.scheduledAt = new Date(at).toISOString();
        this.store.setScheduled(sched);
      }
      return send(200, this.scheduledJson(e));
    }

    // Conversations: direct posts, grouped by who is in them.
    if (pathname === '/api/v1/conversations' && req.method === 'GET') {
      const all = this.store.getStatuses();
      const me = this.urls.actor;
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
        id: this.store.idFor('conversation:' + key),
        unread: false,
        accounts: [...(c.accounts.size ? c.accounts : [me])].map(a => this.account(a)),
        last_status: this.status(c.last, { all }),
      })));
    }

    const mPoll = /^\/api\/v1\/polls\/([a-f0-9]+)(\/votes)?$/.exec(pathname);
    if (mPoll) {
      const noteUrl = this.store.urlFor(mPoll[1]);
      const s = noteUrl && this.store.getStatuses().find(x => x.noteId === noteUrl);
      if (!s?.poll) return send(404, { error: 'Record not found' });
      if (mPoll[2] && req.method === 'POST') {
        const body = await readBody(req);
        const choices = [].concat(body.choices || body['choices[]'] || []).map(Number)
          .filter(Number.isInteger);
        if (!choices.length) return send(422, { error: 'choices required' });
        const r = await social.votePoll(this.agent, s, choices);
        if (!r.ok) return send(422, { error: r.error });
        return send(200, this.pollJson(this.store.getStatuses().find(x => x.noteId === noteUrl)));
      }
      return send(200, this.pollJson(s));
    }

    const mAction = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(favourite|unfavourite|reblog|unreblog)$/.exec(pathname);
    if (mAction && req.method === 'POST') {
      // Acting on a carried row acts on the post itself, as Mastodon does.
      const { s } = this.lookup(mAction[1]);
      if (!s) return send(404, { error: 'Record not found' });
      // Mirrored Bluesky posts are read-only: they are not AP objects, so a
      // Like or Announce has nothing to address.
      if (s.kind === 'bsky') return send(422, { error: 'this is a Bluesky post — open it on Bluesky to interact' });
      const updated = await social[mAction[2]](this.agent, s);
      return send(200, this.status(updated || s));
    }

    if (pathname === '/api/v1/notifications') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 60);
      let items = this.store.getNotifications();
      const maxId = url.searchParams.get('max_id');
      if (maxId) {
        const i = items.findIndex(n => n.id === maxId);
        if (i >= 0) items = items.slice(i + 1);
      }
      return send(200, items.slice(0, limit).map(n => this.notification(n)));
    }

    if (pathname === '/api/v1/markers') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const markers = this.store.read('masto-markers.json', {});
        for (const [k, v] of Object.entries(body)) {
          const lastId = v?.last_read_id || v;
          if (typeof lastId === 'string') {
            markers[k] = { last_read_id: lastId, version: (markers[k]?.version || 0) + 1, updated_at: new Date().toISOString() };
          }
        }
        this.store.write('masto-markers.json', markers);
        return send(200, markers);
      }
      return send(200, this.store.read('masto-markers.json', {}));
    }

    if (pathname === '/api/v1/accounts/relationships') {
      const ids = [...url.searchParams.getAll('id[]'), ...url.searchParams.getAll('id')];
      const rels = ids.map(id => this.store.urlFor(id)).filter(Boolean).map(u => this.relationship(u));
      return send(200, rels);
    }

    if (pathname === '/api/v1/accounts/search') {
      return send(200, await this.accountSearch(url.searchParams.get('q')));
    }

    if (pathname === '/api/v1/accounts/lookup') {
      const acct = String(url.searchParams.get('acct') || '').replace(/^@/, '');
      const cfg = this.store.getConfig();
      if (acct === cfg?.handle || acct === `${cfg?.handle}@${this.host}`) {
        return send(200, this.selfAccount());
      }
      const hit = Object.entries(this.store.getActors()).find(([u, a]) => {
        try { return `${a.preferredUsername}@${new URL(u).host}` === acct; } catch { return false; }
      });
      return hit ? send(200, this.account(hit[0])) : send(404, { error: 'Record not found' });
    }

    // Block and mute, from where the trouble is seen. A block also unfollows —
    // intake refuses a blocked author already — and a mute is view-only: their
    // posts stay out of the timelines, nothing federates.
    const mRel = /^\/api\/v1\/accounts\/([a-f0-9]+)\/(block|unblock|mute|unmute)$/.exec(pathname);
    if (mRel && req.method === 'POST') {
      const actorUrl = this.store.urlFor(mRel[1]);
      if (!actorUrl) return send(404, { error: 'Record not found' });
      if (mRel[2] === 'block' || mRel[2] === 'unblock') {
        const b = this.store.getBlocklist();
        if (mRel[2] === 'block' && !b.actors.includes(actorUrl)) b.actors.push(actorUrl);
        if (mRel[2] === 'unblock') b.actors = b.actors.filter(a => a !== actorUrl);
        this.store.setBlocklist(b);
        if (mRel[2] === 'block') await social.unfollowActor(this.agent, actorUrl).catch(() => {});
      } else {
        const m = this.store.getMuted();
        if (mRel[2] === 'mute' && !m.actors.includes(actorUrl)) m.actors.push(actorUrl);
        if (mRel[2] === 'unmute') m.actors = m.actors.filter(a => a !== actorUrl);
        this.store.setMuted(m);
      }
      return send(200, this.relationship(actorUrl));
    }

    const mFollow = /^\/api\/v1\/accounts\/([a-f0-9]+)\/(follow|unfollow)$/.exec(pathname);
    if (mFollow && req.method === 'POST') {
      const actorUrl = this.store.urlFor(mFollow[1]);
      if (!actorUrl) return send(404, { error: 'Record not found' });
      if (mFollow[2] === 'follow') await social.followActor(this.agent, actorUrl);
      else await social.unfollowActor(this.agent, actorUrl).catch(() => {});   // already-gone is fine
      return send(200, this.relationship(actorUrl));
    }

    const mAccount = /^\/api\/v1\/accounts\/([a-f0-9]+)$/.exec(pathname);
    if (mAccount && req.method === 'GET') {
      const actorUrl = this.store.urlFor(mAccount[1]);
      return actorUrl ? send(200, this.account(actorUrl)) : send(404, { error: 'Record not found' });
    }
    // Web push: one subscription per client login. The agent pushes payloads
    // to the browser's push service itself, so a closed client still hears.
    if (pathname === '/api/v1/push/subscription') {
      const token = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
      if (!token) return send(401, { error: 'The access token is invalid' });
      if (req.method === 'GET') {
        const sub = this.push.get(token);
        return sub ? send(200, this.push.json(token, sub)) : send(404, { error: 'Record not found' });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const sub = this.push.set(token, {
          endpoint: body.subscription?.endpoint,
          keys: body.subscription?.keys,
          alerts: body.data?.alerts,
        });
        if (!sub) return send(422, { error: 'a https endpoint and p256dh/auth keys are required' });
        return send(200, this.push.json(token, sub));
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const sub = this.push.setAlerts(token, body.data?.alerts);
        return sub ? send(200, this.push.json(token, sub)) : send(404, { error: 'Record not found' });
      }
      if (req.method === 'DELETE') {
        this.push.drop(token);
        return send(200, {});
      }
    }
    if (/^\/api\/v1\/accounts\/[a-f0-9]+\/featured_tags$/.test(pathname)) return send(200, []);

    // The counts these back are rendered from the same two arrays (see
    // `account`), so a client that shows a number here can always open it.
    const mAccList = /^\/api\/v1\/accounts\/([a-f0-9]+)\/(following|followers)$/.exec(pathname);
    if (mAccList && req.method === 'GET') {
      const actorUrl = this.store.urlFor(mAccList[1]);
      if (!actorUrl) return send(404, { error: 'Record not found' });
      // Only our own lists are known. A remote actor's collections live on its
      // own server, and opening a profile is not worth a fetch of a stranger's
      // pod — an empty list, not an error, is what the API can honestly say.
      const mine = actorUrl === this.urls?.actor;
      const c = this.store.getContacts();
      // Reversed: the contact arrays append, and page()'s cursors read
      // newest-first — fed as stored, since_id answered with its complement.
      const recs = (!mine ? []
        : mAccList[2] === 'followers' ? c.followers
          : c.following.filter(f => f.accepted))   // pending is not following
        .slice().reverse();
      const { items, headers } = this.page(recs, url,
        { limit: 40, max: 80, idOf: (r) => this.store.idFor(r.actor) });
      return send(200, items.map(r => this.account(r.actor)), headers);
    }

    // Who among the people I follow also follows THEM — a graph we do not hold,
    // and the shape is an entry per requested account, not a bare list.
    if (pathname === '/api/v1/accounts/familiar_followers') {
      const ids = [...url.searchParams.getAll('id[]'), ...url.searchParams.getAll('id')];
      return send(200, ids.map(id => ({ id, accounts: [] })));
    }

    const mAccStatuses = /^\/api\/v1\/accounts\/([a-f0-9]+)\/statuses$/.exec(pathname);
    if (mAccStatuses) {
      const actorUrl = this.store.urlFor(mAccStatuses[1]);
      const all = this.store.getStatuses();
      const pinnedOnly = url.searchParams.get('pinned') === 'true';
      const { items, headers } = this.page(
        all.filter(s => s.actor === actorUrl && (!pinnedOnly || s.pinned)), url);
      return send(200, items.map(s => this.statusOrBoost(s, { all })), headers);
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
          const doc = await social.resolveHandle(this.agent, q);
          out.accounts.push(this.account(doc.id));
        } catch (e) { this.log(`search resolve ${q}: ${e.message}`); }
      } else if (/^https?:\/\//.test(q)) {
        const doc = await this.agent.intake.fetchAP(q).catch(() => null);
        if (doc?.type === 'Person' && doc.id) out.accounts.push(this.account(doc.id));
        else if (doc?.type === 'Note' && doc.id) {
          let s = this.store.getStatuses().find(x => x.noteId === doc.id);
          // Third site of the same rule: the note's own origin has to vouch for
          // the author before we store one. The owner chose the URL, but the
          // document at it still names whoever it likes.
          const author = authorOf(doc);
          if (!s && author) {
            s = {
              noteId: doc.id, actor: author, content: sanitizeHtml(doc.content),
              published: doc.published, inReplyTo: doc.inReplyTo, kind: 'remote',
            };
            this.store.addStatus(s);
          }
          if (s) out.statuses.push(this.status(s));
        }
      } else if (q) {
        const needle = q.toLowerCase();
        if (type !== 'accounts') {
          const all = this.store.getStatuses();
          out.statuses = all
            .filter(s => (s.content || '').toLowerCase().includes(needle)).slice(0, 20)
            .map(s => this.status(s, { all }));
        }
        if (type !== 'statuses') out.accounts = await this.accountSearch(q);
      }
      return send(200, out);
    }

    // Media upload: file → remote pod /ap/media/ (public-Read), entry in the
    // media registry so a later POST /statuses can attach it.
    if ((pathname === '/api/v2/media' || pathname === '/api/v1/media') && req.method === 'POST') {
      const { fields, file } = await readMultipart(req);
      if (!file?.data?.length) return send(422, { error: 'file required' });
      // The client said what this is, and we used to believe it. The media
      // container is world-readable and sits on the pod's own origin — the same
      // origin as the WebID and the ACLs — so a file stored as text/html is a
      // page served from your identity, and script in it runs as you in any
      // browser already logged into that pod. A bearer is not "only you": the
      // facade exists so third-party clients can connect, tokens last 90 days,
      // and no scope is enforced. So any client you authorize could leave that
      // page behind.
      const mediaType = attachmentType(file.contentType);
      const ext = extensionFor(mediaType, file.filename);
      const slug = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      const mediaUrl = this.urls.media + slug;
      await this.agent.publisher.ensureMediaContainer();
      await this.agent.remote.put(mediaUrl, file.data, mediaType);
      const entry = { url: mediaUrl, mediaType, description: fields.description || '' };
      const id = this.store.idFor(mediaUrl);
      this.store.setMedia(id, entry);
      return send(200, this.mediaJson({ id, ...entry }));
    }
    const mMedia = /^\/api\/v1\/media\/([a-f0-9]+)$/.exec(pathname);
    if (mMedia) {
      const entry = this.store.getMedia()[mMedia[1]];
      if (!entry) return send(404, { error: 'Record not found' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (typeof body.description === 'string') {
          entry.description = body.description;
          this.store.setMedia(mMedia[1], entry);
        }
      }
      return send(200, this.mediaJson({ id: mMedia[1], ...entry }));
    }

    this.log(`mastoapi: unhandled ${req.method} ${pathname} — punch list`);
    return send(404, { error: `Unimplemented: ${req.method} ${pathname}` });
  }
}

function instanceConfig() {
  return {
    statuses: { max_characters: 5000, max_media_attachments: 4, characters_reserved_per_url: 23 },
    media_attachments: {
      supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg'],
      image_size_limit: 10 * 1024 * 1024, video_size_limit: 40 * 1024 * 1024,
      image_matrix_limit: 16777216, video_matrix_limit: 2304000,
    },
    polls: { max_options: 0 },
    accounts: { max_featured_tags: 0 },
  };
}

// 1x1 transparent PNG — placeholder avatar/header for accounts without icons.
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// scrypt check for the optional UI password ({ saltHex, hashHex } record —
// see hashPassword, used by the passwd CLI).
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return { saltHex: salt.toString('hex'), hashHex: hash.toString('hex') };
}
function checkPassword(rec, password) {
  try {
    const hash = crypto.scryptSync(String(password), Buffer.from(rec.saltHex, 'hex'), 32);
    return crypto.timingSafeEqual(hash, Buffer.from(rec.hashHex, 'hex'));
  } catch { return false; }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The authorize login page: every original OAuth param rides along as a
// hidden field so the POST can complete the flow.
function sendLoginForm(res, params, error = '') {
  const hidden = [...params.entries()].filter(([k]) => k !== 'password')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('\n');
  res.writeHead(error ? 401 : 200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Solid ActivityPub — log in</title>
<style>:root{color-scheme:light dark;font-size:20px;--heading:#1a4f8a}
body{font:1rem system-ui,sans-serif;max-width:22rem;margin:15vh auto;padding:0 1rem}
h1{color:var(--heading)}
@media (prefers-color-scheme:dark){:root{--heading:#7fb3e8}}
input,button{font:inherit;width:100%;padding:.5rem;margin:.3rem 0;box-sizing:border-box}
.err{color:#b00020}
@media (prefers-color-scheme:dark){.err{color:#ff8a8a}}</style></head><body>
<h1>Solid ActivityPub</h1>
<p>Enter the agent password to authorize this client.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="POST" action="/oauth/authorize">
${hidden}
<label for="password">Agent password</label>
<input type="password" id="password" name="password" autofocus autocomplete="current-password">
<button type="submit">Authorize</button>
</form></body></html>`);
  return true;
}

// Minimal multipart/form-data reader for media uploads: string fields plus
// at most one file part (Mastodon's media endpoints send exactly one).
const selfIcon = (api, self, cached) =>
  (self ? api.store.getConfig()?.icon : null) || cached.icon;

function readMultipart(req, limit = 12e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(req.headers['content-type'] || ''));
        if (!m) return resolve({ fields: {}, file: null });
        const buf = Buffer.concat(chunks);
        const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
        const fields = {};
        // `file` is the last one seen, which is what the single-file media
        // upload wants. `files` keys them by field name, because the profile
        // editor submits an avatar and a header in one request.
        const files = {};
        let file = null;
        let i = buf.indexOf(boundary);
        while (i >= 0) {
          const start = i + boundary.length;
          if (buf.slice(start, start + 2).toString() === '--') break;
          const next = buf.indexOf(boundary, start);
          if (next < 0) break;
          const part = buf.slice(start + 2, next - 2);        // strip the CRLFs framing the part
          const sep = part.indexOf('\r\n\r\n');
          if (sep >= 0) {
            const head = part.slice(0, sep).toString();
            const body = part.slice(sep + 4);
            const name = /name="([^"]*)"/.exec(head)?.[1];
            const filename = /filename="([^"]*)"/.exec(head)?.[1];
            if (filename !== undefined) {
              file = {
                filename,
                contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() || 'application/octet-stream',
                data: body,
              };
              if (name) files[name] = file;
            } else if (name) fields[name] = body.toString();
          }
          i = next;
        }
        resolve({ fields, file, files });
      } catch (e) { reject(e); }
    });
  });
}

// Accepts JSON or form-encoded bodies (OAuth posts are often form-encoded).
// The source of a post that predates raw-text storage: its HTML back to
// typed text, near enough to edit.
function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      // Destroying the socket without settling left the awaiting handler
      // pending for the life of the process and the client waiting on a
      // response that would never come.
      if (data.length > 1e6) { req.destroy(); reject(new Error('request body too large')); }
    });
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.includes('application/json')) return resolve(data ? JSON.parse(data) : {});
        resolve(Object.fromEntries(new URLSearchParams(data)));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
