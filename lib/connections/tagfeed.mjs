// tagfeed.mjs — topical firehose for a single-actor instance: polls public
// no-auth hashtag timelines on a configured instance and mirrors NEW notes
// into the statuses index as kind 'tag'. View cache only — tag content is
// NOT written to the pod; the pod holds followed/own content.
//
// Config in tagfeed.json: { instance, tags: [...], intervalMin }. Every note
// is still verified by dereference at its origin before it is mirrored.

import { isContentType, authorOf } from '../core/intake/index.mjs';

// A public timeline page from somebody else's instance. Generous for 20 posts,
// and a bound where there was none.
const MAX_TIMELINE_BYTES = 2 * 1024 * 1024;

// Two tags from each of six subjects, so a new account reads something on the
// first morning without having followed anybody. Deliberately even: a busy
// subject and a quiet one get the same number of places, and the sweep below
// makes sure the busy ones cannot take the quiet ones' turns as well.
const DEFAULTS = {
  instance: 'https://mastodon.social',
  tags: [
    'fediverse', 'activitypub',                  // the network this account is on
    'opensource', 'foss',                        // how the software gets made
    'solidproject', 'linkeddata',                // where the data lives
    'privacy', 'digitalrights',                  // what is at stake
    'indieweb', 'smallweb',                      // publishing for yourself
    'commons', 'platformcooperativism',          // owning it together
  ],
  intervalMin: 15,
};
const PER_TAG = 20;              // statuses requested per tag per sweep
const MAX_NEW_PER_SWEEP = 8;     // dereference budget per sweep — stay light
// …and no one tag may take more than this much of it. Without a per-tag share
// the budget was spent in list order: the first two or three busy tags used it
// all and everything below them never appeared once, however long you waited.
const MAX_NEW_PER_TAG = 2;
// Only this many tags are polled in any one sweep, taken in turn. A sweep holds
// its writes until it finishes — so on the browser build, where the agent lives
// in a service worker the browser is free to kill whenever it likes, a sweep
// that runs long enough to be killed contributes NOTHING. Twelve tags was long
// enough: a new account could open the app repeatedly and still see an empty
// timeline. Four finishes. The list is still covered, three sweeps at a time,
// and a sweep now costs the gateway less than the three-tag one it replaced.
const TAGS_PER_SWEEP = 4;
const MAX_TAG_ENTRIES = 200;     // oldest tag entries pruned beyond this
// The instance here is a stranger's server we poll on our own schedule, and it
// has no other way to tell us to stop.
const BACKOFF_MIN_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * 60 * 60_000;
const instanceRefusal = (status) => (status ? `the instance answered ${status}` : 'the instance did not answer');

export class TagFeed {
  constructor({ store, intake, log = console.log, fetcher = globalThis.fetch }) {
    Object.assign(this, { store, intake, log, fetcher });
    this.lastSweep = null;
    this.lastAdded = 0;
    // Where this sweep starts in the tag list. It moves on by one each time, so
    // when the budget does run out it is a different tag that goes without.
    this.cursor = 0;
  }

  config() { return { ...DEFAULTS, ...this.store.read('tagfeed.json', {}) }; }

