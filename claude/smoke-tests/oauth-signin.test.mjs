// oauth-signin.test.mjs — the Server's sign-in page for a client asking to use
// an account. A link that lands there with the owner's pod sign-in already
// stored must allow nothing until the owner presses Allow in that tab.
// The page script runs against a stand-in page and a stand-in sign-in library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-signin-'));
fs.copyFileSync(path.join(here, '../../web/admin/oauth-signin.mjs'), path.join(dir, 'oauth-signin.mjs'));
fs.writeFileSync(path.join(dir, 'fedi-login.mjs'), `export function fediLogin() {
  const t = globalThis.__signin;
  return { resume: async () => {}, getSession: async () => t.session, login: async (...a) => { t.logins.push(a); } };
}\n`);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const OWNER = 'https://kofi.pod.example/profile/card#me';
const store = new Map();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
} });

let loads = 0;
async function open({ session = 'owner', search = '?client_id=app1&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_type=code' } = {}) {
  const t = { posts: [], logins: [], session: null };
  if (session) {
    t.session = { webId: session === 'owner' ? OWNER : 'https://someone.else.example/profile/card#me',
      fetch: async (url, init) => { t.posts.push({ url, init }); return new Response(JSON.stringify({ redirect: 'https://app.example/cb?code=c1' }), { status: 200 }); } };
  }
  globalThis.__signin = t;
  const el = () => ({ hidden: true, textContent: '', attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(type, f) { this.listeners[type] = f; } });
  const page = { webid: { href: OWNER }, signin: el(), cancel: el(), 'signin-status': el() };
  globalThis.document = { getElementById: (id) => page[id] };
  globalThis.location = { origin: 'https://kofi.pod.example', pathname: '/oauth/authorize', search,
    href: `https://kofi.pod.example/oauth/authorize${search}` };
  await import(`${pathToFileURL(path.join(dir, 'oauth-signin.mjs')).href}?load=${++loads}`);
  return { t, page, press: (id) => page[id].listeners.click() };
}

test('a link that lands with a stored sign-in allows nothing until Allow is pressed', async () => {
  store.clear();
  const { t, page, press } = await open();
  assert.equal(t.posts.length, 0, 'nothing is sent on load');
  assert.equal(page.signin.hidden, false); assert.equal(page.cancel.hidden, false);
  await press('signin');
  assert.equal(t.posts.length, 1, 'pressing Allow signs the client in');
  assert.equal(location.href, 'https://app.example/cb?code=c1');
});

test('Cancel allows nothing and says so', async () => {
  store.clear();
  const { t, page, press } = await open();
  await press('cancel');
  assert.equal(t.posts.length, 0);
  assert.equal(page.signin.hidden, true);
  assert.match(page['signin-status'].textContent, /Nothing was allowed/u);
});

test('with no stored sign-in, Allow goes to the pod, and the return from it finishes without a second press', async () => {
  store.clear();
  const first = await open({ session: null });
  await first.press('signin');
  assert.equal(first.t.logins.length, 1, 'Allow sends the owner to sign in at their pod');
  assert.equal(first.t.posts.length, 0);
  const back = await open();
  assert.equal(back.t.posts.length, 1, 'back from the pod in the same tab, the Allow already given is used once');
  const again = await open();
  assert.equal(again.t.posts.length, 0, 'and not a second time');
});

test("a stored sign-in for somebody else is refused with a reason, and nothing is sent", async () => {
  store.clear();
  const { t, page, press } = await open({ session: 'other' });
  await press('signin');
  assert.equal(t.posts.length, 0);
  assert.match(page['signin-status'].textContent, /this account belongs to/u);
});

test('the page with no client named (the way back from the pod) offers nothing to press', async () => {
  store.clear();
  const { t, page } = await open({ search: '?code=x&state=y' });
  assert.equal(t.posts.length, 0); assert.equal(page.signin.hidden, true);
});
