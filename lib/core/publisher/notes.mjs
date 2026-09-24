// notes.mjs — a note of the actor's own going up: the containers it needs
// (media, and the owner-only one private posts live in), who it mentions,
// publishing it, and editing it afterwards.

import crypto from 'node:crypto';
import * as wire from '../wire.mjs';
import * as wireQuotes from '../wire-quotes.mjs';
import * as containers from '../../pod/containers.mjs';
import * as podNotes from '../../pod/notes.mjs';

// Media container on the remote pod — public-Read like notes, created lazily
// at first upload (idempotent; the flag only saves round-trips).
// Ask before writing. `_mediaReady` is per PROCESS, and a service worker is
// restarted whenever the browser feels like it — so on the browser build this
// re-created a container that has existed since sign-up, and rewrote its ACL,
// on every restart. A HEAD is one request and usually the only one.
export async function ensureMediaContainer(publisher) {
  if (publisher._mediaReady) return;
  if (await containers.exists(publisher.remote, publisher.urls.media)) { publisher._mediaReady = true; return; }
  await containers.provisionPublic(publisher.remote, publisher.urls.media);
  publisher._mediaReady = true;
}

// Whether the canary this class writes is already there. Only a definite
// "yes" counts: anything else falls through to the write, which is
// idempotent anyway, so a failed probe costs a request and never correctness.
export function containerExists(publisher, base) { return containers.exists(publisher.remote, base); }

// The owner-only container that followers-only and direct posts live in.
// Its ACL is set once; every note under it inherits.
export async function ensurePrivateContainer(publisher) {
  if (publisher._privateContainer) return;
  // Same reasoning as ensureMediaContainer: probe before provisioning, so a
  // worker restart is not a re-provision. The ACL is NOT skipped on the
  // strength of the container existing alone — ensurePrivateAcls re-checks
  // that separately on every connect, which is the control that matters here.
  if (await containers.exists(publisher.remote, publisher.urls.privateNotes)) { publisher._privateContainer = true; return; }
  await containers.provisionOwnerOnly(publisher.remote, publisher.urls.privateNotes);
  publisher._privateContainer = true;
}

// Whether the pod actually enforces that ACL: a bare, unauthenticated read
// of the private container's canary must be refused. Returns true, or the
// reason private posts stay off. A definite answer is cached for the run; a
// network failure is not, so a pod that was briefly unreachable is asked
// again rather than refused forever.
export async function privateReady(publisher) {
  if (publisher._privateVerdict !== undefined) return publisher._privateVerdict;
  try {
    await publisher.ensurePrivateContainer();
    // The probe is credential-free and bypasses RemotePod's url map, so a
    // fronted identity must map the advertised private container back to the
    // pod itself — the ACL we are testing is the pod's.
    const pn = publisher.urls.toPod ? publisher.urls.toPod(publisher.urls.privateNotes) : publisher.urls.privateNotes;
    const verdict = await containers.probePrivateEnforcement(publisher.probeFetch || fetch, pn + '.keep');
    publisher._privateVerdict = verdict === true ? true : `${verdict} — private posts stay off it`;
    return publisher._privateVerdict;
  } catch (e) {
    return `could not verify that the pod protects private posts (${e.message})`;
  }
}

// Compose → wire note on remote pod + RDF truth locally + deliver Create.
// Who this text mentions, resolved. A mention nobody can resolve stays plain
// text rather than failing the post. The text itself decides: trim a handle
// out and that person is not notified, which is what every fediverse client
// leads people to expect. A Group named in the parent is the one thing
// carried forward regardless — drop it and the group stops carrying the
// thread.
export async function mentionsFor(publisher, content, inReplyTo) {
  const inText = new Set(wire.mentionsIn(content));
  const carried = inReplyTo
    ? (publisher.store.getStatuses().find(s => s.noteId === inReplyTo)?.mentions || [])
      .map(m => String(m.name || '').replace(/^@/, '')).filter(Boolean)
    : [];
  const mentions = [];
  for (const handle of [...new Set([...inText, ...carried])]) {
    if (!publisher.resolveMention) break;
    const doc = await publisher.resolveMention(handle).catch(() => null);
    if (!doc?.id) { publisher.log(`mention @${handle} did not resolve — left as text`); continue; }
    if (!inText.has(handle) && doc.type !== 'Group') continue;   // author trimmed them out
    mentions.push({ handle, actor: doc.id, page: doc.url || null, inbox: doc.endpoints?.sharedInbox || doc.inbox });
  }
  return mentions;
}

