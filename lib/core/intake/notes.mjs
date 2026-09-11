// notes.mjs — a note on its way in: whether it concerns us, fetching it at
// its origin, filing it, the replies collection on our own posts, and the
// two ways a held post leaves again (forget, retract). Also the §7.1.2
// forward of a reply into one of our threads to our followers.

import * as podNotes from '../../pod/notes.mjs';
import { PUBLIC } from '../wire.mjs';
import * as polls from '../polls.mjs';
import { httpOnly, emojisOf, pollOf, isContentType, authorOf, MAX_MENTIONS, MAX_URL_CHARS, MAX_REPLIES_RECORDED, MAX_FORWARDED, FORWARDABLE, FORWARD_TYPES } from './activity.mjs';

// Does this activity/note concern us at all? Either it comes from someone
// we follow, or it names us (to/cc, mention tag) or replies to one of our
// notes. Anything else is a stranger blasting inboxes — refuse it before
// spending a dereference on it.
export function concernsUs(intake, doc, actor) {
  if (intake.store.getContacts().following.some(f => f.actor === actor && f.accepted)) return true;
  const audience = []
    .concat(doc?.to || [], doc?.cc || [], doc?.bto || [], doc?.bcc || [], doc?.audience || [])
    .map(v => (typeof v === 'string' ? v : v?.id)).filter(Boolean);
  if (audience.includes(intake.urls.actor) || audience.includes(intake.urls.followers)) return true;
  const tagged = [].concat(doc?.tag || [])
    .some(t => t?.type === 'Mention' && (t.href === intake.urls.actor || t.name?.includes(intake.urls.actor)));
  if (tagged) return true;
  const inReplyTo = typeof doc?.inReplyTo === 'string' ? doc.inReplyTo : doc?.inReplyTo?.id;
  if (!inReplyTo) return false;
  if (String(inReplyTo).startsWith(intake.urls.notes)) return true;
  // A group also owns the conversation under anything it carried. Without
  // this, a reply that lost the group's mention on its way round the
  // fediverse is refused, and the thread breaks for everyone who was only
  // ever following the group.
  return intake.config.kind === 'group'
    && intake.store.getStatuses().some(s => s.noteId === String(inReplyTo));
}

// §7.1.2 Forwarding from the inbox. A reply into one of our threads reaches
// only the servers the replier's server chose to deliver to — never our
// followers on servers it has never heard of. As the actor those followers
// follow, WE close that gap: an activity addressed to our followers collection
// that names one of our objects is re-delivered to our followers' inboxes.
//
// Only what was addressed to the followers COLLECTION is carried — bto/bcc are
// never read here, so a direct message (addressed to a person) never qualifies
// and is never rebroadcast. And this runs only after handle() accepted the
// activity, so anything blocked or muted was already refused upstream and is
// never forwarded.
export async function maybeForward(intake, activity) {
  if (!activity || typeof activity !== 'object') return;
  if (!FORWARDABLE.has(activity.type)) return;              // see FORWARDABLE
  // Forwarding signs somebody else's activity with OUR key and pushes it to
  // every follower we have. That is a lot to do on the word of an unsigned
  // POST, so it is narrowed three ways:
  //
  //   1. Only the types whose object this drain actually DEREFERENCED at the
  //      author's own origin. A Create/Update/Delete went through onCreate /
  //      onUpdate / onDelete, which fetch and check the author; a Like, an
  //      Announce or an Undo is believed on the envelope alone, so relaying
  //      one made us a signed relay for anything a stranger cared to write.
  //   2. The actor has to be someone we already know of. A complete stranger
  //      addressing our followers collection is not a conversation we are
  //      party to.
  //   3. A budget per drain, so a flood cannot turn one sweep into thousands
  //      of outbound deliveries under our signature.
  if (!FORWARD_TYPES.has(activity.type)) return;
  try {
    const audience = []
      .concat(activity.to || [], activity.cc || [], activity.audience || [])
      .map(v => (typeof v === 'string' ? v : v?.id)).filter(Boolean);
    if (!audience.includes(intake.urls.followers)) return;      // not for our followers
    if (!intake._referencesOurObject(activity)) return;         // not into a thread of ours
    const actor = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (actor === intake.urls.actor) return;                    // our own; nothing to forward
    if (!intake.known(actor)) {
      intake.log(`not forwarding ${activity.type} from ${actor}: nobody we know of`);
      return;
    }
    if (intake._forwardBudget <= 0) {
      intake.log(`not forwarding ${activity.type}: this drain's forwarding budget is spent`);
      return;
    }
    const id = typeof activity.id === 'string' ? activity.id : null;
    if (!id) return;
    const forwarded = intake.store.read('forwarded.json', []);
    if (forwarded.includes(id)) return;                       // already done

    const inboxes = [...new Set(intake.store.getContacts().followers
      .filter(f => !f.bsky)                                   // Bluesky members are not AP inboxes
      .map(f => f.sharedInbox || f.inbox)
      .filter(Boolean))];
    if (!inboxes.length) return;
    intake._forwardBudget -= 1;
    await intake.deliverer.deliverToAll(inboxes, activity);
    intake.store.write('forwarded.json', [...forwarded, id].slice(-MAX_FORWARDED));
    intake.log(`forwarded ${activity.type} ${id} to ${inboxes.length} follower inbox(es)`);
  } catch (e) {
    intake.log(`inbox forwarding: ${e.message}`);               // never stalls the drain
  }
}

