// forum-pages.mjs — a forum's page at its own host (bb.<gateway>/<forum>/…).
// Every address under a forum is handed to the forum's own code
// (ctx.forum.renderPage, netlify/forum-support.mjs), which draws the ones it
// draws; for the rest, or when drawing fails, the page as the site serves it,
// which the reader's browser builds. Which addresses are drawn is the forum's
// business, not this file's.

// A forum's path, and anything under it.
const VIEW = /^\/([^/]+)\//u;
// First path segments the bb host gives to something other than a forum.
const NOT_FORUMS = new Set(['api', 'bb', 'icons', 'u', '.well-known']);
// How long the edge keeps a drawn page. The forum's documents are dropped
// from the edge when a post lands and when the forum runs, under the labels
// the page carries too, so an hour only bounds a change nothing announced.
// Kept per region, not durably: a page names the scripts of the deploy that
// drew it.
const PAGE_EDGE_SECONDS = 3600;
const MISSING_EDGE_SECONDS = 120;

// The page as the site serves it, read once per running instance: it changes
// only with a deploy, which starts new ones.
const shells = new Map();
async function shellOf(origin, f) {
  if (shells.has(origin)) return shells.get(origin);
  const r = await f(`${origin}/bb/index.html`).catch(() => null);
  const text = r?.ok ? await r.text().catch(() => null) : null;
  if (text) shells.set(origin, text);
  return text;
}

/** The answer for a forum's page at its own host, or null for any other request. */
export async function routeForumPage(request, ctx) {
  const url = new URL(request.url);
  if (!/^bb\./u.test(url.hostname)) return null;
  const m = VIEW.exec(url.pathname);
  if (!m || NOT_FORUMS.has(m[1])) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: { allow: 'GET, HEAD' }, body: '' };
  const shell = await shellOf(url.origin, ctx.siteFetch || globalThis.fetch.bind(globalThis));
  if (!shell) return { status: 503, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', 'retry-after': '30' }, body: 'the forum\'s page is not available right now\n' };
  const page = (status, body, headers) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...headers }, body });
  // An address with a query is a sign-in coming back, or nothing a reader
  // follows: the page builds it.
  const draws = !!ctx.forum?.renderPage && !url.search;
  // A drawing not done in time goes on after the page has gone, where the
  // host lets work outlive its answer (ctx.waitUntil): the next reader's
  // drawing then finds the forum's documents at hand.
  const drawn = draws ? await ctx.forum.renderPage({ url: url.href, shell, keepGoing: ctx.waitUntil || null }).catch(() => null) : null;
  if (drawn) {
    const hold = drawn.status === 404 ? MISSING_EDGE_SECONDS : PAGE_EDGE_SECONDS;
    return page(drawn.status, drawn.html, {
      'netlify-cdn-cache-control': `public, s-maxage=${hold}, stale-while-revalidate=${hold * 4}`,
      'netlify-cache-tag': drawn.tags.join(','),
    });
  }
  // Not drawn. Where drawing was tried, this answer is not kept, so the next
  // reader gets a drawn page; where nothing here draws, it is the same page
  // for everyone and is kept like one.
  return page(200, shell, draws || url.search ? {} : { 'netlify-cdn-cache-control': `public, s-maxage=${PAGE_EDGE_SECONDS}` });
}
