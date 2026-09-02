// acctfeed.mjs — polls each connected fediverse account's home timeline and
// notifications and merges them into the statuses index as kind 'acct'. View
// cache only: none of it is written to the pod, which holds followed and own
// content. Modeled on bskyfeed.mjs, which is modeled on tagfeed.mjs.
//
// A note is NOT re-fetched at its origin before being stored. The dereference
// rule guards material an unauthenticated stranger chose for us; this is the
// owner's own authenticated account answering with the result of the owner's
// own follow decisions there — the same trust anchor that lets bskyfeed skip
// it. A local block still applies, because that is the owner's decision.
//
// Config in fediacctfeed.json: { intervalMin, accounts: { <id>: marks } }.

import { sanitizeHtml } from './wire.mjs';

const DEFAULTS = { intervalMin: 5 };
const PER_SWEEP = 40;
const MAX_PER_ACCT = 150;
const MAX_ACCT_ENTRIES = 400;
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 2 * 60 * 60_000;
// Mastodon allows 300 requests per five minutes per token. Four go per sweep,
// so the floor is only ever reached by something else using the same token.
const RATE_FLOOR = 20;

const MEDIA_TYPES = {
  image: 'image/jpeg', gifv: 'image/gif', video: 'video/mp4', audio: 'audio/mpeg',
};

export class AcctFeed {
  constructor({ store, accounts, log = console.log, onNotification = null }) {
    Object.assign(this, { store, accounts, log, onNotification });
    this.state = new Map();          // account id → { failures, quietUntil }
    this.lastSweep = null;
    this.lastAdded = 0;
  }

  config() { return { ...DEFAULTS, ...this.store.read('fediacctfeed.json', {}) }; }

  setConfig(patch) {
    const clean = {};
    if (patch.intervalMin) clean.intervalMin = Math.max(1, Number(patch.intervalMin) || DEFAULTS.intervalMin);
    this.store.write('fediacctfeed.json', { ...this.config(), ...clean });
    this.stop();
    this.start();
    return this.config();
  }

  marks(id) { return this.config().accounts?.[id] || {}; }

  setMarks(id, patch) {
    const cfg = this.config();
    this.store.write('fediacctfeed.json', {
      ...cfg, accounts: { ...(cfg.accounts || {}), [id]: { ...(cfg.accounts?.[id] || {}), ...patch } },
    });
  }

  start() {
    this.stopped = false;
    this.sweep().catch(e => this.log(`acctfeed: ${e.message}`));
    const tick = () => {
      this.timer = setTimeout(() => {
        this.sweep()
          .catch(e => this.log(`acctfeed: ${e.message}`))
          .finally(() => { if (!this.stopped) tick(); });
      }, Math.round(this.config().intervalMin * 60_000 * (0.85 + Math.random() * 0.3)));
      this.timer.unref?.();
    };
    tick();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }

  // Per account, not per feed: one server being down must not silence the rest.
  _stateOf(id) {
    if (!this.state.has(id)) this.state.set(id, { failures: 0, quietUntil: 0 });
    return this.state.get(id);
  }

  _backOff(id, handle, status, retryAfter) {
    const st = this._stateOf(id);
    st.failures += 1;
    const ladder = Math.min(BACKOFF_MIN_MS * 2 ** (st.failures - 1), BACKOFF_MAX_MS);
    const wait = retryAfter || Math.round(ladder * (0.85 + Math.random() * 0.3));
    st.quietUntil = Date.now() + wait;
    this.log(`acctfeed: ${handle} ${status ? `answered ${status}` : 'did not answer'} — not asking again for ${Math.round(wait / 60_000)} min`);
  }

  // One author into the shared actor cache. `uri` is the ActivityPub id, so a
  // person the pod already knows from its own inbox stays one actor here.
  _rememberAuthor(a) {
    const url = a?.uri || a?.url;
    if (!url) return null;
    if (!this.store.getActors()[url]) {
      this.store.cacheActor(url, {
        name: a.display_name || a.username, preferredUsername: a.username,
        icon: a.avatar || null, type: a.bot ? 'Service' : 'Person',
      });
    }
    return url;
  }

