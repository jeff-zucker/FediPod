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
  const home = base + root;
  return {
    base, home,
    webfinger: base + '.well-known/webfinger',
    actor: home + 'ap/actor',
    inbox: home + 'ap/inbox/',
    outbox: home + 'ap/outbox',
    followers: home + 'ap/followers',
    following: home + 'ap/following',
    notes: home + 'ap/notes/',
    media: home + 'ap/media/',
    fediverse: home + 'fediverse/',
    state: home + 'ap-state/',
  };
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

export function actorDoc({ urls, handle, name, publicKeyPem }) {
  return {
    '@context': [AS_CTX, SEC_CTX],
    id: urls.actor,
    type: 'Person',
    preferredUsername: handle,
    name: name || handle,
    url: urls.base,
    inbox: urls.inbox,
    outbox: urls.outbox,
    followers: urls.followers,
    following: urls.following,
    publicKey: { id: urls.actor + '#main-key', owner: urls.actor, publicKeyPem },
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
    software: { name: 'activitypod-js', version },
    protocols: ['activitypub'],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: 1, activeMonth: 1, activeHalfyear: 1 }, localPosts },
    metadata: {},
  };
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
export function contentHtml(text) {
  return '<p>' + String(text).replace(/[&<>]/g, c => HTML_ESCAPES[c]).replace(/\n+/g, '</p><p>') + '</p>';
}

export function noteDoc({ urls, slug, content, published, inReplyTo, attachments }) {
  const id = urls.notes + slug;
  const note = {
    '@context': AS_CTX,
    id, type: 'Note',
    attributedTo: urls.actor,
    content: contentHtml(content),
    published,
    to: [PUBLIC],
    cc: [urls.followers],
  };
  if (inReplyTo) note.inReplyTo = inReplyTo;
  if (attachments?.length) {
    note.attachment = attachments.map(a => ({
      type: 'Document', mediaType: a.mediaType, url: a.url,
      ...(a.description ? { name: a.description } : {}),
    }));
  }
  return note;
}

export function createActivity(note, urls) {
  return {
    '@context': AS_CTX,
    id: note.id + '#create',
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

export function announceActivity({ urls, noteId, serial }) {
  return {
    '@context': AS_CTX,
    id: urls.actor + '#announce-' + serial,
    type: 'Announce',
    actor: urls.actor,
    to: [PUBLIC], cc: [urls.followers],
    object: noteId,
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
