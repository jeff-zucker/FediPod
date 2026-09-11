// restore.mjs — a machine that is behind the pod catching up: followers and
// outbox entries the pod carries and this machine never heard of, and the
// actor's own posts rebuilt from the published outbox.

import * as wire from '../wire.mjs';
import * as podNotes from '../../pod/notes.mjs';

const ACCEPT_AP = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
const REBUILD_MAX_PER_RUN = 200;

// Anyone the pod says follows us that we have no record of, and never
// deliberately removed. In the steady state there is nobody: the pod's list is
// written from this one. They appear when the local half is BEHIND the pod —
// a restored backup, a home copied off a dead machine — and republishing
// blindly would delete them from the wire and, worse, stop delivering to them.
//
// Removals are what makes this safe to do unconditionally: `dropFollower`
// records every unfollow, ejection and account deletion, so a returning name
// is either genuinely still a follower or genuinely a mistake we made.
export async function reconcileFollowers(publisher, contacts) {
  let published = [];
  try {
    published = (await publisher.readPublishedFollowers()) || [];   // walks pages
  } catch { return 0; }                       // no list to reconcile against

  const known = new Set(contacts.followers.map(f => f.actor));
  const removed = new Set((contacts.removedFollowers || []).map(r => r.actor));
  const missing = published.filter(a => typeof a === 'string' && !known.has(a) && !removed.has(a));
  if (!missing.length) return 0;

  // An inbox is what delivery needs, and only the actor document has it — so
  // recovering a follower costs one fetch each. Capped: a list this wrong is
  // a restore, and the rest catch up on the next publish.
  let recovered = 0;
  for (const actor of missing.slice(0, 200)) {
    try {
      const res = await publisher.deliverer.signedFetch(actor, { headers: { accept: ACCEPT_AP } });
      if (!res.ok) continue;
      const doc = await res.json();
      if (!doc?.inbox) continue;
      contacts.followers.push({
        actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox || null, recovered: true,
        // Said explicitly, because onUndo reads it: the pod publishes WHO
        // follows, never the id of the Follow that did it, so a recovered
        // record has nothing an Undo can be matched against and must not be
        // evictable by one naming anything at all.
        followId: null,
      });
      recovered++;
    } catch { /* unreachable now; it will be there next time */ }
  }
  if (recovered) {
    publisher.store.setContacts(contacts);
    publisher.log(`reconciled ${recovered} follower(s) the pod knew about and this machine did not `
      + '— a restored or copied state was behind');
  }
  return recovered;
}

// The same argument as reconcileFollowers, for the other published list. It
// matters more: the outbox is the INDEX a statuses rebuild reads, so a
// republish from a restored-and-behind machine would destroy the record of
// everything this actor ever posted — and destroy it before anyone noticed
// there was anything to recover.
//
// Safe for the same reason: `unrecordOutbox` leaves a tombstone, so an entry
// the pod still carries is one this machine has not heard of, never one it
// deliberately took back.
export async function reconcileOutbox(publisher, outbox) {
  let published = [];
  try {
    published = await publisher.readPublishedOutbox() || [];
  } catch { return 0; }
  if (!Array.isArray(published) || !published.length) return 0;

  const idOf = (i) => (typeof i === 'string' ? i : i?.id || null);
  const known = new Set(outbox.map(idOf).filter(Boolean));
  const removed = new Set((publisher.store.read('outbox-removed.json', [])).map(r => r.id));
  const missing = published.filter((i) => {
    const id = idOf(i);
    return id && !known.has(id) && !removed.has(id);
  });
  if (!missing.length) return 0;
  // Newest first, like recordOutbox leaves it; the pod's copy is already in
  // that order, so appending the tail is enough to keep both sorted.
  outbox.push(...missing);
  publisher.store.write('outbox.json', outbox);
  publisher.log(`reconciled ${missing.length} outbox entr(ies) the pod carried and this machine did not`);
  return missing.length;
}

