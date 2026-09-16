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

import { reader, placeOf, authorLabel } from './read.mjs';
import { MastoLogin, hostOfHandle, serverKind } from './masto.mjs';

const $ = (id) => document.getElementById(id);
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
const read = reader();
const login = new MastoLogin({ storage: localStorage, redirectUri: location.origin + location.pathname + location.search });

let forum = null;
const cats = () => forum?.categories || [];
const catBySlug = (slug) => cats().find(c => c.slug === slug || c.base.endsWith('/c/' + slug + '/'));
const handleOf = (cat) => {
  // Through a Gateway a category answers as @slug@gateway; read from a pod, its id is its address.
  if (place.handle && cat.slug) return `@${cat.slug}@${frontHost}`;
  return cat.id;
};
const waitingKey = (topicId) => 'bb:waiting:' + topicId;
const waiting = (topicId) => { try { return JSON.parse(localStorage.getItem(waitingKey(topicId)) || '[]'); } catch { return []; } };
const remember = (topicId, entry) => { try { localStorage.setItem(waitingKey(topicId), JSON.stringify([...waiting(topicId), entry].slice(-20))); } catch { /* full or blocked */ } };

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
  $('forum-status').textContent = forum.lastHosted ? `hosted ${ago(forum.lastHosted)}` : 'not hosted yet';
  route();
}

