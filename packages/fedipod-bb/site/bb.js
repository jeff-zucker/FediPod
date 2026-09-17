// bb.js — the forum website: reads a forum from its pod (through this site's
// own /u/<handle>/ when the forum is attached here, or a pod named outright)
// and shows categories, topics and threads. Replying signs the reader in
// with a Mastodon account and posts from it; the reply appears here once the
// forum's host has placed it, and until then the reader sees their own copy
// marked as waiting.
//
//   /bb/?forum=<handle>            a forum attached to this site
//   /bb/?pod=https://…/fedipod-bb/  a forum read from its pod directly
//   https://bb.<site>/<handle>/     the same forum at its own address
//   #/  #/c/<slug>  #/t/<slug>/<tid>

import { reader, placeOf, authorLabel, cacheKey, categoryBase } from './read.mjs';
import { MastoLogin, hostOfHandle, serverKind } from './masto.mjs';
import * as pod from './pod.mjs';
import { mine as keptByReader } from './mine.mjs';
import { readState } from './seen.mjs';
import { toHtml } from './markdown.mjs';

const $ = (id) => document.getElementById(id);
// Said to a screen reader when the page changes under it and no focus moves:
// what is loading, how much arrived, that a link was copied.
const say = (msg) => { const el = $('say'); if (el) el.textContent = msg; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };
const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

const params = new URLSearchParams(location.search);
const place = placeOf({ origin: location.origin, pathname: location.pathname, search: location.search });
const { front, base } = place;
const frontHost = new URL(front).host;
// The reader asks anonymously first; where a category is members-only it
// asks again with the pod session, if there is one.
let read = reader();
const login = new MastoLogin({ storage: localStorage, redirectUri: location.origin + location.pathname + location.search });
// What this reader has already read. Theirs, in their own browser: a public
// forum has nowhere to keep it and no business keeping it.
const seen = base ? readState({ storage: localStorage, forum: base }) : null;

let forum = null;
let podAcct = null;          // { handle, actor, webId } when signed in with a pod
let moderators = [];         // the category's own list, read from the forum
const account = () => podAcct || login.account();
const cats = () => forum?.categories || [];
const iModerate = () => {
  const me = podAcct?.actor || login.account()?.url;
  return !!me && moderators.includes(me);
};
const catBySlug = (slug) => cats().find(c => c.slug === slug || c.base.endsWith('/c/' + slug + '/'));
const handleOf = (cat) => {
  // Through a Gateway a category answers as @slug@gateway; read from a pod, its id is its address.
  if (place.handle && cat.slug) return `@${cat.slug}@${frontHost}`;
  return cat.id;
};
// A post names the category it is for, and every reader of this page is
// already in it: the address is how it got here, not something to read.
function body(p, cat) {
  const html = p?.content || '';
  if (!cat) return html;
  const d = document.createElement('div');
  d.innerHTML = html;
  for (const a of [...d.querySelectorAll('a')]) {
    const names = a.getAttribute('href') === cat.id
      || a.textContent.trim().replace(/^@/u, '') === String(cat.slug || '')
      || a.textContent.trim() === handleOf(cat);
    if (!names) continue;
    const p0 = a.closest('p') || a.parentElement;
    a.remove();
    if (p0 && !p0.textContent.trim() && !p0.querySelector('img,a')) p0.remove();
  }
  return d.innerHTML;
}

// The author as they are known: their name when the forum kept a card for
// them, and always the handle, which is the thing that is theirs everywhere.
function byline(p, author) {
  if (!author) return esc(p.author ? authorLabel(p.author) : '');
  const handle = esc(author.handle);
  const name = author.name && author.name !== author.handle ? esc(author.name) : null;
  const inner = name ? `${name} <span class="dim">${handle}</span>` : handle;
  // Their posts in this forum, not their page elsewhere: that is what a
  // reader here is asking for when they click a name.
  return `<a href="#/who/${encodeURIComponent(author.id)}">${inner}</a>`;
}

// Where this post can be READ away from here. A pod answers its post's own
// address with JSON, so that address is no use to a person and is not shown;
// a server that publishes a page for it says so, and the link names its host.
function elsewhere(p) {
  if (!p?.page) return '';
  let host = '';
  try { host = new URL(p.page).host; } catch { return ''; }
  return ` <a href="${esc(p.page)}" class="dim" rel="noopener">on ${esc(host)}</a>`;
}

// Whose post this is, as this browser can tell: a pod account is its actor,
// a Mastodon account is the profile its server gave us.
const mine = (p) => {
  const me = podAcct?.actor || login.account()?.url;
  return !!me && !!p?.author && (p.author === me || p.author === podAcct?.webId);
};

// A thread in the shape it was written: each reply under the post it answers,
// and anything whose parent is not here at the top level. Depth is capped so
// a long argument does not walk off the side of the page.
const MAX_DEPTH = 6;
async function threaded(posts, authors, cat) {
  const byId = new Map(posts.map(p => [p.id, p]));
  const kids = new Map();
  const roots = [];
  for (const p of posts) {
    const parent = p.inReplyTo && byId.has(p.inReplyTo) && p.inReplyTo !== p.id ? p.inReplyTo : null;
    if (!parent) { roots.push(p); continue; }
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(p);
  }
  const out = [];
  const walk = async (p, depth) => {
    const html = card(p, { author: p.author ? authors.get(p.author) : null, cat, anchor: await cacheKey(p.id) });
    out.push(depth ? `<div class="nest" style="--depth:${Math.min(depth, MAX_DEPTH)}">${html}</div>` : html);
    for (const k of kids.get(p.id) || []) await walk(k, depth + 1);
  };
  for (const r of roots) await walk(r, 0);
  return out;
}

function topicActs(topicId) {
  if (!iModerate()) return '';
  return `<div class="acts mod" role="group" aria-label="Moderator actions for this topic" data-topic="${esc(topicId)}">
    <button data-act="rename">Rename topic</button>
    <button data-act="lock">Close topic</button><button data-act="unlock">Reopen topic</button>
    <button data-act="pin">Pin topic</button><button data-act="unpin">Unpin topic</button>
    <button data-act="sitepin">Pin site-wide</button><button data-act="siteunpin">Unpin site-wide</button>
    <button data-act="droptopic">Delete topic</button>
  </div>`;
}

function card(p, { author = null, cat = null, extra = '', waiting = false, anchor = null } = {}) {
  const at = p.published ? when(p.published) : '';
  // What a screen reader hears before the words, and what each of this post's
  // own buttons is called — a thread of them is not twenty identical "Reply"s.
  const whose = esc(author ? (author.name || author.handle) : (p.author ? authorLabel(p.author) : 'someone'));
  const named = `${waiting ? 'Waiting: p' : 'P'}ost by ${whose}${at ? `, ${esc(at)}` : ''}`;
  return `<article class="post${p.gone ? ' gone' : ''}${extra}" aria-label="${named}"${anchor ? ` id="p-${esc(anchor)}"` : ''}>
    <div class="who"><b>${waiting ? '<span class="dim">waiting for the forum · </span>' : ''}${byline(p, author)}</b>
      <span class="when">${esc(at)}${elsewhere(p)}</span></div>
    <div class="body">${p.gone ? 'This post was removed.' : (body(p, cat) || '<span class="dim">(not readable here)</span>')}</div>
    ${p.gone || waiting || !p.id ? '' : `<div class="acts" data-post="${esc(p.id)}">
      <button data-act="reply" aria-label="Reply to ${whose}">Reply</button>
      ${account() ? `<button data-act="${own().isLiked(p.id) ? 'unlike' : 'like'}" aria-label="${own().isLiked(p.id) ? 'Take back your vote' : 'Vote for this post'}">▲ ${p.likes || 0}</button>` : `<span class="votes" aria-label="${p.likes || 0} votes">▲ ${p.likes || 0}</span>`}
      <button data-act="share" aria-label="Copy a link to the post by ${whose}">Share</button>
      ${account() ? `<button data-act="${own().isSaved(p.id) ? 'unsave' : 'save'}" aria-label="${own().isSaved(p.id) ? 'Remove this post from your bookmarks' : 'Bookmark this post'}">${own().isSaved(p.id) ? 'Bookmarked' : 'Bookmark'}</button>` : ''}
      ${mine(p) || !account() ? '' : `<button data-act="report" aria-label="Report the post by ${whose}">Report</button>`}
      ${mine(p) ? '<button data-act="edit" aria-label="Edit your own post">Edit</button><button data-act="delete" aria-label="Delete your own post">Delete</button>' : ''}
      ${!mine(p) && iModerate() ? `<button data-act="remove" aria-label="Remove the post by ${whose}">Remove</button>` : ''}
    </div>`}
  </article>`;
}

