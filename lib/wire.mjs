// wire.mjs — builders for the opaque AS2/JSON wire documents the remote pod
// serves (see claude/plans/ap-pod-mapping.md, "Remote pod layout"). These are
// protocol documents, not our RDF.

export const AS_CTX = 'https://www.w3.org/ns/activitystreams';
export const SEC_CTX = 'https://w3id.org/security/v1';
export const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

// URLs of the actor's documents on the remote pod. Everything the agent owns
// nests under ONE top-level container (`root`) so the pod stays tidy and one
// pod could host several actors under different roots. Webfinger + host-meta
// stay at the pod root — fediverse discovery requires the host root.
export function apUrls(remotePod, root = 'activitypods-js/') {
  const base = remotePod.endsWith('/') ? remotePod : remotePod + '/';
  const home = base + (!root || root.endsWith('/') ? root : root + '/');
  return {
    base, home,
    webfinger: base + '.well-known/webfinger',
    actor: home + 'ap/actor',
    inbox: home + 'ap/inbox/',
    outbox: home + 'ap/outbox',
    followers: home + 'ap/followers',
    following: home + 'ap/following',
    notes: home + 'ap/notes/',
    privateNotes: home + 'ap/private/',
    featured: home + 'ap/featured',
    profileHtml: home + 'ap/profile.html',
    media: home + 'ap/media/',
    fediverse: home + 'fediverse/',
    state: home + 'ap-state/',
  };
}

// The host a handle would resolve through, or null when no handle can point
// here. @name@host is looked up at https://host/.well-known/webfinger, so only
// a pod that owns the root of its host can answer for one; a pod living at
// https://server/name/ may publish the document but nothing will ever ask.
export function webfingerHost(podUrl) {
  const u = new URL(podUrl);
  return u.pathname === '/' ? u.host : null;
}

