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
  return `<a href="${esc(author.url)}">${inner}</a>`;
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

function card(p, { author = null, cat = null, extra = '', waiting = false } = {}) {
  const at = p.published ? when(p.published) : '';
  return `<article class="post${p.gone ? ' gone' : ''}${extra}">
    <div class="who"><b>${waiting ? '<span class="dim">waiting for the forum · </span>' : ''}${byline(p, author)}</b>
      <span class="when">${esc(at)}${elsewhere(p)}</span></div>
    ${p.name ? `<h2>${esc(p.name)}</h2>` : ''}
    <div class="body">${p.gone ? 'This post was removed.' : (body(p, cat) || '<span class="dim">(not readable here)</span>')}</div>
    ${p.gone || waiting || !p.id ? '' : `<div class="acts" data-post="${esc(p.id)}">
      <button data-act="reply">Reply</button>
      ${mine(p) ? '<button data-act="edit">Edit</button><button data-act="delete">Delete</button>' : ''}
    </div>`}
  </article>`;
}

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
      <div class="meta"><a href="#/t/${esc(slug)}/${esc(tid)}">${t.count} post${t.count === 1 ? '' : 's'}</a> · last ${esc(when(t.updated))}</div>
      ${first ? card(first, { author: who, cat }) : ''}</li>`);
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
  const placed = new Set(t.posts);
  const pending = waiting(topicId).filter(w => !placed.has(w.id));
  $('main').innerHTML = `<h1>${esc(t.name)}</h1>
    ${posts.map(p => card(p, { author: p.author ? authors.get(p.author) : null, cat })).join('')}
    ${pending.map(w => card({ author: w.author, published: w.at, content: esc(w.text).replace(/\n/g, '<br>') },
      { cat, extra: ' waiting', waiting: true })).join('')}`;
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
  editing = null;
  $('reply-send').textContent = 'Post reply';
  $('post-title').value = '';
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

$('reply-open').addEventListener('click', () => { openReply({ inReplyToUrl: replyCtx?.inReplyToUrl || null }); });
$('main').addEventListener('click', (e) => {
  const b = e.target.closest('.acts button');
  if (!b) return;
  const id = b.closest('.acts')?.dataset.post;
  const act = b.dataset.act;
  if (act === 'reply') return openReply({ inReplyToUrl: id });
  if (act === 'edit') return openEdit(id);
  if (act === 'delete') return removePost(id);
});

// The dialog, armed for what it is about to do.
function openReply({ inReplyToUrl = null } = {}) {
  editing = null;
  if (replyCtx) replyCtx.inReplyToUrl = inReplyToUrl;
  $('reply-title').textContent = replyCtx?.title || 'Reply';
  $('reply-send').textContent = 'Post reply';
  $('reply-err').textContent = '';
  $('reply-dlg').showModal();
}

let editing = null;
async function openEdit(id) {
  const p = await read.post(replyCtx.cat.base, id);
  if (!p) { $('reply-err').textContent = 'that post is not readable here'; return; }
  editing = { id, page: p.page || null };
  $('reply-title').textContent = 'Edit your post';
  $('reply-send').textContent = 'Save';
  $('reply-err').textContent = '';
  $('topic-title-row').hidden = true;
  $('post-title').value = p.name || '';
  // Back to the words, from the HTML the post is kept as.
  const d = document.createElement('div');
  d.innerHTML = body(p, replyCtx.cat);
  $('reply-text').value = [...d.querySelectorAll('p')].map(x => x.textContent.trim()).join('\n\n') || d.textContent.trim();
  $('reply-dlg').showModal();
}

async function removePost(id) {
  if (!confirm('Delete this post? Everywhere it has reached is told to remove it.')) return;
  try {
    const cat = replyCtx.cat;
    if (podAcct) {
      const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
      await pod.remove({ actor: podAcct.actor, podHome: podAcct.podHome, id, category: cat.id, inbox });
    } else {
      const p = await read.post(cat.base, id);
      await login.remove({ url: p?.page || id });
    }
    await route();
  } catch (e) { alert(e.message); }
}
$('reply-cancel').addEventListener('click', () => $('reply-dlg').close());
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

async function saveEdit({ title, body }) {
  const cat = replyCtx.cat;
  if (podAcct) {
    const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
    return pod.edit({ actor: podAcct.actor, podHome: podAcct.podHome, id: editing.id, title, text: body, category: cat.id, inbox });
  }
  return login.edit({ url: editing.page || editing.id, text: body });
}

// A post written into the reader's own pod and announced to the forum. The
// category is named on its own pod, which is where a delivery is taken.
async function postFromPod({ topic, title, body }) {
  const cat = replyCtx.cat;
  const inbox = await pod.podInboxOf(cat.id, { front, handle: cat.slug || null });
  if (!inbox) throw new Error('the forum did not say where to send it');
  await pod.join({ actor: podAcct.actor, category: cat.id, inbox });
  return pod.post({
    actor: podAcct.actor, podHome: podAcct.podHome, category: cat.id, categoryHandle: handleOf(cat), inbox,
    topic, title, text: body, inReplyTo: replyCtx.inReplyToUrl,
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
  const title = $('post-title').value.trim();
  const text = topic ? `${topic}\n\n${body}` : body;
  $('reply-err').textContent = '';
  $('reply-send').disabled = true;
  try {
    const made = editing
      ? await saveEdit({ title, body })
      : podAcct
        ? await postFromPod({ topic, title, body })
        : await login.post({ text, mention: handleOf(replyCtx.cat), inReplyToUrl: replyCtx.inReplyToUrl });
    const acct = account();
    if (replyCtx.topicId) remember(replyCtx.topicId, { id: made.uri || made.url, author: acct.url || acct.handle, text, at: new Date().toISOString() });
    $('reply-text').value = '';
    $('topic-title').value = '';
    $('post-title').value = '';
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
