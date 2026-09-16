// topics.mjs — a category's topic record: what the host knows about its
// topics and their posts, kept in the category's owner-only state as one
// document per topic and one list of them. The published collections are
// built from this record; the record is never rebuilt from them.
//
// `topics.json`      [{ tid, title, op, author, created, last, count, pinned, locked }]
// `topics/<tid>.json` { tid, title, posts: [{ id, author, published, inReplyTo, cached }],
//                       index: [[ids]], pages: { n: digest }, headDigest }

import { isTid } from './urls.mjs';

export const TOPICS = 'topics.json';
// Flat, not `topics/<tid>.json`: state is loaded by listing ONE container and
// reading the .json in it, so a document in a folder below it is written, never
// read back, and the forum loses every topic when it restarts.
export const topicDoc = (tid) => `topic-${tid}.json`;
export const topicDocOld = (tid) => `topics/${tid}.json`;

// A title becomes the tail of a topic id: lower case, letters digits and
// hyphens, at most eighty characters, never empty.
export function slugOfTitle(title) {
  const s = String(title || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 79)
    .replace(/-+$/u, '');
  return s || 'topic';
}

// A topic id that is not yet taken in this category.
export function mintTid(store, title, published = new Date().toISOString()) {
  const month = String(published).slice(0, 7);
  const base = `${month}-${slugOfTitle(title)}`;
  const taken = new Set(list(store).map(t => t.tid));
  let tid = base;
  for (let n = 2; taken.has(tid); n++) tid = `${base.slice(0, 76)}-${n}`;
  return tid;
}

export function list(store) { return store.read(TOPICS, []); }

export function get(store, tid) {
  if (!isTid(tid)) return null;
  return store.read(topicDoc(tid), null);
}

// Which topic holds a post, by the post's id.
export function topicOf(store, postId) {
  for (const t of list(store)) {
    const doc = get(store, t.tid);
    if (doc?.posts?.some(p => p.id === postId)) return t.tid;
  }
  return null;
}

// Open a topic with its first post. Returns the topic id.
export function open(store, { title, post, tid = null }) {
  const id = tid || mintTid(store, title, post.published);
  if (get(store, id)) throw new Error(`topic already open: ${id}`);
  const entry = { tid: id, title: String(title), op: post.id, author: post.author,
    created: post.published, last: post.published, count: 1, pinned: false, locked: false };
  store.write(TOPICS, [...list(store), entry]);
  store.write(topicDoc(id), { tid: id, title: entry.title, posts: [post], index: [], pages: {}, headDigest: null });
  return id;
}

// Add a post to a topic. A post already there is not added twice.
export function append(store, tid, post) {
  const doc = get(store, tid);
  if (!doc) throw new Error(`no such topic: ${tid}`);
  if (doc.posts.some(p => p.id === post.id)) return false;
  doc.posts.push(post);
  store.write(topicDoc(tid), doc);
  const topics = list(store).map(t => (t.tid === tid
    ? { ...t, count: doc.posts.length, last: post.published > t.last ? post.published : t.last } : t));
  store.write(TOPICS, topics);
  return true;
}

// Take a post out of a topic. Its page stays one short (wire.topicPaging).
export function remove(store, tid, postId) {
  const doc = get(store, tid);
  if (!doc) return false;
  const before = doc.posts.length;
  doc.posts = doc.posts.filter(p => p.id !== postId);
  if (doc.posts.length === before) return false;
  store.write(topicDoc(tid), doc);
  store.write(TOPICS, list(store).map(t => (t.tid === tid ? { ...t, count: doc.posts.length } : t)));
  return true;
}

export function setTitle(store, tid, title) {
  const doc = get(store, tid);
  if (!doc) return null;
  store.write(topicDoc(tid), { ...doc, title });
  store.write(TOPICS, list(store).map(t => (t.tid === tid ? { ...t, title } : t)));
  return title;
}

export function setFlags(store, tid, { pinned, locked } = {}) {
  store.write(TOPICS, list(store).map(t => (t.tid === tid
    ? { ...t, ...(pinned !== undefined ? { pinned: !!pinned } : {}), ...(locked !== undefined ? { locked: !!locked } : {}) } : t)));
}

// ── placing a carried post ─────────────────────────────────────────────
const idOf = (v) => (typeof v === 'string' ? v : v?.id);
const MAX_PARENT_HOPS = 20;

// A post's title: what it says it is, else its first words.
export function titleOf(note) {
  if (typeof note?.name === 'string' && note.name.trim()) return note.name.trim().slice(0, 200);
  const text = String(note?.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = text.split(' ').slice(0, 12).join(' ');
  return (words.length < text.length ? words + '…' : words) || 'Untitled';
}

// Which topic a carried post belongs to, and put it there. In order: the
// topic its `context` names; the topic its reply chain leads to, walking up
// through parents fetched at their origins; else a new topic with this post
// as its opening. Returns the topic id.
export async function assign({ store, urls, fetchAP }, note, activity = null) {
  const post = {
    id: note.id,
    author: idOf([].concat(note.attributedTo || [])[0]) || null,
    published: note.published || new Date().toISOString(),
    inReplyTo: idOf(note.inReplyTo) || null,
    cached: urls.cached(note.id),
  };
  const named = idOf(note.context);
  if (named && named.startsWith(urls.topicContainer)) {
    const tail = named.slice(urls.topicContainer.length);
    const tid = get(store, tail) ? tail : tail.replace(/-\d+$/u, '');
    if (get(store, tid)) { append(store, tid, post); return tid; }
  }
  let parent = post.inReplyTo;
  for (let hop = 0; parent && hop < MAX_PARENT_HOPS; hop++) {
    const tid = topicOf(store, parent);
    if (tid) { append(store, tid, post); return tid; }
    const doc = await fetchAP(parent).catch(() => null);
    parent = idOf(doc?.inReplyTo) || null;
  }
  // The name of a new topic, in order: what the opening activity called it —
  // a client here asks for a topic BY NAME, which is a different thing from
  // the post's own title — then the post's title, then its first words, for
  // everything arriving from servers that have no notion of a topic.
  const asked = typeof activity?.name === 'string' ? activity.name.trim().slice(0, 200) : '';
  return open(store, { title: asked || titleOf(note), post });
}

// A topic gone from the record: its list entry and its document.
export function drop(store, tid) {
  if (!get(store, tid)) return false;
  store.write(TOPICS, list(store).filter(t => t.tid !== tid));
  store.remove?.(topicDoc(tid));
  return true;
}