function crumbs(parts) {
  $('crumbs').innerHTML = parts.map(([label, href], i) => (href && i < parts.length - 1 ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join(' › ');
}

async function route() {
  const hash = location.hash.replace(/^#\/?/u, '');
  const [kind, a, b] = hash.split('/');
  $('reply').hidden = true;
  if (kind === 'c' && a) return showCategory(a);
  if (kind === 't' && a && b) return showTopic(a, b);
  return showForum();
}

function showForum() {
  crumbs([[forum.name, '#/']]);
  const items = cats().map(c => `<li><a class="title" href="#/c/${esc(c.slug || '')}">${esc(c.name)}</a>
    <div class="meta">${c.members} member${c.members === 1 ? '' : 's'} · ${esc(handleOf(c))}</div>
    ${c.summary ? `<div class="dim">${c.summary}</div>` : ''}</li>`);
  $('main').innerHTML = `${forum.summary ? `<div>${forum.summary}</div>` : ''}
    ${items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="empty">No categories yet.</p>'}`;
}

async function showCategory(slug) {
  const cat = catBySlug(slug);
  if (!cat) { $('main').innerHTML = '<p class="err">No such category.</p>'; return; }
  crumbs([[forum.name, '#/'], [cat.name, `#/c/${slug}`]]);
  $('main').innerHTML = '<p class="dim">Loading topics…</p>';
  const { topics } = await read.topics(cat.base);
  const items = topics.map(t => {
    const tid = t.id.split('/').pop();
    return `<li><a class="title" href="#/t/${esc(slug)}/${esc(tid)}">${esc(t.name)}</a>
      <div class="meta">${t.count} post${t.count === 1 ? '' : 's'} · last ${esc(when(t.updated))}</div></li>`;
  });
  $('main').innerHTML = `<p class="hint">Follow <code>${esc(handleOf(cat))}</code> from Mastodon or Lemmy to see new topics where you are.</p>
    ${items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="empty">No topics yet. The first post mentioning this category opens one.</p>'}`;
  replyBox({ cat, title: 'Start a topic', inReplyToUrl: null, topicId: null });
}

async function showTopic(slug, tid) {
  const cat = catBySlug(slug);
  if (!cat) { $('main').innerHTML = '<p class="err">No such category.</p>'; return; }
  const topicId = cat.base + 'ap/topic/' + tid;
  crumbs([[forum.name, '#/'], [cat.name, `#/c/${slug}`], ['topic', null]]);
  $('main').innerHTML = '<p class="dim">Loading…</p>';
  const t = await read.topic(topicId);
  if (!t) { $('main').innerHTML = '<p class="err">No such topic.</p>'; return; }
  crumbs([[forum.name, '#/'], [cat.name, `#/c/${slug}`], [t.name, null]]);
  const posts = [];
  for (const id of t.posts) posts.push({ id, ...(await read.post(cat.base, id)) });
  const authors = new Map();
  for (const p of posts) {
    if (!p.author || authors.has(p.author)) continue;
    authors.set(p.author, await read.author(cat.base, p.author));
  }
  const who = (p) => { const a = p.author && authors.get(p.author); return a ? `<a href="${esc(a.url)}">${esc(a.handle)}</a>` : esc(p.author ? authorLabel(p.author) : ''); };
  const placed = new Set(t.posts);
  const pending = waiting(topicId).filter(w => !placed.has(w.id));
  const article = (p, extra = '') => `<article class="post${p.gone ? ' gone' : ''}${extra}">
    <div class="who"><b>${who(p)}</b><span>${esc(when(p.published))}</span>
      ${p.id ? `<a href="${esc(p.id)}" class="dim">original</a>` : ''}</div>
    ${p.name ? `<h2>${esc(p.name)}</h2>` : ''}
    <div class="body">${p.gone ? 'This post was removed.' : (p.content || '<span class="dim">(not readable here)</span>')}</div>
  </article>`;
  $('main').innerHTML = `<h1>${esc(t.name)}</h1>
    ${posts.map(p => article(p)).join('')}
    ${pending.map(w => article({ author: w.author, published: w.at, content: esc(w.text).replace(/\n/g, '<br>') }, ' waiting')
      .replace('<div class="who">', '<div class="who"><span class="dim">waiting for the forum ·</span>')).join('')}`;
  replyBox({ cat, title: 'Reply', inReplyToUrl: t.posts[t.posts.length - 1] || null, topicId });
}

// The reply box: signed out, it offers the two ways in; signed in, it posts.
let replyCtx = null;
function replyBox(ctx) {
  replyCtx = ctx;
  const box = $('reply');
  box.hidden = false;
  $('reply-title').textContent = ctx.title;
  $('reply-handle').textContent = handleOf(ctx.cat);
  $('reply-err').textContent = '';
  const acct = login.account();
  $('reply-signed-out').hidden = !!acct;
  $('reply-signed-in').hidden = !acct;
  $('fedi-note').textContent = '';
  $('topic-title-row').hidden = !!ctx.topicId;
  $('reply-text').placeholder = ctx.topicId ? 'Write your reply' : 'Your opening post';
  if (acct) {
    $('reply-as').textContent = acct.handle;
    $('reply-note').textContent = `Your server will address it to your followers too. It names ${handleOf(ctx.cat)} so the forum receives it.`;
  }
}

// From a handle to a way in. A server that speaks the Mastodon API signs the
// reader in here; a Lemmy server takes part by its own community address; any
// other account posts from where it is, naming the category.
async function signIn(handleInput) {
  const host = hostOfHandle(handleInput);
  if (!host) throw new Error('a handle looks like @you@your.server');
  const cat = replyCtx?.cat;
  const kind = await serverKind(host);
  if (kind === 'mastodon-api') {
    sessionStorage.setItem('bb:return', location.hash);
    location.href = await login.begin(host);
    return;
  }
  const at = cat ? handleOf(cat) : 'the category';
  $('fedi-note').textContent = kind === 'lemmy'
    ? `From Lemmy, subscribe to !${at.replace(/^@/u, '')} and post in it there; it arrives here.`
    : `Post from your account at ${host} mentioning ${at}; it arrives here.`;
}

$('fedi-login').addEventListener('click', async () => {
  $('reply-err').textContent = '';
  $('fedi-login').disabled = true;
  try { await signIn($('fedi-handle').value); } catch (e) { $('reply-err').textContent = e.message; }
  $('fedi-login').disabled = false;
});
$('fedi-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('fedi-login').click(); });
$('masto-logout').addEventListener('click', () => { login.signOut(); if (replyCtx) replyBox(replyCtx); });
$('reply-send').addEventListener('click', async () => {
  if (!replyCtx) return;
  const body = $('reply-text').value.trim();
  if (!body) return;
  // A new topic's title is its first line: the host takes a post's first
  // words as the title, and a titled line reads as one everywhere.
  const title = replyCtx.topicId ? '' : $('topic-title').value.trim();
  const text = title ? `${title}\n\n${body}` : body;
  $('reply-err').textContent = '';
  $('reply-send').disabled = true;
  try {
    const made = await login.post({ text, mention: handleOf(replyCtx.cat), inReplyToUrl: replyCtx.inReplyToUrl });
    const acct = login.account();
    if (replyCtx.topicId) remember(replyCtx.topicId, { id: made.uri || made.url, author: acct.url || acct.handle, text, at: new Date().toISOString() });
    $('reply-text').value = '';
    $('topic-title').value = '';
    await route();
  } catch (e) { $('reply-err').textContent = e.message; }
  $('reply-send').disabled = false;
});

// Back from the reader's server with a code: finish the sign-in, then clean
// the address so a reload does not replay it.
(async () => {
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
