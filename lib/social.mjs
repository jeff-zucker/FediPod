// social.mjs — outbound social actions (follow, like, announce, delete)
// shared by the admin API and the Mastodon-API facade. Each action delivers
// the activity and mirrors state into the store; the store keeps the
// activity a later Undo must name.

import { lookupWebFinger } from '@fedify/fedify/webfinger';
import * as wire from './wire.mjs';

// acct:user@host → verified actor doc (cached by fetchAP), or throws.
export async function resolveHandle(agent, handle) {
  const clean = String(handle || '').replace(/^@/, '');
  if (!/^[^@]+@[^@]+$/.test(clean)) throw new Error('handle must look like user@host');
  if (agent.store.isBlocked('https://' + clean.split('@')[1] + '/')) throw new Error('domain is blocked');
  const jrd = await lookupWebFinger('acct:' + clean);
  const self = jrd?.links?.find(l => l.rel === 'self' &&
    /application\/(activity\+json|ld\+json)/.test(l.type || ''));
  if (!self?.href) throw new Error(`webfinger found no actor for ${clean}`);
  const doc = await agent.intake.fetchAP(self.href);
  if (!doc?.id) throw new Error(`actor document unusable for ${clean}`);
  return doc;
}

export async function followActor(agent, actorUrl) {
  const doc = await agent.intake.fetchAP(actorUrl);
  if (!doc?.inbox) throw new Error(`actor document unusable (${actorUrl})`);
  const contacts = agent.store.getContacts();
  let rec = contacts.following.find(f => f.actor === doc.id);
  if (!rec) {
    rec = { actor: doc.id, inbox: doc.inbox, accepted: false };
    contacts.following.push(rec);
  }
  const follow = wire.followActivity({ urls: agent.publisher.urls, targetActor: doc.id, serial: Date.now() });
  rec.followActivity = follow;               // kept for a later Undo
  agent.store.setContacts(contacts);
  await agent.deliverer.deliver(doc.inbox, follow);
  await agent.publisher.publishCollections();
  return doc;
}

export async function followHandle(agent, handle) {
  const doc = await resolveHandle(agent, handle);
  await followActor(agent, doc.id);
  const clean = String(handle || '').replace(/^@/, '');
  const contacts = agent.store.getContacts();
  const rec = contacts.following.find(f => f.actor === doc.id);
  if (rec && !rec.handle) { rec.handle = clean; agent.store.setContacts(contacts); }
  return { ok: true, actor: doc.id };
}

export async function unfollowActor(agent, actor) {
  const contacts = agent.store.getContacts();
  const rec = contacts.following.find(f => f.actor === actor);
  if (!rec) throw new Error('not following that actor');
  if (rec.followActivity) {
    await agent.deliverer.deliver(rec.inbox,
      wire.undoActivity({ urls: agent.publisher.urls, activity: rec.followActivity, serial: Date.now() }));
  }
  contacts.following = contacts.following.filter(f => f.actor !== actor);
  agent.store.setContacts(contacts);
  await agent.publisher.publishCollections();
  return { ok: true };
}

export async function favourite(agent, s) {
  if (s.favourited) return s;
  const doc = await agent.intake.fetchAP(s.actor);
  if (!doc?.inbox) throw new Error('author inbox unavailable');
  const act = wire.likeActivity({ urls: agent.publisher.urls, noteId: s.noteId, serial: Date.now() });
  await agent.deliverer.deliver(doc.endpoints?.sharedInbox || doc.inbox, act);
  return agent.store.updateStatus(s.noteId, { favourited: true, likeActivity: act });
}

export async function unfavourite(agent, s) {
  if (s.likeActivity) {
    const doc = await agent.intake.fetchAP(s.actor).catch(() => null);
    if (doc?.inbox) {
      await agent.deliverer.deliver(doc.endpoints?.sharedInbox || doc.inbox,
        wire.undoActivity({ urls: agent.publisher.urls, activity: s.likeActivity, serial: Date.now() }));
    }
  }
  return agent.store.updateStatus(s.noteId, { favourited: false, likeActivity: undefined });
}

