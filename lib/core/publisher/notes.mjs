// notes.mjs — a note of the actor's own going up: the containers it needs
// (media, and the owner-only one private posts live in), who it mentions,
// publishing it, and editing it afterwards.

import crypto from 'node:crypto';
import * as wire from '../wire.mjs';
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

export async function publishNote(publisher, content, { inReplyTo, attachments, visibility = 'public', spoilerText = null } = {}) {
  const { urls } = publisher;
  const priv = visibility === 'private' || visibility === 'direct';
  if (priv) {
    const ready = await publisher.privateReady();
    if (ready !== true) throw new Error(ready);
  }
  const published = new Date().toISOString();
  const slug = published.slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
  const mentions = await publisher._mentionsFor(content, inReplyTo);
  const note = wire.noteDoc({ urls, slug, content, published, inReplyTo, attachments, mentions,
    visibility, summary: spoilerText, container: priv ? urls.privateNotes : urls.notes });

  await podNotes.write(publisher.remote, note.id, note);
  // Empty, but present: a dangling `replies` that 404s is worse than none.
  await podNotes.writeEmptyReplies(publisher.remote, wire.repliesId(note.id),
    wire.collection(wire.repliesId(note.id), []));
  // The outbox is the PUBLIC index; a private or direct post is not in it.
  if (!priv) await publisher.recordOutbox(note.id);

  publisher.store.addStatus({
    noteId: note.id, actor: urls.actor, content: note.content, published, inReplyTo,
    kind: 'post', slug, text: content, visibility,
    ...(spoilerText ? { spoiler: spoilerText } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(note.tag?.length ? { mentions: note.tag.map(t => ({ href: t.href, name: t.name })) } : {}),
  });

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
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, create);
  publisher.log(`note published: ${note.id} → ${inboxes.length} inbox(es)`);

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
export async function updateNote(publisher, s, { content, spoilerText = null, attachments = null } = {}) {
  const { urls } = publisher;
  const updated = new Date().toISOString();
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
  const note = wire.noteDoc({
    urls, slug, content, published: s.published, inReplyTo: s.inReplyTo,
    attachments: atts, mentions, visibility: s.visibility || 'public',
    summary: spoilerText, updated, container,
  });
  await podNotes.write(publisher.remote, note.id, note);
  await podNotes.writeCreate(publisher.remote, wire.createActivityId(note.id), wire.createActivity(note, urls));
  const patched = publisher.store.updateStatus(s.noteId, {
    content: note.content, text: content, editedAt: updated,
    spoiler: spoilerText || undefined,
    attachments: atts.length ? atts : undefined,
    mentions: note.tag?.length ? note.tag.map(t => ({ href: t.href, name: t.name })) : undefined,
  });
  const update = wire.updateActivity(note, urls);
  const contacts = publisher.store.getContacts();
  const inboxes = [...new Set([
    ...(s.visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
    ...mentions.map(m => m.inbox),
  ].filter(Boolean))];
  await publisher.deliverer.deliverToAll(inboxes, update);
  publisher.log(`note edited: ${note.id} → ${inboxes.length} inbox(es)`);
  return patched;
}