// RFC 6415 host-meta: several fediverse implementations discover WebFinger
// through this LRDD template rather than hitting /.well-known/webfinger
// directly.
export function hostMeta(base) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n  <Link rel="lrdd" template="${base}.well-known/webfinger?resource={uri}"/>\n</XRD>\n`;
}

export function jrd({ handle, host, actor }) {
  return {
    subject: `acct:${handle}@${host}`,
    links: [{ rel: 'self', type: 'application/activity+json', href: actor }],
  };
}

// `kind: 'group'` publishes a Group rather than a Person, which is what makes
// Mastodon and Lemmy treat the actor as a community you join.
export function actorDoc({ urls, handle, name, publicKeyPem, movedTo = null, kind = 'person',
  approveJoins = false, summary = null, icon = null, image = null, fields = [],
  webId = null }) {
  // manuallyApprovesFollowers is NOT in the base AS2 context, so it is declared
  // inline exactly as Mastodon declares it — and only when we actually use it.
  // It is what makes a client show "Request to follow" rather than "Follow" and
  // then sit in Requested with no explanation.
  // PropertyValue is the same case: schema.org's, declared the way Mastodon
  // declares it, and only when there are fields to carry. `image` (the banner)
  // and `attachment` are both plain AS2 and need no declaration.
  const context = [AS_CTX, SEC_CTX];
  // `featured` is Mastodon's term for the pinned-posts collection, declared
  // inline exactly as Mastodon declares it.
  context.push({ toot: 'http://joinmastodon.org/ns#', featured: { '@id': 'toot:featured', '@type': '@id' } });
  if (approveJoins) context.push({ manuallyApprovesFollowers: 'as:manuallyApprovesFollowers' });
  // The actor's other identity: the account's WebID. Declared inline exactly
  // as Mastodon declares it.
  if (webId) context.push({ alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' } });
  if (fields.length) {
    context.push({ schema: 'http://schema.org#', PropertyValue: 'schema:PropertyValue', value: 'schema:value' });
  }
  return {
    '@context': context,
    id: urls.actor,
    type: kind === 'group' ? 'Group' : 'Person',
    ...(approveJoins ? { manuallyApprovesFollowers: true } : {}),
    ...(movedTo ? { movedTo } : {}),
    ...(webId ? { alsoKnownAs: [webId] } : {}),
    preferredUsername: handle,
    name: name || handle,
    // The bio, and the avatar. For a group, `summary` is where what the group
    // is for goes — there is nowhere else for it.
    ...(summary ? { summary: contentHtml(summary) } : {}),
    ...(icon ? { icon: { type: 'Image', url: icon } } : {}),
    // The banner behind the avatar, and the labelled rows a client shows under
    // the bio — what Mastodon's profile editor calls Header picture and Extra
    // fields. Both are what every other server publishes for the same thing.
    ...(image ? { image: { type: 'Image', url: image } } : {}),
    // Escaped, not run through contentHtml: a field value is one inline row,
    // and wrapping it in <p> renders as a paragraph inside a table cell.
    ...(fields.length ? {
      attachment: fields.map(f => ({
        type: 'PropertyValue',
        name: String(f.name).replace(/[&<>]/g, c => HTML_ESCAPES[c]),
        value: String(f.value).replace(/[&<>]/g, c => HTML_ESCAPES[c]),
      })),
    } : {}),
    // The human page. Remote servers send profile clicks here, so it must be
    // something a person can read — the pod root is not.
    url: urls.profileHtml,
    inbox: urls.inbox,
    // Every Mastodon actor publishes one. With a single actor per pod ours is
    // just the inbox, but its absence is the non-standard thing.
    endpoints: { sharedInbox: urls.inbox },
    outbox: urls.outbox,
    // The pinned posts, as the collection other servers read when they show
    // this profile. Mastodon's term, declared the way Mastodon declares it.
    featured: urls.featured,
    followers: urls.followers,
    following: urls.following,
    publicKey: { id: urls.actor + '#main-key', owner: urls.actor, publicKeyPem },
  };
}

// The human half of the actor: a page a browser can open, published beside
// the actor document. It says who this is and how to follow — the handle to
// paste, and the remote-follow control that hands the visitor to their own
// server's follow screen.
export function profilePageHtml({ name, address, summary = null, icon = null, kind = 'person' }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ ...HTML_ESCAPES, '"': '&quot;' }[c]));
  const what = kind === 'group' ? 'a group' : 'an account';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} (${esc(address)})</title>
<style>
:root { color-scheme: light dark; }
body { font: 112.5%/1.5 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; }
img.avatar { width: 6rem; height: 6rem; border-radius: 1rem; object-fit: cover; }
h1 { margin: .5rem 0 0; }
.address { font-size: 1.1rem; user-select: all; }
form { margin-top: 2rem; }
label { display: block; margin-bottom: .3rem; }
input { font: inherit; padding: .5rem; width: 14rem; max-width: 100%; }
button { font: inherit; padding: .5rem 1rem; }
.hint { color: #777; font-size: .9rem; }
.err { color: #b00020; }
.err:empty { display: none; }
@media (prefers-color-scheme: dark) {
  .hint { color: #aaa; }
  .err { color: #ff8a80; }
}
</style>
</head>
<body>
<main>
${icon ? `<img class="avatar" src="${esc(icon)}" alt="">` : ''}
<h1>${esc(name)}</h1>
<p class="address">${esc(address)}</p>
${summary ? `<div>${summary}</div>` : ''}
<p>This is ${what} on the fediverse. To follow it, paste the address above
into the search box of Mastodon or any fediverse app — or use the form.</p>
<form id="follow">
  <label for="server">your server</label>
  <input id="server" type="text" placeholder="mastodon.social" autocomplete="off"
    required aria-describedby="follow-err">
  <button type="submit">Follow</button>
  <p class="err" id="follow-err" role="alert"></p>
</form>
<p class="hint">The form sends you to your own server's follow screen.</p>
</main>
<script>
document.getElementById('follow').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const s = document.getElementById('server').value.trim().replace(/^https?:\\/\\//, '').replace(/\\/.*$/, '');
  const err = document.getElementById('follow-err');
  const addr = document.querySelector('.address').textContent.trim();
  if (!s) { err.textContent = 'Enter your server, e.g. mastodon.social'; return; }
  err.textContent = '';
  location.href = 'https://' + s + '/authorize_interaction?uri=' + encodeURIComponent(addr);
});
</script>
</body>
</html>
`;
}

