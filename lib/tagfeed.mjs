// tagfeed.mjs — topical firehose for a single-actor instance: polls public
// no-auth hashtag timelines on a configured instance and mirrors NEW notes
// into the statuses index as kind 'tag'. View cache only — tag content is
// NOT written to the pod; the pod holds followed/own content.
//
// Config in tagfeed.json: { instance, tags: [...], intervalMin }. Every note
// is still verified by dereference at its origin before it is mirrored.

import { isContentType } from './intake.mjs';

const DEFAULTS = {
  instance: 'https://mastodon.social',
  tags: ['solidproject', 'linkeddata', 'rdf'],
  intervalMin: 15,
};
const PER_TAG = 20;              // statuses requested per tag per sweep
const MAX_NEW_PER_SWEEP = 12;    // dereference budget per sweep — stay light
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

  start() {
    this.stopped = false;                     // restartable, the same way Intake.start is
    this.sweep().catch(e => this.log(`tagfeed: ${e.message}`));
    // Jittered and self-scheduling: every agent polling the same instance on
    // the same 15-minute boundary is a beat nobody asked for.
    const tick = () => {
      this.timer = setTimeout(() => {
        this.sweep()
          .catch(e => this.log(`tagfeed: ${e.message}`))
          .finally(() => { if (!this.stopped) tick(); });
      }, Math.round(this.config().intervalMin * 60_000 * (0.85 + Math.random() * 0.3)));
      this.timer.unref?.();
    };
    tick();
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
    for (const tag of tags) {
      let list;
      try {
        const { safeFetch, retryAfterMs } = await import('./safefetch.mjs');
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
        list = await res.json();
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
        if (budget-- <= 0) break;
        const note = await this.intake.fetchAP(noteId).catch(() => null);
        if (!note || note.id !== noteId || !isContentType(note.type)) continue;
        // The author is only known once the note is dereferenced, and this
        // path never went through ingestNote, where that check lives. So a
        // blocked account still reached the timeline by posting under a tag —
        // the one route round a block the owner had explicitly set.
        const author = note.attributedTo;
        if (author && this.store.isBlocked(author)) continue;
        if (note.attributedTo && !this.store.getActors()[note.attributedTo]) {
          await this.intake.fetchAP(note.attributedTo).catch(() => {});   // warm name+avatar
        }
        const { attachmentsOf, sanitizeHtml } = await import('./wire.mjs');
        const attachments = attachmentsOf(note);
        this.store.addStatus({
          noteId, actor: note.attributedTo, content: sanitizeHtml(note.content),
          published: note.published, inReplyTo: note.inReplyTo, kind: 'tag', tag,
          ...(attachments.length ? { attachments } : {}),
        });
        known.add(noteId);
        added++;
      }
    }
    const all = this.store.getStatuses();
    const tagged = all.filter(s => s.kind === 'tag');
    if (tagged.length > MAX_TAG_ENTRIES) {
      const drop = new Set(tagged.slice(MAX_TAG_ENTRIES).map(s => s.noteId));   // arrival order: tail = oldest
      this.store.write('statuses.json', all.filter(s => !drop.has(s.noteId)));
    }
    this.lastAdded = added;
    if (added) this.log(`tagfeed: +${added} from #${tags.join(' #')}`);
  }
}
