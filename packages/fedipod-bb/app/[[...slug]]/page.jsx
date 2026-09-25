import { headers } from 'next/headers';
import { isIP } from 'node:net';
import ForumApp from '../forum-client.jsx';
import { reader, placeOf, cacheKey } from '../../site/read.mjs';

export const dynamic = 'force-dynamic';

function routeFromPath(pathname, alias) {
  const parts = pathname.split('/').filter(Boolean);
  const route = alias ? parts.slice(1) : parts[0] === 'bb' ? parts.slice(1) : parts;
  if (route[0] === 't' && route[1] && route[2]) return { kind: 'topic', slug: route[1], tid: route[2], at: route[3] || null };
  if (route[0] === 'c' && route[1]) return { kind: 'category', slug: route[1] };
  if (route[0] === 'who' && route[1]) return { kind: 'who', id: decodeURIComponent(route[1]) };
  return { kind: 'index' };
}

const localPodAllowed = process.env.NODE_ENV === 'development' || process.env.FEDIPOD_BB_ALLOW_LOCAL_PODS === '1';
function publicDocument(url, ownOrigin) {
  try {
    const u = new URL(url);
    if (u.username || u.password || !['http:', 'https:'].includes(u.protocol)) return false;
    if (u.origin === ownOrigin) return true;
    if (localPodAllowed && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local') && isIP(host) === 0;
  } catch { return false; }
}

async function indexData(read, base, forum) {
  const limit = 150;
  const [latest, sitePins, collections] = await Promise.all([
    read.latest(base, { limit }), read.featured(base),
    Promise.all(forum.categories.map(async c => ({ id: c.id, pins: await read.featured(c.base), mods: await read.moderators(c.base) }))),
  ]);
  const catPins = Object.fromEntries(collections.map(c => [c.id, c.pins]));
  const catMods = Object.fromEntries(collections.map(c => [c.id, c.mods]));
  const people = [...new Set(latest.filter(p => p.author).map(p => p.author))];
  const authors = Object.fromEntries(await Promise.all(people.map(async id => {
    const cat = forum.categories.find(c => latest.some(p => p.author === id && p.category === c.id));
    return [id, cat ? await read.author(cat.base, id) : null];
  })));
  const digests = Object.fromEntries(await Promise.all(latest.map(async p => [p.id, await cacheKey(p.id)])));
  return { kind: 'index', latest: [...latest], more: latest.more || 0, sitePins, catPins, catMods, authors, digests, limit };
}

async function topicData(read, cat, tid) {
  if (!cat) return null;
  const topic = await read.topic(`${cat.base}ap/topic/${tid}`);
  if (!topic) return null;
  const posts = (await Promise.all(topic.posts.map(id => read.post(cat.base, id)))).map((p, i) => p || { id: topic.posts[i], content: '', author: null });
  const people = [...new Set(posts.map(p => p.author).filter(Boolean))];
  const [names, digests] = await Promise.all([
    Promise.all(people.map(async id => [id, await read.author(cat.base, id)])),
    Promise.all(posts.map(async p => [p.id, await cacheKey(p.id)])),
  ]);
  return { kind: 'topic', topic, posts, authors: Object.fromEntries(names), digests: Object.fromEntries(digests), pending: [] };
}

export default async function Page({ params, searchParams }) {
  const h = await headers();
  const q = await searchParams;
  const segments = (await params).slug || [];
  const pathname = '/' + segments.join('/') + '/';
  const host = h.get('x-forwarded-host') || h.get('host') || 'localhost:3000';
  const protocol = h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  const origin = `${protocol}://${host}`;
  const search = new URLSearchParams(Object.entries(q).filter(([, v]) => typeof v === 'string')).toString();
  const alias = /^bb\./u.test(host);
  const at = placeOf({ origin, pathname, search: search ? '?' + search : '' });
  const place = { ...at, origin, pathBase: alias ? `/${encodeURIComponent(at.handle || '')}` : '/bb',
    query: at.pod ? `?pod=${encodeURIComponent(at.pod)}` : at.handle && !alias ? `?forum=${encodeURIComponent(at.handle)}` : '' };
  const route = routeFromPath(pathname, alias);
  let forum = null;
  let data = null;
  if (place.base && publicDocument(place.base, origin)) {
    const read = reader({ fetch: (url, options) => publicDocument(url, origin)
      ? fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(8000) })
      : Promise.resolve(new Response('', { status: 403 })) });
    forum = await read.forum(place.base);
    if (forum) {
      data = route.kind === 'topic'
        ? await topicData(read, forum.categories.find(c => c.slug === route.slug), route.tid)
        : await indexData(read, place.base, forum);
      if (route.kind === 'category') {
        const cat = forum.categories.find(c => c.slug === route.slug);
        if (cat && !data.latest.some(p => p.category === cat.id))
          data = { ...data, restricted: !(await read.canRead(cat.base)) };
      }
    }
  }
  return <ForumApp initialForum={forum} initialRoute={route} initialData={data} place={place} />;
}
