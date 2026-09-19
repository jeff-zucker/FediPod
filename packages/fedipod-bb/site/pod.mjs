// pod.mjs — posting to the forum from the reader's own Solid pod, in this
// page. The reader signs in to their pod (Solid-OIDC, the browser build's
// own session module), the post is written into their pod as their own
// document, and the activity announcing it is appended to the forum's inbox.
// Nothing is posted from the forum's account and no key is needed here: the
// forum's host fetches the post back from the reader's pod, which is where
// the truth of who wrote it lives (FEP-fe34).

import { beginLogin, completeLogin, getSession, signOut as endSession } from './oidc-session.mjs';
import { toHtml } from './markdown.mjs';
import * as priv from './private.mjs';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS = 'https://www.w3.org/ns/activitystreams';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48);
const stamp = () => new Date().toISOString().slice(0, 10);

// Where this reader's own account keeps its things. Two addresses for one
// post: it is WRITTEN into their pod, and it is PUBLISHED under the address
// their actor answers at — the same one for a plain pod, the front's for an
// account fronted at a Gateway. The two must agree, or a receiving server is
// right to refuse a post whose author lives on another host (FEP-fe34).
// A picture goes into the reader's own pod, in the container their account
// already keeps media in — public to read, like the posts that will show it.
export async function upload({ actor, podHome, file }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  if (!/^image\//u.test(file.type)) throw new Error('that is not an image');
  if (file.size > 5 * 1024 * 1024) throw new Error('images are limited to 5 MB');
  const home = (podHome || actor.replace(/ap\/actor$/u, '')).replace(/\/?$/u, '/');
  const ext = (file.name.match(/\.[a-z0-9]{1,5}$/iu) || [''])[0].toLowerCase() || '.img';
  const at = `${home}ap/media/${stamp()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const put = await s.fetch(at, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  if (!put.ok) throw new Error(`your pod refused the image (HTTP ${put.status})`);
  // Published under the address the account answers at, like its posts.
  return actor.replace(/ap\/actor$/u, '') + at.slice(home.length);
}

export const placeOf = (actor, podHome) => ({
  actor,
  id: (name) => actor.replace(/ap\/actor$/u, 'ap/notes/') + name,
  at: (name) => (podHome ? podHome.replace(/\/?$/u, '/') + 'ap/notes/' + name
    : actor.replace(/ap\/actor$/u, 'ap/notes/') + name),
});

// The face an account publishes under, and the pod it is actually written on.
// A post in a private category does not live in `ap/notes/`, so the address it
// is written at is worked out from the whole id rather than from its last
// segment: the two differ by the container, not only by the name.
const faceOf = (actor) => actor.replace(/ap\/actor$/u, '');
const homeOf = (actor, podHome) => (podHome ? podHome.replace(/\/?$/u, '/') : faceOf(actor));
export const podUrlOf = (actor, podHome, id) => {
  const face = faceOf(actor);
  return String(id).startsWith(face) ? homeOf(actor, podHome) + String(id).slice(face.length) : String(id);
};

// Where a post goes and who it is addressed to. An open category: the public
// notes container, addressed to the world and to the category. A private one:
// a container of its own on the author's pod, readable by the people the
// category names, addressed to the category's members and to nobody else —
// not to the public, and not to the author's own followers.
//
// Every failure here throws, so a post never lands in the open because the
// private half did not work.
async function placeAndAudience(s, { actor, podHome, category, categoryBase, isPrivate }) {
  if (!isPrivate) return { where: 'ap/notes/', to: [PUBLIC, category] };
  if (!categoryBase) throw new Error('this category was not read from the forum, so nothing was posted');
  const readers = await priv.readersOf(categoryBase, s);
  if (!readers) throw new Error('the forum does not say who may read this category — nothing was posted');
  if (!readers.length) throw new Error('you are not a member of this category');
  const where = priv.placeFor(category);
  await priv.prepare(s, homeOf(actor, podHome) + where, s.webId, readers);
  return { where, to: [categoryBase + 'ap/followers'] };
}

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
export async function post({ actor, podHome, category, categoryBase = null, categoryHandle, isPrivate = false,
  inbox, topic = '', title = '', text, inReplyTo = null, context = null }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const { where, to } = await placeAndAudience(s, { actor, podHome, category, categoryBase, isPrivate });
  const name = `${stamp()}-${slug(title) || slug(topic) || 'post'}-${crypto.randomUUID().slice(0, 8)}`;
  const id = faceOf(actor) + where + name;
  const now = new Date().toISOString();
  const body = htmlOf(text);
  const note = {
    '@context': AS,
    id,
    // A post with a title of its own is an Article (FEP-b2b8); the title is
    // the POST's, and says nothing about what its topic is called.
    type: title ? 'Article' : 'Note',
    attributedTo: actor,
    ...(title ? { name: String(title).slice(0, 200) } : {}),
    // The category is named in audience, in to, and as a Mention tag — the
    // three places a receiving server reads. Not in the words.
    content: body,
    source: sourceOf(text),
    published: now,
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(context ? { context, audience: category } : { audience: category }),
    to,
    cc: [],
    tag: [{ type: 'Mention', href: category, ...(categoryHandle ? { name: categoryHandle } : {}) }],
  };
  // The type it is STORED as decides what a reader may ask for: a pod will
  // not convert one JSON flavour into another, and answers 501 to a server
  // asking for ActivityPub over a document filed as plain JSON-LD.
  const put = await s.fetch(homeOf(actor, podHome) + where + name, { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(note) });
  if (!put.ok) throw new Error(`your pod refused the post (HTTP ${put.status})`);
  const create = {
    '@context': AS,
    id: `${id}#create`,
    type: 'Create',
    actor,
    published: now,
    ...(topic ? { name: String(topic).slice(0, 200) } : {}),
    object: note,
    to,
    cc: [],
  };
  const sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(create) });
  if (!sent.ok) throw new Error(`the forum did not take it (HTTP ${sent.status})`);
  return { id, uri: id };
}

