// seen.mjs — what this reader has already read, kept in their own browser.
//
// A forum's record is public and its readers are mostly anonymous, so there is
// nowhere on the pod to write "Mei has read this" and no right to. The mark is
// the reader's own: one entry per topic, the time of the newest post that was
// on the page when they last opened it, in this browser's storage and nowhere
// else. Nothing here is sent anywhere.

const KEY = (forum) => 'bb:seen:' + forum;
// How many topics a reader's mark is kept for. Beyond this the oldest marks
// go, and the forum's first-sight time below covers what falls off.
const MAX = 300;

const at = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

export function readState({ storage, forum, now = () => new Date().toISOString() }) {
  const key = KEY(forum);
  let rec;
  try { rec = JSON.parse(storage.getItem(key) || 'null'); } catch { rec = null; }
  if (!rec || typeof rec !== 'object') rec = null;
  const save = () => { try { storage.setItem(key, JSON.stringify(rec)); } catch { /* full or blocked */ } };
  // A forum a person has never opened is not a hundred unread topics; it is a
  // forum they are arriving at. The first visit reads everything before it.
  if (!rec) { rec = { since: now(), topics: {} }; save(); }
  if (!rec.topics || typeof rec.topics !== 'object') rec.topics = {};

  return {
    since: rec.since,

    // A post is new when it arrived after this reader last had its topic open
    // — or, for a topic they have never opened, after they first saw the forum.
    isNew(topicId, published) {
      const when = at(published);
      if (when === null) return false;
      const mark = at((topicId && rec.topics[topicId]) || rec.since);
      return mark === null ? false : when > mark;
    },

    // Opening a topic reads it, up to the newest post that was in it.
    markRead(topicId, newest) {
      const when = at(newest);
      if (!topicId || when === null) return;
      const had = at(rec.topics[topicId]);
      if (had !== null && had >= when) return;
      rec.topics[topicId] = new Date(when).toISOString();
      const ids = Object.keys(rec.topics);
      if (ids.length > MAX) {
        ids.sort((a, b) => (at(rec.topics[a]) || 0) - (at(rec.topics[b]) || 0));
        for (const id of ids.slice(0, ids.length - MAX)) delete rec.topics[id];
      }
      save();
    },

    // The newest post in a list, which is what opening it reads up to.
    newest(posts) {
      let best = null;
      for (const p of posts || []) {
        const t = at(p?.published);
        if (t !== null && (best === null || t > best)) best = t;
      }
      return best === null ? null : new Date(best).toISOString();
    },
  };
}