  setConfig(patch) {
    const clean = {};
    if (patch.instance) clean.instance = String(patch.instance).replace(/\/+$/, '');
    if (Array.isArray(patch.tags)) clean.tags = patch.tags.map(t => String(t).replace(/^#/, '').trim()).filter(Boolean);
    if (patch.intervalMin) clean.intervalMin = Math.max(5, Number(patch.intervalMin) || DEFAULTS.intervalMin);
    this.store.write('tagfeed.json', { ...this.config(), ...clean });
    this.stop();
    this.start();
    return this.config();
  }

  // `lastSweptAt` and `onSwept` are for a browser worker the browser stops and
  // restarts: it keeps the time of its last sweep, so a restart sweeps only
  // when the interval is due rather than on every wake.
  start({ lastSweptAt = 0, onSwept = null } = {}) {
    this.stopped = false;                     // restartable, the same way Intake.start is
    const sweep = () => this.sweep()
      .catch(e => this.log(`tagfeed: ${e.message}`))
      .finally(() => onSwept?.(Date.now()));
    // Jittered and self-scheduling: every agent polling the same instance on
    // the same 15-minute boundary is a beat nobody asked for.
    const every = () => Math.round(this.config().intervalMin * 60_000 * (0.85 + Math.random() * 0.3));
    const tick = (ms) => {
      this.timer = setTimeout(() => { sweep().finally(() => { if (!this.stopped) tick(every()); }); }, ms);
      this.timer.unref?.();
    };
    const due = lastSweptAt + this.config().intervalMin * 60_000 - Date.now();
    if (due > 0) { tick(due); return; }
    sweep();
    tick(every());
  }

  // The flag is what makes this stick. Clearing the timer only cancels a sweep
  // that has not started: one already in flight re-arms itself in `finally`,
  // and `this.stopped` was read there but never written — so a stop landing
  // mid-sweep leaked that chain for the life of the process. Intake has had the
  // flag all along; this is the same shape.
  stop() { this.stopped = true; clearTimeout(this.timer); }

  // Jittered exponential, capped, and cleared by an instance that answers.
  // The next sweep is skipped rather than the timer stretched, so the tag
  // config keeps meaning what it says once the far end is well again.
  _backOff(status, retryAfter) {
    this.failures = (this.failures || 0) + 1;
    const ladder = Math.min(BACKOFF_MIN_MS * 2 ** (this.failures - 1), BACKOFF_MAX_MS);
    const wait = retryAfter || Math.round(ladder * (0.85 + Math.random() * 0.3));
    this.quietUntil = Date.now() + wait;
    this.log(`tagfeed: ${instanceRefusal(status)} — not asking again for ${Math.round(wait / 60_000)} min`);
  }

  async sweep() {
    const { instance, tags } = this.config();
    if (!tags.length) return;
    if (this.quietUntil && Date.now() < this.quietUntil) {
      this.log(`tagfeed: still backing off for ${Math.round((this.quietUntil - Date.now()) / 60_000)} min`);
      return;
    }
    this.lastSweep = new Date().toISOString();
    const known = new Set(this.store.getStatuses().map(s => s.noteId));
    let budget = MAX_NEW_PER_SWEEP;
    let added = 0;
    // A different handful every time, taken in turn, so no tag is permanently
    // first and none is permanently last.
    const start = this.cursor % tags.length;
    this.cursor = (start + TAGS_PER_SWEEP) % tags.length;
    const order = [...tags, ...tags].slice(start, start + Math.min(TAGS_PER_SWEEP, tags.length));
    // The store's 300ms debounce cannot coalesce a sweep that awaits between
    // items — every note costs a fetch to somebody else's server, which outlives
    // the timer — so statuses.json and actors.json, the two largest documents,
    // were serialized and PUT whole once per new note. On by default, every 15
    // minutes, and on the browser build every one of those is a pod write.
    // acctfeed has done it this way since 2026-08-03; this is the same fix.
    this.store.hold?.();
    try {
    for (const tag of order) {
      let perTag = MAX_NEW_PER_TAG;
      let list;
      try {
        const { safeFetch, retryAfterMs, readCapped } = await import('../shared/safefetch.mjs');
        const url = `${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${PER_TAG}`;
        const res = this.fetcher === globalThis.fetch
          ? await safeFetch(url, { headers: { accept: 'application/json' } })
          : await this.fetcher(url, { headers: { accept: 'application/json' } });
        if (res.status >= 400) {
          // This is somebody else's server, polled on OUR schedule, and it had
          // no way to ask us to stop: a 429 or a 503 logged a line and the next
          // sweep arrived on the same cadence regardless. One refusal now ends
          // the sweep — the remaining tags are on the same instance, so there
          // is nothing to be gained by asking them too.
          this._backOff(res.status, retryAfterMs(res));
          return;
        }
        // Somebody else's server, polled on our schedule: bounded, because
        // res.json() would buffer a timeline of whatever size it sent.
        list = JSON.parse(await readCapped(res, MAX_TIMELINE_BYTES));
      } catch (e) {
        // A network failure is the same signal, minus the courtesy.
        this.log(`tagfeed #${tag}: ${e.message}`);
        this._backOff(0, null);
        return;
      }
      this.failures = 0;                      // it answered; the ladder resets
      for (const st of Array.isArray(list) ? list : []) {
        const noteId = st?.uri;
        if (!noteId || known.has(noteId) || this.store.isBlocked(noteId)) continue;
        if (perTag <= 0 || budget <= 0) break;
        perTag--; budget--;
        const note = await this.intake.fetchAP(noteId).catch(() => null);
        if (!note || note.id !== noteId || !isContentType(note.type)) continue;
        // The author is only known once the note is dereferenced, and this
        // path never went through ingestNote, where that check lives. So a
        // blocked account still reached the timeline by posting under a tag —
        // the one route round a block the owner had explicitly set.
        // The author is only known once the note is dereferenced, and this path
        // never went through ingestNote, where that check lives. Two things
        // followed: a blocked account reached the timeline by posting under a
        // tag — the one route round a block the owner had explicitly set — and
        // a note could name an author its own origin does not vouch for, which
        // is the same forgery ingestNote refuses. No `delivered` fallback here:
        // a tag-feed note has no envelope, so it names its author or it is not
        // one we can attribute.
        const author = authorOf(note);
        if (!author || this.store.isBlocked(author)) continue;
        if (!this.store.getActors()[author]) {
          await this.intake.fetchAP(author).catch(() => {});   // warm name+avatar
        }
        const { attachmentsOf, titledContent } = await import('../core/wire.mjs');
        const attachments = attachmentsOf(note);
        this.store.addStatus({
          noteId, actor: author, content: titledContent(note),
          published: note.published, inReplyTo: note.inReplyTo, kind: 'tag', tag,
          ...(attachments.length ? { attachments } : {}),
        });
        known.add(noteId);
        added++;
      }
      // Nothing left to take, so stop asking. Every remaining tag would be a
      // request whose answer is thrown away — and in the browser build every
      // one of those goes out through the gateway.
      if (budget <= 0) break;
    }
    const all = this.store.getStatuses();
    const tagged = all.filter(s => s.kind === 'tag');
    if (tagged.length > MAX_TAG_ENTRIES) {
      const drop = new Set(tagged.slice(MAX_TAG_ENTRIES).map(s => s.noteId));   // arrival order: tail = oldest
      this.store.write('statuses.json', all.filter(s => !drop.has(s.noteId)));
    }
    } finally {
      this.store.release?.();
    }
    this.lastAdded = added;
    if (added) this.log(`tagfeed: +${added} from #${order.join(' #')}`);
  }
}
