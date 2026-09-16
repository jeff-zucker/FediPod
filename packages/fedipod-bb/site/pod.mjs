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
export async function podInboxOf(categoryActorId, { front = null, handle = null, fetch: f = globalThis.fetch.bind(globalThis) } = {}) {
  // Through a Gateway the category's actor names the Gateway's own door, which
  // takes signed mail between servers. A post made here is the reader's own,
  // so it goes to the pod inbox the Gateway names when asked.
  if (front && handle && categoryActorId.startsWith(front)) {
    const said = await f(`${front}/api/server?host=${encodeURIComponent(new URL(front).host)}&handle=${encodeURIComponent(handle)}`,
      { headers: { accept: 'application/json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (said?.inbox) return said.inbox;
  }
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
// forum's inbox. A post has no title of its own; when it opens a topic, the
// activity that opens it carries the TOPIC's name, which is a different
// thing and belongs to the topic.
export async function post({ actor, podHome, category, categoryHandle, inbox, topic = '', text, inReplyTo = null, context = null }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const place = placeOf(actor, podHome);
  const name = `${stamp()}-${slug(topic) || 'post'}-${crypto.randomUUID().slice(0, 8)}`;
  const id = place.id(name);
  const now = new Date().toISOString();
  const body = htmlOf(text);
  const note = {
    '@context': AS,
    id,
    type: 'Note',
    attributedTo: actor,
    // The category is named in audience, in to, and as a Mention tag — the
    // three places a receiving server reads. Not in the words.
    content: body,
    published: now,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(context ? { context, audience: category } : { audience: category }),
    to: [PUBLIC, category],
    cc: [],
    tag: [{ type: 'Mention', href: category, ...(categoryHandle ? { name: categoryHandle } : {}) }],
  };
  // The type it is STORED as decides what a reader may ask for: a pod will
  // not convert one JSON flavour into another, and answers 501 to a server
  // asking for ActivityPub over a document filed as plain JSON-LD.
  const put = await s.fetch(place.at(name), { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(note) });
  if (!put.ok) throw new Error(`your pod refused the post (HTTP ${put.status})`);
  const create = {
    '@context': AS,
    id: `${id}#create`,
    type: 'Create',
    actor,
    published: now,
    ...(topic ? { name: String(topic).slice(0, 200) } : {}),
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
export async function edit({ actor, podHome, id, text, category, inbox }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const now = new Date().toISOString();
  const at = placeOf(actor, podHome).at(id.split('/').pop());
  const was = await fetch(id, { headers: { accept: 'application/activity+json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  const note = {
    ...(was || { '@context': AS, id, type: 'Note', attributedTo: actor, to: [PUBLIC, category] }),
    content: htmlOf(text),
    updated: now,
  };
  const put = await s.fetch(at, { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(note) });
  if (!put.ok) throw new Error(`your pod refused the change (HTTP ${put.status})`);
  const update = { '@context': AS, id: `${id}#update-${Date.now()}`, type: 'Update', actor, published: now,
    object: note, to: [PUBLIC, category], cc: [] };
  const sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(update) });
  if (!sent.ok) throw new Error(`the forum did not take the change (HTTP ${sent.status})`);
  return { id };
}

export async function remove({ actor, podHome, id, category, inbox }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const now = new Date().toISOString();
  const at = placeOf(actor, podHome).at(id.split('/').pop());
  const stone = { '@context': AS, id, type: 'Tombstone', formerType: 'Note', deleted: now };
  const put = await s.fetch(at, { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(stone) });
  if (!put.ok) throw new Error(`your pod refused the deletion (HTTP ${put.status})`);
  const del = { '@context': AS, id: `${id}#delete-${Date.now()}`, type: 'Delete', actor, published: now,
    object: id, to: [PUBLIC, category], cc: [] };
  const sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(del) });
  if (!sent.ok) throw new Error(`the forum was not told (HTTP ${sent.status})`);
  return { id };
}

export async function join({ actor, category, inbox }) {
  const follow = { '@context': AS, id: `${actor}#follow-${Date.now()}`, type: 'Follow', actor, object: category, to: [category] };
  const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(follow) });
  return r.ok;
}

const htmlOf = (text) => String(text).split(/\n{2,}/u).map(p => `<p>${escape_(p).replace(/\n/gu, '<br>')}</p>`).join('');

function escape_(s) {
  return String(s).replace(/[&<>"]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