  // One Mastodon status into the statuses index. Never pre-checks for a
  // duplicate: a repeat sighting is what carries the second account's
  // provenance, and addStatus is the only thing that knows how to merge it.
  _mirror(st, { acct, via = null, parents = null }) {
    const noteId = st.uri;
    if (!noteId) return false;
    const actor = this._rememberAuthor(st.account);
    if (!actor || this.store.isBlocked(actor)) return false;
    const inReplyTo = st.in_reply_to_id ? parents?.get(String(st.in_reply_to_id)) : null;
    const out = this.store.addStatus({
      noteId, actor,
      content: sanitizeHtml(st.content || ''),
      published: st.created_at,
      kind: 'acct',
      sourceAccts: [{ acct, remoteId: String(st.id) }],
      ...(st.url && st.url !== noteId ? { link: st.url } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(via ? { via } : {}),
      ...(st.spoiler_text ? { spoiler: st.spoiler_text } : {}),
      ...(st.media_attachments?.length ? {
        attachments: st.media_attachments.map(m => ({
          url: m.url, mediaType: MEDIA_TYPES[m.type] || 'image/jpeg', description: m.description || '',
        })),
      } : {}),
    });
    return !!out?.added;
  }

  // Mastodon threads by its own local ids, which mean nothing anywhere else.
  // A parent we already hold from this same account can be resolved locally,
  // and one we do not hold simply has no parent here rather than a fetch.
  _parentMap(acct) {
    const map = new Map();
    for (const s of this.store.getStatuses()) {
      for (const v of s.sourceAccts || []) {
        if (v.acct === acct && v.remoteId) map.set(String(v.remoteId), s.noteId);
      }
    }
    return map;
  }

  _rateGuard(id, handle, res) {
    const left = Number(res.headers.get('x-ratelimit-remaining'));
    if (!Number.isFinite(left) || left > RATE_FLOOR) return false;
    const reset = Date.parse(res.headers.get('x-ratelimit-reset') || '');
    const wait = Number.isFinite(reset) ? Math.max(0, reset - Date.now()) : BACKOFF_MIN_MS;
    this._stateOf(id).quietUntil = Date.now() + wait;
    this.log(`acctfeed: ${handle} has ${left} requests left — waiting ${Math.round(wait / 1000)}s`);
    return true;
  }

  async sweep() {
    const rows = (this.accounts?.list() || []).filter(r => r.token && r.enabled !== false);
    if (!rows.length) return;
    this.lastSweep = new Date().toISOString();
    let added = 0;
    // The 300ms debounce cannot coalesce a sweep that awaits between items —
    // every fetch outlives it — so the whole sweep is one commit boundary.
    // Without this, statuses.json is serialized whole once per post.
    this.store.hold();
    try {
      for (const rec of rows) {
        if (this.stopped) break;
        added += await this._sweepOne(rec).catch((e) => {
          this._backOff(rec.id, rec.handle, e.status || 0, null);
          return 0;
        });
      }
      this._prune();
    } finally {
      this.store.release();
    }
    this.lastAdded = added;
    if (added) this.log(`acctfeed: +${added} from ${rows.length} connected account(s)`);
  }

  async _sweepOne(rec) {
    const st = this._stateOf(rec.id);
    if (st.quietUntil && Date.now() < st.quietUntil) return 0;
    const marks = this.marks(rec.id);
    const parents = this._parentMap(rec.id);
    let added = 0;

    const homeQ = marks.homeSinceId ? `&since_id=${encodeURIComponent(marks.homeSinceId)}` : '';
    const homeRes = await this.accounts.api(rec.id, `/api/v1/timelines/home?limit=${PER_SWEEP}${homeQ}`);
    if (this._rateGuard(rec.id, rec.handle, homeRes)) return 0;
    const home = await homeRes.json().catch(() => []);
    if (!Array.isArray(home)) throw new Error(`${rec.handle} answered with no timeline`);
    for (const item of home) {
      if (item?.reblog) {
        // A boost: the inner post is the content, the booster is the carrier —
        // the same envelope statusOrBoost already renders for our own timeline.
        const via = this._rememberAuthor(item.account);
        if (this._mirror(item.reblog, { acct: rec.id, via, parents })) added++;
      } else if (item?.uri) {
        if (this._mirror(item, { acct: rec.id, parents })) added++;
      }
    }
    // Mastodon returns newest first, so the first row is the new mark.
    // Ids are 19-digit snowflakes: opaque strings, never numbers.
    if (home.length && home[0]?.id) this.setMarks(rec.id, { homeSinceId: String(home[0].id) });

    const notifQ = marks.notifSinceId ? `&since_id=${encodeURIComponent(marks.notifSinceId)}` : '';
    const notifRes = await this.accounts.api(rec.id, `/api/v1/notifications?limit=${PER_SWEEP}${notifQ}`);
    if (this._rateGuard(rec.id, rec.handle, notifRes)) return added;
    const notes = await notifRes.json().catch(() => []);
    if (Array.isArray(notes)) {
      for (const n of notes) {
        if (!n?.account || String(n.account.id) === String(rec.accountId)) continue;
        const actor = this._rememberAuthor(n.account);
        if (!actor || this.store.isBlocked(actor)) continue;
        // The post a favourite or boost is about is one of this account's own,
        // so it is mirrored first — a notification pointing at nothing is a
        // row the client drops.
        if (n.status?.uri) this._mirror(n.status, { acct: rec.id, parents });
        if (n.type === 'favourite' || n.type === 'reblog') {
          this.store.addNotification({
            type: n.type === 'favourite' ? 'favourite' : 'reblog',
            actor, noteId: n.status?.uri, via: rec.id,
          });
        } else if (n.type === 'follow' || n.type === 'follow_request') {
          this.store.addNotification({ type: 'follow', actor, via: rec.id });
          await this.onNotification?.(n, { actor, acct: rec.id });
        } else if (n.type === 'mention') {
          this.store.addNotification({ type: 'mention', actor, noteId: n.status?.uri, via: rec.id });
          await this.onNotification?.(n, { actor, acct: rec.id });
        }
      }
      if (notes.length && notes[0]?.id) this.setMarks(rec.id, { notifSinceId: String(notes[0].id) });
    }

    st.failures = 0;
    return added;
  }

  // Two caps. The per-account one keeps a busy account from crowding out a
  // quiet one; the total keeps every connected account together from evicting
  // the pod's own posts and the timeline it already had.
  _prune() {
    const all = this.store.getStatuses();
    const mine = all.filter(s => s.kind === 'acct');
    if (!mine.length) return;
    const drop = new Set();
    const seen = new Map();
    for (const s of mine) {
      const acct = s.sourceAccts?.[0]?.acct || '?';
      const n = (seen.get(acct) || 0) + 1;
      seen.set(acct, n);
      if (n > MAX_PER_ACCT) drop.add(s.noteId);
    }
    for (const s of mine.slice(MAX_ACCT_ENTRIES)) drop.add(s.noteId);
    if (!drop.size) return;
    this.store.write('statuses.json', all.filter(s => !drop.has(s.noteId)));
  }
}