const waitingKey = (topicId) => 'bb:waiting:' + topicId;
const waiting = (topicId) => { try { return (JSON.parse(localStorage.getItem(waitingKey(topicId)) || '[]') || []).filter(w => w?.id); } catch { return []; } };
// A copy is kept only for a post that is waiting to be PLACED, and only when
// it carries the id the topic will name it by: an entry nothing can match is
// an entry nothing can ever clear.
const remember = (topicId, entry) => {
  if (!entry?.id) return;
  try { localStorage.setItem(waitingKey(topicId), JSON.stringify([...waiting(topicId), entry].slice(-20))); } catch { /* full or blocked */ }
};

async function load() {
  if (!base) {
    $('main').innerHTML = `<p class="err">Name a forum: <code>${esc(location.origin)}/&lt;forum&gt;/</code></p>`;
    return;
  }
  forum = await read.forum(base);
  if (!forum) {
    $('main').innerHTML = '<p class="err">No forum answers at this address.</p>';
    return;
  }
  document.title = forum.name || 'FediPod-BB';
  $('forum-link').textContent = forum.name || 'Forum';
  const by = (forum.admins || []).map(a => `<a href="${esc(a.url)}">${esc(a.handle)}</a>`).join(', ');
  $('forum-status').innerHTML = by ? `hosted by ${by}` : '';
  route();
}

function crumbs(parts) {
  // One stop is no trail: the front page needs no line saying it is the
  // front page.
  if (parts.length < 2) { $('crumbs').textContent = ''; $('crumbs').hidden = true; $('forum-status').hidden = false; return; }
  $('crumbs').hidden = false;
  $('forum-status').hidden = parts.length > 1;
  $('crumbs').innerHTML = parts.map(([label, href], i) => (href && i < parts.length - 1 ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join(' › ');
}

async function route() {
  const mine = ++view;
  void mine;
  const hash = location.hash.replace(/^#\/?/u, '');
  const [kind, a, b, c] = hash.split('/');
  $('reply-row').hidden = true;
  $('reply-dlg').close();
  if (kind === 'replies') return showReplies();
  if (kind === 'bookmarks' || kind === 'saved') return showSaved();
  if (kind === 'queue') return showQueue();
  if (kind === 'settings') return showSettings();
  if (kind === 'who' && a) return showWho(decodeURIComponent(a));
  if (kind === 'c' && a) { if (feedFilter !== a) shown = 30; feedFilter = a; return showForum(); }
  if (kind === 't' && a && b) return showTopic(a, b, c || null);
  return showForum();
}

// The front page is an index of what has been said, newest first, across the
// forum: which category, which topic, who, and when. The words themselves are
// in the topic, one click away.
let feedFilter = 'all';        // 'all', or a category's slug
let shown = 30;                // how many of the index's rows are on the page
let view = 0;                  // which view the page is on; an older one must not draw
let order = 'date';            // which column the index is ordered by
let down = true;               // and which way
let finding = '';              // what the reader is looking for, if anything
// What this reader keeps for themselves, under the account they signed in as.
const own = () => keptByReader({ storage: localStorage, who: account()?.handle || null });

// Answers to this reader's own posts, newest first. The forum publishes what
// each post answers, so nobody has to be told whom to notify.
async function showReplies() {
  crumbs([['Home', '#/'], ['Replies to you', null]]);
  const me = podAcct?.actor || login.account()?.url;
  if (!me) { $('main').innerHTML = '<p class="empty">Sign in to see answers to your posts.</p>'; return; }
  $('main').innerHTML = '<p class="dim">Looking…</p>';
  const latest = await read.latest(base, { limit: 200 });
  const mineIds = new Set(latest.filter(p => p.author === me).map(p => p.id));
  const answers = latest.filter(p => p.inReplyTo && mineIds.has(p.inReplyTo) && p.author !== me);
  if (!answers.length) { $('main').innerHTML = '<p class="empty">Nobody has answered you yet.</p>'; return; }
  const items = [];
  for (const p of answers) {
    const cat = cats().find(c => c.id === p.category) || null;
    const who = cat && p.author ? await read.author(cat.base, p.author) : null;
    const tid = p.topic ? p.topic.split('/').pop() : null;
    const href = cat && tid ? `#/t/${esc(cat.slug)}/${esc(tid)}/${esc(await cacheKey(p.id))}` : '#/';
    items.push(`<li><a class="title" href="${href}">${esc(p.topicName || 'Topic')}</a>
      <div class="meta">${who ? esc(who.handle) : esc(authorLabel(p.author || ''))} · ${esc(when(p.published))}</div>
      <article class="post"><div class="body">${p.content || ''}</div></article></li>`);
  }
  $('main').innerHTML = `<ul class="list">${items.join('')}</ul>`;
}

// Posts this reader kept. The list is theirs and lives in this browser.
function showSaved() {
  crumbs([['Home', '#/'], ['Bookmarked', null]]);
  const rows = own().saved();
  if (!rows.length) { $('main').innerHTML = '<p class="empty">Nothing bookmarked yet. Use Bookmark on a post.</p>'; return; }
  $('main').innerHTML = `<ul class="list">${rows.map(r => {
    const cat = cats().find(c => c.slug === r.cat) || null;
    const tid = r.topic ? r.topic.split('/').pop() : null;
    const href = cat && tid ? `#/t/${esc(cat.slug)}/${esc(tid)}` : '#/';
    return `<li><a class="title" href="${href}">${esc(r.text || r.id)}</a>
      <div class="meta">bookmarked ${esc(when(r.at))}${cat ? ' · ' + esc(cat.name) : ''}</div></li>`;
  }).join('')}</ul>`;
}

// The moderators' queue: reports, posts held from people who have not joined,
// and asks not yet acted on. Read from the forum's pod with the moderator's
// own login — it is not public and never passes through the Gateway.
async function showQueue() {
  crumbs([['Home', '#/'], ['Queue', null]]);
  if (!podAcct) { $('main').innerHTML = '<p class="empty">The queue is read with your pod account.</p>'; return; }
  $('main').innerHTML = '<p class="dim">Reading the queue…</p>';
  try {
    const said = await serverKind(new URL(front).host, front, undefined, forum.handle || 'forum');
    if (!said?.podHome) throw new Error('this forum does not say where its pod is');
    const q = await pod.modQueue(said.podHome);
    const rows = q?.rows || [];
    if (!rows.length) { $('main').innerHTML = '<p class="empty">Nothing is waiting.</p>'; return; }
    $('main').innerHTML = `<ul class="list">${rows.map(r => `<li>
      <div class="title">${esc(r.type)}${r.category ? ' · ' + esc(r.category) : ''}</div>
      <div class="meta">${r.type === 'Flag' ? 'reported by ' : ''}${esc(r.by ? authorLabel(r.by) : '')}${r.about ? ` · about <a href="#/who/${encodeURIComponent(r.about)}">${esc(authorLabel(r.about))}</a>` : ''} · ${esc(when(r.at))}${r.verified ? ' · checked' : ''}</div>
      ${r.object ? `<div class="dim">${esc(r.object)}</div>` : ''}
      ${r.why ? `<article class="post"><div class="body">${esc(r.why)}</div></article>` : ''}
      ${r.object ? `<div class="acts mod" data-post="${esc(r.object)}" data-cat="${esc(r.category || '')}">
        ${r.type === 'Held' || r.type === 'Create' ? '<button data-act="approve">Let it through</button><button data-act="refuse">Turn it away</button>' : ''}
        ${r.type === 'Join request' ? '<button data-act="admit">Admit</button><button data-act="refuse">Turn them away</button>' : ''}
        ${r.about ? '<button data-act="ban" data-who="' + esc(r.about) + '">Ban the author</button>' : ''}
        ${r.about && r.object ? '<button data-act="removepost" data-post="' + esc(r.object) + '">Remove the post</button>' : ''}
        ${r.type !== 'Flag' && r.by ? '<button data-act="ban" data-who="' + esc(r.by) + '">Ban them</button>' : ''}
      </div>` : ''}
    </li>`).join('')}</ul>`;
  } catch (e) { $('main').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function showWho(handleOrId) {
  crumbs([['Home', '#/'], ['Someone', null]]);
  $('main').innerHTML = '<p class="dim">Looking…</p>';
  const latest = await read.latest(base, { limit: 200 });
  const theirs = latest.filter(p => p.author === handleOrId);
  const cat = theirs[0] ? cats().find(c => c.id === theirs[0].category) : cats()[0];
  const card = cat ? await read.author(cat.base, handleOrId) : null;
  crumbs([['Home', '#/'], [card?.handle || authorLabel(handleOrId), null]]);
  const head = `<div class="topline"><h1>${esc(card?.name || card?.handle || authorLabel(handleOrId))}</h1></div>
    <p class="hint">${esc(card?.handle || authorLabel(handleOrId))}${card?.url ? ` · <a href="${esc(card.url)}">their page</a>` : ''}
      · ${theirs.length} post${theirs.length === 1 ? '' : 's'} here</p>`;
  if (!theirs.length) { $('main').innerHTML = head + '<p class="empty">Nothing from them in what the forum is holding.</p>'; return; }
  const items = [];
  for (const p of theirs) {
    const c = cats().find(x => x.id === p.category) || null;
    const tid = p.topic ? p.topic.split('/').pop() : null;
    const href = c && tid ? `#/t/${esc(c.slug)}/${esc(tid)}/${esc(await cacheKey(p.id))}` : '#/';
    items.push(`<li><a class="title" href="${href}">${esc(p.topicName || 'Topic')}</a>
      <div class="meta">${c ? esc(c.name) + ' · ' : ''}${esc(when(p.published))} · ▲ ${p.likes || 0}</div>
      <article class="post"><div class="body">${p.content || ''}</div></article></li>`);
  }
  $('main').innerHTML = head + `<ul class="list">${items.join('')}</ul>`;
}

