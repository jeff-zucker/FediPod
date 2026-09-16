// mine.mjs — what a reader keeps for themselves: the categories they have
// joined and the posts they saved. Both live in this browser under the
// account that is signed in, because a public forum has nowhere to write
// "Mei saved this" and no business writing it. Nothing here is sent
// anywhere; a reader on another machine starts with an empty list.

const KEY = (who, what) => `bb:${what}:${who || 'anon'}`;

const read = (storage, who, what) => {
  try { const v = JSON.parse(storage.getItem(KEY(who, what)) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
};
const write = (storage, who, what, list) => {
  try { storage.setItem(KEY(who, what), JSON.stringify(list.slice(0, 500))); } catch { /* full or blocked */ }
};

export function mine({ storage, who }) {
  return {
    // Categories this reader has joined from here. The forum's own followers
    // list is the truth; this is what this browser asked for, so the page can
    // show Join or Leave without reading a collection per category.
    joined: () => read(storage, who, 'joined'),
    isJoined: (id) => read(storage, who, 'joined').includes(id),
    join: (id) => write(storage, who, 'joined', [...new Set([...read(storage, who, 'joined'), id])]),
    leave: (id) => write(storage, who, 'joined', read(storage, who, 'joined').filter(x => x !== id)),

    // Posts kept to come back to.
    saved: () => read(storage, who, 'saved'),
    isSaved: (id) => read(storage, who, 'saved').some(x => x.id === id),
    save: (entry) => write(storage, who, 'saved', [entry, ...read(storage, who, 'saved').filter(x => x.id !== entry.id)]),
    unsave: (id) => write(storage, who, 'saved', read(storage, who, 'saved').filter(x => x.id !== id)),
  };
}
