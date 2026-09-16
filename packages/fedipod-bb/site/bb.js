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
import * as pod from './pod.mjs';

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
let podAcct = null;          // { handle, actor, webId } when signed in with a pod
const account = () => podAcct || login.account();
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
  $('forum-status').hidden = parts.length > 1;
  $('crumbs').innerHTML = parts.map(([label, href], i) => (href && i < parts.length - 1 ? `<a href="${esc(href)}">${esc(label)}</a>` : esc(label))).join(' › ');
}

async function route() {
  const hash = location.hash.replace(/^#\/?/u, '');
  const [kind, a, b] = hash.split('/');
  $('reply-row').hidden = true;
  $('reply-dlg').close();
  if (kind === 'c' && a) return showCategory(a);
  if (kind === 't' && a && b) return showTopic(a, b);
  return showForum();
}

function showForum() {
  crumbs([['Home', '#/']]);
  const items = cats().map(c => `<li><a class="title" href="#/c/${esc(c.slug || '')}">${esc(c.name)}</a>
    <div class="meta">${c.members} member${c.members === 1 ? '' : 's'} · ${esc(handleOf(c))}</div>
    ${c.summary ? `<div class="dim">${c.summary}</div>` : ''}</li>`);
  $('main').innerHTML = `${forum.summary ? `<div>${forum.summary}</div>` : ''}
    ${items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="empty">No categories yet.</p>'}`;
}

async function showCategory(slug) {
  const cat = catBySlug(slug);
  if (!cat) { $('main').innerHTML = '<p class="err">No such category.</p>'; return; }
  crumbs([['Home', '#/'], [cat.name, `#/c/${slug}`]]);
  $('main').innerHTML = '<p class="dim">Loading topics…</p>';
  const { topics } = await read.topics(cat.base);
  // Each topic shows its opening post: a reader sees what was written
  // without opening anything, and the title opens the rest.
  const items = [];
  for (const t of topics.slice(0, 20)) {
    const tid = t.id.split('/').pop();
    const full = await read.topic(t.id);
    const first = full?.posts?.[0] ? await read.post(cat.base, full.posts[0]) : null;
    const who = first?.author ? await read.author(cat.base, first.author) : null;
    items.push(`<li><div class="title">${esc(t.name)}</div>
      <div class="meta">${who ? esc(who.handle) + ' · ' : ''}<a href="#/t/${esc(slug)}/${esc(tid)}">${t.count} post${t.count === 1 ? '' : 's'}</a> · last ${esc(when(t.updated))}</div>
      ${first && !first.gone ? `<article class="post"><div class="body">${first.content || ''}</div></article>` : ''}</li>`);
  }
  $('main').innerHTML = `${items.length ? `<ul class="list">${items.join('')}</ul>` : '<p class="empty">No topics yet. The first post mentioning this category opens one.</p>'}`;
  replyBox({ cat, title: 'Start a topic', inReplyToUrl: null, topicId: null });
}

async function showTopic(slug, tid) {
  const cat = catBySlug(slug);
  if (!cat) { $('main').innerHTML = '<p class="err">No such category.</p>'; return; }
  const topicId = cat.base + 'ap/topic/' + tid;
  crumbs([['Home', '#/'], [cat.name, `#/c/${slug}`], ['topic', null]]);
  $('main').innerHTML = '<p class="dim">Loading…</p>';
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
  $('reply-row').hidden = false;
  $('reply-open').textContent = ctx.title;
  $('reply-title').textContent = ctx.title;
  $('reply-err').textContent = '';
  const acct = account();
  $('reply-signed-out').hidden = !!acct;
  $('reply-signed-in').hidden = !acct;
  $('fedi-note').textContent = '';
  $('topic-title-row').hidden = !!ctx.topicId;
  $('reply-text').placeholder = ctx.topicId ? 'Write your reply' : 'Your opening post';
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

$('reply-open').addEventListener('click', () => { $('reply-err').textContent = ''; $('reply-dlg').showModal(); });
$('reply-close').addEventListener('click', () => $('reply-dlg').close());
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

// A post written into the reader's own pod and announced to the forum. The
// category is named on its own pod, which is where a delivery is taken.
async function postFromPod({ title, body }) {
  const cat = replyCtx.cat;
  const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
  if (!inbox) throw new Error('the forum did not say where to send it');
  await pod.join({ actor: podAcct.actor, category: cat.id, inbox });
  return pod.post({
    actor: podAcct.actor, podHome: podAcct.podHome, category: cat.id, categoryHandle: handleOf(cat), inbox,
    title, text: body, inReplyTo: replyCtx.inReplyToUrl,
    context: replyCtx.topicId ? replyCtx.topicId : null,
  });
}
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
    const made = podAcct
      ? await postFromPod({ title, body })
      : await login.post({ text, mention: handleOf(replyCtx.cat), inReplyToUrl: replyCtx.inReplyToUrl });
    const acct = account();
    if (replyCtx.topicId) remember(replyCtx.topicId, { id: made.uri || made.url, author: acct.url || acct.handle, text, at: new Date().toISOString() });
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
      if (s) podAcct = { ...JSON.parse(kept), webId: s.webId };
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