// Who a reply is answering. Their server gets the post whether or not the
// text names them — that is how the thread stays whole where they are — but
// no Mention tag is added, so a handle the author trimmed out still means no
// notification. Nothing for a direct post: it goes to whom it names. The
// parent is read from the timeline row; a parent the agent never held (a
// client-to-server reply to any address) is fetched to find its author.
export async function replyTarget(publisher, inReplyTo, mentions = [], visibility = 'public') {
  if (!inReplyTo || visibility === 'direct' || !publisher.resolveActor) return null;
  const parent = publisher.store.getStatuses().find(s => s.noteId === inReplyTo);
  let actor = parent?.actor || null;
  if (!parent) {
    const doc = await publisher.resolveActor(inReplyTo).catch(() => null);
    const by = doc?.attributedTo;
    actor = typeof by === 'string' ? by : (Array.isArray(by) ? by[0] : by)?.id || null;
    if (typeof actor === 'object') actor = actor?.id || null;
  }
  if (!actor || actor === publisher.urls.actor) return null;
  if (mentions.some(m => m.actor === actor)) return null;
  if (publisher.store.isBlocked?.(actor)) return null;
  const doc = await publisher.resolveActor(actor).catch(() => null);
  const inbox = doc?.endpoints?.sharedInbox || doc?.inbox || null;
  if (!inbox) publisher.log(`reply: no inbox found for ${actor} — they get it only through followers`);
  return { actor, inbox };
}

// Inboxes for actors a client addressed by id — the people in a post's
// to/cc and the ones in bto/bcc, who are delivered to and never listed.
export async function inboxesFor(publisher, actorIds = []) {
  const out = [];
  for (const id of [...new Set(actorIds.filter(a => typeof a === 'string' && a && a !== publisher.urls.actor))]) {
    if (!publisher.resolveActor) break;
    const doc = await publisher.resolveActor(id).catch(() => null);
    const inbox = doc?.endpoints?.sharedInbox || doc?.inbox;
    if (inbox) out.push(inbox);
    else publisher.log(`addressed actor ${id} has no inbox the agent can find — not delivered to`);
  }
  return out;
}

// A direct post goes only to the people it names, so one that names nobody
// the agent can find would be kept in the private container and delivered
// to no one, with nothing said. Refused instead, before anything is written,
// with the handles that did not resolve — that is what the sender can act on.
export function assertDirectAddressed(content, mentions) {
  const wanted = [...new Set(wire.mentionsIn(content))];
  const missing = wanted.filter((h) => !mentions.some((m) => m.handle === h));
  let why = null;
  if (!wanted.length) why = 'a direct message names who it is for — mention them as @name@host';
  else if (missing.length) why = `could not find ${missing.map((h) => '@' + h).join(', ')} — the direct message was not sent`;
  if (!why) return;
  const e = new Error(why);
  e.code = 'unaddressed';
  throw e;
}

// A client may name the document it is creating (the Slug of a client-to-server
// POST). Only a plain name is taken, and only when nothing is there already;
// otherwise the agent mints one as it always has.
const SLUG_OK = /^[A-Za-z0-9._-]{1,64}$/u;
export const safeSlug = (s) => (typeof s === 'string' && SLUG_OK.test(s) && !/^\.+$/u.test(s) ? s : null);
export async function slugFor(publisher, container, wanted, published) {
  const name = safeSlug(wanted);
  if (name && !(await podNotes.read(publisher.remote, container + name).catch(() => null))) return name;
  return published.slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
}

// A message from this account to itself, for something its owner must hear
// and has no other way to: a post an app sent through the outbox door that the
// account then refused, after the door had already told the app "created".
// Addressed to the owner alone and kept in the private container, so it shows
// in the owner's apps as a direct message and a mention, and nowhere else.
export async function noteToSelf(publisher, text) {
  const { urls } = publisher;
  const published = new Date().toISOString();
  const slug = published.slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
  const id = urls.privateNotes + slug;
  const content = wire.contentHtml(text);
  await podNotes.write(publisher.remote, id, { '@context': wire.AS_CTX, id, type: 'Note',
    attributedTo: urls.actor, to: [urls.actor], published, content })
    .catch(e => publisher.log(`note to self kept here only — the pod would not take it: ${e.message}`));
  publisher.store.addStatus({ noteId: id, actor: urls.actor, content, text, published,
    kind: 'post', visibility: 'direct', slug });
  publisher.store.addNotification({ type: 'mention', actor: urls.actor, noteId: id });
  return id;
}