// The "objects owned by the server" half of §7.1.2: does the activity reply
// to, like, boost or otherwise name one of our own objects?
export function referencesOurObject(intake, activity) {
  const refs = [];
  const add = (v) => { const id = typeof v === 'string' ? v : v?.id; if (id) refs.push(String(id)); };
  const obj = activity.object;
  if (obj && typeof obj === 'object') add(obj.inReplyTo);     // a reply's parent
  add(activity.inReplyTo);
  add(activity.object);                                       // a Like/Announce of our note
  add(activity.target);
  if (refs.some(r => r.startsWith(intake.urls.notes))) return true;
  return intake.config.kind === 'group'
    && refs.some(r => intake.store.getStatuses().some(s => s.noteId === r));
}

// Shared tail of Create/Announce: deref the note at its origin (never trust
// the delivered copy), mirror it into pod RDF + statuses, notify on replies
// to our own notes. Returns a rejection reason string, or undefined.
export async function ingestNote(intake, objectId, actor, { via } = {}) {
  const note = await intake.fetchAP(objectId);
  if (!note) return `object fetch failed (${objectId})`;
  if (note.id !== objectId || !isContentType(note.type)) return `object not verifiable content (${objectId}, ${note.type})`;
  const { attachmentsOf, titledContent } = await import('../wire.mjs');
  const attachments = attachmentsOf(note);
  const content = titledContent(note);          // hostile markup never reaches pod or client
  // The delivering actor was checked on arrival; the author is only known once
  // the note is dereferenced. authorOf refuses an author the note's own origin
  // does not vouch for — see its comment; this is where a forged attribution
  // would otherwise become a timeline entry, a pod document, and for a group a
  // signed Announce to every member.
  const author = authorOf(note, actor);
  if (!author) return `object names an author its origin does not vouch for (${objectId})`;
  // This is the check that catches a blocked actor reaching us through
  // somebody else's boost, or through a hashtag feed.
  if (intake.store.isBlocked(author)) return `blocked author (${author})`;

  // The ENVELOPE said this concerns us. The envelope is a document a stranger
  // wrote: onCreate reads addressing off the delivered copy to decide whether
  // fetching is worth it, and nothing re-asked the question of the copy that
  // came back from the author's own server. So anyone could take any public
  // post, address the delivery to us, and have it filed as "X mentioned you"
  // — or, to a group, have a member's post carried to every follower when the
  // member never sent it there.
  //
  // A boost is exempt (`via`): someone we follow deliberately putting a post
  // in front of us is the whole point, and the note will not address us.
  if (!via && !intake.concernsUs(note, author)) {
    return `the note its own server serves does not address us (${objectId})`;
  }

  // An answer to one of our polls is a number on a document, not a post. It
  // arrives as an ordinary reply naming an option and carrying nothing else,
  // so filing it as one would put a blank entry in the thread and ring the
  // owner once per voter. Counted or refused — a second answer, an option we
  // do not offer, a poll already shut — it stops here either way.
  const asked = note.inReplyTo && intake.store.getStatuses()
    .find(x => x.noteId === String(note.inReplyTo) && x.kind === 'post' && x.poll);
  if (asked && polls.isVoteShape(note)) {
    const counted = await intake.publisher.recordVote(asked.noteId, author, note.name)
      .catch(e => { intake.log(`vote on ${asked.noteId}: ${e.message}`); return false; });
    intake.log(counted
      ? `vote counted (${note.name}): ${asked.noteId}`
      : `vote not counted (${note.name}) from ${author}: ${asked.noteId}`);
    return;
  }

  // Anyone can Append to a public inbox, so arriving is not the same as
  // belonging in the home timeline. Follow Mastodon's split: people you
  // follow (and their boosts) are HOME; anyone else is a MENTION — kept,
  // notified, readable in the Mentions view, but out of the timeline, and
  // mirror-only so unsolicited content never accumulates in the pod.
  // A group's people are its FOLLOWERS — it follows nobody. Reading the
  // following list for one filed every member's post as a stranger's mention,
  // so nothing reached the pod RDF and each post raised a notification.
  const contacts = intake.store.getContacts();
  const known = intake.config.kind === 'group'
    ? contacts.followers.some(f => f.actor === author)
    : contacts.following.some(f => f.actor === author && f.accepted);
  // Someone in a group you are in is not a stranger: their reply belongs in
  // the room, not in the drawer of unsolicited mail. Whose word this is on
  // is the group's — its published membership — so the group's own door
  // decides who gets in.
  const followed = via || known || (!known && await intake.isCoMember(author));
  const kind = followed ? 'timeline' : 'mention';

  // Mastodon carries a thread's mentions into every reply, which is the only
  // reason a reply ever reaches a group. Keep them so our composer can too.
  const mentions = [].concat(note.tag || [])
    .filter(t => t?.type === 'Mention' && t.href && t.name)
    .slice(0, MAX_MENTIONS)
    .map(t => ({ href: httpOnly(String(t.href).slice(0, MAX_URL_CHARS)), name: String(t.name).slice(0, 256) }))
    .filter(m => m.href);
  const emojis = emojisOf(note);
  const poll = pollOf(note);
  // Explicitly addressed, but to nobody public and to no followers
  // collection: a direct message, which belongs to the conversations view
  // rather than a timeline. A note with no addressing at all is NOT direct —
  // some servers omit to/cc, and vanishing from home is the wrong reading.
  const audience = [].concat(note.to || [], note.cc || []).map(String);
  const direct = audience.length > 0
    && !audience.includes(PUBLIC) && !audience.some(a => a.endsWith('/followers'));
  // Addressed to less than the world: whatever else happens to it, a group
  // must never widen its audience by carrying it.
  const nonPublic = audience.length > 0 && !audience.includes(PUBLIC);
  intake.store.addStatus({
    noteId: note.id, actor: author, content,
    published: note.published, inReplyTo: note.inReplyTo, kind,
    ...(direct ? { direct: true } : {}),
    ...(nonPublic ? { nonPublic: true } : {}),
    // The author's content warning, shown as one: plain text only.
    ...(note.summary ? { spoiler: String(note.summary).replace(/<[^>]*>/g, '') } : {}),
    ...(poll ? { poll } : {}),
    ...(emojis.length ? { emojis } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(via ? { via } : {}),
  });
  if (!followed || (note.inReplyTo && String(note.inReplyTo).startsWith(intake.urls.notes))) {
    intake.store.addNotification({ type: 'mention', actor: author, noteId: note.id });
  }
  if (note.inReplyTo && String(note.inReplyTo).startsWith(intake.urls.notes)) {
    await intake.addReply(String(note.inReplyTo), note.id)
      .catch(e => intake.log(`replies collection: ${e.message}`));
  }
  intake.log(`${kind}: ${note.id}${via ? ` (boosted by ${via})` : ''}`);
}

// Drop a post we were holding. A group that carried it also unsays its own
// Announce — forwarding the author's Delete would be signed by us and not by
// them, which receivers are right to refuse.
// `collect` batches the outbox side: retract pushes the Announce id onto it
// instead of republishing, and the caller writes once for all of them.
export async function forget(intake, s, { collect = null } = {}) {
  if (s.announceActivity) {
    await intake.retract(s.noteId, { collect }).catch(e => intake.log(`retract: ${e.message}`));
  }
  intake.store.removeStatus(s.noteId);
}

// Undo an Announce this group made. Shared with the operator's `retract`.
export async function retract(intake, noteId, { collect = null } = {}) {
  const s = intake.store.getStatuses().find(x => x.noteId === noteId);
  if (!s) throw new Error('no such post');
  // A Bluesky carry is a repost, and unsaying it is deleting the repost.
  if (s.repostUri) {
    if (!intake.bskyGroup) throw new Error('no bluesky account connected');
    return intake.bskyGroup.retract(s);
  }
  if (!s.announceActivity) throw new Error('that post was never carried');
  const { undoActivity } = await import('../wire.mjs');
  const inboxes = intake.announceTargets(s.actor);
  await intake.deliverer.deliverToAll(inboxes,
    undoActivity({ urls: intake.urls, activity: s.announceActivity, serial: intake.serial++ }));
  if (collect) collect.push(s.announceActivity.id);
  else await intake.publisher.unrecordOutbox(i => i?.id === s.announceActivity.id);
  intake.store.updateStatus(noteId, {
    announcedAt: undefined, announceActivity: undefined, retractedAt: new Date().toISOString(),
  });
  return { ok: true, noteId, inboxes: inboxes.length };
}

// Read-modify-write, and the drain is serialized, so two replies in one sweep
// do not race. Nothing else writes this document.
// MAX_REPLIES_RECORDED caps the collection. It is a discovery aid — a client
// reading a thread — and the statuses index is what actually holds the
// replies, so dropping the oldest costs a hop, not a record.
export async function addReply(intake, parentId, replyId) {
  // The parent has to be a post we actually made. The only check used to be
  // that the id started with our notes prefix, and `inReplyTo` is read off a
  // document at the sender's own origin — so a stranger could name a note we
  // never wrote, and we would CREATE a document on the pod at a URL of their
  // choosing and then grow it, one whole re-PUT per reply, with no cap. Four
  // pod requests each and bytes quadratic in the number of replies.
  if (!intake.store.getStatuses().some(s => s.noteId === parentId && s.kind === 'post')) {
    intake.log(`reply names ${parentId}, which is not a post of ours — not recorded`);
    return;
  }
  const { repliesId, collection } = await import('../wire.mjs');
  const url = repliesId(parentId);
  // Deliberately NOT caught: a read we could not make is not an empty
  // collection, and rewriting on top of one erases every reply already
  // recorded. getJson returns null only for a genuine 404 — the document does
  // not exist yet — and throws otherwise, which the caller logs and retries.
  const cur = await podNotes.readReplies(intake.remote, url);
  const items = Array.isArray(cur?.items) ? cur.items : [];
  if (items.includes(replyId)) return;
  items.push(replyId);
  await podNotes.writeReplies(intake.remote, url, collection(url, items.slice(-MAX_REPLIES_RECORDED)));
  intake.log(`reply recorded on ${parentId}`);
}