// Retirement. An abandoned pod keeps accepting deliveries into a container
// nobody will ever drain, and no remote server has any way to learn that. A
// Delete of the actor is the signal to drop us; the Tombstone left in its place
// answers anyone who dereferences the actor afterwards.
export function deleteActorActivity(urls, stamp) {
  return {
    '@context': AS_CTX,
    id: `${urls.actor}#delete-${stamp}`,
    type: 'Delete',
    actor: urls.actor,
    object: urls.actor,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
}

// Move is the fediverse's "this account lives elsewhere now": remote servers
// stop delivering here and migrate their followers to the target, while the old
// handle keeps resolving. movedTo on the actor is the durable half of it.
export function moveActivity(urls, target, stamp) {
  return {
    '@context': AS_CTX,
    id: `${urls.actor}#move-${stamp}`,
    type: 'Move',
    actor: urls.actor,
    object: urls.actor,
    target,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
}

export function tombstoneDoc(urls, deletedAt, kind = 'person') {
  return {
    '@context': AS_CTX,
    id: urls.actor,
    type: 'Tombstone',
    formerType: kind === 'group' ? 'Group' : 'Person',
    deleted: deletedAt,
  };
}

// A deleted note is left as a Tombstone at its own URL — kept fetchable — so a
// peer that dereferences it learns the post was DELETED rather than getting a
// bare 404 it cannot tell from "never existed" (§7.4).
export function noteTombstone(noteId, deletedAt) {
  return {
    '@context': AS_CTX,
    id: noteId,
    type: 'Tombstone',
    formerType: 'Note',
    deleted: deletedAt,
  };
}

// A note's replies live in a document of their own, so a server that was never
// delivered a reply can still discover it by dereferencing this.
export function repliesId(noteId) { return noteId + '-replies'; }

export function collection(id, items) {
  return {
    '@context': AS_CTX,
    id, type: 'Collection',
    totalItems: items.length,
    items,
  };
}

export function orderedCollection(id, items) {
  return {
    '@context': AS_CTX,
    id, type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  };
}

// A PAGED outbox, the shape Mastodon serves.
//
// One document holding every activity ever posted has to be rewritten whole on
// every post, so the cost of saying something grows with everything you have
// already said. Pages fix that without dropping anything: a new post rewrites
// the newest page and a head that is four lines long, and every sealed page is
// written once and never touched again.
//
// Pages are numbered from the OLDEST end, and that is the load-bearing part.
// Number them from the newest and every page boundary shifts each time you
// post, which is the problem again with more requests.
export const OUTBOX_PAGE_SIZE = 20;
export const outboxPageId = (outboxId, n) => `${outboxId}-${n}`;

// How many pages `total` activities occupy. Always at least one, so an empty
// outbox still has somewhere to point and a reader always has a `first`.
export const outboxPageCount = (total) => Math.max(1, Math.ceil(total / OUTBOX_PAGE_SIZE));

// `first` is the NEWEST page and `next` walks backwards in time, which is what
// a client following an outbox expects.
// `pageCount` is passed by anyone using outboxPaging, because once a page can
// be SHORT the count is no longer ceil(total/20) — deriving it there would put
// `first` below the newest page and hide everything above it.
export function outboxHead(id, total, pageCount = outboxPageCount(total)) {
  const pages = Math.max(1, pageCount);
  return {
    '@context': AS_CTX,
    id, type: 'OrderedCollection',
    totalItems: total,
    first: outboxPageId(id, pages),
    last: outboxPageId(id, 1),
  };
}

// `items` is this page's slice, newest-first within the page. `next` points at
// the older page; a sealed page never needs rewriting, so it carries no `prev`
// — that would have to be written when the page AFTER it is created.
export function outboxPage(outboxId, n, items) {
  return {
    '@context': AS_CTX,
    id: outboxPageId(outboxId, n),
    type: 'OrderedCollectionPage',
    partOf: outboxId,
    orderedItems: items,
    ...(n > 1 ? { next: outboxPageId(outboxId, n - 1) } : {}),
  };
}

// The slices, oldest page first. `outbox` arrives newest-first (recordOutbox
// unshifts), and paging has to be anchored at the oldest end or appending one
// activity moves every boundary.
//
// Anchoring at the oldest end is right for appends and wrong for REMOVALS,
// which is why nothing calls this to publish any more — see outboxPaging.
export function outboxPages(outbox) {
  const chron = [...outbox].reverse();
  const out = [];
  for (let i = 0; i < Math.max(chron.length, 1); i += OUTBOX_PAGE_SIZE) {
    out.push(chron.slice(i, i + OUTBOX_PAGE_SIZE).reverse());   // newest-first within the page
  }
  return out;
}

export const outboxItemId = (i) => (typeof i === 'string' ? i : i?.id || null);

// Assign entries to pages, and KEEP the assignment.
//
// Deriving the pages from position — which is what outboxPages does — makes an
// append cheap, because only the newest page moves. It makes a REMOVAL cost the
// whole history: every entry after the hole shifts back one, so every page from
// there to the newest gets different contents, a different digest and a PUT.
// Taking one old post down rewrote all of them, and an inbound Delete{actor}
// paid that once per post the actor had.
//
// Holding the assignment instead means a removal touches the single page that
// held it and leaves that page one item short. A short sealed page is legal
// AS2 — the newest page is already partial — and `totalItems` on the head is
// still the true count.
//
// `index` is the assignment we last published, oldest page first, ids only.
// Ids it no longer contains have been removed; ids it does not know are new and
// extend the newest page, spilling into fresh ones. An absent index (a first
// publish, or a machine that lost its state) re-derives the same boundaries
// outboxPages would have given, so upgrading rewrites nothing.
// The stable-paging core, shared by the outbox and the followers collection.
// `order` is the ids to place, in the order new ones should fill pages; `byId`
// maps each id back to its item. Ids the `index` no longer contains are dropped
// (a removal leaves that page one short); ids not in the index are appended to
// the newest page. A middle hole stays a hole — never a re-slice.
export function pageItems({ order, byId, index = [], pageSize }) {
  const next = (Array.isArray(index) ? index : [])
    .map(ids => (Array.isArray(ids) ? ids.filter(id => byId.has(id)) : []));
  const placed = new Set(next.flat());
  for (const id of order) {
    if (id == null || placed.has(id)) continue;
    placed.add(id);
    const last = next[next.length - 1];
    if (!last || last.length >= pageSize) next.push([id]);
    else last.push(id);
  }
  // A trailing empty page would leave `first`/`last` pointing at nothing; a
  // middle hole is the short page this exists to keep.
  while (next.length > 1 && !next[next.length - 1].length) next.pop();
  if (!next.length) next.push([]);
  return { index: next, pages: next.map(ids => ids.map(id => byId.get(id))) };
}

export function outboxPaging(outbox, index = []) {
  const byId = new Map();
  for (const it of outbox) {
    const id = outboxItemId(it);
    if (id && !byId.has(id)) byId.set(id, it);
  }
  // Fill pages oldest-first (outbox.json is newest-first), then reverse each
  // page back to newest-first for display.
  const order = [...outbox].reverse().map(outboxItemId);
  const { index: idx, pages } = pageItems({ order, byId, index, pageSize: OUTBOX_PAGE_SIZE });
  return { index: idx, pages: pages.map(p => [...p].reverse()) };
}

// ── followers, paged the same way ────────────────────────────────────────
// A followers collection is a set of actor IRIs. Each IRI is its own id, so
// there is nothing to dereference to page it, and no within-page order to keep.
export const FOLLOWERS_PAGE_SIZE = 20;
export const followersPageId = (id, n) => `${id}-${n}`;
export const followersPageCount = (total) => Math.max(1, Math.ceil(total / FOLLOWERS_PAGE_SIZE));

export function followersHead(id, total, pageCount = followersPageCount(total)) {
  const pages = Math.max(1, pageCount);
  return {
    '@context': AS_CTX,
    id, type: 'OrderedCollection',
    totalItems: total,
    first: followersPageId(id, 1),
    last: followersPageId(id, pages),
  };
}

export function followersPage(id, n, items, pageCount) {
  return {
    '@context': AS_CTX,
    id: followersPageId(id, n),
    type: 'OrderedCollectionPage',
    partOf: id,
    orderedItems: items,
    ...(n < pageCount ? { next: followersPageId(id, n + 1) } : {}),
  };
}

export function followersPaging(actors, index = []) {
  const list = actors.filter(a => typeof a === 'string');
  const byId = new Map();
  for (const a of list) if (!byId.has(a)) byId.set(a, a);
  return pageItems({ order: list, byId, index, pageSize: FOLLOWERS_PAGE_SIZE });
}

// NodeInfo (the fediverse's server self-description): a root .well-known
// pointer plus the document it points at. Both are static, so the pod can
// serve them exactly like webfinger.
export function nodeinfoPointer(docHref) {
  return {
    links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: docHref }],
  };
}

