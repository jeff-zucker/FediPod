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

    // Which way this reader voted on a post. The forum's count is the truth;
    // this is only so the buttons can show which one is theirs. A post is
    // remembered in one list or the other, never both.
    votedOn: (id) => (read(storage, who, 'liked').includes(id) ? 'up'
      : read(storage, who, 'disliked').includes(id) ? 'down' : 'none'),
    isLiked: (id) => read(storage, who, 'liked').includes(id),
    vote: (id, way) => {
      write(storage, who, 'liked', way === 'up'
        ? [...new Set([...read(storage, who, 'liked'), id])]
        : read(storage, who, 'liked').filter(x => x !== id));
      write(storage, who, 'disliked', way === 'down'
        ? [...new Set([...read(storage, who, 'disliked'), id])]
        : read(storage, who, 'disliked').filter(x => x !== id));
    },

    // Posts kept to come back to.
    saved: () => read(storage, who, 'saved'),
    isSaved: (id) => read(storage, who, 'saved').some(x => x.id === id),
    save: (entry) => write(storage, who, 'saved', [entry, ...read(storage, who, 'saved').filter(x => x.id !== entry.id)]),
    unsave: (id) => write(storage, who, 'saved', read(storage, who, 'saved').filter(x => x.id !== id)),
  };
}