// Recover this actor's own posts from the pod's public face. The private half
// lives on this machine now, so a restored backup or a replaced machine loses
// statuses.json while the pod still serves every note. Followers already come
// back; this is the other half of the same gap.
//
// The INDEX is ap/outbox, not the ap/notes/ listing, and that difference is
// the safety argument. Deleting a post rewrites the outbox in one PUT, so an
// entry still there is a post that still stands. The note DOCUMENT can outlive
// its own deletion — deleteNote's `remote.delete` is a request that can fail —
// so walking the container can bring back something its author took down.
// `fromNotes` is for when you would rather have that than lose the post; it is
// not the default, and it says so where it is offered.
//
// MERGE ONLY. A status this machine already holds is left exactly as it is:
// it carries local facts — favourited, reblogged, the activities an Undo has
// to name — that the pod knows nothing about. That is also what makes the
// failure modes harmless: a listing that fails returns nothing, and nothing
// is what an empty listing recovers.
export async function rebuildStatuses(publisher, { fromNotes = false } = {}) {
  const { urls } = publisher;
  const ids = new Set();
  const boosts = [];
  let indexed = false;

  const published = await publisher.readPublishedOutbox().catch(() => null);
  if (published) {
    indexed = true;
    for (const item of published) {
      if (typeof item === 'string') { if (item.startsWith(urls.notes)) ids.add(item); }
      else if (item?.type === 'Announce') boosts.push(item);
    }
  }
  if (fromNotes) {
    // Three documents are published per post — the note, `-create` and
    // `-replies` — plus a `.keep`. Which is which is settled by reading the
    // document below, not by its name: a slug is a date and eight hex
    // characters and says nothing about what it holds.
    for (const child of await podNotes.list(publisher.remote, urls).catch(() => [])) {
      ids.add(child.url);
    }
    indexed = true;
  }
  if (!indexed) return { indexed: 0, recovered: 0, reblogs: 0, landed: false, why: 'the pod would not answer for its outbox' };

  const statuses = publisher.store.getStatuses();
  const have = new Set(statuses.map(s => s.noteId));
  const removed = new Set(publisher.store.read('outbox-removed.json', []).map(r => r.id));
  const recovered = [];
  // Capped per run: a long-lived actor's rebuild is otherwise one pod request
  // per post it has ever made, in one burst. What is left is picked up by
  // running it again — the merge is idempotent, so that is safe to repeat.
  let budget = REBUILD_MAX_PER_RUN;
  for (const id of ids) {
    if (budget <= 0) { publisher.log(`rebuild: stopping at ${REBUILD_MAX_PER_RUN} this run — run it again for the rest`); break; }
    if (have.has(id) || removed.has(id)) continue;
    budget--;
    const note = await podNotes.read(publisher.remote, id).catch(() => null);
    if (note?.type !== 'Note' || note.id !== id || note.attributedTo !== urls.actor) continue;
    const attachments = wire.attachmentsOf(note);
    const mentions = (Array.isArray(note.tag) ? note.tag : [])
      .filter(t => t?.type === 'Mention' && t.href)
      .map(t => ({ href: t.href, name: t.name }));
    recovered.push({
      noteId: note.id, actor: urls.actor, content: note.content || '',
      published: note.published || null,
      ...(note.inReplyTo ? { inReplyTo: note.inReplyTo } : {}),
      kind: 'post', slug: note.id.slice(urls.notes.length),
      ...(attachments.length ? { attachments } : {}),
      ...(mentions.length ? { mentions } : {}),
      recovered: true,
    });
  }

  // A boost is only recoverable for a post we can name — the Announce carries
  // the activity a later Undo needs, but not the boosted post's text, which
  // belongs to whoever wrote it.
  const merged = [...statuses, ...recovered];
  let reblogs = 0;
  for (const act of boosts) {
    const object = typeof act.object === 'string' ? act.object : act.object?.id;
    const s = object && merged.find(x => x.noteId === object);
    if (!s || s.reblogged) continue;
    s.reblogged = true;
    s.announceActivity = act;
    reblogs++;
  }
  if (!recovered.length && !reblogs) return { indexed: ids.size, recovered: 0, reblogs: 0, landed: true };

  // Written whole and sorted: addStatus unshifts and fires the streaming
  // event, so a loop of it would arrive backwards and push every recovered
  // post at connected clients as new.
  merged.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  const kept = merged.slice(0, 1000);
  publisher.store.write('statuses.json', kept);
  const landed = await publisher.store.commit();

  publisher.log(`rebuilt ${recovered.length} post(s) and ${reblogs} boost(s) from the pod`
    + `${landed ? '' : ' — THE STATE WRITE DID NOT LAND'}`);
  return {
    indexed: ids.size, recovered: recovered.length, reblogs, landed,
    dropped: Math.max(0, merged.length - kept.length),
  };
}
