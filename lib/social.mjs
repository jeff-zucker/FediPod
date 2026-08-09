// social.mjs — outbound social actions (follow, like, announce, delete)
// shared by the admin API and the Mastodon-API facade. Each action delivers
// the activity and mirrors state into the store; the store keeps the
// activity a later Undo must name.

import crypto from 'node:crypto';
import * as wire from './wire.mjs';
import { dropFollower } from './store.mjs';

// WebFinger, ours rather than fedify's — v2 dropped lookupWebFinger.
//
// Better here anyway: the host comes out of a handle, and a handle can arrive
// in a MENTION inside a post somebody else wrote, so it is remote input and
// belongs behind the same SSRF guard as every other outbound request. fedify's
// lookup did not go through ours. https only, because a handle resolved over
// plaintext is a handle anyone on the path can answer for.
export async function lookupWebFinger(acct) {
  const clean = String(acct || '').replace(/^acct:/, '');
  const at = clean.lastIndexOf('@');
  if (at < 1) return null;
  const [user, host] = [clean.slice(0, at), clean.slice(at + 1)];
  if (!host || /[/\\?#]/.test(host)) return null;
  const { safeFetch, readCapped } = await import('./safefetch.mjs');
  const url = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${clean}`)}`;
  const res = await safeFetch(url, {
    headers: { accept: 'application/jrd+json, application/json' },
  }).catch(() => null);
  if (!res || res.status >= 400) return null;
  try { return JSON.parse(await readCapped(res, 256 * 1024)); } catch { return null; }
}

const selfLink = (jrd) => jrd?.links?.find(l => l.rel === 'self' &&
  /application\/(activity\+json|ld\+json)/.test(l.type || ''));

// A WebFinger server can name an actor on ANY host, and until this ran we
// believed it. The handle is remote input — it arrives in the Mention tags of a
// note somebody else wrote — so evil.example could answer for `@x@evil.example`
// with a real, busy actor elsewhere, and a reply that carried that mention was
// addressed, tagged and DELIVERED to a third party who had nothing to do with
// the thread, over our signature.
//
// The host cannot simply be required to match: `@user@example.com` served by
// mastodon.example is the ordinary delegated setup and the whole point of
// WebFinger. So ask the ACTOR's own host who it says that actor is, and require
// it to come back to the same document. A server may name anyone; it cannot
// make that person's server agree. This is the round trip Mastodon does.
//
// Only when the two hosts differ — same-host is self-consistent by
// construction, so the common case costs no extra request.
export async function confirmDelegation(asked, doc, lookup = lookupWebFinger) {
  let home;
  try { home = new URL(doc.id).host.toLowerCase(); }
  catch { throw new Error(`actor id is not a URL (${doc.id})`); }
  if (home === asked.toLowerCase()) return;
  const user = doc.preferredUsername;
  if (!user) {
    throw new Error(`${asked} points at ${doc.id} on another host, which names no `
      + 'username to confirm it by');
  }
  const back = await lookup(`acct:${user}@${home}`);
  if (selfLink(back)?.href !== doc.id) {
    throw new Error(`${asked} claims ${doc.id}, but ${home} does not agree that is `
      + `@${user}@${home} — refusing to take one host's word for another's actor`);
  }
}

// acct:user@host → verified actor doc (cached by fetchAP), or throws.
export async function resolveHandle(agent, handle) {
  const clean = String(handle || '').replace(/^@/, '');
  if (!/^[^@]+@[^@]+$/.test(clean)) throw new Error('handle must look like user@host');
  if (agent.store.isBlocked('https://' + clean.split('@')[1] + '/')) throw new Error('domain is blocked');
  const jrd = await lookupWebFinger('acct:' + clean);
  const self = selfLink(jrd);
  if (!self?.href) throw new Error(`webfinger found no actor for ${clean}`);
  const doc = await agent.intake.fetchAP(self.href);
  if (!doc?.id) throw new Error(`actor document unusable for ${clean}`);
  if (agent.store.isBlocked(doc.id)) throw new Error('actor is blocked');
  await confirmDelegation(clean.slice(clean.lastIndexOf('@') + 1), doc);
  // Counts live in the collections, not the actor document, so a client asking
  // "who is this" would otherwise be told everyone has none. Two GETs, and only
  // when someone asked by name — never on the drain path.
  await cacheCounts(agent, doc);
  return doc;
}

// totalItems off the followers/following collections, stored beside the cached
// actor. Best effort: a collection that will not answer leaves the count unset
// rather than reported as zero, which is a different claim.
async function cacheCounts(agent, doc) {
  const total = async (url) => {
    if (!url) return null;
    try {
      const res = await agent.intake.fetchAP(url);
      return Number.isInteger(res?.totalItems) ? res.totalItems : null;
    } catch { return null; }
  };
  const [followers, following] = await Promise.all([total(doc.followers), total(doc.following)]);
  if (followers === null && following === null) return;
  const actors = agent.store.getActors();
  if (!actors[doc.id]) return;
  actors[doc.id] = { ...actors[doc.id], counts: { followers, following } };
  agent.store.write('actors.json', actors);
}

export async function followActor(agent, actorUrl) {
  const doc = await agent.intake.fetchAP(actorUrl);
  if (!doc?.inbox) throw new Error(`actor document unusable (${actorUrl})`);
  if (agent.store.isBlocked(doc.id)) throw new Error('actor is blocked');
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
  await agent.publisher.publishCollections({ following: true });
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
  await agent.publisher.publishCollections({ following: true });
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
  const act = wire.announceActivity({ urls, object: s.noteId, serial: Date.now() });
  const inboxes = new Set(agent.store.getContacts().followers
    .map(f => f.sharedInbox || f.inbox).filter(Boolean));
  if (s.actor !== urls.actor) {
    const doc = await agent.intake.fetchAP(s.actor).catch(() => null);
    if (doc?.inbox) inboxes.add(doc.endpoints?.sharedInbox || doc.inbox);
  }
  await agent.deliverer.deliverToAll([...inboxes], act);
  // Mark it boosted before recording it: a failed outbox write costs one
  // missing entry, a failed status write would let a retry announce twice.
  const updated = agent.store.updateStatus(s.noteId, { reblogged: true, announceActivity: act });
  await agent.publisher.recordOutbox(act);
  return updated;
}

export async function unreblog(agent, s) {
  if (s.announceActivity) {
    const undo = wire.undoActivity({ urls: agent.publisher.urls, activity: s.announceActivity, serial: Date.now() });
    const inboxes = new Set(agent.store.getContacts().followers
      .map(f => f.sharedInbox || f.inbox).filter(Boolean));
    const doc = await agent.intake.fetchAP(s.actor).catch(() => null);
    if (doc?.inbox && s.actor !== agent.publisher.urls.actor) inboxes.add(doc.endpoints?.sharedInbox || doc.inbox);
    await agent.deliverer.deliverToAll([...inboxes], undo);
    await agent.publisher.unrecordOutbox(i => i?.id === s.announceActivity.id);
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
  dropFollower(contacts, actor, 'ejected');
  agent.store.setContacts(contacts);
  const muted = agent.store.getMuted();
  muted.actors = [...new Set([...muted.actors, actor])];
  agent.store.setMuted(muted);
  await agent.publisher.publishCollections({ followers: true });
  // A Bluesky-side member's departure sticks by blocking the DID.
  if (rec.bsky) {
    await agent.bskygroup?.blockDid(rec.bsky.did)
      .catch(e => agent.log?.(`bluesky block failed for ${rec.bsky.handle}: ${e.message}`));
    return { ok: true, actor, told: true };
  }
  if (rec.inbox) {
    await agent.deliverer.deliver(rec.inbox, wire.rejectActivity({
      urls,
      followActivity: { id: rec.followId, type: 'Follow', actor, object: urls.actor },
      serial: Date.now(),
    }));
  }
  return { ok: true, actor, told: !!rec.inbox };
}

// Group: answer a held join request. Admitting is the Accept onFollow would
// have sent immediately had the group not been gated.
export async function admitRequest(agent, actor) {
  const reqs = agent.store.getRequests();
  const req = reqs.find(r => r.actor === actor);
  if (!req) throw new Error('no such request');
  const contacts = agent.store.getContacts();
  if (!contacts.followers.some(f => f.actor === actor)) {
    contacts.followers.push(req.bsky
      ? { actor, bsky: req.bsky }
      : { actor, inbox: req.inbox, sharedInbox: req.sharedInbox, followId: req.activity?.id });
    agent.store.setContacts(contacts);
    agent.store.addNotification({ type: 'follow', actor, ...(req.bsky ? { bsky: true } : {}) });
  }
  agent.store.setRequests(reqs.filter(r => r.actor !== actor));
  // A Bluesky-only member has no inbox and no Accept to receive; the follow
  // already stands on their side. The one-time bridge nudge goes out instead.
  if (req.bsky) {
    await agent.bskygroup?.nudgeOnce(contacts.followers.find(f => f.actor === actor));
    return { ok: true, actor };
  }
  await agent.publisher.publishCollections({ followers: true });
  await agent.deliverer.deliver(req.inbox, wire.acceptActivity({
    urls: agent.publisher.urls, followActivity: req.activity, serial: Date.now(),
  }));
  return { ok: true, actor };
}

// Refusing is not a ban: they may ask again, and the queue is where you would
// see that. Eject is the sticky one, because it mutes.
export async function refuseRequest(agent, actor) {
  const reqs = agent.store.getRequests();
  const req = reqs.find(r => r.actor === actor);
  if (!req) throw new Error('no such request');
  agent.store.setRequests(reqs.filter(r => r.actor !== actor));
  // No Reject can reach a Bluesky-only requester, so the refusal is enforced
  // where it can be: their DID is blocked.
  if (req.bsky) {
    await agent.bskygroup?.blockDid(req.bsky.did)
      .catch(e => agent.log?.(`bluesky block failed for ${req.bsky.handle}: ${e.message}`));
    return { ok: true, actor };
  }
  await agent.deliverer.deliver(req.inbox, wire.rejectActivity({
    urls: agent.publisher.urls, followActivity: req.activity, serial: Date.now(),
  }));
  return { ok: true, actor };
}

// Group: unsay an Announce. The work is in Intake because an upstream Delete
// has to do the same thing, and both must use the recipient set amplify used.
export async function retractAnnouncement(agent, noteId) {
  return agent.intake.retract(noteId);
}

// Remove an own note everywhere: Delete→followers, remote note + outbox,
// local pod RDF, statuses mirror.
//
// Two of the three pod deletes have to land, and both are checked. While the
// note document answers, anyone holding its id can still read a post its author
// deleted — and the `-create` beside it EMBEDS the whole note, so leaving that
// one behind publishes the same content under another name. A failure keeps the
// post here and says so, rather than reporting a deletion that did not happen:
// removing it locally would leave nothing to try again with, and nothing to see
// that it is still up.
// A vote is the fediverse convention: one bare Note per chosen option, whose
// name IS the option, inReplyTo the question, addressed to the question's
// author alone. The documents are stored for dereference but never listed —
// not in the outbox, not in the local index.
export async function votePoll(agent, s, choices) {
  const { urls } = agent.publisher;
  const poll = s.poll || {};
  const opts = poll.options || [];
  if (poll.closed || (poll.expiresAt && Date.parse(poll.expiresAt) < Date.now())) {
    return { ok: false, error: 'this poll has closed' };
  }
  if (poll.voted) return { ok: false, error: 'already voted' };
  const picks = [...new Set(choices)].filter(i => i >= 0 && i < opts.length);
  if (!picks.length) return { ok: false, error: 'invalid choice' };
  if (!poll.multiple && picks.length > 1) return { ok: false, error: 'this poll takes one choice' };
  const author = await agent.intake.fetchAP(s.actor).catch(() => null);
  const inbox = author?.endpoints?.sharedInbox || author?.inbox;
  if (!inbox) return { ok: false, error: 'could not reach the poll author' };
  const published = new Date().toISOString();
  for (const i of picks) {
    const id = urls.notes + published.slice(0, 10) + '-vote-' + crypto.randomBytes(4).toString('hex');
    const note = {
      '@context': wire.AS_CTX, id, type: 'Note',
      attributedTo: urls.actor, name: opts[i].title,
      inReplyTo: s.noteId, published, to: [s.actor],
    };
    const create = {
      '@context': wire.AS_CTX, id: wire.createActivityId(id), type: 'Create',
      actor: urls.actor, published, to: [s.actor], object: note,
    };
    await agent.remote.putJson(id, note);
    await agent.remote.putJson(create.id, create);
    await agent.deliverer.deliverToAll([inbox], create);
  }
  agent.store.updateStatus(s.noteId, {
    poll: {
      ...poll, voted: true, ownVotes: picks,
      options: opts.map((o, j) => (picks.includes(j) ? { ...o, votes: (o.votes || 0) + 1 } : o)),
    },
  });
  return { ok: true };
}

export async function deleteNote(agent, s) {
  const { urls } = agent.publisher;
  const inboxes = agent.store.getContacts().followers
    .map(f => f.sharedInbox || f.inbox).filter(Boolean);
  await agent.deliverer.deliverToAll(inboxes, wire.deleteActivity({ urls, noteId: s.noteId }));

  // The note is REPLACED with a Tombstone rather than removed, so a peer that
  // dereferences it learns the post was deleted instead of a bare 404 (§7.4).
  // The Tombstone must stay readable; the container above it is owner-only, so
  // the ACL cannot be inherited. The Create activity is the withdrawn action,
  // not the object, so it is deleted outright.
  const stuck = [];
  const deletedAt = new Date().toISOString();
  try {
    await agent.remote.putJson(s.noteId, wire.noteTombstone(s.noteId, deletedAt));
    await agent.remote.setAcl(s.noteId, ['Read']);
  } catch { stuck.push(s.noteId); }
  if (!await agent.remote.delete(wire.createActivityId(s.noteId)).catch(() => false)) {
    stuck.push(wire.createActivityId(s.noteId));
  }
  if (stuck.length) {
    agent.log?.(`delete ${s.noteId}: the pod kept ${stuck.length} document(s) — the post is STILL PUBLISHED`);
    return {
      ok: false, stillPublished: stuck,
      error: 'the pod would not remove the post — it is still published, and has been kept here so you can try again',
    };
  }
  // Empty, and referenced by nothing once the note is gone.
  await agent.remote.delete(wire.repliesId(s.noteId)).catch(() => {});

  // The Bluesky mirror goes with the post. Best-effort: a mirror the far side
  // already lost is not a reason to keep the post here.
  if (s.atproto?.uri && agent.atproto?.connected()) {
    await agent.atproto.deleteCrossPost(s.atproto.uri)
      .then(() => agent.log?.(`bluesky mirror deleted: ${s.atproto.uri}`))
      .catch(e => agent.log?.(`bluesky mirror not deleted (${e.message}): ${s.atproto.uri}`));
  }

  // The note, and our own boost of it if there was one.
  await agent.publisher.unrecordOutbox(i => i === s.noteId || (i?.id && i.id === s.announceActivity?.id));
  if (s.slug) await agent.local.delete(agent.local.fedi + 'posts/' + s.slug).catch(() => {});
  agent.store.removeStatus(s.noteId);
  return { ok: true };
}