// What a moderator may change about the forum itself. Every change is a
// request published at the moderator's own pod and checked there, so this
// page needs no rights on the forum's pod at all.
async function showSettings() {
  crumbs([['Home', '#/'], ['Settings', null]]);
  if (!iModerate()) { $('main').innerHTML = '<p class="empty">Only this forum\'s moderators may change it.</p>'; return; }
  if (!podAcct) { $('main').innerHTML = '<p class="empty">Changing the forum is done with your pod account.</p>'; return; }
  $('main').innerHTML = `
    <div class="topline"><h1>Settings</h1></div>
    <section class="reply">
      <h2>The forum</h2>
      <div class="row oneline">
        <label for="set-forum-name">Name</label>
        <input type="text" id="set-forum-name" value="${esc(forum.name || '')}">
        <button data-act="set-forum-name">Rename</button>
        <button data-act="open-mods">Manage moderators</button>
      </div>
    </section>
    <section class="reply">
      <h2>Categories</h2>
      <ul class="list bare">${cats().map(c => `<li>
        <div class="row">
          <input type="text" class="cat-name" data-cat="${esc(c.id)}" value="${esc(c.name)}">
          <button data-act="set-cat-name" data-cat="${esc(c.id)}">Rename</button>
          <button data-act="open-members" data-cat="${esc(c.id)}">Manage members</button>
          <span class="dim">${esc(handleOf(c))}</span>
          <label><input type="radio" name="cat-private-${esc(c.slug || c.id)}" data-act="set-cat-private" data-cat="${esc(c.id)}" value="open"${c.private ? '' : ' checked'}> Open</label>
          <label><input type="radio" name="cat-private-${esc(c.slug || c.id)}" data-act="set-cat-private" data-cat="${esc(c.id)}" value="private"${c.private ? ' checked' : ''}> Private</label>
        </div>
      </li>`).join('')}</ul>
    </section>
    <section class="reply">
      <h2>New Category</h2>
      <div class="row oneline">
        <label for="set-new-name">Category name</label>
        <input type="text" id="set-new-name">
        <label for="set-new-slug">Category slug</label>
        <input type="text" id="set-new-slug" placeholder="Fediverse Username" size="18">
      </div>
      <div class="row">
        <label><input type="radio" name="set-new-private" value="open" checked> Open</label>
        <label><input type="radio" name="set-new-private" value="private"> Private</label>
        <button data-act="add-cat">Create</button>
      </div>
    </section>
`;
}