// Announce goes to our followers (that's what boosting is) and to the author.
export async function reblog(agent, s) {
  if (s.reblogged) return s;
  const { urls } = agent.publisher;
  const act = wire.announceActivity({ urls, noteId: s.noteId, serial: Date.now() });
  const inboxes = new Set(agent.store.getContacts().followers
    .map(f => f.sharedInbox || f.inbox).filter(Boolean));
  if (s.actor !== urls.actor) {
    const doc = await agent.intake.fetchAP(s.actor).catch(() => null);
    if (doc?.inbox) inboxes.add(doc.endpoints?.sharedInbox || doc.inbox);
  }
  await agent.deliverer.deliverToAll([...inboxes], act);
  return agent.store.updateStatus(s.noteId, { reblogged: true, announceActivity: act });
}

export async function unreblog(agent, s) {
  if (s.announceActivity) {
    const undo = wire.undoActivity({ urls: agent.publisher.urls, activity: s.announceActivity, serial: Date.now() });
    const inboxes = new Set(agent.store.getContacts().followers
      .map(f => f.sharedInbox || f.inbox).filter(Boolean));
    const doc = await agent.intake.fetchAP(s.actor).catch(() => null);
    if (doc?.inbox && s.actor !== agent.publisher.urls.actor) inboxes.add(doc.endpoints?.sharedInbox || doc.inbox);
    await agent.deliverer.deliverToAll([...inboxes], undo);
  }
  return agent.store.updateStatus(s.noteId, { reblogged: false, announceActivity: undefined });
}

// Group: end a following we will no longer carry. Forgetting them locally is
// not enough — without the Reject their server keeps the relationship and they
// keep receiving everything the group announces. Muting them too, because an
// ejection anyone can undo by re-following is not an ejection; a re-follow is
// still auto-accepted, but nothing of theirs gets carried.
export async function ejectFollower(agent, actor) {
  const { urls } = agent.publisher;
  const contacts = agent.store.getContacts();
  const rec = contacts.followers.find(f => f.actor === actor);
  if (!rec) throw new Error('not a member');
  contacts.followers = contacts.followers.filter(f => f.actor !== actor);
  agent.store.setContacts(contacts);
  const muted = agent.store.getMuted();
  muted.actors = [...new Set([...muted.actors, actor])];
  agent.store.setMuted(muted);
  await agent.publisher.publishCollections();
  if (rec.inbox) {
    await agent.deliverer.deliver(rec.inbox, wire.rejectActivity({
      urls,
      followActivity: { id: rec.followId, type: 'Follow', actor, object: urls.actor },
      serial: Date.now(),
    }));
  }
  return { ok: true, actor, told: !!rec.inbox };
}

// Group: unsay an Announce. The recipient set has to be the one amplify used,
// so it comes from the same helper.
export async function retractAnnouncement(agent, noteId) {
  const s = agent.store.getStatuses().find(x => x.noteId === noteId);
  if (!s) throw new Error('no such post');
  if (!s.announceActivity) throw new Error('that post was never carried');
  const inboxes = agent.intake.announceTargets(s.actor);
  await agent.deliverer.deliverToAll(inboxes, wire.undoActivity({
    urls: agent.publisher.urls, activity: s.announceActivity, serial: Date.now(),
  }));
  agent.store.updateStatus(noteId, { announcedAt: undefined, announceActivity: undefined, retractedAt: new Date().toISOString() });
  return { ok: true, noteId, inboxes: inboxes.length };
}

// Remove an own note everywhere: Delete→followers, remote note + outbox,
// local pod RDF, statuses mirror.
export async function deleteNote(agent, s) {
  const { urls } = agent.publisher;
  const inboxes = agent.store.getContacts().followers
    .map(f => f.sharedInbox || f.inbox).filter(Boolean);
  await agent.deliverer.deliverToAll(inboxes, wire.deleteActivity({ urls, noteId: s.noteId }));
  await agent.remote.delete(s.noteId);
  const outbox = agent.store.read('outbox.json', []).filter(u => u !== s.noteId);
  agent.store.write('outbox.json', outbox);
  await agent.remote.putJson(urls.outbox, wire.orderedCollection(urls.outbox, outbox));
  if (s.slug) await agent.local.delete(agent.local.fedi + 'posts/' + s.slug).catch(() => {});
  agent.store.removeStatus(s.noteId);
  return { ok: true };
}
