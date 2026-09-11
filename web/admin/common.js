// common.js — what every admin page starts from: the element lookup, the
// door the page is served behind, and the two ways it talks to the agent.
// Loaded first by the record page and by the setup page.

const $ = (id) => document.getElementById(id);
// The door this page is served behind: nothing when the agent runs on this
// machine, `/app` when the identity is hosted by its own pod server. Read from
// the page's own address, so one build serves both.
const BASE = location.pathname.replace(/\/admin\/.*$/u, '');
// Every call carries `x-fedipod-page`. On the Node agent it is ignored — the
// Origin check there already refuses a page on somebody else's site. In the
// browser build the agent IS this origin's service worker, which cannot see
// Sec-Fetch-* and answers these routes with no password, so this header is the
// whole door: a cross-site form cannot set one, and a cross-origin fetch that
// sets one is stopped at a preflight the worker never grants. See sw-src.mjs.
const PAGE_HEADER = { 'x-fedipod-page': '1' };
const api = async (path, init) => {
  const res = await fetch(BASE + path, { ...init, headers: { ...(init?.headers || {}), ...PAGE_HEADER } });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const postJson = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});