async function showForum() {
  const mineView = view;
  const here = cats().find(c => c.slug === feedFilter) || null;
  crumbs(here ? [['Home', '#/'], [here.name, `#/c/${here.slug}`]] : [['Home', '#/']]);
  // Who moderates what is on screen. Showing the whole forum, that is
  // whoever moderates its categories — otherwise a moderator looking at
  // everything would look like a stranger.
  if (here) moderators = await read.moderators(here.base);
  else {
    const all = new Set();
    for (const c of cats()) for (const m of await read.moderators(c.base)) all.add(m);
    moderators = [...all];
  }
  const chip = (slug, label) => `<a class="chip${feedFilter === slug ? ' on' : ''}"${feedFilter === slug ? ' aria-current="page"' : ''} href="${slug === 'all' ? '#/' : `#/c/${esc(slug)}`}">${esc(label)}</a>`;
  // Starting a topic from the front page: in the category being shown, or the
  // first one when the whole forum is.
  const into = cats().find(c => c.slug === feedFilter) || cats()[0] || null;
  const head = `<p class="hint chips">Categories: ${chip('all', 'All')}${cats().map(c => chip(c.slug || '', c.name)).join('')}
    ${account() ? '<a class="chip" href="#/replies">Replies to you</a><a class="chip" href="#/bookmarks">Bookmarked</a>' : ''}
    ${iModerate() ? '<a class="chip" href="#/queue">Queue</a><a class="chip" href="#/settings">Settings</a>' : ''}
    <label class="vh" for="find">Search this forum</label>
    <input type="text" id="find" placeholder="Search" value="${esc(finding)}" autocomplete="off">
    ${here && account() && podAcct ? `<button class="new" data-act="${own().isJoined(here.id) ? 'leave' : 'join'}" data-cat="${esc(here.id)}">${own().isJoined(here.id) ? 'Leave' : 'Join'}</button>` : ''}
    ${into ? `<button class="new" data-act="newtopic" data-slug="${esc(into.slug || '')}">New topic</button>` : ''}</p>`;
  if (mineView !== view) return;
  $('main').innerHTML = head + '<p class="dim">Loading…</p>';
  say('Loading the latest posts');
  // Enough posts to fill a page of TOPICS: several posts can belong to one.
  const latest = await read.latest(base, { limit: Math.min(300, shown * 5) });
  const looking = finding.trim().toLowerCase();
  const mine = latest.filter(p => (feedFilter === 'all'
    || (cats().find(c => c.id === p.category)?.slug === feedFilter))
    // Searching what the page has: a topic's name, an author's handle, and
    // the words of the post itself.
    && (!looking || [p.topicName, p.author, p.content].some(v => String(v || '').toLowerCase().includes(looking))));
  // Pinned topics first. A pin belongs to a category; the forum has a
  // featured collection of its own for a pin that holds everywhere.
  const pins = { cat: new Set(), site: new Set(await read.featured(base)) };
  for (const c of cats()) {
    if (feedFilter !== 'all' && c.slug !== feedFilter) continue;
    for (const id of await read.featured(c.base)) pins.cat.add(id);
  }
  // One row per topic: the newest post in it stands for it, which is what a
  // reader wants to open — the thing they have not read.
  const byTopic = new Map();
  for (const p of mine) {
    if (!p.topic) continue;
    const held = byTopic.get(p.topic);
    if (!held || String(p.published || '') > String(held.published || '')) byTopic.set(p.topic, p);
  }
  const rank = (p) => (pins.site.has(p.topic) ? 2 : pins.cat.has(p.topic) ? 1 : 0);
  // Pinned first whatever the order; then the column the reader chose.
  const by = (p) => (order === 'replies' ? (p.topicReplies || 0) : String(p.published || ''));
  const topics = [...byTopic.values()].sort((a, b) => rank(b) - rank(a)
    || (down ? (by(a) > by(b) ? -1 : by(a) < by(b) ? 1 : 0) : (by(a) > by(b) ? 1 : by(a) < by(b) ? -1 : 0)));
  const page = topics.slice(0, shown);
  if (!topics.length) {
    // A members-only category that will not answer this reader looks exactly
    // like an empty one. Ask it a question only a member can have answered.
    if (here && !(await read.topics(here.base)).total && !(await read.canRead(here.base))) {
      if (mineView !== view) return;
      $('main').innerHTML = head + (podAcct
        ? `<p class="empty row">This category is for its members.
           <button class="new" data-act="ask-join" data-cat="${esc(here.id)}">Request membership</button></p>`
        : `<p class="empty row">This category is for its members, and membership needs a FediPod account.
           <a class="big" href="${esc(front)}/new-account">Get a FediPod account</a></p>`);
      say('This category is for its members');
      return;
    }
    // The one thing to do on an empty page is the one thing offered.
    if (mineView !== view) return;
    $('main').innerHTML = head + '<p class="empty">Nothing posted here yet. Use the button at the upper right to create a topic.</p>';
    say('Nothing posted here yet');
    return;
  }
  const rows = [];
  let fresh = 0;
  for (const p of page) {
    const cat = cats().find(c => c.id === p.category) || null;
    const who = cat && p.author ? await read.author(cat.base, p.author) : null;
    const tid = p.topic ? p.topic.split('/').pop() : null;
    const href = cat && tid ? `#/t/${esc(cat.slug)}/${esc(tid)}/${esc(await cacheKey(p.id))}` : null;
    const name = esc(p.topicName || 'Topic');
    // New to THIS reader: posted since they last had the topic open.
    const isNew = !!seen?.isNew(p.topic, p.published);
    if (isNew) fresh += 1;
    rows.push(`<tr>
      <td>${pins.site.has(p.topic) ? '<span class="pin" title="Pinned across the forum" role="img" aria-label="pinned across the forum">\u2B50</span> ' : pins.cat.has(p.topic) ? '<span class="pin" title="Pinned in this category" role="img" aria-label="pinned in this category">\uD83D\uDCCC</span> ' : ''}${href ? `<a href="${href}">${name}</a>` : name}${isNew
        ? ' <span class="badge">New<span class="vh"> since you last opened this topic</span></span>' : ''}</td>
      <td>${cat ? esc(cat.name) : ''}</td>
      <td>${who ? esc(who.handle) : esc(p.author ? authorLabel(p.author) : '')}</td>
      <td>${esc(when(p.published))}</td>
      <td>${Number.isFinite(p.topicReplies) ? p.topicReplies : ''}</td>
    </tr>`);
  }
  // A table, so a reader can run their eye down any one of the four things
  // an entry says.
  const more = Math.max(0, topics.length - page.length) + (latest.more || 0);
  if (mineView !== view) return;
  $('main').innerHTML = head + `<div class="scroll" role="region" aria-label="Topics, most recently posted in first" tabindex="0"><table class="index">
    <thead><tr><th scope="col">Topic</th><th scope="col">Category</th><th scope="col">Latest by</th>
      <th scope="col" aria-sort="${order === 'date' ? (down ? 'descending' : 'ascending') : 'none'}">
        <button class="sort" data-act="order" data-order="date">Date ${order === 'date' ? (down ? '▼' : '▲') : '<span class="dim">▽</span>'}</button></th>
      <th scope="col" aria-sort="${order === 'replies' ? (down ? 'descending' : 'ascending') : 'none'}">
        <button class="sort" data-act="order" data-order="replies">Replies ${order === 'replies' ? (down ? '▼' : '▲') : '<span class="dim">▽</span>'}</button></th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    ${more ? `<p class="row"><button data-act="more">Show ${Math.min(more, 30)} more of ${more}</button></p>` : ''}</div>`;
  say(`${rows.length} topic${rows.length === 1 ? '' : 's'}${fresh ? `, ${fresh} with something new` : ''}`);
  // The box takes the keyboard only when there is something in it to scroll:
  // a tab stop that does nothing is one more press between a reader and the page.
  const box = $('main').querySelector('.scroll');
  if (box) { if (box.scrollHeight > box.clientHeight) box.tabIndex = 0; else box.removeAttribute('tabindex'); }
}


