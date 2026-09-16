// read.mjs — reading a forum from its pod, as a browser does: the forum's
// actor, its categories, a category's topics, a topic's posts, and the
// readable copy of each post. Plain fetches of public documents; nothing here
// needs an account. Runs in a browser and in Node alike.

// No quoted profile parameter: a quote in a request header turns a browser's
// read into a preflighted one, and a plain Accept is enough for every server.
const ACCEPT = 'application/activity+json, application/ld+json, application/json;q=0.9';
const MAX_PAGES = 50;

export const categoryBase = (actorId) => String(actorId).replace(/ap\/actor$/u, '');

// Where a forum is read from: through a Gateway at `<origin>/u/<handle>/`, or
// a pod home given outright.
export const forumBase = ({ origin = null, handle = null, pod = null } = {}) => {
  if (pod) return pod.endsWith('/') ? pod : pod + '/';
  if (!origin || !handle) throw new Error('a forum is named by a handle at this site, or by its pod');
  return `${origin}/u/${encodeURIComponent(handle)}/`;
};

// Where the page runs decides how a forum is named and where it is read from.
// At `bb.<gateway>` the forum is the first path segment and its record is read
// through the Gateway at `<gateway>`; anywhere else it is `?forum=<handle>`
// read through the page's own origin, or `?pod=<home>` read from the pod.
export function placeOf({ origin, pathname = '/', search = '' }) {
  const params = new URLSearchParams(search);
  const u = new URL(origin);
  const own = /^bb\./u.test(u.host);
  const front = own ? `${u.protocol}//${u.host.replace(/^bb\./u, '')}` : origin;
  const fromPath = own ? decodeURIComponent(pathname.split('/').filter(Boolean)[0] || '') : '';
  const handle = params.get('forum') || fromPath || null;
  const pod = params.get('pod');
  return { front, handle, pod, base: pod || handle ? forumBase({ origin: front, handle, pod }) : null };
}

// The name a cached copy is filed under (the same digest the host uses).
export async function cacheKey(postId) {
  const bytes = new TextEncoder().encode(String(postId));
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// `@name@host` for an actor id, for display: what the id says about itself.
export function authorLabel(actorId) {
  try {
    const u = new URL(actorId);
    const name = u.pathname.replace(/\/$/u, '').split('/').filter(Boolean).filter(s => s !== 'ap' && s !== 'actor').pop() || u.host;
    return `@${name}@${u.host}`;
  } catch { return String(actorId); }
}

export function reader({ fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
  const get = async (url) => {
    const r = await f(url, { headers: { accept: ACCEPT } });
    if (!r || !r.ok) return null;
    try { return await r.json(); } catch { return null; }
  };
  const idOf = (v) => (typeof v === 'string' ? v : v?.id);
  const pages = async (head, { forward = true } = {}) => {
    const out = [];
    let next = forward ? head?.first : head?.first;   // both collections start at `first`
    const seen = new Set();
    while (next && !seen.has(next) && out.length < MAX_PAGES) {
      seen.add(next);
      const page = await get(next);
      if (!page) break;
      out.push(page);
      next = page.next;
    }
    return out;
  };

  return {
    // The forum: its actor and its categories, each with its name, its
    // summary and how many members it has.
    async forum(base) {
      const actor = await get(base + 'ap/actor');
      if (!actor) return null;
      const list = await get(base + 'ap/categories');
      const categories = [];
      for (const id of (list?.orderedItems || [])) {
        const a = await get(id);
        if (!a) continue;
        const cbase = categoryBase(a.id || id);
        const followers = await get(cbase + 'ap/followers');
        categories.push({
          id: a.id || id, base: cbase, slug: a.preferredUsername || null,
          name: a.name || a.preferredUsername || id, summary: a.summary || null,
          members: Number(followers?.totalItems) || 0,
        });
      }
      const heartbeat = await get(base + 'ap/heartbeat');
      return { id: actor.id, name: actor.name || actor.preferredUsername, summary: actor.summary || null,
        handle: actor.preferredUsername || null, categories, lastHosted: heartbeat?.at || null };
    },

    // A category's topics, newest first, with each topic's head.
    async topics(cbase) {
      const head = await get(cbase + 'ap/topics');
      if (!head) return { total: 0, topics: [] };
      const ps = await pages(head);
      const topics = [];
      for (const page of ps) {
        for (const id of (page.orderedItems || [])) {
          const t = await get(idOf(id));
          if (t) topics.push({ id: t.id, name: t.name || '', count: Number(t.totalItems) || 0, published: t.published || null, updated: t.updated || t.published || null });
        }
      }
      return { total: Number(head.totalItems) || topics.length, topics };
    },

    // One topic: its head and every post id in order.
    async topic(topicId) {
      const head = await get(topicId);
      if (!head) return null;
      const ps = await pages(head);
      const posts = ps.flatMap(p => (p.orderedItems || []).map(idOf)).filter(Boolean);
      return { id: head.id, name: head.name || '', category: idOf(head.attributedTo) || null,
        total: Number(head.totalItems) || posts.length, published: head.published || null, updated: head.updated || null, posts };
    },

    // The author's card, when the forum kept one: handle, name, picture.
    async author(cbase, actorId) {
      const card = await get(cbase + 'ap/cache/' + await cacheKey(actorId));
      if (!card) return null;
      let host = '';
      try { host = new URL(card.id || actorId).host; } catch { /* unlabelled */ }
      return {
        id: card.id || actorId, name: card.name || card.preferredUsername || null,
        handle: card.preferredUsername && host ? `@${card.preferredUsername}@${host}` : authorLabel(actorId),
        icon: card.icon?.url || null, url: card.url || card.id || actorId,
      };
    },

    // The readable copy of a post, or null when the forum holds none.
    async post(cbase, postId) {
      const copy = await get(cbase + 'ap/cache/' + await cacheKey(postId));
      if (!copy) return null;
      return {
        id: copy.id || postId, type: copy.type || 'Note', gone: copy.type === 'Tombstone',
        author: idOf([].concat(copy.attributedTo || [])[0]) || null,
        name: copy.name || null, content: typeof copy.content === 'string' ? copy.content : '',
        published: copy.published || null, updated: copy.updated || null, inReplyTo: idOf(copy.inReplyTo) || null,
      };
    },
  };
}
