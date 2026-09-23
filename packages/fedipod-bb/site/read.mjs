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

export function reader({ fetch: f = globalThis.fetch.bind(globalThis), session = null } = {}) {
  // A topic's name and how many posts are in it, read once however many of
  // its posts a feed carries.
  const topicInfo = async (topicId, seen) => {
    if (!topicId) return { name: null, total: 0 };
    if (seen.has(topicId)) return seen.get(topicId);
    const head = await get(topicId);
    const info = { name: head?.name || null, total: Number(head?.totalItems) || 0 };
    seen.set(topicId, info);
    return info;
  };
  const get = async (url) => {
    // A request that fails at the network level — a dropped connection, a
    // document that is simply not there — reads the same as one that is not
    // readable: nothing. Letting it throw meant one missing side document
    // took the whole page down with it.
    let r = null;
    try { r = await f(url, { headers: { accept: ACCEPT } }); } catch { return null; }
    // A members-only category answers 401 or 403 to the world. A reader who
    // is signed in asks again as themselves, and the pod decides.
    if (r && (r.status === 401 || r.status === 403) && session?.fetch) {
      const mine = await session.fetch(url, { headers: { accept: ACCEPT } }).catch(() => null);
      if (mine?.ok) { try { return await mine.json(); } catch { return null; } }
      return null;
    }
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
          // Open or private, as the forum itself says on the category's
          // actor. A private category approves each join, which is what AS2
          // spells `manuallyApprovesFollowers`.
          private: a.manuallyApprovesFollowers === true,
          members: Number(followers?.totalItems) || 0,
        });
      }
      // Who runs it (FEP-baf5), each with the page a person is sent to.
      const admins = [];
      for (const id of ((await get(base + 'ap/administrators'))?.orderedItems || []).map(idOf).filter(Boolean)) {
        const a = await get(id);
        admins.push({
          id,
          handle: a?.preferredUsername && a?.id ? `@${a.preferredUsername}@${new URL(a.id).host}` : authorLabel(id),
          url: (typeof a?.url === 'string' && a.url) || id,
        });
      }
      const heartbeat = await get(base + 'ap/heartbeat');
      return { id: actor.id, name: actor.name || actor.preferredUsername, summary: actor.summary || null,
        handle: actor.preferredUsername || null, categories, admins, lastHosted: heartbeat?.at || null };
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
        closed: head.closed || null,
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
        // The page a person is sent to is the one the actor names. Its id is a
        // document for machines, so it is not offered in its place.
        icon: card.icon?.url || null, url: (typeof card.url === 'string' && card.url) || null,
      };
    },

    // Somebody the forum has kept nothing about — a moderator who has not
    // posted, say. Their own actor is what the page has to go on.
    async actorCard(actorId) {
      const doc = await get(actorId);
      if (!doc?.id) return null;
      let host = '';
      try { host = new URL(doc.id).host; } catch { /* unlabelled */ }
      const icon = typeof doc.icon === 'string' ? doc.icon : doc.icon?.url;
      return {
        id: doc.id, name: doc.name || doc.preferredUsername || null,
        handle: doc.preferredUsername && host ? `@${doc.preferredUsername}@${host}` : authorLabel(actorId),
        icon: icon || null, url: (typeof doc.url === 'string' && doc.url) || null,
        // Where a message for them is handed in.
        inbox: (typeof doc.inbox === 'string' && doc.inbox) || doc.endpoints?.sharedInbox || null,
      };
    },

    // The handle an actor says is its own. A name read off an address is a
    // guess, right only where the address happens to spell the name; a server
    // that will not hand out its actors unasked leaves the guess standing.
    async actorHandle(actorId) {
      const doc = await get(actorId);
      if (!doc?.preferredUsername) return null;
      try { return `@${doc.preferredUsername}@${new URL(doc.id || actorId).host}`; } catch { return null; }
    },

    // The forum's newest posts, across every category: the index names the
    // forum's own copies, so one fetch of each tells who wrote it, when, and
    // which topic and category it belongs to.
    async latest(base, { limit = 30, from = 0 } = {}) {
      const head = await get(base + 'ap/latest');
      const all = (head?.orderedItems || []).map(idOf).filter(Boolean);
      const ids = all.slice(from, from + limit);
      const out = [];
      const named = new Map();
      for (const url of ids) {
        const copy = await get(url);
        if (!copy || copy.type === 'Tombstone') continue;
        out.push({
          id: copy.id || url,

          author: idOf([].concat(copy.attributedTo || [])[0]) || null,
          name: copy.name || null,
          content: typeof copy.content === 'string' ? copy.content : '',
          published: copy.published || null,
          topic: idOf(copy.context) || null,
          inReplyTo: idOf(copy.inReplyTo) || null,
          // Answers to THIS post, as the forum counted them.
          replies: Number(copy.replies?.totalItems) || 0,
          likes: Number(copy.likes?.totalItems) || 0,
          // The forum's own count, carried in the copy beside `likes`.
          dislikes: Number(copy.dislikes?.totalItems) || 0,
          category: idOf([].concat(copy.audience || [])[0]) || null,
          page: [].concat(copy.url || []).map(u => (typeof u === 'string' ? u : null)).find(Boolean) || null,
        });
        const info = await topicInfo(out[out.length - 1].topic, named);
        out[out.length - 1].topicName = info.name;
        // Replies: everything in the topic but the post that opened it.
        out[out.length - 1].topicTotal = info.total;
        // What the index shows: how many replies the TOPIC has had. The
        // post's own answers are on `replies`, for whatever wants them.
        out[out.length - 1].topicReplies = Math.max(0, info.total - 1);
      }
      // What is left behind this page, so a reader can ask for it.
      out.more = Math.max(0, all.length - (from + ids.length));
      return out;
    },

    // The topics a category has pinned (its featured collection): what a
    // reader should see first, whatever else has been said since.
    async featured(cbase) {
      const c = await get(cbase + 'ap/featured');
      return (c?.orderedItems || []).map(idOf).filter(Boolean);
    },

    // Whether this reader may read a category's posts at all: a members-only
    // one refuses the world, and its topics then look like none.
    async canRead(cbase) {
      const r = await f(cbase + 'ap/topics', { headers: { accept: ACCEPT } }).catch(() => null);
      if (r && (r.status === 401 || r.status === 403)) {
        if (!session?.fetch) return false;
        const mine = await session.fetch(cbase + 'ap/topics', { headers: { accept: ACCEPT } }).catch(() => null);
        return !!mine?.ok;
      }
      return !!r?.ok;
    },

    // Who moderates a category. The category says so itself (FEP-1b12), which
    // is what lets a page show a moderator their own buttons.
    async moderators(cbase) {
      const c = await get(cbase + 'ap/moderators');
      return (c?.orderedItems || []).map(idOf).filter(Boolean);
    },

    // The readable copy of a post, or null when the forum holds none.
    async post(cbase, postId) {
      const at = cbase + 'ap/cache/' + await cacheKey(postId);
      const copy = await get(at);
      if (!copy) return null;
      // `url` is where a PERSON reads this post; `id` is where a server
      // fetches it. They are the same on some servers and never on a pod.
      const page = [].concat(copy.url || [])
        .map(u => (typeof u === 'string' ? u : (u?.mediaType === 'text/html' ? u.href : null)))
        .find(u => typeof u === 'string' && /^https?:/u.test(u)) || null;
      return {
        id: copy.id || postId, type: copy.type || 'Note', gone: copy.type === 'Tombstone', page,
        author: idOf([].concat(copy.attributedTo || [])[0]) || null,
        name: copy.name || null, content: typeof copy.content === 'string' ? copy.content : '',
        // What its author typed, when they said so: an edit reopens this
        // rather than guessing it back out of the HTML.
        source: copy.source?.mediaType === 'text/markdown' && typeof copy.source?.content === 'string' ? copy.source.content : null,
        published: copy.published || null, updated: copy.updated || null, inReplyTo: idOf(copy.inReplyTo) || null,
        // Which topic the forum placed it in: what a Delete has to name as
        // the place the post is being taken out of.
        topic: idOf(copy.context) || null,
        likes: Number(copy.likes?.totalItems) || 0,
        dislikes: Number(copy.dislikes?.totalItems) || 0,
      };
    },
  };
}
