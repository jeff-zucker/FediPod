// bskyfeed.mjs — mirrors the connected Bluesky account's home timeline and
// notifications into the statuses index as kind 'bsky'. View cache only — none
// of it is written to the pod; the pod holds fediverse content.
//
// Config in bskyfeed.json: { intervalMin }. The poll is authed XRPC against
// the account's own PDS, so the politeness dial is the account's own rate
// budget — backed off the same way tagfeed backs off a stranger's instance.

const DEFAULTS = { intervalMin: 5 };
const PER_SWEEP = 30;
const MAX_BSKY_ENTRIES = 200;
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 2 * 60 * 60_000;

export const profileUrl = (did) => `https://bsky.app/profile/${did}`;
export const postUrl = (uri) => {
  const m = String(uri).match(/^at:\/\/([^/]+)\/[^/]+\/(.+)$/);
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null;
};

export class BskyFeed {
  constructor({ store, atproto, log = console.log, onNotification = null }) {
    Object.assign(this, { store, atproto, log, onNotification });
    this.lastSweep = null;
    this.lastAdded = 0;
  }

  config() { return { ...DEFAULTS, ...this.store.read('bskyfeed.json', {}) }; }

  setConfig(patch) {
    const clean = {};
    if (patch.intervalMin) clean.intervalMin = Math.max(1, Number(patch.intervalMin) || DEFAULTS.intervalMin);
    this.store.write('bskyfeed.json', { ...this.config(), ...clean });
    this.stop();
    this.start();
    return this.config();
  }

  start() {
    this.stopped = false;
    this.sweep().catch(e => this.log(`bskyfeed: ${e.message}`));
    const tick = () => {
      this.timer = setTimeout(() => {
        this.sweep()
          .catch(e => this.log(`bskyfeed: ${e.message}`))
          .finally(() => { if (!this.stopped) tick(); });
      }, Math.round(this.config().intervalMin * 60_000 * (0.85 + Math.random() * 0.3)));
      this.timer.unref?.();
    };
    tick();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); }

  _backOff(status, retryAfter) {
    this.failures = (this.failures || 0) + 1;
    const ladder = Math.min(BACKOFF_MIN_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    const wait = retryAfter || Math.round(ladder * (0.85 + Math.random() * 0.3));
    this.quietUntil = Date.now() + wait;
    this.log(`bskyfeed: ${status ? `bluesky answered ${status}` : 'bluesky did not answer'} — not asking again for ${Math.round(wait / 60_000)} min`);
  }

  // One author into the shared actor cache, under a page anyone can open.
  _rememberAuthor(a) {
    const url = profileUrl(a.did);
    if (!this.store.getActors()[url]) {
      this.store.cacheActor(url, {
        name: a.displayName || a.handle, preferredUsername: a.handle,
        icon: a.avatar || null, type: 'Person',
      });
    }
    return url;
  }

  // One Bluesky post into the statuses index. Returns its noteId, new or not.
  _mirrorPost(post, { via = null } = {}) {
    const noteId = post.uri;
    const existing = this.store.getStatuses().some(s => s.noteId === noteId);
    if (existing) return { noteId, added: false };
    const actor = this._rememberAuthor(post.author);
    if (this.store.isBlocked(actor)) return { noteId, added: false };
    const text = post.record?.text || '';
    const images = post.embed?.images || [];
    this.store.addStatus({
      noteId, actor,
      content: `<p>${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</p>`,
      published: post.record?.createdAt || post.indexedAt,
      kind: 'bsky',
      ...(post.cid ? { cid: post.cid } : {}),
      link: postUrl(noteId),
      ...(via ? { via } : {}),
      ...(images.length ? {
        attachments: images.map(i => ({ url: i.fullsize, mediaType: 'image/jpeg', description: i.alt || '' })),
      } : {}),
    });
    return { noteId, added: true };
  }

  async sweep() {
    if (!this.atproto?.connected()) return;
    if (this.quietUntil && Date.now() < this.quietUntil) return;
    this.lastSweep = new Date().toISOString();
    const self = this.atproto.read()?.did;
    let added = 0;
    try {
      // Our own CROSS-POSTS must not echo back into the feed — but a post or
      // reply written natively on Bluesky is ours to see here too. The mirrors
      // are known by uri, so only they are skipped.
      const ownMirrors = new Set(this.store.getStatuses().map(s => s.atproto?.uri).filter(Boolean));
      const tl = await this.atproto.xrpc('app.bsky.feed.getTimeline', { params: { limit: PER_SWEEP } });
      for (const item of tl.feed || []) {
        if (!item?.post?.uri) continue;
        if (item.post.author?.did === self && ownMirrors.has(item.post.uri)) continue;
        const via = item.reason?.$type === 'app.bsky.feed.defs#reasonRepost' && item.reason.by
          ? this._rememberAuthor(item.reason.by) : null;
        if (this._mirrorPost(item.post, { via }).added) added++;
      }

      // Only notifications newer than the last sweep's high-water mark are
      // acted on — the list is a window, not a queue, and re-reading it must
      // not re-fire the group hooks.
      const seen = this.store.read('bskyfeed.json', {}).lastNotifiedAt || '';
      let high = seen;
      const nots = await this.atproto.xrpc('app.bsky.notification.listNotifications', { params: { limit: PER_SWEEP } });
      for (const n of nots.notifications || []) {
        if (!n?.author?.did || n.author.did === self) continue;
        if (n.indexedAt) {
          if (seen && n.indexedAt <= seen) continue;
          if (n.indexedAt > high) high = n.indexedAt;
        }
        const actor = this._rememberAuthor(n.author);
        // A like or repost points at OUR mirror; the notification should point
        // at the pod post it mirrors, which is the one the client can open.
        if (n.reason === 'like' || n.reason === 'repost') {
          const mine = this.store.getStatuses().find(s => s.atproto?.uri === n.reasonSubject);
          if (!mine) continue;
          this.store.addNotification({
            type: n.reason === 'like' ? 'favourite' : 'reblog',
            actor, noteId: mine.noteId, bsky: true,
          });
        } else if (n.reason === 'follow') {
          this.store.addNotification({ type: 'follow', actor, bsky: true });
          await this.onNotification?.(n, { actor });
        } else if (n.reason === 'mention' || n.reason === 'reply') {
          const record = { uri: n.uri, cid: n.cid, author: n.author, record: n.record, indexedAt: n.indexedAt };
          this._mirrorPost(record);
          this.store.addNotification({ type: 'mention', actor, noteId: n.uri, bsky: true });
          await this.onNotification?.(n, { actor });
        }
      }
      if (high && high !== seen) this.store.write('bskyfeed.json', { ...this.config(), lastNotifiedAt: high });
      this.failures = 0;
    } catch (e) {
      this._backOff(e.status || 0, null);
      return;
    }
    const all = this.store.getStatuses();
    const mirrored = all.filter(s => s.kind === 'bsky');
    if (mirrored.length > MAX_BSKY_ENTRIES) {
      const drop = new Set(mirrored.slice(MAX_BSKY_ENTRIES).map(s => s.noteId));
      this.store.write('statuses.json', all.filter(s => !drop.has(s.noteId)));
    }
    this.lastAdded = added;
    if (added) this.log(`bskyfeed: +${added} from the bluesky timeline`);
  }
}