async function showTopic(slug, tid, atPost = null) {
  const cat = catBySlug(slug);
  if (!cat) { $('main').innerHTML = '<p class="err">No such category.</p>'; return; }
  const topicId = cat.base + 'ap/topic/' + tid;
  moderators = await read.moderators(cat.base);
  crumbs([['Home', '#/'], [cat.name, `#/c/${slug}`], ['topic', null]]);
  $('main').innerHTML = '<p class="dim">Loading…</p>';
  say('Loading the topic');
  const t = await read.topic(topicId);
  if (!t) { $('main').innerHTML = '<p class="err">No such topic.</p>'; return; }
  crumbs([['Home', '#/'], [cat.name, `#/c/${slug}`], [t.name, null]]);
  const posts = [];
  for (const id of t.posts) posts.push({ id, ...(await read.post(cat.base, id)) });
  const authors = new Map();
  for (const p of posts) {
    if (!p.author || authors.has(p.author)) continue;
    authors.set(p.author, await read.author(cat.base, p.author));
  }
  // Opening a topic reads it, up to the newest post that was in it.
  seen?.markRead(topicId, seen.newest(posts));
  const placed = new Set(t.posts);
  const pending = waiting(topicId).filter(w => !placed.has(w.id));
  $('main').innerHTML = `<div class="topline"><h1>${esc(t.name)}</h1>
      <button class="primary" data-act="newpost" data-topic="${esc(topicId)}">New post</button></div>
    ${topicActs(topicId)}

    ${(await threaded(posts, authors, cat)).join('')}
    ${pending.map(w => card({ author: w.author, published: w.at, content: toHtml(w.text) },
      { cat, extra: ' waiting', waiting: true })).join('')}`;
  replyBox({ cat, title: 'Reply', inReplyToUrl: t.posts[t.posts.length - 1] || null, topicId });
  $('reply-row').hidden = true;      // the thread's own button opens it
  // A closed topic takes nothing more: the forum would refuse it anyway, so
  // the page does not offer it.
  if (t.closed) {
    for (const b of document.querySelectorAll('[data-act="newpost"], [data-act="reply"]')) b.remove();
    const said = document.createElement('p');
    said.className = 'hint';
    said.textContent = 'This topic is closed. No more replies are being taken.';
    document.querySelector('.topline')?.after(said);
  }
  // Arriving from the front page: the post that was linked to, in view and
  // marked, rather than the top of a thread it sits somewhere inside.
  say(`${t.name}, ${posts.length} post${posts.length === 1 ? '' : 's'}`);
  if (atPost) {
    const el = document.getElementById('p-' + atPost);
    // Taken to, not just scrolled to: a keyboard and a screen reader both land
    // on the post that was linked, rather than at the top of the thread.
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('picked'); el.tabIndex = -1; el.focus(); }
  }
}

// The reply box: signed out, it offers the two ways in; signed in, it posts.
let replyCtx = null;
function replyBox(ctx) {
  replyCtx = ctx;
  $('reply-row').hidden = false;
  $('reply-open').textContent = ctx.title;
  $('reply-title').textContent = ctx.title;
  $('reply-err').textContent = '';
  const acct = account();
  $('reply-signed-out').hidden = !!acct;
  $('reply-signed-in').hidden = !acct;
  $('fedi-note').textContent = '';
  editing = null;
  $('reply-send').textContent = 'Post reply';
  $('topic-title-row').hidden = !!ctx.topicId;
  $('reply-text').placeholder = ctx.topicId ? 'Write your reply' : 'Your opening post';
  $('reply-text-label').textContent = ctx.topicId ? 'Your reply' : 'Your opening post';
  if (acct) $('reply-as').textContent = acct.handle;
}

// From a handle to a way in. A server that speaks the Mastodon API signs the
// reader in here; a Lemmy server takes part by its own community address; any
// other account posts from where it is, naming the category.
async function signIn(handleInput) {
  const host = hostOfHandle(handleInput);
  if (!host) throw new Error('a handle looks like @you@your.server');
  const at = replyCtx?.cat ? handleOf(replyCtx.cat) : 'the category';
  $('fedi-note').textContent = `Asking ${host}…`;
  const handle = String(handleInput).trim().replace(/^@/u, '').split('@')[0];
  const said = await serverKind(host, front, undefined, handle);
  const kind = said.kind;
  if (kind === 'mastodon-api') {
    sessionStorage.setItem('bb:return', location.hash);
    location.href = await login.begin(host);
    return;
  }
  const note = $('fedi-note');
  note.textContent = '';
  if (kind === 'fedipod') {
    if (!said.issuer || !said.actor) throw new Error(`${host} did not say where ${handleInput} signs in`);
    sessionStorage.setItem('bb:return', location.hash);
    sessionStorage.setItem('bb:pod', JSON.stringify({ handle: `@${handle}@${host}`, actor: said.actor, podHome: said.podHome }));
    location.href = await pod.signIn({ issuer: said.issuer, redirectUri: location.origin + location.pathname });
    return;
  }
  note.textContent = kind === 'lemmy'
    ? `From ${host}, subscribe to !${at.replace(/^@/u, '')} and post there; it arrives here.`
    : kind === 'invalid'
      ? 'A handle looks like @you@your.server.'
      : `${host} does not offer a sign-in this page can use. Post from your account there, naming ${at}, and it arrives here.`;
}

// A box in front of the page is movable: press its heading and drag. It
// stays where it was put until it is closed, and it cannot be dragged off
// the edge and lost.
function movable(dlg) {
  const grip = dlg.querySelector('h2');
  if (!grip || grip.dataset.movable) return;
  grip.dataset.movable = '1';
  grip.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    const box = dlg.getBoundingClientRect();
    const from = { x: e.clientX - box.left, y: e.clientY - box.top };
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(Math.max(0, ev.clientX - from.x), window.innerWidth - box.width);
      const y = Math.min(Math.max(0, ev.clientY - from.y), window.innerHeight - 40);
      dlg.classList.add('moved');
      dlg.style.left = `${x}px`;
      dlg.style.top = `${y}px`;
    };
    const done = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', done); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done);
  });
}

// Anything the page opens in front of itself goes through here.
function openPanel(title, html) {
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  $('panel-err').textContent = '';
  const dlg = $('panel');
  dlg.classList.remove('moved');
  dlg.style.left = dlg.style.top = '';
  movable(dlg);
  dlg.showModal();
}
$('panel-close').addEventListener('click', () => $('panel').close());

$('reply-open').addEventListener('click', () => { openReply({ inReplyToUrl: replyCtx?.inReplyToUrl || null }); });
$('main').addEventListener('click', (e) => {

  // Every button in the page that names an action, wherever it sits: a
  // post's row, a topic's row, or the categories line.
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('[data-post]')?.dataset.post;
  const act = b.dataset.act;
  if (act === 'reply') return openReply({ inReplyToUrl: id });
  if (act === 'edit') return openEdit(id);
  if (act === 'delete') return removePost(id);
  if (act === 'share') return share(id, b);
  if (act === 'report') return report(id);
  if (act === 'remove') return modRemove(id);
  const topic = b.dataset.topic || b.closest('[data-topic]')?.dataset.topic;
  if (act === 'more') { shown += 30; return showForum(); }
  if (act === 'order') {
    const col = b.dataset.order;
    if (order === col) down = !down; else { order = col; down = true; }
    shown = 30;
    return showForum();
  }
  if (act === 'join' || act === 'leave') return joinOrLeave(b.dataset.cat, act === 'join');
  if (act === 'ask-join') return askToJoin(b.dataset.cat);
  if (act === 'admit') return modAdmit(id, b.closest('[data-cat]')?.dataset.cat);
  if (act === 'removepost') return modRemoveFromQueue(b.dataset.post, b.closest('[data-cat]')?.dataset.cat);
  if (act === 'save' || act === 'unsave') return saveOrNot(id, act === 'save');
  if (act === 'like' || act === 'unlike') return voteOn(id, act === 'like');
  if (act === 'approve' || act === 'refuse') return modHeld(id, b.closest('[data-cat]')?.dataset.cat, act === 'approve');
  if (act === 'ban') return modBan(b.dataset.who, b.closest('[data-cat]')?.dataset.cat);
  if (act === 'open-mods') {
    return openPanel('Moderators', `<p class="hint">${moderators.map(m => esc(authorLabel(m))).join(', ') || 'nobody yet'}</p>
      <div class="row">
        <label for="set-mod">Their Fediverse actor</label>
        <input type="text" id="set-mod" placeholder="https://their.server/users/them">
        <button data-act="add-mod">Add</button><button data-act="drop-mod">Remove</button>
      </div>
      <div class="row">
        <label for="set-mod-webid">And their WebID, so they can read the queue</label>
        <input type="text" id="set-mod-webid" placeholder="https://their.pod/profile/card#me">
        <button data-act="add-mod-webid">Add</button>
      </div>`);
  }
  if (act === 'open-members') {
    const cat = cats().find(c => c.id === b.dataset.cat);
    if (!cat) return;
    return openPanel(`Members of ${cat.name}`, `<p class="hint">Naming anyone here closes this category to everyone else. A member is named by their WebID, which is what a pod's own rule can grant.</p>
      <div class="row">
        <label for="set-member">Their WebID</label>
        <input type="text" id="set-member" class="cat-member" data-cat="${esc(cat.id)}" placeholder="https://someone.example/profile/card#me">
        <button data-act="add-member" data-cat="${esc(cat.id)}">Let them in</button>
        <button data-act="drop-member" data-cat="${esc(cat.id)}">Take them out</button>
      </div>`);
  }
  if (act.startsWith('set-') || act.startsWith('add-') || act.startsWith('drop-')) return onSettings(b);
  if (act === 'newpost') return openReply({ inReplyToUrl: replyCtx?.inReplyToUrl || null });
  if (act === 'newtopic') {
    const cat = catBySlug(b.dataset.slug);
    if (!cat) return;
    replyBox({ cat, title: 'Start a topic', inReplyToUrl: null, topicId: null });
    $('reply-row').hidden = true;
    return openReply({ inReplyToUrl: null });
  }
  if (act === 'rename') return modRename(topic);
  if (act === 'pin' || act === 'unpin') return modPin(topic, act === 'pin');
  if (act === 'sitepin' || act === 'siteunpin') return modPin(topic, act === 'sitepin', true);
  if (act === 'lock' || act === 'unlock') return modLock(topic, act === 'lock');
  if (act === 'droptopic') return modDropTopic(topic);
});