// Joining: a category carries a member's posts, so the first post from a new
// reader is preceded by a Follow the category answers itself.
export async function edit({ actor, podHome, id, title = '', text, category, categoryBase = null, isPrivate = false, inbox }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const now = new Date().toISOString();
  const at = podUrlOf(actor, podHome, id);
  // Read as the author: a post in a private category answers nobody else.
  const was = await s.fetch(id, { headers: { accept: 'application/activity+json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  // A change keeps the audience the post already had. Rewriting it from the
  // category alone would turn a private post public on its way through an
  // edit, which is the kind of quiet widening nothing here may do.
  const to = was?.to || (isPrivate && categoryBase ? [categoryBase + 'ap/followers'] : [PUBLIC, category]);
  const note = {
    ...(was || { '@context': AS, id, type: 'Note', attributedTo: actor, to }),
    type: title ? 'Article' : 'Note',
    content: htmlOf(text),
    source: sourceOf(text),
    updated: now,
  };
  // A title taken away is taken away, not left behind from the old copy.
  if (title) note.name = String(title).slice(0, 200); else delete note.name;
  const put = await s.fetch(at, { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(note) });
  if (!put.ok) throw new Error(`your pod refused the change (HTTP ${put.status})`);
  note.to = to;
  const update = { '@context': AS, id: `${id}#update-${Date.now()}`, type: 'Update', actor, published: now,
    object: note, to, cc: [] };
  const sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(update) });
  if (!sent.ok) throw new Error(`the forum did not take the change (HTTP ${sent.status})`);
  return { id };
}

export async function remove({ actor, podHome, id, category, categoryBase = null, isPrivate = false, inbox }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const now = new Date().toISOString();
  const at = podUrlOf(actor, podHome, id);
  const to = isPrivate && categoryBase ? [categoryBase + 'ap/followers'] : [PUBLIC, category];
  const stone = { '@context': AS, id, type: 'Tombstone', formerType: 'Note', deleted: now };
  const put = await s.fetch(at, { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(stone) });
  if (!put.ok) throw new Error(`your pod refused the deletion (HTTP ${put.status})`);
  const del = { '@context': AS, id: `${id}#delete-${Date.now()}`, type: 'Delete', actor, published: now,
    object: id, to, cc: [] };
  const sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(del) });
  if (!sent.ok) throw new Error(`the forum was not told (HTTP ${sent.status})`);
  return { id };
}

// A message for one person and nobody else. It is written into a container on
// the sender's own pod whose rule names only them, and handed to the
// recipient's inbox, which is where the recipient reads it. The forum is not
// told and holds no copy.
//
// What this is NOT: a message their server can be made to keep private, and
// not something a server which requires signed delivery will accept from a
// page — a browser holds no signing key. A refusal says which host refused.
export async function dm({ actor, podHome, to, inbox, text }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const home = homeOf(actor, podHome);
  const where = 'ap/private/dm/';
  // Three requests to two hosts, and a network failure in any of them arrives
  // as the browser's bare "Failed to fetch", which names neither the host nor
  // what was being done. Each one says both.
  try {
    await priv.prepare(s, home + where, s.webId, []);
  } catch (e) {
    throw new Error(`${e.message} — making a private place for it on ${new URL(home).host}`);
  }
  const name = `${stamp()}-${crypto.randomUUID().slice(0, 8)}`;
  // The message's own address on the pod, not the face the account publishes
  // under. A fronted address is the right id for anything the front can hand
  // over; this one it cannot — the document is readable by its owner alone —
  // so naming it there would name an address that answers nobody.
  const id = home + where + name;
  const now = new Date().toISOString();
  const note = {
    '@context': AS, id, type: 'Note', attributedTo: actor,
    content: htmlOf(text), source: sourceOf(text), published: now,
    to: [to], cc: [], tag: [{ type: 'Mention', href: to }],
  };
  let put;
  try {
    put = await s.fetch(home + where + name, {
      method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(note),
    });
  } catch (e) {
    throw new Error(`${e.message} — writing it to ${new URL(home).host}`);
  }
  if (!put.ok) throw new Error(`your pod refused to keep the message (HTTP ${put.status}) — ${home + where + name}`);
  const create = { '@context': AS, id: `${id}#create`, type: 'Create', actor, published: now, object: note, to: [to], cc: [] };
  let sent;
  try {
    sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(create) });
  } catch (e) {
    throw new Error(`${e.message} — handing it to ${new URL(inbox).host}`);
  }
  if (!sent.ok) throw new Error(`${new URL(inbox).host} did not take the message (HTTP ${sent.status})`);
  return { id };
}

