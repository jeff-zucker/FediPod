// forum-pages.test.mjs — a forum's page at its own host: drawn by the forum's
// code when this Gateway keeps forums, kept at the edge under the forum's
// labels, and the page as the site serves it when nothing draws it.
import test from 'node:test';
import assert from 'node:assert/strict';
const { routeFront } = await import('../../lib/gateway/front-core.mjs');

const SHELL = '<!doctype html><title>FediPod-BB</title><main id="main" tabindex="-1"><p class="dim">Loading…</p></main>';
const drawnCalls = [];
// The site's own copy of the page, and a forum module that draws (or not).
const ctxWith = (renderPage, extra = {}) => ({
  lookup: () => null,
  siteFetch: async (u) => (u.endsWith('/bb/index.html') ? new Response(SHELL) : new Response('', { status: 404 })),
  forum: renderPage ? { isForumRow: () => false, renderPage } : null,
  ...extra,
});
const draws = async ({ url, shell }) => {
  drawnCalls.push(url);
  if (url.includes('/t/gardening/gone')) return { status: 404, html: shell.replace('Loading…', 'No such topic.'), tags: ['u-forum', 'u-gardening'] };
  return { status: 200, html: shell.replace('Loading…', 'Tomato blight'), tags: ['u-forum', 'u-gardening', 'u-seeds'] };
};
const ask = (url, ctx, init) => routeFront(new Request(url, init), ctx);

test('a forum\'s front page, a category and a topic arrive drawn, kept an hour under the forum\'s labels', async () => {
  for (const path of ['/forum/', '/forum/c/gardening', '/forum/t/gardening/abc']) {
    const out = await ask(`https://bb.fedipod.net${path}`, ctxWith(draws));
    assert.equal(out.status, 200, path);
    assert.match(out.body, /Tomato blight/u, path);
    assert.equal(out.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(out.headers['netlify-cdn-cache-control'], 'public, s-maxage=3600, stale-while-revalidate=14400');
    assert.doesNotMatch(out.headers['netlify-cdn-cache-control'], /durable/u, 'emptied with each deploy');
    assert.equal(out.headers['netlify-cache-tag'], 'u-forum,u-gardening,u-seeds', 'dropped with the forum\'s documents');
    assert.equal(out.headers['cache-control'], 'no-cache', 'a browser asks again each time, as for the page\'s scripts');
    assert.match(out.headers['content-security-policy'] || '', /script-src 'self'/u, 'with the page\'s own policy');
  }
});

test('a topic that is not there is not found, and kept only briefly', async () => {
  const out = await ask('https://bb.fedipod.net/forum/t/gardening/gone', ctxWith(draws));
  assert.equal(out.status, 404);
  assert.match(out.body, /No such topic\./u);
  assert.match(out.headers['netlify-cdn-cache-control'], /s-maxage=120\b/u);
});

test('what is not drawn is the page as the site serves it', async () => {
  const failing = await ask('https://bb.fedipod.net/forum/t/gardening/abc', ctxWith(async () => null));
  assert.equal(failing.status, 200);
  assert.equal(failing.body, SHELL, 'the reader\'s browser builds it');
  assert.equal(failing.headers['netlify-cdn-cache-control'], undefined, 'and it is not kept, so the next reader gets a drawn page');
  const throwing = await ask('https://bb.fedipod.net/forum/', ctxWith(async () => { throw new Error('boom'); }));
  assert.equal(throwing.body, SHELL);
  drawnCalls.length = 0;
  const signIn = await ask('https://bb.fedipod.net/forum/?code=x&state=y', ctxWith(draws));
  assert.equal(signIn.body, SHELL, 'a sign-in coming back is built by the page');
  assert.equal(drawnCalls.length, 0, 'and nothing is drawn for it');
  assert.equal(signIn.headers['netlify-cdn-cache-control'], undefined);
  const none = await ask('https://bb.fedipod.net/forum/', ctxWith(null));
  assert.equal(none.body, SHELL, 'a Gateway that keeps no forums serves the page');
  assert.equal(none.headers['netlify-cdn-cache-control'], 'public, s-maxage=3600', 'the same for everyone, so kept');
});

test('a drawing not done in time is left to finish after the answer, where the host allows it', async () => {
  let handed = null;
  const late = async ({ keepGoing }) => { keepGoing?.(Promise.resolve('read')); return null; };
  const out = await ask('https://bb.fedipod.net/forum/t/gardening/abc', ctxWith(late, { waitUntil: (p) => { handed = p; } }));
  assert.equal(out.body, SHELL, 'the reader gets the page undrawn at once');
  assert.equal(await handed, 'read', 'and the drawing is handed to the host to finish');
  const none = await ask('https://bb.fedipod.net/forum/t/gardening/abc', ctxWith(late));
  assert.equal(none.body, SHELL, 'a host with nothing to wait on sends the same page');
});

test('every address under a forum at its own host goes to the forum\'s code, and only to be read', async () => {
  drawnCalls.length = 0;
  for (const url of ['https://bb.fedipod.net/api/', 'https://bb.fedipod.net/bb/', 'https://fedipod.net/forum/',
    'https://bb.fedipod.net/u/forum/ap/actor', 'https://bb.fedipod.net/robots.txt']) {
    await ask(url, ctxWith(draws));
  }
  assert.deepEqual(drawnCalls, [], 'nothing that is not a forum\'s is handed to it');
  for (const url of ['https://bb.fedipod.net/forum/t/x', 'https://bb.fedipod.net/forum/someday/a/new/view']) await ask(url, ctxWith(draws));
  assert.deepEqual(drawnCalls, ['https://bb.fedipod.net/forum/t/x', 'https://bb.fedipod.net/forum/someday/a/new/view'],
    'whatever is under a forum is the forum\'s to draw or not');
  const declined = await ask('https://bb.fedipod.net/forum/someday', ctxWith(async () => null));
  assert.equal(declined.body, SHELL, 'what the forum does not draw is the page as the site serves it');
  const post = await ask('https://bb.fedipod.net/forum/', ctxWith(draws), { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  const noShell = await ask('https://bb.elsewhere.example/forum/', { ...ctxWith(draws), siteFetch: async () => new Response('', { status: 500 }) });
  assert.equal(noShell.status, 503, 'without the page there is nothing to send');
  assert.equal(noShell.headers['cache-control'], 'no-store');
});
