// pod.mjs — posting to the forum from the reader's own Solid pod, in this
// page. The reader signs in to their pod (Solid-OIDC, the browser build's
// own session module), the post is written into their pod as their own
// document, and the activity announcing it is appended to the forum's inbox.
// Nothing is posted from the forum's account and no key is needed here: the
// forum's host fetches the post back from the reader's pod, which is where
// the truth of who wrote it lives (FEP-fe34).

import { beginLogin, completeLogin, getSession, signOut as endSession } from './oidc-session.mjs';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS = 'https://www.w3.org/ns/activitystreams';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48);
const stamp = () => new Date().toISOString().slice(0, 10);

// Where this reader's own account keeps its things. Two addresses for one
// post: it is WRITTEN into their pod, and it is PUBLISHED under the address
// their actor answers at — the same one for a plain pod, the front's for an
// account fronted at a Gateway. The two must agree, or a receiving server is
// right to refuse a post whose author lives on another host (FEP-fe34).
export const placeOf = (actor, podHome) => ({
  actor,
  id: (name) => actor.replace(/ap\/actor$/u, 'ap/notes/') + name,
  at: (name) => (podHome ? podHome.replace(/\/?$/u, '/') + 'ap/notes/' + name
    : actor.replace(/ap\/actor$/u, 'ap/notes/') + name),
});

// What the forum answers as, on its own pod: the page reads a category
// through the Gateway, whose ids are the front's, but a post is delivered to
// the pod itself.
export async function podInboxOf(categoryActorId, { fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
  const doc = await f(categoryActorId, { headers: { accept: 'application/activity+json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const inbox = doc?.endpoints?.sharedInbox || doc?.inbox;
  return typeof inbox === 'string' ? inbox : null;
}

export const session = getSession;
export const signOut = endSession;

// Send them to their pod to sign in. `issuer` came from the Gateway, which
// knows the pod behind their handle.
export async function signIn({ issuer, redirectUri }) {
  const { authorizationUrl } = await beginLogin({ issuer, redirectUri });
  return authorizationUrl;
}
export async function complete(currentUrl) {
  await completeLogin({ currentUrl });
  return getSession();
}

// The post itself: a document in their pod, then a Create appended to the
// forum's inbox. A title makes it an Article, which is what a board shows as
// a topic (FEP-b2b8).
export async function post({ actor, podHome, category, categoryHandle, inbox, title, text, inReplyTo = null, context = null }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const place = placeOf(actor, podHome);
  const name = `${stamp()}-${slug(title) || 'post'}-${crypto.randomUUID().slice(0, 8)}`;
  const id = place.id(name);
  const now = new Date().toISOString();
  const mention = categoryHandle ? `<a href="${category}">${categoryHandle}</a> ` : '';
  const body = String(text).split(/\n{2,}/u).map(p => `<p>${escape_(p).replace(/\n/gu, '<br>')}</p>`).join('');
  const note = {
    '@context': AS,
    id,
    type: title ? 'Article' : 'Note',
    attributedTo: actor,
    ...(title ? { name: String(title).slice(0, 200) } : {}),
    content: `<p>${mention}</p>${body}`.replace('<p></p>', ''),
    published: now,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(context ? { context, audience: category } : { audience: category }),
    to: [PUBLIC, category],
    cc: [],
    tag: [{ type: 'Mention', href: category, ...(categoryHandle ? { name: categoryHandle } : {}) }],
  };
  const put = await s.fetch(place.at(name), { method: 'PUT', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(note) });
  if (!put.ok) throw new Error(`your pod refused the post (HTTP ${put.status})`);
  const create = {
    '@context': AS,
    id: `${id}#create`,
    type: 'Create',
    actor,
    published: now,
    object: note,
    to: [PUBLIC, category],
    cc: [],
  };
  const sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(create) });
  if (!sent.ok) throw new Error(`the forum did not take it (HTTP ${sent.status})`);
  return { id, uri: id };
}

// Joining: a category carries a member's posts, so the first post from a new
// reader is preceded by a Follow the category answers itself.
export async function join({ actor, category, inbox }) {
  const follow = { '@context': AS, id: `${actor}#follow-${Date.now()}`, type: 'Follow', actor, object: category, to: [category] };
  const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(follow) });
  return r.ok;
}

function escape_(s) {
  return String(s).replace(/[&<>"]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