// What the author's own timeline shows for an object: its content, else its
// text under one of the names other vocabularies use, else a link to it.
export function rowContent(obj) {
  if (typeof obj?.content === 'string' && obj.content.trim()) return wire.sanitizeHtml(obj.content);
  const plain = [obj?.bodyValue, obj?.name, obj?.summary].find((v) => typeof v === 'string' && v.trim());
  if (plain) return wire.contentHtml(plain);
  const esc = (v) => String(v).replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<p><a href="${esc(obj?.id || '')}">${esc(obj?.type || 'object')}</a></p>`;
}

// `quote`: the post this one quotes, `{ id, actor }` — the quoted author is
// asked to allow it (FEP-044f). A quote of one of this actor's own posts is
// allowed on the spot.
export async function publishNote(publisher, content, { inReplyTo, attachments, visibility = 'public', spoilerText = null, sensitive = false, slug: wanted = null, also = [], deliverTo = [], quote = null } = {}) {
  const { urls } = publisher;
  const priv = visibility === 'private' || visibility === 'direct';
  if (priv) {
    const ready = await publisher.privateReady();
    if (ready !== true) throw new Error(ready);
  }
  const published = new Date().toISOString();
  const slug = await slugFor(publisher, priv ? urls.privateNotes : urls.notes, wanted, published);
  const mentions = await publisher._mentionsFor(content, inReplyTo);
  if (visibility === 'direct') assertDirectAddressed(content, mentions);
  const reply = await replyTarget(publisher, inReplyTo, mentions, visibility);
  const selfQuote = quote?.id && quote.actor === urls.actor;
  const quoted = quote?.id ? {
    id: quote.id,
    // Our own post: the authorization is minted here, before the note goes out.
    authorization: selfQuote ? await grantQuote(publisher, quote.id, (priv ? urls.privateNotes : urls.notes) + slug) : null,
  } : null;
  const note = wire.noteDoc({ urls, slug, content, published, inReplyTo, attachments, mentions,
    visibility, summary: spoilerText, sensitive, container: priv ? urls.privateNotes : urls.notes,
    also: [...also, ...(reply ? [reply.actor] : []), ...(quote?.actor && !selfQuote ? [quote.actor] : [])], quote: quoted });
  const addressedInboxes = await inboxesFor(publisher, [...also, ...deliverTo, ...(quote?.actor && !selfQuote ? [quote.actor] : [])]);

  await podNotes.write(publisher.remote, note.id, note);
  // Empty, but present: a dangling `replies` that 404s is worse than none.
  await podNotes.writeEmptyReplies(publisher.remote, wire.repliesId(note.id),
    wire.collection(wire.repliesId(note.id), []));
  // The outbox is the PUBLIC index; a private or direct post is not in it.
  if (!priv) await publisher.recordOutbox(note.id);

  const request = quote?.id && !selfQuote
    ? wireQuotes.quoteRequestActivity({ urls, note, quoted: quote.id, quotedActor: quote.actor, serial: Date.now() })
    : null;
  publisher.store.addStatus({
    noteId: note.id, actor: urls.actor, content: note.content, published, inReplyTo,
    kind: 'post', slug, text: content, visibility,
    ...(spoilerText ? { spoiler: spoilerText } : {}),
    ...(note.sensitive ? { sensitive: true } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...rowTags(note),
    ...(quote?.id ? {
      quote: quote.id,
      quoteState: selfQuote ? 'accepted' : 'pending',
      ...(quoted.authorization ? { quoteAuthorization: quoted.authorization } : {}),
      ...(request ? { quoteRequest: { id: request.id, actor: quote.actor } } : {}),
    } : {}),
  });
  // The row is what the author's own timeline reads. Land it before answering
  // — the same PUT the debounce would send in 300 ms — so a worker killed or a
  // write refused after the answer cannot leave a post that stands on the pod
  // and reached followers but never shows to its author.
  if (await publisher.store.commit?.() === false) publisher.log(`post published but its timeline row was refused: ${note.id}`);

  const create = wire.createActivity(note, urls);
  // Published as its own document: a group that carries this post wraps the
  // whole activity, and the receiving server resolves it by fetching this id.
  // It inherits the notes container's public-Read acl:default.
  await podNotes.writeCreate(publisher.remote, create.id, create);
  const contacts = publisher.store.getContacts();
  // A direct post goes to the people it names and to nobody else.
  const inboxes = [...new Set([
    ...(visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
    ...mentions.map(m => m.inbox),
    reply?.inbox,
    ...addressedInboxes,
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, create);
  publisher.log(`note published: ${note.id} → ${inboxes.length} inbox(es)`);
  // The quoted author is asked after the note is out: their Accept names the
  // note, so it has to exist where they will look for it.
  if (request) {
    const [inbox] = await inboxesFor(publisher, [quote.actor]);
    if (inbox) await publisher.deliverer.deliver(inbox, request);
    else publisher.log(`quote of ${quote.id}: no inbox found for ${quote.actor} — the quote stays pending`);
  }

  // Bluesky mirror: PUBLIC posts only — unlisted, followers-only and direct
  // are never carried off the fediverse. A mirror failure never fails the
  // post; it is logged and recorded on the status for the admin page.
  if (visibility === 'public' && publisher.atproto?.connected()
    && publisher.store.getConfig()?.atproto?.crossPost) {
    try {
      const mirror = await publisher.atproto.crossPost(
        { text: content, published, attachments }, { noteUrl: note.id });
      publisher.store.updateStatus(note.id, { atproto: mirror });
      publisher.log(`cross-posted to bluesky: ${mirror.uri}${mirror.truncated ? ' (truncated, links back)' : ''}`);
    } catch (e) {
      publisher.store.updateStatus(note.id, { atproto: { error: e.message } });
      publisher.log(`bluesky cross-post failed: ${e.message}`);
    }
  }
  return note;
}

// An edit keeps the note's id, slug and published time; `updated` is the
// edit's own stamp. The pod documents are overwritten in place — the Create
// too, so a group's Announce resolves to the edited text — and an Update
// goes everywhere the Create went.
// Any object as a post: what a client-to-server Create carries when it is not
// a Note or a Question — a Web Annotation, say. Stored as sent, with its own
// context, under this actor; the Create around it is what followers receive.
// Servers that know the type show it; the rest ignore it, which is the
// expected outcome.
//
// An object already living on this pod (an id under it) is not copied: the
// Create names it where it is. Anything else is written into the notes
// container under the client's slug when it is free, else a minted one.
export async function publishObject(publisher, object, { visibility = 'public', slug: wanted = null, also = [], deliverTo = [] } = {}) {
  const { urls } = publisher;
  const priv = visibility === 'private' || visibility === 'direct';
  if (priv) {
    const ready = await publisher.privateReady();
    if (ready !== true) throw new Error(ready);
  }
  const published = new Date().toISOString();
  const container = priv ? urls.privateNotes : urls.notes;
  const pod = publisher.config?.remotePod || urls.base;
  const ownId = typeof object.id === 'string' && /^https?:\/\//u.test(object.id) && object.id.startsWith(pod)
    ? object.id : null;
  const name = await slugFor(publisher, container, wanted, published);
  const addressed = wire.addressing(urls, visibility, visibility === 'direct' ? also : []);
  if (visibility !== 'direct') addressed.cc = [...new Set([...addressed.cc, ...also])];
  let doc = null;
  const id = ownId || container + name;
  if (!ownId) {
    // bto and bcc are for delivery alone: they never appear in what is
    // stored, served or sent (ActivityPub §6).
    const { bto, bcc, ...sent } = object;   // eslint-disable-line no-unused-vars
    doc = { ...sent, id, attributedTo: urls.actor, published: object.published || published, to: addressed.to, cc: addressed.cc };
    if (!doc['@context']) doc['@context'] = wire.AS_CTX;
    if (typeof doc.content === 'string') doc.content = wire.sanitizeHtml(doc.content);
    await podNotes.write(publisher.remote, id, doc);
  }
  if (!priv) await publisher.recordOutbox(id);
  const row = doc || object;
  publisher.store.addStatus({
    noteId: id, actor: urls.actor, content: rowContent(row), published: row.published || published,
    kind: 'post', slug: name, visibility,
  });
  if (await publisher.store.commit?.() === false) publisher.log(`object published but its timeline row was refused: ${id}`);

  // The Create sits beside the object; for an object living elsewhere on the
  // pod it sits in the notes container, whose ACL is public Read.
  const createId = doc ? wire.createActivityId(id) : wire.createActivityId(container + name);
  const create = {
    '@context': wire.AS_CTX, id: createId, type: 'Create', actor: urls.actor,
    published: row.published || published, to: addressed.to, cc: addressed.cc,
    object: doc || id,
  };
  await podNotes.writeCreate(publisher.remote, create.id, create);
  const contacts = publisher.store.getContacts();
  const inboxes = [...new Set([
    ...(visibility === 'direct' ? [] : contacts.followers.map((f) => f.sharedInbox || f.inbox)),
    ...(await inboxesFor(publisher, [...also, ...deliverTo])),
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, create);
  publisher.log(`${row.type || 'object'} published: ${id} → ${inboxes.length} inbox(es)`);
  return { id, createId, copied: !ownId };
}

// What the author's timeline row keeps of a note's tags: the people it
// mentions and the hashtags it carries, each as the client-facing shape.
export function rowTags(note) {
  const tags = [].concat(note.tag || []);
  const mentions = tags.filter(t => t.type === 'Mention').map(t => ({ href: t.href, name: t.name }));
  const hashtags = tags.filter(t => t.type === 'Hashtag').map(t => ({ name: String(t.name).replace(/^#/, ''), url: t.href }));
  return { ...(mentions.length ? { mentions } : {}), ...(hashtags.length ? { tags: hashtags } : {}) };
}

export async function updateNote(publisher, s, { content, spoilerText = null, sensitive = null, attachments = null, updated = new Date().toISOString() } = {}) {
  const { urls } = publisher;
  const inText = new Set(wire.mentionsIn(content));
  const mentions = [];
  for (const handle of inText) {
    if (!publisher.resolveMention) break;
    const doc = await publisher.resolveMention(handle).catch(() => null);
    if (!doc?.id) { publisher.log(`mention @${handle} did not resolve — left as text`); continue; }
    mentions.push({ handle, actor: doc.id, page: doc.url || null, inbox: doc.endpoints?.sharedInbox || doc.inbox });
  }
  const atts = attachments ?? s.attachments ?? [];
  // The note stays in the container its visibility put it in; a recovered
  // post may carry no slug, but the note id already contains it.
  const container = String(s.noteId).startsWith(urls.privateNotes) ? urls.privateNotes : urls.notes;
  const slug = s.slug || String(s.noteId).slice(container.length);
  const reply = await replyTarget(publisher, s.inReplyTo, mentions, s.visibility || 'public');
  const note = wire.noteDoc({
    urls, slug, content, published: s.published, inReplyTo: s.inReplyTo,
    attachments: atts, mentions, visibility: s.visibility || 'public',
    summary: spoilerText, sensitive: sensitive ?? !!s.sensitive, updated, container,
    also: reply ? [reply.actor] : [],
    quote: rowQuote(s),
  });
  await podNotes.write(publisher.remote, note.id, note);
  await podNotes.writeCreate(publisher.remote, wire.createActivityId(note.id), wire.createActivity(note, urls));
  const patched = publisher.store.updateStatus(s.noteId, {
    content: note.content, text: content, editedAt: updated,
    spoiler: spoilerText || undefined,
    sensitive: note.sensitive || undefined,
    attachments: atts.length ? atts : undefined,
    mentions: rowTags(note).mentions,
    tags: rowTags(note).tags,
  });
  const update = wire.updateActivity(note, urls);
  const contacts = publisher.store.getContacts();
  const inboxes = [...new Set([
    ...(s.visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
    ...mentions.map(m => m.inbox),
    reply?.inbox,
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, update);
  // The edit goes on the record beside the Create, for a post the outbox lists:
  // a reader catching up from the outbox otherwise keeps the words it first saw.
  if (publisher.store.read('outbox.json', []).includes(s.noteId)) await publisher.recordOutbox(update);
  publisher.log(`note edited: ${note.id} → ${inboxes.length} inbox(es)`);
  return patched;
}

// What a note's document says about its quote, read off the timeline row: the
// quoted post and, once granted, the authorization. A quote the author
// refused is no longer said.
export function rowQuote(s) {
  if (!s?.quote || s.quoteState === 'rejected') return null;
  return { id: s.quote, ...(s.quoteAuthorization ? { authorization: s.quoteAuthorization } : {}) };
}

// The note's document again, unchanged in what it says, changed in what it
// says about its quote. Not an edit — no `updated` stamp — so nobody shows it
// as edited; the Update goes where the Create went, plus to the quoted author.
async function restateNote(publisher, s, { quote }) {
  const { urls } = publisher;
  const content = s.text ?? '';
  const mentions = await publisher._mentionsFor(content, s.inReplyTo);
  const container = String(s.noteId).startsWith(urls.privateNotes) ? urls.privateNotes : urls.notes;
  const slug = s.slug || String(s.noteId).slice(container.length);
  const reply = await replyTarget(publisher, s.inReplyTo, mentions, s.visibility || 'public');
  const note = wire.noteDoc({
    urls, slug, content, published: s.published, inReplyTo: s.inReplyTo,
    attachments: s.attachments || [], mentions, visibility: s.visibility || 'public',
    summary: s.spoiler || null, sensitive: !!s.sensitive, updated: s.editedAt || null, container,
    also: [...(reply ? [reply.actor] : []), ...(s.quoteRequest?.actor ? [s.quoteRequest.actor] : [])],
    quote,
  });
  await podNotes.write(publisher.remote, note.id, note);
  await podNotes.writeCreate(publisher.remote, wire.createActivityId(note.id), wire.createActivity(note, urls));
  const update = wire.updateActivity(note, urls, { serial: Date.now() });
  const contacts = publisher.store.getContacts();
  const inboxes = [...new Set([
    ...(s.visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
    ...mentions.map(m => m.inbox),
    reply?.inbox,
    ...(await inboxesFor(publisher, s.quoteRequest?.actor ? [s.quoteRequest.actor] : [])),
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, update);
  return inboxes.length;
}

// The quoted author said yes: their authorization goes onto the note, and
// everyone who has the note is told.
export async function authorizeQuote(publisher, s, authorizationId) {
  const patched = publisher.store.updateStatus(s.noteId, { quoteState: 'accepted', quoteAuthorization: authorizationId });
  const n = await restateNote(publisher, patched || s, { quote: { id: s.quote, authorization: authorizationId } });
  publisher.log(`quote allowed by ${s.quoteRequest?.actor || 'the author'}: ${s.noteId} → ${n} inbox(es)`);
  return patched;
}

// The quoted author said no: the note stops naming their post.
export async function withdrawQuote(publisher, s) {
  const patched = publisher.store.updateStatus(s.noteId, { quoteState: 'rejected', quoteAuthorization: undefined });
  const n = await restateNote(publisher, patched || s, { quote: null });
  publisher.log(`quote refused by ${s.quoteRequest?.actor || 'the author'}: ${s.noteId} → ${n} inbox(es)`);
  return patched;
}

// Somebody may quote one of this actor's posts: the authorization is written
// beside the post — public-Read, like the post — and remembered on its row,
// so a receiver that checks the quote finds it and a re-asked question gets
// the same answer. Returns the authorization's id.
const MAX_QUOTED_BY = 200;
export async function grantQuote(publisher, noteId, instrumentId) {
  const { urls } = publisher;
  const id = wireQuotes.quoteAuthorizationId(noteId, instrumentId);
  await podNotes.write(publisher.remote, id, wireQuotes.quoteAuthorizationDoc({ urls, id, instrument: instrumentId, target: noteId }));
  const s = publisher.store.getStatuses().find(x => x.noteId === noteId);
  if (s) {
    const quotedBy = (s.quotedBy || []).filter(q => q.note !== instrumentId);
    quotedBy.unshift({ note: instrumentId, authorization: id });
    publisher.store.updateStatus(noteId, { quotedBy: quotedBy.slice(0, MAX_QUOTED_BY) });
  }
  return id;
}