// The dialog takes the focus when it opens and hands it back to whatever
// opened it when it closes, so a keyboard is never left where the page was.
let reopener = null;
// What a private category actually promises the person about to write in it.
// Said in the box, at the moment it matters, because the word Private on a
// button is a claim and this is the whole of what is behind it.
function sayPrivacy() {
  const note = $('reply-private');
  if (!note) return;
  const cat = replyCtx?.cat;
  if (!cat?.private) { note.hidden = true; note.textContent = ''; return; }
  note.hidden = false;
  note.textContent = `${cat.name} is private. This is written into your own pod for its members to read, `
    + 'and goes to nobody else. Your followers are not sent it and cannot read it. '
    + 'Anyone admitted later can read it, and anyone admitted now can copy it.';
}

function showDialog() {
  sayPrivacy();
  reopener = document.activeElement;
  $('reply-dlg').showModal();
  (account() ? $('reply-text') : $('fedi-handle'))?.focus();
}
$('reply-dlg').addEventListener('close', () => { reopener?.focus?.(); reopener = null; });

// The dialog, armed for what it is about to do.
function openReply({ inReplyToUrl = null } = {}) {
  movable($('reply-dlg'));
  editing = null;
  if (replyCtx) replyCtx.inReplyToUrl = inReplyToUrl;
  $('reply-title').textContent = replyCtx?.title || 'Reply';
  $('reply-send').textContent = 'Post reply';
  $('reply-err').textContent = '';
  showDialog();
}

let editing = null;
async function openEdit(id) {
  const p = await read.post(replyCtx.cat.base, id);
  if (!p) { $('reply-err').textContent = 'that post is not readable here'; return; }
  editing = { id, page: p.page || null };
  $('reply-title').textContent = 'Edit your post';
  $('reply-text-label').textContent = 'Your post';
  $('reply-send').textContent = 'Save';
  $('reply-err').textContent = '';
  $('topic-title-row').hidden = true;
  // Back to the words, from the HTML the post is kept as.
  if (p.source) {
    $('reply-text').value = p.source;
  } else {
    // Written before the forum kept the source, or written elsewhere: the
    // words are recovered from the HTML, losing whatever marked them up.
    const d = document.createElement('div');
    d.innerHTML = body(p, replyCtx.cat);
    $('reply-text').value = [...d.querySelectorAll('p')].map(x => x.textContent.trim()).join('\n\n') || d.textContent.trim();
  }
  showDialog();
}

// The address of this post on this site, for pasting anywhere. The thread is
// what a person wants to open, and the post is named in it.
async function share(id, btn) {
  const hash = location.hash.startsWith('#/t/') ? location.hash : `#/t/${replyCtx.cat.slug}/${(await topicOf(id)) || ''}`;
  const link = `${location.origin}${location.pathname}${hash}`;
  try { await navigator.clipboard.writeText(link); btn.textContent = 'Copied'; say('Link copied'); }
  catch { window.prompt('Copy this address', link); return; }
  setTimeout(() => { btn.textContent = 'Share'; }, 1500);
}

// Which topic holds a post, when the page is showing a category rather than a
// thread: the card sits inside the topic's own list item.
async function topicOf(id) {
  const li = [...document.querySelectorAll('ul.list li')].find(el => el.querySelector(`[data-post="${CSS.escape(id)}"]`));
  const a = li?.querySelector('a[href^="#/t/"]');
  return a ? a.getAttribute('href').split('/').pop() : null;
}

async function report(id) {
  const why = window.prompt('Report this post to the moderators. What is wrong with it?');
  if (why === null) return;
  try {
    const cat = replyCtx.cat;
    const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
    const who = podAcct?.actor || login.account()?.url;
    await pod.report({ actor: who, object: id, category: cat.id, inbox, why });
    alert('Reported. A moderator will see it in the forum\'s queue.');
  } catch (e) { alert(e.message); }
}

async function asksTo(activity, forCat = null) {
  if (!podAcct) throw new Error('moderating from here needs your pod account');
  const cat = forCat || replyCtx.cat;
  const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
  await pod.moderate({ actor: podAcct.actor, podHome: podAcct.podHome, inbox, activity });
  alert('Sent to the forum. It takes effect once the forum has checked who asked.');
}

// A post out of its topic: a Delete whose origin is the topic it is leaving.
async function modRemove(id) {
  if (!confirm('Remove this post from the topic?')) return;
  const topicId = replyCtx.topicId || (replyCtx.cat.base + 'ap/topic/' + (await topicOf(id)));
  try { await asksTo({ type: 'Delete', object: id, origin: topicId }); } catch (e) { alert(e.message); }
}

// A topic's name belongs to the topic, and only the forum writes it.
async function modRename(topicId) {
  const now = document.querySelector('.topline h1')?.textContent || '';
  const name = window.prompt('Name for this topic', now);
  if (name === null || !name.trim()) return;
  try { await asksTo({ type: 'Update', object: { id: topicId, name: name.trim() } }); } catch (e) { alert(e.message); }
}

// Pinned topics are the category's featured collection.
// Closed to further replies. `closed` is AS2's own word for a collection
// that takes no more, so a reader on any server can see it too.
// Joining is a Follow to the category and leaving undoes it. A category
// carries its members' posts and nobody else's, so this is what makes
// posting from here work at all.
async function joinOrLeave(categoryId, on) {
  const cat = cats().find(c => c.id === categoryId);
  if (!cat || !podAcct) { alert('joining from here needs your pod account'); return; }
  try {
    const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
    const ok = on
      ? await pod.join({ actor: podAcct.actor, category: cat.id, inbox })
      : await pod.leave({ actor: podAcct.actor, category: cat.id, inbox });
    if (!ok) throw new Error('the forum did not take it');
    if (on) own().join(cat.id); else own().leave(cat.id);
    await showForum();
  } catch (e) { alert(e.message); }
}

