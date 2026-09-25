'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { reader, authorLabel, cacheKey } from '../site/read.mjs';
import { MastoLogin, hostOfHandle, serverKind, actorOfHandle } from '../site/masto.mjs';
import * as pod from '../site/pod.mjs';
import { mine } from '../site/mine.mjs';
import { readState } from '../site/seen.mjs';
import { toHtml } from '../site/markdown.mjs';
import { safeBody, date } from './content.mjs';

const parseRoute = (hash, fallback) => {
  const [kind, a, b, c] = String(hash || '').replace(/^#\/?/u, '').split('/');
  if (kind === 't' && a && b) return { kind: 'topic', slug: decodeURIComponent(a), tid: decodeURIComponent(b), at: c || null };
  if (kind === 'c' && a) return { kind: 'category', slug: decodeURIComponent(a) };
  if (kind === 'who' && a) return { kind: 'who', id: decodeURIComponent(a) };
  if (['replies', 'bookmarks', 'saved', 'queue', 'settings'].includes(kind)) return { kind: kind === 'saved' ? 'bookmarks' : kind };
  return fallback || { kind: 'index' };
};
const routeKey = (r) => [r.kind, r.slug, r.tid, r.id].filter(Boolean).join('/');
const topicHref = (cat, topic, digest = null) => cat && topic
  ? `#/t/${encodeURIComponent(cat.slug)}/${encodeURIComponent(topic.split('/').pop())}${digest ? '/' + digest : ''}` : '#/';
const waitingKey = (topic) => 'bb:waiting:' + topic;
const waitingPosts = (topic) => { try { return (JSON.parse(localStorage.getItem(waitingKey(topic)) || '[]') || []).filter(p => p?.id); } catch { return []; } };
const rememberWaiting = (topic, entry) => { if (!entry?.id) return; try { localStorage.setItem(waitingKey(topic), JSON.stringify([...waitingPosts(topic), entry].slice(-20))); } catch {} };
const urlHost = value => { try { return new URL(value).host; } catch { return ''; } };
const noStore = { saved: () => [], isSaved: () => false, isJoined: () => false, votedOn: () => 'none' };

function Html({ html }) { return <div dangerouslySetInnerHTML={{ __html: safeBody(html) }} />; }

function PostCard({ post, author, cat, digest, account, isMine, isModerator, own, votes, onAction, waiting = false }) {
  const who = author?.name || author?.handle || authorLabel(post.author || 'someone');
  const way = own.votedOn(post.id);
  const up = votes?.up ?? post.likes ?? 0;
  const down = votes?.down ?? post.dislikes ?? 0;
  return <article className={`post${post.gone ? ' gone' : ''}${waiting ? ' waiting' : ''}`} id={digest ? `p-${digest}` : undefined} aria-label={`${waiting ? 'Waiting: p' : 'P'}ost by ${who}${post.published ? ', ' + date(post.published) : ''}`}>
    <div className="who"><b>{waiting && <span className="dim">waiting for the forum · </span>}{post.author ? <a href={`#/who/${encodeURIComponent(post.author)}`}>{author?.name || author?.handle || authorLabel(post.author)}{author?.name && author?.handle && author.name !== author.handle && <span className="dim"> {author.handle}</span>}</a> : 'someone'}</b><span className="when">{date(post.published)}{urlHost(post.page) && <a className="dim" href={post.page} rel="noopener">on {urlHost(post.page)}</a>}</span></div>
    <div className="body">{post.gone ? 'This post was removed.' : post.content ? <Html html={post.content} /> : <span className="dim">(not readable here)</span>}</div>
    {!post.gone && !waiting && post.id && <div className="acts">
      <button onClick={() => onAction('reply', post, cat)} aria-label={`Reply to ${who}`}>Reply</button>
      <button className={way === 'up' ? 'voted' : ''} aria-pressed={way === 'up'} onClick={() => onAction('vote', post, cat, way === 'up' ? 'none' : 'up', way)} aria-label={way === 'up' ? 'Take back your vote for this post' : 'Vote for this post'}>▲ {up}</button>
      <button className={way === 'down' ? 'voted' : ''} aria-pressed={way === 'down'} onClick={() => onAction('vote', post, cat, way === 'down' ? 'none' : 'down', way)} aria-label={way === 'down' ? 'Take back your vote against this post' : 'Vote against this post'}>▼ {down}</button>
      <button onClick={() => onAction('share', post, cat, digest)} aria-label={`Copy a link to the post by ${who}`}>Share</button>
      {account && <button onClick={() => onAction(own.isSaved(post.id) ? 'unsave' : 'save', post, cat)} aria-label={own.isSaved(post.id) ? 'Remove this post from your bookmarks' : 'Bookmark this post'}>{own.isSaved(post.id) ? 'Bookmarked' : 'Bookmark'}</button>}
      {account && !isMine && <button onClick={() => onAction('report', post, cat)} aria-label={`Report the post by ${who}`}>Report</button>}
      {isMine && <><button onClick={() => onAction('edit', post, cat)} aria-label="Edit your own post">Edit</button><button onClick={() => onAction('delete', post, cat)} aria-label="Delete your own post">Delete</button></>}
      {!isMine && isModerator && <button onClick={() => onAction('remove', post, cat)} aria-label={`Remove the post by ${who}`}>Remove</button>}
    </div>}
  </article>;
}

function Thread({ data, cat, account, own, viewer, moderators, votes, onAction, onTopicAction }) {
  const { topic, posts, authors, digests, pending = [] } = data;
  const byId = new Map(posts.map((p, i) => [p.id, i]));
  const children = new Map();
  const roots = [];
  posts.forEach((p, i) => {
    const parent = p.inReplyTo && p.inReplyTo !== p.id && byId.has(p.inReplyTo) ? p.inReplyTo : null;
    if (parent) children.set(parent, [...(children.get(parent) || []), i]); else roots.push(i);
  });
  const seen = new Set();
  const me = viewer?.actor || account?.url;
  const renderPost = (i, depth = 0) => {
    if (seen.has(i)) return null;
    seen.add(i);
    const p = posts[i];
    const contents = <><PostCard post={p} author={authors[p.author]} cat={cat} digest={digests[p.id]} account={account} own={own} votes={votes[p.id]} isMine={!!me && (p.author === me || p.author === viewer?.webId)} isModerator={!!me && moderators.includes(me)} onAction={onAction} />{(children.get(p.id) || []).map(child => renderPost(child, depth + 1))}</>;
    return depth ? <div className="nest" style={{ '--depth': Math.min(depth, 6) }} key={p.id}>{contents}</div> : <div key={p.id}>{contents}</div>;
  };
  return <><div className="topline"><h1>{topic.name}</h1>{!topic.closed && <button className="primary" onClick={() => onAction('newpost', null, cat)}>New post</button>}</div>
    {!!me && moderators.includes(me) && <div className="acts mod" role="group" aria-label="Moderator actions for this topic"><button onClick={() => onTopicAction('rename')}>Rename topic</button><button onClick={() => onTopicAction('unlock')}>Reopen topic</button><button onClick={() => onTopicAction('pin')}>Pin topic</button><button onClick={() => onTopicAction('unpin')}>Unpin topic</button><button onClick={() => onTopicAction('sitepin')}>Pin site-wide</button><button onClick={() => onTopicAction('siteunpin')}>Unpin site-wide</button><button className="grave" onClick={() => onTopicAction('lock')}>Close topic</button><button className="grave" onClick={() => onTopicAction('droptopic')}>Delete topic</button></div>}
    {topic.closed && <p className="hint">This topic is closed. No more replies are being taken.</p>}
    {roots.map(i => renderPost(i))}{posts.map((p, i) => !seen.has(i) ? renderPost(i) : null)}
    {pending.map((p, i) => <PostCard key={p.id || i} post={{ ...p, content: toHtml(p.text), published: p.at }} cat={cat} account={account} own={own} votes={null} onAction={onAction} waiting />)}
  </>;
}

function Index({ data, forum, filter, search, order, descending, shown, seen, own, account, viewer, moderators, onMore, onSort, onJoin }) {
  const cat = forum.categories.find(c => c.slug === filter);
  const sitePins = new Set(data.sitePins || []);
  const localPins = new Set(cat ? data.catPins?.[cat.id] || [] : Object.values(data.catPins || {}).flat());
  const looking = search.trim().toLowerCase();
  const byTopic = new Map();
  for (const p of data.latest || []) {
    if ((cat && p.category !== cat.id) || (looking && ![p.topicName, p.author, p.content].some(v => String(v || '').toLowerCase().includes(looking))) || !p.topic) continue;
    const had = byTopic.get(p.topic);
    if (!had || String(p.published || '') > String(had.published || '')) byTopic.set(p.topic, p);
  }
  const rank = p => sitePins.has(p.topic) ? 2 : localPins.has(p.topic) ? 1 : 0;
  const by = p => order === 'replies' ? (p.topicReplies || 0) + 1 : String(p.published || '');
  const topics = [...byTopic.values()].sort((a, b) => rank(b) - rank(a) || (descending ? (by(a) > by(b) ? -1 : by(a) < by(b) ? 1 : 0) : (by(a) > by(b) ? 1 : by(a) < by(b) ? -1 : 0)));
  const page = topics.slice(0, shown);
  const more = Math.max(0, topics.length - page.length) + (data.more || 0);
  const isModerator = !!viewer?.actor && moderators.includes(viewer.actor);
  return <><p className="hint chips">Categories: <a className={`chip${!cat ? ' on' : ''}`} aria-current={!cat ? 'page' : undefined} href="#/">All</a>{forum.categories.map(c => <a className={`chip${cat?.id === c.id ? ' on' : ''}`} aria-current={cat?.id === c.id ? 'page' : undefined} key={c.id} href={`#/c/${encodeURIComponent(c.slug)}`}>{c.name}</a>)}{account && <><a className="chip" href="#/replies">Replies to you</a><a className="chip" href="#/bookmarks">Bookmarked</a></>}{isModerator && <><a className="chip" href="#/queue">Queue</a><a className="chip" href="#/settings">Settings</a></>}{cat && viewer && <span className="rowend"><button className="new" onClick={() => onJoin(cat, !own.isJoined(cat.id))}>{own.isJoined(cat.id) ? 'Leave' : 'Join'}</button></span>}</p>
    {!page.length && !data.restricted ? <p className="empty">Nothing posted here yet. Use New topic to create one.</p> : !!page.length && <div className="scroll" role="region" aria-label="Topics, most recently posted in first" tabIndex={0}><table className="index"><thead><tr><th scope="col">Topic</th><th scope="col">Category</th><th scope="col">Latest by</th><th scope="col" aria-sort={order === 'date' ? descending ? 'descending' : 'ascending' : 'none'}><button className="sort" onClick={() => onSort('date')}>Date {order === 'date' ? descending ? '▼' : '▲' : '▽'}</button></th><th scope="col" aria-sort={order === 'replies' ? descending ? 'descending' : 'ascending' : 'none'}><button className="sort" onClick={() => onSort('replies')}>Posts {order === 'replies' ? descending ? '▼' : '▲' : '▽'}</button></th></tr></thead><tbody>{page.map(p => {
      const category = forum.categories.find(c => c.id === p.category);
      const handle = data.authors?.[p.author]?.handle || authorLabel(p.author || '');
      return <tr key={p.topic}><td>{sitePins.has(p.topic) ? <span className="pin" role="img" aria-label="pinned across the forum">⭐ </span> : localPins.has(p.topic) ? <span className="pin" role="img" aria-label="pinned in this category">📌 </span> : null}<a href={topicHref(category, p.topic, data.digests?.[p.id])}>{p.topicName || 'Topic'}</a>{seen?.isNew(p.topic, p.published) && <span className="badge">New<span className="vh"> since you last opened this topic</span></span>}</td><td>{category?.name || ''}</td><td>{p.author && <a className="who" href={`#/who/${encodeURIComponent(p.author)}`} title={handle}>{handle}</a>}</td><td>{date(p.published)}</td><td>{Number.isFinite(p.topicReplies) ? p.topicReplies + 1 : ''}</td></tr>;
    })}</tbody></table>{more > 0 && <p className="row"><button onClick={onMore}>Show {Math.min(more, 30)} more of {more}</button></p>}</div>}
  </>;
}

export default function ForumApp({ initialForum, initialRoute, initialData, place }) {
  const [forum, setForum] = useState(initialForum);
  const [route, setRoute] = useState(initialRoute);
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [browserReady, setBrowserReady] = useState(false);
  const [account, setAccount] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [moderators, setModerators] = useState([]);
  const [shown, setShown] = useState(30);
  const [order, setOrder] = useState('date');
  const [descending, setDescending] = useState(true);
  const [finding, setFinding] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [votes, setVotes] = useState({});
  const [notice, setNotice] = useState('');
  const [signinOpen, setSigninOpen] = useState(false);
  const [signinWhy, setSigninWhy] = useState('');
  const [signinHandle, setSigninHandle] = useState('');
  const [signinNote, setSigninNote] = useState('');
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyCtx, setReplyCtx] = useState(null);
  const [editing, setEditing] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [topicTitle, setTopicTitle] = useState('');
  const [replyError, setReplyError] = useState('');
  const [replyHandle, setReplyHandle] = useState('');
  const [imageSaid, setImageSaid] = useState('');
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState(null);
  const [panelError, setPanelError] = useState('');
  const [dmText, setDmText] = useState('');
  const [dmSaid, setDmSaid] = useState('');
  const [forumName, setForumName] = useState(initialForum?.name || '');
  const [categoryNames, setCategoryNames] = useState(Object.fromEntries((initialForum?.categories || []).map(c => [c.id, c.name])));
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategorySlug, setNewCategorySlug] = useState('');
  const [newCategoryPrivate, setNewCategoryPrivate] = useState(false);
  const [panelValue, setPanelValue] = useState('');
  const signinRef = useRef(null);
  const replyRef = useRef(null);
  const panelRef = useRef(null);
  const reopenRef = useRef(null);
  const loginRef = useRef(null);
  const readRef = useRef(null);
  const seenRef = useRef(null);
  const indexCache = useRef(initialData?.kind === 'index' ? { value: initialData, at: Date.now(), limit: initialData.limit || 150 } : null);
  const bootPromise = useRef(null);
  const requestNo = useRef(0);
  const searchRef = useRef(null);

  const cats = forum?.categories || [];
  const own = useMemo(() => browserReady ? mine({ storage: localStorage, who: account?.handle || null }) : noStore, [browserReady, account?.handle, revision]);
  const me = viewer?.actor || account?.url;
  const isModerator = !!me && moderators.includes(me);
  const catBySlug = slug => cats.find(c => c.slug === slug || c.base.endsWith('/c/' + slug + '/'));
  const handleOf = cat => place.handle && cat?.slug ? `@${cat.slug}@${new URL(place.front).host}` : cat?.id || '';
  const say = message => setNotice(message);
  const refresh = () => { indexCache.current = null; setRevision(n => n + 1); };

  useEffect(() => {
    let active = true;
    const start = async () => {
      const login = new MastoLogin({ storage: localStorage, redirectUri: location.origin + location.pathname + location.search });
      loginRef.current = login;
      readRef.current = reader();
      seenRef.current = place.base ? readState({ storage: localStorage, forum: place.base }) : null;
      let podAccount = null;
      let session = null;
      const params = new URLSearchParams(location.search);
      const waiting = sessionStorage.getItem('bb:pod');
      try {
        if (waiting) {
          const who = JSON.parse(waiting);
          session = params.get('code') ? await pod.complete(location.href) : await pod.session();
          if (session) {
            podAccount = { ...who, webId: session.webId };
            localStorage.setItem('bb:acct', JSON.stringify(who));
            sessionStorage.removeItem('bb:pod');
          }
        } else {
          const kept = localStorage.getItem('bb:acct');
          if (kept) {
            session = await pod.session();
            if (session) podAccount = { ...JSON.parse(kept), webId: session.webId };
            else localStorage.removeItem('bb:acct');
          }
        }
        if (!podAccount && params.get('code') && params.get('state')) await login.complete({ code: params.get('code'), state: params.get('state') });
        if (session) readRef.current = reader({ session });
      } catch (e) { setReplyError(e.message); }
      if (params.has('code') || params.has('state') || params.has('iss')) {
        params.delete('code'); params.delete('state'); params.delete('iss');
        const back = sessionStorage.getItem('bb:return') || location.hash;
        sessionStorage.removeItem('bb:return');
        history.replaceState(null, '', `${location.pathname}${String(params) ? '?' + params : ''}${back}`);
      }
      return { podAccount, login };
    };
    if (!bootPromise.current) bootPromise.current = start();
    bootPromise.current.then(({ podAccount, login }) => {
      if (!active) return;
      setViewer(podAccount);
      setAccount(podAccount || login.account());
      setBrowserReady(true);
      setRoute(parseRoute(location.hash, initialRoute));
    });
    const onHash = () => setRoute(parseRoute(location.hash, { kind: 'index' }));
    window.addEventListener('hashchange', onHash);
    return () => { active = false; window.removeEventListener('hashchange', onHash); };
  }, [initialRoute, place.base]);

  useEffect(() => {
    const dlg = signinRef.current;
    if (!dlg) return;
    if (signinOpen && !dlg.open) { reopenRef.current = document.activeElement; dlg.showModal(); dlg.querySelector('input')?.focus(); }
    if (!signinOpen && dlg.open) dlg.close();
  }, [signinOpen]);
  useEffect(() => {
    const dlg = replyRef.current;
    if (!dlg) return;
    if (replyOpen && !dlg.open) { reopenRef.current = document.activeElement; dlg.showModal(); dlg.querySelector(account ? 'textarea' : 'input[type=text]')?.focus(); }
    if (!replyOpen && dlg.open) dlg.close();
  }, [replyOpen, account]);
  useEffect(() => {
    const dlg = panelRef.current;
    if (!dlg) return;
    if (panel && !dlg.open) { reopenRef.current = document.activeElement; dlg.showModal(); }
    if (!panel && dlg.open) dlg.close();
  }, [panel]);

  useEffect(() => {
    if (!browserReady || !forum || !place.base) return;
    const number = ++requestNo.current;
    const read = readRef.current;
    const load = async () => {
      setLoading(true); setError('');
      let result;
      if (route.kind === 'index' || route.kind === 'category') {
        const want = Math.min(300, shown * 5);
        const cached = indexCache.current;
        if (cached && cached.limit >= want && Date.now() - cached.at < 60_000) result = cached.value;
        else {
          const [latest, sitePins, collections] = await Promise.all([
            read.latest(place.base, { limit: want }), read.featured(place.base),
            Promise.all(cats.map(async c => ({ id: c.id, pins: await read.featured(c.base), mods: await read.moderators(c.base) }))),
          ]);
          const catPins = Object.fromEntries(collections.map(c => [c.id, c.pins]));
          const catMods = Object.fromEntries(collections.map(c => [c.id, c.mods]));
          const people = [...new Set(latest.filter(p => p.author).map(p => p.author))];
          const authors = Object.fromEntries(await Promise.all(people.map(async id => {
            const cat = cats.find(c => latest.some(p => p.author === id && p.category === c.id));
            return [id, cat ? await read.author(cat.base, id) : null];
          })));
          const digests = Object.fromEntries(await Promise.all(latest.map(async p => [p.id, await cacheKey(p.id)])));
          result = { kind: 'index', latest: [...latest], more: latest.more || 0, sitePins, catPins, catMods, authors, digests, limit: want };
          indexCache.current = { value: result, at: Date.now(), limit: want };
        }
        if (route.kind === 'category') {
          const cat = catBySlug(route.slug);
          if (cat && !result.latest.some(p => p.category === cat.id)) result = { ...result, restricted: !(await read.canRead(cat.base)) };
        }
        const selected = route.kind === 'category' ? result.catMods?.[catBySlug(route.slug)?.id] || [] : [...new Set(Object.values(result.catMods || {}).flat())];
        if (number === requestNo.current) setModerators(selected);
      } else if (route.kind === 'topic') {
        const cat = catBySlug(route.slug);
        if (!cat) throw new Error('No such category.');
        const topic = await read.topic(`${cat.base}ap/topic/${route.tid}`);
        if (!topic) throw new Error('No such topic.');
        const posts = (await Promise.all(topic.posts.map(id => read.post(cat.base, id)))).map((p, i) => p || { id: topic.posts[i], content: '', author: null });
        const people = [...new Set(posts.map(p => p.author).filter(Boolean))];
        const [names, digests, mods] = await Promise.all([
          Promise.all(people.map(async id => [id, await read.author(cat.base, id)])),
          Promise.all(posts.map(async p => [p.id, await cacheKey(p.id)])), read.moderators(cat.base),
        ]);
        if (number === requestNo.current) {
          seenRef.current?.markRead(topic.id, seenRef.current.newest(posts));
          setModerators(mods);
          setReplyCtx({ cat, topicId: topic.id, inReplyToUrl: topic.posts.at(-1) || null, title: 'Reply' });
          if (route.at) setTimeout(() => { const el = document.getElementById('p-' + route.at); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } }, 0);
        }
        const placed = new Set(topic.posts);
        result = { kind: 'topic', topic, posts, authors: Object.fromEntries(names), digests: Object.fromEntries(digests), pending: waitingPosts(topic.id).filter(p => !placed.has(p.id)) };
      } else if (route.kind === 'who') {
        const latest = await read.latest(place.base, { limit: 200 });
        const posts = latest.filter(p => p.author === route.id);
        const cat = posts[0] ? cats.find(c => c.id === posts[0].category) : cats[0];
        const kept = cat ? await read.author(cat.base, route.id) : null;
        const said = kept?.url ? null : await read.actorCard(route.id).catch(() => null);
        const card = kept && said ? { ...kept, url: said.url, name: kept.name || said.name } : kept || said;
        const digests = Object.fromEntries(await Promise.all(posts.map(async p => [p.id, await cacheKey(p.id)])));
        result = { kind: 'who', card, posts, digests };
      } else if (route.kind === 'replies') {
        if (!me) result = { kind: 'replies', posts: [] };
        else {
          const latest = await read.latest(place.base, { limit: 200 });
          const ids = new Set(latest.filter(p => p.author === me).map(p => p.id));
          const posts = latest.filter(p => p.inReplyTo && ids.has(p.inReplyTo) && p.author !== me);
          const digests = Object.fromEntries(await Promise.all(posts.map(async p => [p.id, await cacheKey(p.id)])));
          result = { kind: 'replies', posts, digests };
        }
      } else if (route.kind === 'bookmarks') result = { kind: 'bookmarks', rows: own.saved() };
      else if (route.kind === 'settings') {
        const lists = await Promise.all(cats.map(c => read.moderators(c.base)));
        const mods = [...new Set(lists.flat())];
        if (number === requestNo.current) setModerators(mods);
        result = { kind: 'settings' };
      } else if (route.kind === 'queue') {
        if (!viewer) result = { kind: 'queue', rows: [] };
        else {
          const said = await serverKind(new URL(place.front).host, place.front, undefined, forum.handle || 'forum');
          if (!said?.podHome) throw new Error('this forum does not say where its pod is');
          const queue = await pod.modQueue(said.podHome);
          const acts = new Set(['Flag', 'Held', 'Create', 'Join request']);
          result = { kind: 'queue', rows: (queue?.rows || []).filter(r => r.failed || acts.has(r.type)) };
        }
      }
      if (number !== requestNo.current) return;
      setData(result); setLoading(false);
    };
    load().catch(e => { if (number === requestNo.current) { setError(e.message); setLoading(false); } });
  }, [browserReady, forum, routeKey(route), shown, revision, viewer?.actor]);

  const openSignIn = (why, intent = null) => {
    if (intent) sessionStorage.setItem('bb:intent', JSON.stringify(intent));
    setSigninWhy(why ? `Sign in to ${why}.` : '');
    setSigninNote(''); setSigninOpen(true);
  };
  const closeSignIn = () => { sessionStorage.removeItem('bb:intent'); setSigninOpen(false); reopenRef.current?.focus?.(); };
  const openReply = (cat, inReplyToUrl = null, topicId = null, title = 'Reply') => {
    setReplyCtx({ cat, inReplyToUrl, topicId, title });
    setEditing(null); setReplyText(''); setTopicTitle(''); setReplyError(''); setImageSaid('');
    setReplyOpen(true);
  };
  const closeReply = () => { setReplyOpen(false); reopenRef.current?.focus?.(); };
  const signIn = async (typed, setter) => {
    const input = String(typed || '').trim();
    if (/^https?:\/\//u.test(input)) {
      setter('Asking your pod…');
      const { authorizationUrl, storageRoot } = await pod.signInWithWebId(input, location.origin + location.pathname);
      sessionStorage.setItem('bb:return', location.hash);
      sessionStorage.setItem('bb:pod', JSON.stringify({ handle: authorLabel(input), actor: input, podHome: storageRoot }));
      location.href = authorizationUrl;
      return;
    }
    const host = hostOfHandle(input);
    if (!host) throw new Error('a handle looks like @you@your.server');
    setter(`Asking ${host}…`);
    const handle = input.replace(/^@/u, '').split('@')[0];
    const said = await serverKind(host, place.front, undefined, handle);
    setter('');
    if (said.kind === 'mastodon-api') {
      sessionStorage.setItem('bb:return', location.hash);
      location.href = await loginRef.current.begin(host);
    } else if (said.kind === 'fedipod') {
      if (!said.issuer || !said.actor) throw new Error(`${host} did not say where ${input} signs in`);
      sessionStorage.setItem('bb:return', location.hash);
      sessionStorage.setItem('bb:pod', JSON.stringify({ handle: `@${handle}@${host}`, actor: said.actor, podHome: said.podHome }));
      location.href = await pod.signIn({ issuer: said.issuer, redirectUri: location.origin + location.pathname });
    } else setter(said.kind === 'lemmy'
      ? `From ${host}, subscribe to !${handleOf(replyCtx?.cat).replace(/^@/u, '')} and post there; it arrives here.`
      : said.kind === 'invalid' ? 'A handle looks like @you@your.server.'
        : `${host} does not offer a sign-in this page can use. Post from your account there, naming ${handleOf(replyCtx?.cat) || 'the category'}, and it arrives here.`);
  };
  const signOut = async () => {
    if (viewer) { await pod.signOut(); localStorage.removeItem('bb:acct'); sessionStorage.removeItem('bb:pod'); }
    else loginRef.current?.signOut();
    setViewer(null); setAccount(null); setModerators([]); refresh(); say('Signed out.');
  };
  const askTo = async (activity, cat) => {
    if (!viewer) throw new Error('moderating from here needs your pod account');
    if (!cat) throw new Error('open a topic in a category and try from there');
    let step = 'finding where the forum takes mail';
    try {
      const inbox = await pod.podInboxOf(cat.id, { front: place.front, handle: cat.slug || null });
      if (!inbox) throw new Error('the forum did not say where to send it');
      step = 'sending the request';
      await pod.moderate({ actor: viewer.actor, podHome: viewer.podHome, inbox, activity });
    } catch (e) { throw new Error(`${e.message} — while ${step}`); }
    say('Sent to the forum. It takes effect once the forum has checked who asked.');
    refresh();
  };
  const settingsAsk = async (...activities) => {
    try {
      if (!viewer) throw new Error('changing the forum needs your pod account');
      const inbox = await pod.podInboxOf(cats[0]?.id || forum.id, { front: place.front, handle: cats[0]?.slug || forum.handle });
      if (!inbox) throw new Error('the forum did not say where to send it');
      for (const activity of activities) await pod.moderate({ actor: viewer.actor, podHome: viewer.podHome, inbox, activity });
      const message = 'Sent. It takes effect once the forum has checked who asked.';
      setPanelError(message); say(message); refresh();
      return true;
    } catch (e) { setPanelError(e.message); say(e.message); return false; }
  };
  const joinOrLeave = async (cat, on) => {
    if (!account) return openSignIn(on ? 'join a category' : 'leave a category', { act: on ? 'join' : 'leave', cat: cat.id });
    if (!viewer) return alert('Joining is sent from your own pod. Sign in with your @you@your-pod handle.');
    try {
      const inbox = await pod.podInboxOf(cat.id, { front: place.front, handle: cat.slug || null });
      const ok = on ? await pod.join({ actor: viewer.actor, category: cat.id, inbox }) : await pod.leave({ actor: viewer.actor, category: cat.id, inbox });
      if (!ok) throw new Error('the forum did not take it');
      if (on) own.join(cat.id); else own.leave(cat.id);
      refresh();
    } catch (e) { alert(e.message); }
  };
  const askToJoin = async cat => {
    if (!account) return openSignIn('ask to join a category', { act: 'askJoin', cat: cat.id });
    if (!viewer) return alert('Membership needs a FediPod account.');
    try {
      const inbox = await pod.podInboxOf(cat.id, { front: place.front, handle: cat.slug || null });
      await pod.join({ actor: viewer.actor, category: cat.id, inbox });
      say('Asked. A moderator sees it in the forum’s queue.');
      alert('Your request is with the moderators.');
    } catch (e) { alert(e.message); }
  };
  const vote = async (post, cat, way, was) => {
    if (!account) return openSignIn(way === 'none' ? 'take back your vote' : 'vote on a post', { act: 'vote', post, cat, way, was });
    if (!viewer) return alert('A vote is sent from your own pod. Sign in with your @you@your-pod handle.');
    let step = 'finding where the forum takes mail';
    try {
      const inbox = await pod.podInboxOf(cat.id, { front: place.front, handle: cat.slug || null });
      if (!inbox) throw new Error('the forum did not say where to send it');
      step = `sending the vote to ${new URL(inbox).host}`;
      await pod.vote({ actor: viewer.actor, post: post.id, category: cat.id, inbox, way, was });
      own.vote(post.id, way);
      setVotes(v => ({ ...v, [post.id]: {
        up: Math.max(0, (v[post.id]?.up ?? post.likes ?? 0) + (way === 'up' ? 1 : 0) - (was === 'up' ? 1 : 0)),
        down: Math.max(0, (v[post.id]?.down ?? post.dislikes ?? 0) + (way === 'down' ? 1 : 0) - (was === 'down' ? 1 : 0)),
      } }));
      refresh(); say(way === 'none' ? 'Vote taken back.' : 'Voted. The count follows once the forum has taken it.');
    } catch (e) { alert(`${e.message} — while ${step}`); }
  };
  const onAction = async (act, post, cat, arg, was) => {
    const topic = data?.topic;
    if (act === 'reply') return openReply(cat, post.id, topic?.id || post.topic || null);
    if (act === 'newpost') return openReply(cat, topic?.posts?.at(-1) || null, topic?.id || null);
    if (act === 'newtopic') return openReply(cat, null, null, 'Start a topic');
    if (act === 'vote') return vote(post, cat, arg, was);
    if (act === 'share') {
      const digest = arg || await cacheKey(post.id);
      const topicId = topic?.id || post.topic;
      const link = `${location.origin}${place.pathBase}/t/${encodeURIComponent(cat.slug)}/${encodeURIComponent(topicId?.split('/').pop() || '')}/${digest}${place.query}`;
      try { await navigator.clipboard.writeText(link); say('Link copied'); } catch { window.prompt('Copy this address', link); }
      return;
    }
    if (act === 'save' || act === 'unsave') {
      if (!account) return openSignIn(act === 'save' ? 'save a post' : 'remove a saved post', { act, post, cat });
      if (act === 'save') own.save({ id: post.id, at: new Date().toISOString(), topic: topic?.id || post.topic, cat: cat?.slug, text: String(post.content || '').replace(/<[^>]*>/gu, ' ').trim().slice(0, 140) });
      else own.unsave(post.id);
      setRevision(n => n + 1); return;
    }
    if (act === 'report') {
      const why = window.prompt('Report this post to the moderators. What is wrong with it?');
      if (why === null) return;
      try {
        const inbox = await pod.podInboxOf(cat.id, { front: place.front, handle: cat.slug || null });
        await pod.report({ actor: viewer?.actor || account?.url, object: post.id, category: cat.id, inbox, why });
        alert('Reported. A moderator will see it in the forum’s queue.');
      } catch (e) { alert(e.message); }
      return;
    }
    if (act === 'edit') {
      const p = await readRef.current.post(cat.base, post.id);
      if (!p) return alert('that post is not readable here');
      setReplyCtx({ cat, topicId: topic?.id || p.topic, inReplyToUrl: null, title: 'Edit your post' });
      setEditing({ id: post.id, page: p.page || null });
      setReplyText(p.source || String(p.content || '').replace(/<[^>]*>/gu, ' ').trim());
      setReplyError(''); setReplyOpen(true); return;
    }
    if (act === 'delete') {
      if (!confirm('Delete this post? Everywhere it has reached is told to remove it.')) return;
      try {
        if (viewer) {
          const inbox = await pod.podInboxOf(cat.id, { front: place.front, handle: cat.slug || null });
          await pod.remove({ actor: viewer.actor, podHome: viewer.podHome, id: post.id, category: cat.id, categoryBase: cat.base, isPrivate: !!cat.private, inbox });
        } else {
          const p = await readRef.current.post(cat.base, post.id);
          await loginRef.current.remove({ url: p?.page || post.id });
        }
        refresh();
      } catch (e) { alert(e.message); }
      return;
    }
    if (act === 'remove') {
      if (!confirm('Remove this post from the topic?')) return;
      try { await askTo({ type: 'Delete', object: post.id, origin: topic?.id || post.topic }, cat); } catch (e) { alert(e.message); }
    }
  };

  useEffect(() => {
    if (!browserReady || !account) return;
    let intent;
    try { intent = JSON.parse(sessionStorage.getItem('bb:intent') || 'null'); } catch {}
    sessionStorage.removeItem('bb:intent');
    if (!intent) return;
    const cat = cats.find(c => c.id === intent.cat?.id || c.id === intent.cat);
    if (intent.act === 'join' || intent.act === 'leave') void joinOrLeave(cat, intent.act === 'join');
    else if (intent.act === 'askJoin') void askToJoin(cat);
    else if (intent.act === 'vote') void vote(intent.post, intent.cat, intent.way, intent.was);
    else if (intent.act === 'save' || intent.act === 'unsave') void onAction(intent.act, intent.post, intent.cat);
  }, [browserReady, account?.handle]);

  const onTopicAction = async act => {
    const topic = data?.topic;
    const cat = catBySlug(route.slug);
    if (!topic || !cat) return;
    try {
      if (act === 'rename') {
        const name = prompt('Name for this topic', topic.name);
        if (name?.trim()) await askTo({ type: 'Update', object: { id: topic.id, name: name.trim() } }, cat);
      } else if (act === 'lock' || act === 'unlock') {
        await askTo({ type: 'Update', object: { id: topic.id, type: 'OrderedCollection', closed: act === 'lock' ? new Date().toISOString() : null } }, cat);
      } else if (['pin', 'unpin', 'sitepin', 'siteunpin'].includes(act)) {
        const whole = act.startsWith('site');
        await askTo({ type: act === 'pin' || act === 'sitepin' ? 'Add' : 'Remove', object: topic.id, target: (whole ? place.base : cat.base) + 'ap/featured' }, cat);
      } else if (act === 'droptopic' && confirm('Delete this topic and every post in it?')) {
        await askTo({ type: 'Remove', object: topic.id, target: cat.id }, cat);
      }
    } catch (e) { alert(e.message); }
  };
  const onQueueAction = async (act, row) => {
    const cat = cats.find(c => c.slug === row.category) || catBySlug(route.slug);
    try {
      if (!cat) throw new Error('which category is that in?');
      if (act === 'admit') {
        await askTo({ type: 'Join', object: row.object }, cat);
        await askTo({ type: 'Add', object: row.object, target: cat.base + 'ap/members' }, cat);
      } else if (act === 'approve' || act === 'refuse') await askTo({ type: act === 'approve' ? 'Accept' : 'Reject', object: row.object }, cat);
      else if (act === 'ban') {
        const who = row.about || row.by;
        if (who && confirm(`Ban ${authorLabel(who)} from ${cat.name}? Their posts stop being carried.`)) await askTo({ type: 'Block', object: who }, cat);
      } else if (act === 'removepost' && confirm('Remove this post from its topic?')) {
        const copy = await readRef.current.post(cat.base, row.object);
        if (!copy?.topic) throw new Error('the forum does not say which topic holds it');
        await askTo({ type: 'Delete', object: row.object, origin: copy.topic }, cat);
      }
    } catch (e) { alert(e.message); }
  };
  const onSetting = async (act, cat = null, value = null) => {
    if (act === 'forum-name' && forumName.trim()) await settingsAsk({ type: 'Update', object: { id: forum.id, name: forumName.trim() } });
    else if (act === 'cat-name' && categoryNames[cat.id]?.trim()) await settingsAsk({ type: 'Update', object: { id: cat.id, name: categoryNames[cat.id].trim() } });
    else if (act === 'privacy' && value !== !!cat.private) {
      if (await settingsAsk({ type: 'Update', object: { id: cat.id, manuallyApprovesFollowers: value } }))
        setForum(f => ({ ...f, categories: f.categories.map(c => c.id === cat.id ? { ...c, private: value } : c) }));
    } else if (act === 'new-category') {
      const slug = newCategorySlug.trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug)) return alert('a Fediverse username is lower-case letters, digits and hyphens');
      await settingsAsk({ type: 'Create', target: forum.id, object: { type: 'Group', preferredUsername: slug, name: newCategoryName.trim() || slug, ...(newCategoryPrivate ? { manuallyApprovesFollowers: true } : {}) } });
    } else if (act === 'member') {
      const webid = panelValue.trim();
      if (webid && cat) await settingsAsk({ type: value ? 'Add' : 'Remove', object: webid, target: cat.base + 'ap/members' });
    } else if (act === 'moderator') {
      if (!panelValue.trim()) return setPanelError('Type a handle first, like @mei@their.server.');
      try {
        const who = await actorOfHandle(panelValue.trim());
        const type = value ? 'Add' : 'Remove';
        await settingsAsk({ type, object: who, target: `${place.base}ap/administrators` }, { type, object: who, target: `${place.base}mod/` });
      } catch (e) { setPanelError(e.message); }
    }
  };
  const openPanel = async (kind, cat = null) => {
    setPanelValue(''); setPanelError('');
    if (kind === 'moderators') {
      const labels = await Promise.all(moderators.map(async id => {
        const c = cats[0];
        const card = c ? await readRef.current.author(c.base, id) : null;
        return card?.handle || await readRef.current.actorHandle(id) || authorLabel(id);
      }));
      setPanel({ kind, labels });
    } else setPanel({ kind, cat });
  };
  const sendReply = async () => {
    if (!replyCtx || !replyText.trim()) return;
    const body = replyText.trim();
    const topicName = !editing && !replyCtx.topicId ? topicTitle.trim() : '';
    const text = topicName ? `${topicName}\n\n${body}` : body;
    setSending(true); setReplyError('');
    try {
      let made;
      if (editing) {
        if (viewer) {
          const inbox = await pod.podInboxOf(replyCtx.cat.id, { front: place.front, handle: replyCtx.cat.slug || null });
          made = await pod.edit({ actor: viewer.actor, podHome: viewer.podHome, id: editing.id, text: body, category: replyCtx.cat.id, categoryBase: replyCtx.cat.base, isPrivate: !!replyCtx.cat.private, inbox });
        } else made = await loginRef.current.edit({ url: editing.page || editing.id, text: body });
      } else if (viewer) {
        const inbox = await pod.podInboxOf(replyCtx.cat.id, { front: place.front, handle: replyCtx.cat.slug || null });
        if (!inbox) throw new Error('the forum did not say where to send it');
        if (!replyCtx.cat.private) await pod.join({ actor: viewer.actor, category: replyCtx.cat.id, inbox });
        made = await pod.post({ actor: viewer.actor, podHome: viewer.podHome, category: replyCtx.cat.id, categoryBase: replyCtx.cat.base, categoryHandle: handleOf(replyCtx.cat), isPrivate: !!replyCtx.cat.private, inbox, topic: topicName, text: body, inReplyTo: replyCtx.inReplyToUrl, context: replyCtx.topicId || null });
      } else made = await loginRef.current.post({ text, mention: handleOf(replyCtx.cat), inReplyToUrl: replyCtx.inReplyToUrl });
      if (!editing && replyCtx.topicId) rememberWaiting(replyCtx.topicId, { id: made.uri || made.url, author: viewer?.actor || account?.url || account?.handle, text, at: new Date().toISOString() });
      setReplyText(''); setTopicTitle(''); closeReply(); refresh();
    } catch (e) { setReplyError(e.message); } finally { setSending(false); }
  };
  const uploadImage = async file => {
    if (!file) return;
    if (!viewer) return setImageSaid('adding an image needs your pod account');
    setImageSaid('putting it in your pod…');
    try {
      const url = await pod.upload({ actor: viewer.actor, podHome: viewer.podHome, file });
      const alt = file.name.replace(/\.[^.]+$/u, '').replace(/[-_]+/gu, ' ');
      setReplyText(t => `${t}${t && !t.endsWith('\n') ? '\n\n' : ''}![${alt}](${url})\n`);
      setImageSaid('added');
    } catch (e) { setImageSaid(e.message); }
  };
  const postToTimeline = async () => {
    if (!dmText.trim()) return setDmSaid('Write something first.');
    if (!viewer) return setDmSaid('Posting to someone is done from your own pod account.');
    setDmSaid('Posting…');
    try {
      const card = await readRef.current.actorCard(route.id).catch(() => null);
      await pod.postTo({ actor: viewer.actor, podHome: viewer.podHome, handle: viewer.handle, to: route.id, toHandle: card?.handle || data?.card?.handle || '', front: place.front, text: dmText.trim() });
      setDmText(''); setDmSaid('Handed to your own account. It goes out signed when your agent next reads its inbox.'); say('Posted.');
    } catch (e) { setDmSaid(e.message); }
  };

  useEffect(() => {
    if (route.kind !== 'topic' || !route.at || data?.kind !== 'topic') return;
    const target = document.getElementById('p-' + route.at);
    if (target) { target.classList.add('picked'); target.tabIndex = -1; target.scrollIntoView({ block: 'center' }); target.focus(); }
  }, [data, route.at]);

  const currentCat = route.kind === 'category' || route.kind === 'topic' ? catBySlug(route.slug) : null;
  const into = currentCat || cats[0];
  const routeDataReady = data && (['index', 'category'].includes(route.kind) ? data.kind === 'index' : data.kind === route.kind);
  let trail = [];
  if (route.kind === 'category') trail = [['Home', '#/'], [currentCat?.name || route.slug]];
  else if (route.kind === 'topic') trail = [['Home', '#/'], [currentCat?.name || route.slug, `#/c/${route.slug}`], [data?.topic?.name || 'Topic']];
  else if (route.kind !== 'index') trail = [['Home', '#/'], [route.kind === 'who' ? data?.card?.handle || authorLabel(route.id) : ({ replies: 'Replies to you', bookmarks: 'Bookmarked', queue: 'Queue', settings: 'Settings' })[route.kind]]];

  let content = null;
  if (!forum) content = <p className="err">{place.base ? 'No forum answers at this address.' : <>Name a forum: <code>{place.origin}/&lt;forum&gt;/</code></>}</p>;
  else if (error) content = <p className="err">{error}</p>;
  else if (!routeDataReady) content = <p className="dim">{loading ? 'Loading…' : 'Looking…'}</p>;
  else if (route.kind === 'index' || route.kind === 'category') content = <><Index data={data} forum={forum} filter={route.slug} search={finding} order={order} descending={descending} shown={shown} seen={seenRef.current} own={own} account={account} viewer={viewer} moderators={moderators} onMore={() => setShown(n => n + 30)} onSort={column => { if (order === column) setDescending(v => !v); else { setOrder(column); setDescending(true); } setShown(30); }} onJoin={joinOrLeave} />{data.restricted && currentCat && <p className="empty row">This category is for its members. {viewer ? <button className="new" onClick={() => askToJoin(currentCat)}>Request membership</button> : <a className="big" href={`${place.front}/new-account`}>Get a FediPod account</a>}</p>}</>;
  else if (route.kind === 'topic') content = <Thread data={data} cat={currentCat} account={account} own={own} viewer={viewer} moderators={moderators} votes={votes} onAction={onAction} onTopicAction={onTopicAction} />;
  else if (route.kind === 'replies') content = !account ? <p className="empty">Sign in to see answers to your posts.</p> : !data.posts.length ? <p className="empty">Nobody has answered you yet.</p> : <ul className="list">{data.posts.map(p => { const cat = cats.find(c => c.id === p.category); return <li key={p.id}><a className="title" href={topicHref(cat, p.topic, data.digests[p.id])}>{p.topicName || 'Topic'}</a><div className="meta">{authorLabel(p.author)} · {date(p.published)}</div><article className="post"><div className="body"><Html html={p.content} /></div></article></li>; })}</ul>;
  else if (route.kind === 'bookmarks') content = !data.rows.length ? <p className="empty">Nothing bookmarked yet. Use Bookmark on a post.</p> : <ul className="list">{data.rows.map(row => { const cat = cats.find(c => c.slug === row.cat); return <li key={row.id}><a className="title" href={topicHref(cat, row.topic)}>{row.text || row.id}</a><div className="meta">bookmarked {date(row.at)}{cat ? ' · ' + cat.name : ''}</div></li>; })}</ul>;
  else if (route.kind === 'who') content = <><div className="topline"><h1>{data.card?.name || data.card?.handle || authorLabel(route.id)}</h1></div><p className="hint">{data.card?.handle || authorLabel(route.id)}{data.card?.url && <> · <a href={data.card.url}>their profile</a></>} · {data.posts.length} post{data.posts.length === 1 ? '' : 's'} here</p>{viewer && viewer.actor !== route.id && <section className="reply"><h2>Post to {data.card?.handle || authorLabel(route.id)}&apos;s timeline</h2><p className="hint">This is public. Your own account signs and sends it when its agent next reads the inbox.</p><label className="vh" htmlFor="dm-text">Your post</label><textarea id="dm-text" rows={3} placeholder="Your post" value={dmText} onChange={e => setDmText(e.target.value)} /><p className="row"><button className="primary" onClick={postToTimeline}>Post</button></p><p className={dmSaid.startsWith('Handed') ? 'said' : 'err'} role="status">{dmSaid}</p></section>}{!data.posts.length ? <p className="empty">Nothing from them in what the forum is holding.</p> : <ul className="list">{data.posts.map(p => { const cat = cats.find(c => c.id === p.category); return <li key={p.id}><a className="title" href={topicHref(cat, p.topic, data.digests[p.id])}>{p.topicName || 'Topic'}</a><div className="meta">{cat?.name} · {date(p.published)} · ▲ {p.likes || 0} ▼ {p.dislikes || 0}</div><article className="post"><div className="body"><Html html={p.content} /></div></article></li>; })}</ul>}</>;
  else if (route.kind === 'queue') content = !viewer ? <p className="empty">The queue is read with your pod account.</p> : !data.rows.length ? <p className="empty">Nothing is waiting.</p> : <ul className="list">{data.rows.map((r, i) => <li key={r.object + ':' + i}><div className="title">{r.type}{r.category ? ' · ' + r.category : ''}</div><div className="meta">{r.type === 'Flag' && 'reported by '}{r.by && authorLabel(r.by)}{r.about && <> · about <a href={`#/who/${encodeURIComponent(r.about)}`}>{authorLabel(r.about)}</a></>} · {date(r.at)}{r.verified && ' · checked'}</div>{r.object && <div className="dim">{r.object}</div>}{r.failed && <p className="err">It did not take: {r.failed}{r.failedAt && ` (${date(r.failedAt)})`}. It is still here and will be tried again.</p>}{r.why && <article className="post"><div className="body">{r.why}</div></article>}{r.object && <div className="acts mod">{['Held', 'Create'].includes(r.type) && <><button onClick={() => onQueueAction('approve', r)}>Let it through</button><button onClick={() => onQueueAction('refuse', r)}>Turn it away</button></>}{r.type === 'Join request' && <><button onClick={() => onQueueAction('admit', r)}>Admit</button><button onClick={() => onQueueAction('refuse', r)}>Turn them away</button></>}{r.about && <><button onClick={() => onQueueAction('ban', r)}>Ban the author</button><button onClick={() => onQueueAction('removepost', r)}>Remove the post</button></>}{r.type !== 'Flag' && r.by && <button onClick={() => onQueueAction('ban', { ...r, about: r.by })}>Ban them</button>}</div>}</li>)}</ul>;
  else if (route.kind === 'settings') content = !isModerator ? <p className="empty">Only this forum&apos;s moderators may change it.</p> : !viewer ? <p className="empty">Changing the forum is done with your pod account.</p> : <><div className="topline"><h1>Settings</h1></div><section className="reply"><h2>The forum</h2><div className="row oneline"><label htmlFor="set-forum-name">Name</label><input id="set-forum-name" type="text" value={forumName} onChange={e => setForumName(e.target.value)} /><button onClick={() => onSetting('forum-name')}>Rename</button><button onClick={() => openPanel('moderators')}>Manage moderators</button></div></section><section className="reply"><h2>Categories</h2><ul className="list bare">{cats.map(c => <li key={c.id}><div className="row"><label className="vh" htmlFor={`cat-name-${c.slug}`}>Name of {c.name}</label><input id={`cat-name-${c.slug}`} type="text" value={categoryNames[c.id] ?? c.name} onChange={e => setCategoryNames(names => ({ ...names, [c.id]: e.target.value }))} /><button onClick={() => onSetting('cat-name', c)}>Rename</button><button onClick={() => openPanel('members', c)}>Manage members</button><span className="dim">{handleOf(c)}</span><label><input type="radio" name={`cat-private-${c.slug}`} checked={!c.private} onChange={() => onSetting('privacy', c, false)} /> Open</label><label><input type="radio" name={`cat-private-${c.slug}`} checked={!!c.private} onChange={() => onSetting('privacy', c, true)} /> Private</label></div></li>)}</ul></section><section className="reply"><h2>New Category</h2><div className="row oneline"><label htmlFor="set-new-name">Category name</label><input id="set-new-name" type="text" value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)} /><label htmlFor="set-new-slug">Category slug</label><input id="set-new-slug" type="text" placeholder="Fediverse Username" value={newCategorySlug} onChange={e => setNewCategorySlug(e.target.value)} /></div><div className="row"><label><input type="radio" name="new-private" checked={!newCategoryPrivate} onChange={() => setNewCategoryPrivate(false)} /> Open</label><label><input type="radio" name="new-private" checked={newCategoryPrivate} onChange={() => setNewCategoryPrivate(true)} /> Private</label><button onClick={() => onSetting('new-category')}>Create</button></div></section>{panelError && <p className={panelError.startsWith('Sent.') ? 'said' : 'err'} role="status">{panelError}</p>}</>;

  return <>
    <a className="skip" href="#main">Skip to content</a>
    <header className="top"><h1><a href="#/">{forum?.name || 'Forum'}</a></h1><span className="who"><span>{account ? `signed in as ${account.handle}` : ''}</span><button onClick={() => account ? signOut() : openSignIn('take part, and to moderate if you are a moderator')}>{account ? 'Sign out' : 'Sign in'}</button></span></header>
    <p className="dim" id="mods-line"><span>{moderators.length ? <><span className="lead">moderators:</span> {moderators.map((id, i) => <span key={id}>{i ? ', ' : ''}<a href={`#/who/${encodeURIComponent(id)}`}>{forum?.admins?.find(a => a.id === id)?.handle || authorLabel(id)}</a></span>)}</> : forum?.admins?.length ? <><span className="lead">moderators:</span> {forum.admins.map((a, i) => <span key={a.id}>{i ? ', ' : ''}<a href={`#/who/${encodeURIComponent(a.id)}`}>{a.handle}</a></span>)}</> : null}</span>{forum && ['index', 'category'].includes(route.kind) && <span id="mods-acts"><label className="vh" htmlFor="find">Search this forum</label>{searchOpen || finding ? <input ref={searchRef} id="find" type="text" placeholder="Search" value={finding} onChange={e => setFinding(e.target.value)} onBlur={() => !finding.trim() && setSearchOpen(false)} autoComplete="off" /> : <button onClick={() => { setSearchOpen(true); setTimeout(() => searchRef.current?.focus(), 0); }}>Search</button>}{into && <button onClick={() => onAction('newtopic', null, into)}>New topic</button>}</span>}</p>
    <nav className="crumbs" aria-label="Breadcrumb" hidden={trail.length < 2}>{trail.map(([label, href], i) => <span key={i}>{i ? ' › ' : ''}{href && i < trail.length - 1 ? <a href={href}>{label}</a> : label}</span>)}</nav>
    <p className="vh" role="status" aria-live="polite">{notice}</p>
    <main id="main" tabIndex={-1}>{content}</main>
    <dialog ref={panelRef} aria-labelledby="panel-title" onClose={() => { setPanel(null); reopenRef.current?.focus?.(); }}><section className="reply"><h2 id="panel-title">{panel?.kind === 'moderators' ? 'Moderators' : `Members of ${panel?.cat?.name || ''}`}</h2>{panel?.kind === 'moderators' ? <><p className="hint">{panel.labels?.join(', ') || 'nobody yet'}</p><div className="row oneline"><label htmlFor="set-mod">Their handle</label><input id="set-mod" type="text" placeholder="@mei@their.server" value={panelValue} onChange={e => setPanelValue(e.target.value)} /><button onClick={() => onSetting('moderator', null, true)}>Add</button><button onClick={() => onSetting('moderator', null, false)}>Remove</button></div><p className="hint">Adding somebody makes them a moderator and lets them read the queue. Reading the queue also needs a pod account with a WebID.</p></> : panel?.kind === 'members' ? <><p className="hint">A private category grants reading by WebID. An admitted member can read its history and copy posts.</p><div className="row"><label htmlFor="set-member">Their WebID</label><input id="set-member" type="text" placeholder="https://someone.example/profile/card#me" value={panelValue} onChange={e => setPanelValue(e.target.value)} /><button onClick={() => onSetting('member', panel.cat, true)}>Let them in</button><button onClick={() => onSetting('member', panel.cat, false)}>Take them out</button></div></> : null}<p className={panelError.startsWith('Sent.') ? 'said' : 'err'} role="alert">{panelError}</p><p className="row"><button className="plain" onClick={() => setPanel(null)}>Close</button></p></section></dialog>
    <dialog ref={signinRef} aria-labelledby="signin-title" onClose={() => { setSigninOpen(false); reopenRef.current?.focus?.(); }} onCancel={() => sessionStorage.removeItem('bb:intent')}><section className="reply"><h2 id="signin-title">Sign in</h2><p className="hint" role="status">{signinWhy}</p><label htmlFor="signin-handle">Your handle or WebID</label><div className="row"><input id="signin-handle" type="text" placeholder="@you@server or @you@pod or your WebID" autoComplete="off" value={signinHandle} onChange={e => setSigninHandle(e.target.value)} onKeyDown={e => e.key === 'Enter' && signIn(signinHandle, setSigninNote).catch(err => setSigninNote(err.message))} /><button className="primary" onClick={() => signIn(signinHandle, setSigninNote).catch(err => setSigninNote(err.message))}>Sign in</button></div><p className="hint" role="status">{signinNote}</p><p className="hint">You can participate if you have a pod or a Fediverse account. A FediPod account gives you both.</p><p className="row"><a className="big" href={`${place.front}/new-account`}>Get a FediPod account</a></p><div className="row"><button className="plain" onClick={closeSignIn}>Cancel</button></div></section></dialog>
    <dialog ref={replyRef} aria-labelledby="reply-title" onClose={() => { setReplyOpen(false); reopenRef.current?.focus?.(); }}><section className="reply"><h2 id="reply-title">{editing ? 'Edit your post' : replyCtx?.title || 'Reply'}</h2>{!account ? <><label htmlFor="fedi-handle">Your handle or WebID</label><div className="row"><input id="fedi-handle" type="text" placeholder="@you@server or @you@pod or your WebID" autoComplete="off" value={replyHandle} onChange={e => setReplyHandle(e.target.value)} onKeyDown={e => e.key === 'Enter' && signIn(replyHandle, setReplyError).catch(err => setReplyError(err.message))} /><button onClick={() => signIn(replyHandle, setReplyError).catch(err => setReplyError(err.message))}>Sign in</button></div><p className="hint">You can participate if you have a pod or a Fediverse account.</p><p className="row"><a className="big" href={`${place.front}/new-account`}>Get a FediPod account</a></p></> : <><p className="hint">Posting as <b>{account.handle}</b> <button className="link" onClick={signOut}>Sign out</button></p>{!editing && !replyCtx?.topicId && <div className="row"><label htmlFor="topic-title">Topic name</label><input id="topic-title" type="text" placeholder="What this topic is about" value={topicTitle} onChange={e => setTopicTitle(e.target.value)} /></div>}<label htmlFor="reply-text">{editing ? 'Your post' : replyCtx?.topicId ? 'Your reply' : 'Your opening post'}</label><textarea id="reply-text" placeholder={replyCtx?.topicId ? 'Write your reply' : 'Your opening post'} value={replyText} onChange={e => setReplyText(e.target.value)} /><p className="row"><label className="filelabel" htmlFor="reply-image">Add an image</label><input id="reply-image" type="file" accept="image/*" onChange={e => { void uploadImage(e.target.files?.[0]); e.target.value = ''; }} /><span className="hint">{imageSaid}</span></p><div className="row"><button className="plain" onClick={closeReply}>Cancel</button><button className="primary" disabled={sending} onClick={sendReply}>{editing ? 'Save' : replyCtx?.topicId ? 'Post reply' : 'Start topic'}</button></div></>}{replyCtx?.cat?.private && <p className="hint">{replyCtx.cat.name} is private. This is written into your own pod for its members to read, and goes to nobody else. Anyone admitted later can read it, and anyone admitted now can copy it.</p>}<p className="err" role="alert">{replyError}</p></section></dialog>
    <footer className="foot">Powered by <a href="https://github.com/jeff-zucker/FediPod" rel="noopener">FediPod-BB</a>. This site adheres to the <a href="https://solidproject.org/code_of_conduct" rel="noopener">Solid Code of Conduct</a>; please use the report button as needed.</footer>
  </>;
}