export function nodeinfoDoc({ version, localPosts = 0 }) {
  return {
    version: '2.0',
    software: { name: 'fedipod', version },
    protocols: ['activitypub'],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts },
    metadata: {},
  };
}

// Federated post bodies are attacker-controlled HTML that clients render —
// and Mastodon clients (Phanpy included) trust the server's content and
// innerHTML it, because Mastodon sanitizes server-side. That makes THIS the
// only line of defence, so it runs on a real HTML parser (sanitize-html →
// htmlparser2) rather than pattern-matching: allowlisted tags and
// attributes, safe URL schemes, and script/style dropped with their text.
import sanitize from 'sanitize-html';

const ALLOWED_TAGS = ['p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'u', 'del',
  'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4'];
const ALLOWED_ATTRS = ['href', 'rel', 'class', 'lang', 'title'];

export function sanitizeHtml(html) {
  if (!html) return '';
  return sanitize(String(html), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { '*': ALLOWED_ATTRS },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'textarea', 'noscript'],   // drop their text too
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'nofollow noopener noreferrer' }),
    },
  });
}

// Normalize a wire Note's attachment list to { url, mediaType, description }.
export function attachmentsOf(note) {
  const list = Array.isArray(note?.attachment) ? note.attachment : note?.attachment ? [note.attachment] : [];
  return list.map(a => ({
    url: typeof a?.url === 'string' ? a.url : a?.url?.href,
    mediaType: a?.mediaType || '',
    ...(a?.name ? { description: a.name } : {}),
  })).filter(a => a.url);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
// user@host in the text, which is what a Mention tag has to agree with.
export const MENTION_RE = /@([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?)/g;

export function mentionsIn(text) {
  return [...new Set(String(text).match(MENTION_RE) || [])].map(m => m.slice(1));
}

// Escape first, then linkify: escaping cannot introduce an @handle, and the
// anchors must survive it. A mention nobody could resolve stays plain text.
export function contentHtml(text, mentions = []) {
  let html = String(text).replace(/[&<>]/g, c => HTML_ESCAPES[c]);
  for (const m of mentions) {
    if (!m?.handle || !m?.actor) continue;
    // The anchor is for PEOPLE — the mentioned actor's advertised page when it
    // has one; a browser landing on a raw actor document reads nothing. The
    // mention TAG keeps the actor id, which is what servers match on.
    const href = String(m.page || m.actor).replace(/[&<>"]/g, c => (HTML_ESCAPES[c] || '&quot;'));
    html = html.split('@' + m.handle).join(
      `<a href="${href}" class="u-url mention">@${m.handle.split('@')[0]}</a>`);
  }
  return '<p>' + html.replace(/\n+/g, '</p><p>') + '</p>';
}

export function noteDoc({ urls, slug, content, published, inReplyTo, attachments, mentions = [],
  visibility = 'public', summary = null, updated = null, container = null }) {
  const id = (container || urls.notes) + slug;
  const who = mentions.map(m => m.actor);
  // Mastodon's four shapes. Public and unlisted are world-readable; private
  // (followers-only) and direct carry no Public address at all and belong in
  // the owner-only container. Mastodon addresses mentions in cc (to, for a
  // direct post) and will not notify anyone it does not find there or in the
  // tags.
  const addressing = {
    public: { to: [PUBLIC], cc: [urls.followers, ...who] },
    unlisted: { to: [urls.followers], cc: [PUBLIC, ...who] },
    private: { to: [urls.followers], cc: who },
    direct: { to: who, cc: [] },
  }[visibility] || { to: [PUBLIC], cc: [urls.followers, ...who] };
  const note = {
    '@context': AS_CTX,
    id, type: 'Note',
    attributedTo: urls.actor,
    content: contentHtml(content, mentions),
    published,
    to: addressing.to,
    cc: addressing.cc,
    replies: repliesId(id),
  };
  if (summary) note.summary = summary;      // the content warning
  if (updated) note.updated = updated;      // an edit's own stamp
  if (mentions.length) {
    note.tag = mentions.map(m => ({ type: 'Mention', href: m.actor, name: '@' + m.handle }));
  }
  if (inReplyTo) note.inReplyTo = inReplyTo;
  if (attachments?.length) {
    note.attachment = attachments.map(a => ({
      type: 'Document', mediaType: a.mediaType, url: a.url,
      ...(a.description ? { name: a.description } : {}),
    }));
  }
  return note;
}

// The id is a document of its own, not `note.id + '#create'`. A group wraps this
// whole activity in its Announce (FEP-1b12), and the receiver resolves it by
// dereferencing this id — a fragment would just serve the Note back under a
// different id, which Mastodon rejects.
export function createActivityId(noteId) { return noteId + '-create'; }

export function createActivity(note, urls) {
  return {
    '@context': AS_CTX,
    id: createActivityId(note.id),
    type: 'Create',
    actor: urls.actor,
    published: note.published,
    to: note.to, cc: note.cc,
    object: note,
  };
}

export function acceptActivity({ urls, followActivity, serial }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#accept-' + serial,
    type: 'Accept',
    actor: urls.actor,
    object: followActivity,
  };
}

// The other half of Accept: what a group sends to end a following it will no
// longer carry. Without it an ejected member's server never learns, and keeps
// receiving everything the group announces.
export function rejectActivity({ urls, followActivity, serial }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#reject-' + serial,
    type: 'Reject',
    actor: urls.actor,
    object: followActivity,
  };
}

export function followActivity({ urls, targetActor, serial }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#follow-' + serial,
    type: 'Follow',
    actor: urls.actor,
    object: targetActor,
  };
}

export function likeActivity({ urls, noteId, serial }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#like-' + serial,
    type: 'Like',
    actor: urls.actor,
    object: noteId,
  };
}

