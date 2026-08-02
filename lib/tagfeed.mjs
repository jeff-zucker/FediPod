// tagfeed.mjs — topical firehose for a single-actor instance: polls public
// no-auth hashtag timelines on a configured instance and mirrors NEW notes
// into the statuses index as kind 'tag'. View cache only — tag content is
// NOT written to the pod; the pod holds followed/own content.
//
// Config in tagfeed.json: { instance, tags: [...], intervalMin }. Every note
// is still verified by dereference at its origin before it is mirrored.

const DEFAULTS = {
  instance: 'https://mastodon.social',
  tags: ['solidproject', 'linkeddata', 'rdf'],
  intervalMin: 15,
};
const PER_TAG = 20;              // statuses requested per tag per sweep
const MAX_NEW_PER_SWEEP = 12;    // dereference budget per sweep — stay light
const MAX_TAG_ENTRIES = 200;     // oldest tag entries pruned beyond this

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

  async sweep() {
    const { instance, tags } = this.config();
    if (!tags.length) return;
    this.lastSweep = new Date().toISOString();
    const known = new Set(this.store.getStatuses().map(s => s.noteId));
    let budget = MAX_NEW_PER_SWEEP;
    let added = 0;
    for (const tag of tags) {
      let list;
      try {
        const { safeFetch } = await import('./safefetch.mjs');
        const url = `${instance}/api/v1/timelines/tag/${encodeURIComponent(tag)}?limit=${PER_TAG}`;
        const res = this.fetcher === globalThis.fetch
          ? await safeFetch(url, { headers: { accept: 'application/json' } })
          : await this.fetcher(url, { headers: { accept: 'application/json' } });
        if (res.status >= 400) { this.log(`tagfeed #${tag}: ${res.status}`); continue; }
        list = await res.json();
      } catch (e) { this.log(`tagfeed #${tag}: ${e.message}`); continue; }
      for (const st of Array.isArray(list) ? list : []) {
        const noteId = st?.uri;
        if (!noteId || known.has(noteId) || this.store.isBlocked(noteId)) continue;
        if (budget-- <= 0) break;
        const note = await this.intake.fetchAP(noteId).catch(() => null);
        if (!note || note.id !== noteId || note.type !== 'Note') continue;
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
