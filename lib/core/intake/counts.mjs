// counts.mjs — how many liked and boosted each of the owner's posts, and the
// totals on the post itself (ActivityPub §5.7, §5.8), so a server showing the
// post shows its real numbers instead of none.
//
// Who liked is kept here, in state, only to tell a repeat from a new one and
// to take back the right one on an Undo; the post says the total and names
// nobody. Past MAX_NAMED on one post the total still grows, but a repeat by
// someone past the cap can no longer be told apart.
//
// The first sweep that finds no totals kept starts them from the account's
// notifications, which hold its recent likes and boosts; older ones are gone.
//
// The post is rewritten once per sweep for every post whose totals changed,
// and only over the version it was read at: an edit or a deletion made in
// between wins, and the totals are written on a later sweep. The posts left
// to rewrite are kept in state, so a restart does not lose them.

import * as podNotes from '../../pod/notes.mjs';
import * as wire from '../wire.mjs';

export const MAX_NAMED = 1000;
export const MAX_POSTS = 2000;
export const REWRITES_PER_SWEEP = 20;
const COUNTS = 'counts.json';
const KIND = { Like: 'likes', Announce: 'shares' };
const MORE = { likes: 'moreLikes', shares: 'moreShares' };

const load = (store) => {
  const st = typeof store?.read === 'function' ? store.read(COUNTS, null) : null;
  return st && typeof st === 'object' && st.posts && typeof st.posts === 'object'
    ? { posts: st.posts, dirty: Array.isArray(st.dirty) ? st.dirty : [] }
    : { posts: {}, dirty: [] };
};

const totals = (p) => ({
  likes: (p?.likes?.length || 0) + (p?.moreLikes || 0),
  shares: (p?.shares?.length || 0) + (p?.moreShares || 0),
});

/** The totals for one post. Zero for a post nobody liked or boosted. */
export function totalsFor(store, noteId) {
  // Read without a copy: the Mastodon API asks this for every post it lists.
  const st = store?.cache?.get?.(COUNTS) ?? store?.read?.(COUNTS, null);
  return totals(st?.posts?.[noteId]);
}

function save(store, st, noteId) {
  if (typeof store?.write !== 'function') return;
  if (noteId && !st.dirty.includes(noteId)) st.dirty.push(noteId);
  const ids = Object.keys(st.posts);
  if (ids.length > MAX_POSTS) {
    // The posts touched longest ago go first.
    ids.sort((a, b) => String(st.posts[a].at || '').localeCompare(String(st.posts[b].at || '')));
    for (const id of ids.slice(0, ids.length - MAX_POSTS)) delete st.posts[id];
    st.dirty = st.dirty.filter(id => st.posts[id]);
  }
  store.write(COUNTS, st);
}

/** A Like or an Announce of one of the owner's posts. True when a total changed. */
export function recordReaction(store, type, noteId, actor) {
  const kind = KIND[type];
  if (!kind || !noteId || !actor) return false;
  const st = load(store);
  const p = st.posts[noteId] || { likes: [], shares: [] };
  const named = p[kind] || [];
  if (named.includes(actor)) return false;
  if (named.length >= MAX_NAMED) p[MORE[kind]] = (p[MORE[kind]] || 0) + 1;
  else p[kind] = [...named, actor];
  p.at = new Date().toISOString();
  st.posts[noteId] = p;
  save(store, st, noteId);
  return true;
}

/** An Undo of one. True when a total changed. */
export function withdrawReaction(store, type, noteId, actor) {
  const kind = KIND[type];
  if (!kind || !noteId || !actor) return false;
  const st = load(store);
  const p = st.posts[noteId];
  if (!p) return false;
  const named = p[kind] || [];
  if (named.includes(actor)) p[kind] = named.filter(a => a !== actor);
  else if (p[MORE[kind]] > 0) p[MORE[kind]] -= 1;
  else return false;
  p.at = new Date().toISOString();
  save(store, st, noteId);
  return true;
}

/** A deleted post keeps no totals. */
export function forgetCounts(store, noteId) {
  const st = load(store);
  if (!st.posts[noteId] && !st.dirty.includes(noteId)) return;
  delete st.posts[noteId];
  st.dirty = st.dirty.filter(id => id !== noteId);
  save(store, st, null);
}

// Totals from before they were kept: the likes and boosts still in the
// notifications. Runs once, the first time there are no totals at all.
function seed(intake) {
  const { store } = intake;
  if (typeof store?.read !== 'function' || store.read(COUNTS, null)) return;
  const notes = intake.urls?.notes;
  const all = typeof store.getNotifications === 'function' ? store.getNotifications() : [];
  for (const n of [...all].reverse()) {                    // oldest first, as they arrived
    if (!notes || !String(n?.noteId || '').startsWith(notes)) continue;
    if (n.type === 'favourite') recordReaction(store, 'Like', n.noteId, n.actor);
    else if (n.type === 'reblog') recordReaction(store, 'Announce', n.noteId, n.actor);
  }
  if (!store.read(COUNTS, null)) store.write(COUNTS, { posts: {}, dirty: [] });
}

/**
 * Write the changed totals onto the posts. Returns how many posts were
 * rewritten. A post the pod no longer has, or has as a Tombstone, is dropped.
 */
export async function publishCounts(intake) {
  seed(intake);
  const st = load(intake.store);
  if (!st.dirty.length) return 0;
  const left = [];
  let wrote = 0;
  for (const noteId of st.dirty.slice(0, REWRITES_PER_SWEEP)) {
    try {
      const { doc, version } = await podNotes.readVersioned(intake.remote, noteId);
      if (!doc || typeof doc !== 'object' || !doc.id || doc.type === 'Tombstone') { delete st.posts[noteId]; continue; }
      const t = totals(st.posts[noteId]);
      const next = { ...doc, ...wire.reactionCounts(t.likes, t.shares) };
      if (JSON.stringify([next.likes, next.shares]) === JSON.stringify([doc.likes, doc.shares])) continue;
      if (await podNotes.writeIfUnchanged(intake.remote, doc.id, next, version)) wrote++;
      else left.push(noteId);            // changed under us: the next sweep reads it again
    } catch (e) {
      intake.log?.(`like and boost totals for ${noteId}: ${e.message}`);
      left.push(noteId);
    }
  }
  st.dirty = [...left, ...st.dirty.slice(REWRITES_PER_SWEEP)].filter(id => st.posts[id]);
  intake.store.write(COUNTS, st);
  return wrote;
}