// `object` is a note URL for a personal boost — what Mastodon renders — or the
// whole received activity when a group carries a member's post, which is what
// FEP-1b12 requires and what lets a follower see the author's own activity
// rather than the group's summary of it. Preserved exactly as delivered.
export function announceActivity({ urls, object, serial, published = new Date().toISOString() }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#announce-' + serial,
    type: 'Announce',
    actor: urls.actor,
    published,
    to: [PUBLIC], cc: [urls.followers],
    object,
  };
}

// Tell followers the actor document changed. Nothing obliges a server to fetch
// an actor it already holds — Mastodon shows its cached copy, follower count
// included, until something makes it look again — so a profile edit is
// invisible to everyone until this goes out.
//
// The actor's own @context is hoisted onto the activity and the embedded copy
// loses its: the document declares `schema:` when it carries PropertyValue
// attachments, and an object nested under a plainer context would lose them.
export function updateActorActivity({ urls, actor, serial, published = new Date().toISOString() }) {
  const { '@context': ctx, ...object } = actor;
  return {
    '@context': ctx || AS_CTX,
    id: urls.actor + '#update-' + serial,
    type: 'Update',
    actor: urls.actor,
    published,
    to: [PUBLIC], cc: [urls.followers],
    object,
  };
}

// An edit: same Note id, `updated` stamped, so receivers replace their copy
// and show it as edited. The activity id carries the stamp — each edit is a
// new activity, and a replay of an old one is already seen.
export function updateActivity(note, urls) {
  return {
    '@context': AS_CTX,
    id: note.id + '#update-' + String(note.updated || '').replace(/[^0-9TZ]/g, ''),
    type: 'Update',
    actor: urls.actor,
    to: note.to, cc: note.cc,
    object: note,
  };
}

export function deleteActivity({ urls, noteId }) {
  return {
    '@context': AS_CTX,
    id: noteId + '#delete',
    type: 'Delete',
    actor: urls.actor,
    to: [PUBLIC],
    object: { id: noteId, type: 'Tombstone' },
  };
}

export function undoActivity({ urls, activity, serial }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#undo-' + serial,
    type: 'Undo',
    actor: urls.actor,
    object: activity,
  };
}