// A vote goes to the category as a Like, and its Undo takes it back. The
// forum counts them; this browser only remembers which way this reader went.
async function voteOn(postId, up) {
  if (!podAcct) { alert('voting needs your pod account'); return; }
  const cat = replyCtx?.cat || cats().find(c => c.slug === feedFilter) || cats()[0];
  if (!cat) return;
  try {
    const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
    await pod.vote({ actor: podAcct.actor, post: postId, category: cat.id, inbox, up });
    if (up) own().like(postId); else own().unlike(postId);
    say(up ? 'Voted. The count follows once the forum has taken it.' : 'Vote taken back.');
  } catch (e) { alert(e.message); }
}

// Asking to be let into a private category: the same Follow that joining
// sends, which a category approving its members holds for a moderator.
async function askToJoin(categoryId) {
  const cat = cats().find(c => c.id === categoryId);
  if (!cat || !podAcct) return;
  try {
    const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
    await pod.join({ actor: podAcct.actor, category: cat.id, inbox });
    say('Asked. A moderator sees it in the forum\'s queue.');
    alert('Your request is with the moderators.');
  } catch (e) { alert(e.message); }
}

// Admitting somebody who asked: their follow is accepted, and in a private
// category their pod is granted the reading that membership means.
async function modAdmit(who, slug) {
  const cat = cats().find(c => c.slug === slug) || replyCtx?.cat;
  if (!cat || !who) return;
  try {
    await asksTo({ type: 'Join', object: who }, cat);
    await asksTo({ type: 'Add', object: who, target: cat.base + 'ap/members' }, cat);
    say('Admitted. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

// A bookmark is this reader's own note to come back to, in this browser.
function saveOrNot(postId, on) {
  const m = own();
  if (on) {
    const card = document.querySelector(`[data-post="${CSS.escape(postId)}"]`)?.closest('article');
    m.save({ id: postId, at: new Date().toISOString(), topic: replyCtx?.topicId || null,
      cat: replyCtx?.cat?.slug || null, text: (card?.querySelector('.body')?.textContent || '').trim().slice(0, 140) });
  } else m.unsave(postId);
  route();
}

// A held post: let through, or turned away. Both are asks like any other,
// published at the moderator's own pod and checked there.
async function modHeld(postId, slug, through) {
  const cat = cats().find(c => c.slug === slug) || replyCtx?.cat;
  if (!cat) { alert('which category is that in?'); return; }
  try {
    await asksTo({ type: through ? 'Accept' : 'Reject', object: postId }, cat);
    say(through ? 'Let through. It is carried once the forum has checked who asked.' : 'Turned away.');
  } catch (e) { alert(e.message); }
}

// A reported post taken out of its topic, from the queue rather than from
// the thread: the topic it is in is the one the forum has it in.
async function modRemoveFromQueue(postId, slug) {
  const cat = cats().find(c => c.slug === slug);
  if (!cat || !postId) return;
  if (!confirm('Remove this post from its topic?')) return;
  try {
    const copy = await read.post(cat.base, postId);
    if (!copy?.topic) throw new Error('the forum does not say which topic holds it');
    await asksTo({ type: 'Delete', object: postId, origin: copy.topic }, cat);
    say('Asked. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

// Banning: the category blocks them, which is the whole of what a group can
// enforce — it stops carrying them and ends the following.
async function modBan(who, slug) {
  const cat = cats().find(c => c.slug === slug) || replyCtx?.cat;
  if (!cat || !who) return;
  if (!confirm(`Ban ${authorLabel(who)} from ${cat.name}? Their posts stop being carried.`)) return;
  try {
    await asksTo({ type: 'Block', object: who }, cat);
    say('Asked. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

// Every settings change is an ordinary activity naming what it changes: a
// Create of a Group for a new category, an Update for a name, an Add or a
// Remove for who moderates and who may read.
async function settingsAsk(activity) {
  try {
    const inbox = await pod.podInboxOf(cats()[0]?.id || forum.id, { front, handle: cats()[0]?.slug || forum.handle });
    await pod.moderate({ actor: podAcct.actor, podHome: podAcct.podHome, inbox, activity });
    say('Sent. It takes effect once the forum has checked who asked.');
  } catch (e) { alert(e.message); }
}

async function onSettings(b) {
  const act = b.dataset.act;
  const catId = b.dataset.cat;
  const val = (sel) => document.querySelector(sel)?.value.trim() || '';
  if (act === 'set-forum-name') {
    const name = val('#set-forum-name');
    if (name) await settingsAsk({ type: 'Update', object: { id: forum.id, name } });
  } else if (act === 'set-cat-name') {
    const name = document.querySelector(`.cat-name[data-cat="${CSS.escape(catId)}"]`)?.value.trim();
    if (name) await settingsAsk({ type: 'Update', object: { id: catId, name } });
  } else if (act === 'add-cat') {
    const slug = val('#set-new-slug').toLowerCase();
    const name = val('#set-new-name') || slug;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug)) { alert('a Fediverse username is lower-case letters, digits and hyphens'); return; }
    const priv = document.querySelector('input[name="set-new-private"]:checked')?.value === 'private';
    await settingsAsk({ type: 'Create', target: forum.id,
      object: { type: 'Group', preferredUsername: slug, name, ...(priv ? { manuallyApprovesFollowers: true } : {}) } });
  } else if (act === 'add-member' || act === 'drop-member') {
    const webid = document.querySelector(`.cat-member[data-cat="${CSS.escape(catId)}"]`)?.value.trim();
    const cat = cats().find(c => c.id === catId);
    if (webid && cat) await settingsAsk({ type: act === 'add-member' ? 'Add' : 'Remove', object: webid, target: cat.base + 'ap/members' });
  } else if (act === 'add-mod' || act === 'drop-mod') {
    const who = val('#set-mod');
    const cat = cats()[0];
    if (who && cat) await settingsAsk({ type: act === 'add-mod' ? 'Add' : 'Remove', object: who, target: cat.base + 'ap/moderators' });
  } else if (act === 'add-mod-webid') {
    const webid = val('#set-mod-webid');
    if (webid) await settingsAsk({ type: 'Add', object: webid, target: `${base}mod/` });
  }
}

async function modLock(topicId, on) {
  try {
    await asksTo({ type: 'Update', object: { id: topicId, closed: on ? new Date().toISOString() : false } });
  } catch (e) { alert(e.message); }
}

async function modPin(topicId, on, wholeSite = false) {
  // Which featured collection it goes into says how far the pin reaches: the
  // category's, or the forum's own.
  const target = wholeSite ? base + 'ap/featured' : replyCtx.cat.base + 'ap/featured';
  try { await asksTo({ type: on ? 'Add' : 'Remove', object: topicId, target }); } catch (e) { alert(e.message); }
}

// A topic removed from the category is a topic gone (FEP-f15d).
async function modDropTopic(topicId) {
  if (!confirm('Delete this topic and every post in it?')) return;
  try { await asksTo({ type: 'Remove', object: topicId, target: replyCtx.cat.id }); } catch (e) { alert(e.message); }
}

async function removePost(id) {
  if (!confirm('Delete this post? Everywhere it has reached is told to remove it.')) return;
  try {
    const cat = replyCtx.cat;
    if (podAcct) {
      const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
      await pod.remove({ actor: podAcct.actor, podHome: podAcct.podHome, id, category: cat.id,
        categoryBase: cat.base, isPrivate: !!cat.private, inbox });
    } else {
      const p = await read.post(cat.base, id);
      await login.remove({ url: p?.page || id });
    }
    await route();
  } catch (e) { alert(e.message); }
}
$('reply-cancel').addEventListener('click', () => $('reply-dlg').close());
// Open or private is the forum's setting, changed here and nowhere else:
// nobody joining, and nobody being named a member, ever moves a category
// between the two.
$('main').addEventListener('change', async (e) => {
  const r = e.target;
  if (r?.dataset?.act !== 'set-cat-private' || !r.checked) return;
  const cat = cats().find(c => c.id === r.dataset.cat);
  if (!cat) return;
  const priv = r.value === 'private';
  if (priv === !!cat.private) return;
  await settingsAsk({ type: 'Update', object: { id: cat.id, manuallyApprovesFollowers: priv } });
  cat.private = priv;
});

let findTimer = null;
$('main').addEventListener('input', (e) => {
  if (e.target?.id !== 'find') return;
  finding = e.target.value;
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const where = e.target.selectionStart;
    await showForum();
    const box = document.getElementById('find');
    if (box) { box.focus(); box.setSelectionRange(where, where); }
  }, 250);
});

$('reply-image').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  const said = $('reply-image-said');
  if (!file) return;
  if (!podAcct) { said.textContent = 'adding an image needs your pod account'; e.target.value = ''; return; }
  said.textContent = 'putting it in your pod…';
  try {
    const url = await pod.upload({ actor: podAcct.actor, podHome: podAcct.podHome, file });
    const box = $('reply-text');
    const alt = file.name.replace(/\.[^.]+$/u, '').replace(/[-_]+/gu, ' ');
    box.value = `${box.value}${box.value && !box.value.endsWith('\n') ? '\n\n' : ''}![${alt}](${url})\n`;
    said.textContent = 'added';
    box.focus();
  } catch (err) { said.textContent = err.message; }
  e.target.value = '';
});

$('fedi-login').addEventListener('click', async () => {
  $('reply-err').textContent = '';
  $('fedi-login').disabled = true;
  try { await signIn($('fedi-handle').value); } catch (e) { $('reply-err').textContent = e.message; }
  $('fedi-login').disabled = false;
});
$('fedi-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fedi-login').click(); });
$('masto-logout').addEventListener('click', async () => {
  if (podAcct) { await pod.signOut(); podAcct = null; localStorage.removeItem('bb:acct'); sessionStorage.removeItem('bb:pod'); } else login.signOut();
  if (replyCtx) replyBox(replyCtx);
});

async function saveEdit({ body }) {
  const cat = replyCtx.cat;
  if (podAcct) {
    const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
    return pod.edit({ actor: podAcct.actor, podHome: podAcct.podHome, id: editing.id, text: body, category: cat.id,
      categoryBase: cat.base, isPrivate: !!cat.private, inbox });
  }
  return login.edit({ url: editing.page || editing.id, text: body });
}

// A post written into the reader's own pod and announced to the forum. The
// category is named on its own pod, which is where a delivery is taken.
async function postFromPod({ topic, body }) {
  const cat = replyCtx.cat;
  const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
  if (!inbox) throw new Error('the forum did not say where to send it');
  // Posting in an open category joins it on the way past, which is what makes
  // the post carry. A private one is joined by asking and being admitted, so
  // the post is refused here instead, and says so.
  if (!cat.private) await pod.join({ actor: podAcct.actor, category: cat.id, inbox });
  return pod.post({
    actor: podAcct.actor, podHome: podAcct.podHome, category: cat.id, categoryBase: cat.base,
    categoryHandle: handleOf(cat), isPrivate: !!cat.private, inbox,
    topic, text: body, inReplyTo: replyCtx.inReplyToUrl,
    context: replyCtx.topicId ? replyCtx.topicId : null,
  });
}
$('reply-send').addEventListener('click', async () => {
  if (!replyCtx) return;
  const body = $('reply-text').value.trim();
  if (!body) return;
  // A Mastodon post has no topic name to give: its first line stands in for
  // one, which is all that server can say. A pod post names the topic on the
  // activity that opens it, and its words are only its words.
  // The topic's name, asked for only when a topic is being opened; the
  // post's own title, which any post may have and any edit may change.
  const topic = !editing && !replyCtx.topicId ? $('topic-title').value.trim() : '';

  const text = topic ? `${topic}\n\n${body}` : body;
  $('reply-err').textContent = '';
  $('reply-send').disabled = true;
  try {
    const made = editing
      ? await saveEdit({ body })
      : podAcct
        ? await postFromPod({ topic, body })
        : await login.post({ text, mention: handleOf(replyCtx.cat), inReplyToUrl: replyCtx.inReplyToUrl });
    const acct = account();
    if (!editing && replyCtx.topicId) remember(replyCtx.topicId, { id: made.uri || made.url, author: acct.url || acct.handle, text, at: new Date().toISOString() });
    $('reply-text').value = '';
    $('topic-title').value = '';
    $('reply-dlg').close();
    await route();
  } catch (e) { $('reply-err').textContent = e.message; }
  $('reply-send').disabled = false;
});

// Back from the reader's server with a code: finish the sign-in, then clean
// the address so a reload does not replay it.
(async () => {
  // Back from a pod's sign-in: the session is this browser's, and the handle
  // it belongs to was put aside before leaving.
  // A reader who signed in stays signed in: the pod session lives in this
  // browser, and the handle it belongs to is kept beside it.
  const kept = localStorage.getItem('bb:acct');
  if (kept && !sessionStorage.getItem('bb:pod')) {
    try {
      const s = await pod.session();
      if (s) { podAcct = { ...JSON.parse(kept), webId: s.webId }; read = reader({ session: s }); }
      else localStorage.removeItem('bb:acct');
    } catch { localStorage.removeItem('bb:acct'); }
  }
  const waiting = sessionStorage.getItem('bb:pod');
  if (waiting) {
    try {
      const who = JSON.parse(waiting);
      const s = params.get('code') ? await pod.complete(location.href) : await pod.session();
      if (s) {
        podAcct = { ...who, webId: s.webId };
        read = reader({ session: s });
        try { localStorage.setItem('bb:acct', JSON.stringify(who)); } catch { /* blocked storage */ }
        sessionStorage.removeItem('bb:pod');
        params.delete('code'); params.delete('state'); params.delete('iss');
        const q = String(params);
        const back = sessionStorage.getItem('bb:return') || '';
        sessionStorage.removeItem('bb:return');
        history.replaceState(null, '', `${location.pathname}${q ? '?' + q : ''}${back}`);
      }
    } catch (e) { $('reply-err').textContent = e.message; }
  }
  const code = params.get('code');
  const state = params.get('state');
  if (code && state) {
    try {
      await login.complete({ state, code });
      params.delete('code'); params.delete('state');
      const back = sessionStorage.getItem('bb:return') || '';
      sessionStorage.removeItem('bb:return');
      const q = String(params);
      history.replaceState(null, '', `${location.pathname}${q ? '?' + q : ''}${back}`);
    } catch (e) { $('reply-err').textContent = e.message; }
  }
  // Sign-up lives at the Gateway, which is this page's own site or the one it is a face of.
  $('fedipod-signup').href = front + '/new-account';
  window.addEventListener('hashchange', () => route());
  await load();
})();