// Reporting a post to the forum's moderators. A Flag names what is being
// reported and, when the reader says why, carries their words with it.
export async function report({ actor, object, category, inbox, why = '' }) {
  const flag = { '@context': AS, id: `${actor}#flag-${Date.now()}`, type: 'Flag', actor,
    object: [].concat(object), audience: category, to: [category],
    ...(why ? { content: String(why).slice(0, 2000) } : {}) };
  const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(flag) });
  if (!r.ok) throw new Error(`the forum did not take the report (HTTP ${r.status})`);
  return true;
}

// A moderator's ask, published at the moderator's own address before it is
// sent: the forum fetches it back there and believes it because only its
// author could have put it there (FEP-fe34). A delivery alone proves nothing.
export async function moderate({ actor, podHome, inbox, activity }) {
  const s = await getSession();
  if (!s) throw new Error('sign in to your pod first');
  const name = `${stamp()}-${String(activity.type).toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
  const place = placeOf(actor, podHome);
  const doc = { '@context': AS, ...activity, id: place.id(name), actor, published: new Date().toISOString() };
  // Two requests to two different servers, and a network failure in either
  // arrives as the browser's bare "Failed to fetch". Said on its own it names
  // neither, so each is named here — the refusals already were.
  let put;
  try {
    put = await s.fetch(place.at(name), { method: 'PUT', headers: { 'content-type': 'application/activity+json' }, body: JSON.stringify(doc) });
  } catch (e) {
    throw new Error(`${e.message} — writing it to ${new URL(place.at(name)).host}`);
  }
  if (!put.ok) throw new Error(`your pod refused to publish the request (HTTP ${put.status})`);
  let sent;
  try {
    sent = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(doc) });
  } catch (e) {
    throw new Error(`${e.message} — handing it to ${new URL(inbox).host}`);
  }
  if (!sent.ok) throw new Error(`the forum did not take the request (HTTP ${sent.status})`);
  return doc.id;
}

// The moderators' queue, read with the moderator's own pod login. It is not
// public and never passes through the Gateway: only a WebID the forum named
// can read it, which is the pod's own rule doing the work.
// A vote: a Like of the post, and its Undo to take it back. One per person;
// the forum counts them and publishes the total with the post.
// A vote, the way Lemmy federates one: a Like up, a Dislike down, and the Undo
// of whichever was cast to take it back. `way` is 'up', 'down' or 'none'.
export async function vote({ actor, post, category, inbox, way, was = null }) {
  const cast = (type) => ({ '@context': AS, id: `${actor}#${type.toLowerCase()}-${Date.now()}`,
    type, actor, object: post, to: [category] });
  const body = way === 'none'
    ? { '@context': AS, id: `${actor}#unvote-${Date.now()}`, type: 'Undo', actor, to: [category],
      object: { type: was === 'down' ? 'Dislike' : 'Like', actor, object: post } }
    : cast(way === 'down' ? 'Dislike' : 'Like');
  const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`the forum did not take the vote (HTTP ${r.status})`);
  return true;
}

export async function modQueue(podHome) {
  const s = await getSession();
  if (!s) throw new Error('sign in with your pod to see the queue');
  const url = podHome.replace(/\/?$/u, '/') + 'mod/queue.json';
  const r = await s.fetch(url, { headers: { accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new Error('this account is not a moderator of this forum');
  if (!r.ok) throw new Error(`the queue could not be read (HTTP ${r.status})`);
  return r.json();
}

export async function join({ actor, category, inbox }) {
  const follow = { '@context': AS, id: `${actor}#follow-${Date.now()}`, type: 'Follow', actor, object: category, to: [category] };
  const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(follow) });
  return r.ok;
}

// Leaving: the category is told, and its own Accept/Reject bookkeeping does
// the rest. A member who leaves is no longer carried.
export async function leave({ actor, category, inbox }) {
  const undo = {
    '@context': AS, id: `${actor}#unfollow-${Date.now()}`, type: 'Undo', actor, to: [category],
    object: { type: 'Follow', actor, object: category },
  };
  const r = await fetch(inbox, { method: 'POST', headers: { 'content-type': 'application/ld+json' }, body: JSON.stringify(undo) });
  return r.ok;
}

const htmlOf = (text) => toHtml(text);
const sourceOf = (text) => ({ content: String(text), mediaType: 'text/markdown' });

function escape_(s) {
  return String(s).replace(/[&<>"]/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
