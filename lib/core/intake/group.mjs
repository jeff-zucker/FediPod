// group.mjs — what a group actor does with what arrives (FEP-1b12): carries a
// member's post to the membership, knows who its co-members are, and queues a
// listed moderator's ask for the operator rather than running it.

import { trimActivity, MAX_MODQUEUE, MAX_PENDING_REVIEW, CO_MEMBER_TTL_MS, CO_MEMBER_MAX } from './activity.mjs';

// Which inbound activities count as a moderator's ask: a ban, an unban, a
// post removal, or a roster change naming OUR moderators collection. A
// moderator's ordinary traffic (their posts, likes, follows) is not
// moderation and takes the normal arms.
export function isModerationAsk(intake, activity) {
  if (activity.type === 'Block') return true;
  if (activity.type === 'Undo') {
    return typeof activity.object === 'object' && activity.object?.type === 'Block';
  }
  if (activity.type === 'Delete') {
    const id = typeof activity.object === 'string' ? activity.object : activity.object?.id;
    const s = id && intake.store.getStatuses().find(x => x.noteId === id);
    // Only a post the group holds and did not author — removing those is
    // moderation; everything else is the author's own Delete.
    return !!s && s.kind !== 'post';
  }
  if (activity.type === 'Add' || activity.type === 'Remove') {
    const target = typeof activity.target === 'string' ? activity.target : activity.target?.id;
    return target === intake.urls.moderators;
  }
  return false;
}

// Held, not run: one entry per distinct ask, capped, waiting for the
// operator to apply or dismiss it (social.applyModeration).
// A moderator's WORD, not their proof. `actor` is a field in an unsigned
// body and a moderator's URL is public, so anyone can claim to be one — which
// is exactly why these are QUEUED for the operator rather than run. What was
// missing is that the queue did not say which is which, and a stranger could
// fill all 200 slots and push the real asks out.
//
// So: the entry records whether the door vouched for the sender, and when the
// queue is full the UNVERIFIED entries are what get dropped. A real
// moderator's ask cannot be crowded out by someone impersonating them.
export function queueModeration(intake, activity, actor, { trusted = false } = {}) {
  const q = intake.store.read('modqueue.json', []);
  const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const key = [activity.type, actor, objectId || JSON.stringify(activity.object || null)].join(' ');
  const seen = q.find(e => e.key === key);
  if (seen) {
    // The same ask arriving verified is worth more than the copy we hold.
    if (trusted && !seen.verified) {
      seen.verified = true;
      intake.store.write('modqueue.json', q);
    }
    return;
  }
  q.unshift({
    key, id: (intake.serial++).toString(36) + '-' + q.length,
    type: activity.type, moderator: actor, activity: trimActivity(activity),
    verified: !!trusted, at: new Date().toISOString(),
  });
  let kept = q;
  if (kept.length > MAX_MODQUEUE) {
    const verified = kept.filter(e => e.verified);
    const rest = kept.filter(e => !e.verified);
    // Verified first, then the newest unverified up to the cap.
    kept = [...verified, ...rest].slice(0, MAX_MODQUEUE);
  }
  intake.store.write('modqueue.json', kept);
  intake.log(`moderation queued from ${actor}${trusted ? '' : ' (unverified)'}: ${activity.type} ${objectId || ''}`);
}

// Anyone can Append to a public inbox, so arriving is not the same as being
// carried to every follower. Membership is the gate: you cannot post to a
// group you have not joined, and declining to carry a member is the only
// moderation a group can actually enforce.
export async function amplify(intake, noteId, { approved = false, activity = null } = {}) {
  const s = intake.store.getStatuses().find(x => x.noteId === noteId);
  if (!s) return;
  if (s.announcedAt) return;                      // a re-delivered Create announces once
  // A DM to the group, or a followers-only post it happened to receive, was
  // addressed to less than the world — carrying it would widen the author's
  // audience for them. A group only ever amplifies public posts.
  if (s.direct || s.nonPublic) {
    intake.log(`not amplified — ${noteId} was not addressed publicly, and a group never widens a post's audience`);
    return;
  }
  const contacts = intake.store.getContacts();
  if (!contacts.followers.some(f => f.actor === s.actor)) {
    intake.log(`not amplified — ${s.actor} is not a member`);
    return;
  }
  if (intake.store.getMuted().actors.includes(s.actor)) {
    intake.log(`not amplified — ${s.actor} is muted`);
    return;
  }
  // A reviewed group carries nothing until its operator says so.
  if (intake.config.review && !approved) {
    const pending = intake.store.getPending();
    if (!pending.some(p => p.noteId === noteId)) {
      // Full means refuse the new one, not evict the oldest. `slice(0, 500)`
      // dropped from the tail, so one member posting 500 notes silently
      // discarded everything the operator was still deciding about — the
      // posts were never carried, never refused, and left no record that they
      // had ever arrived. Becoming a member costs one Follow when joins are
      // unmoderated, which is the default.
      //
      // Not carrying it is what a reviewed group does with anything it has
      // not approved, so refusing is the same outcome the queue was for.
      if (pending.length >= MAX_PENDING_REVIEW) {
        intake.log(`review queue is full (${MAX_PENDING_REVIEW}) — ${noteId} not held. `
          + 'Approve or decline what is waiting and it will be carried on redelivery.');
        return;
      }
      // The activity rides along: approving later still has to wrap the one
      // the member actually sent, not a reconstruction of it.
      pending.unshift({ noteId, actor: s.actor, activity, at: new Date().toISOString() });
      intake.store.setPending(pending);
    }
    intake.log(`held for review: ${noteId}`);
    return;
  }
  // A member's Bluesky post: the carry is a native repost by the group's
  // account. It reaches AP followers only through the author's own bridge —
  // the group never fabricates an AP object for someone else's words.
  if (s.kind === 'bsky') {
    if (!intake.bskyGroup) { intake.log(`not amplified — ${noteId} is a bluesky post and no account is connected`); return; }
    return intake.bskyGroup.carry(s);
  }
  const held = intake.store.getPending().find(p => p.noteId === noteId);
  const inboxes = intake.announceTargets(s.actor);
  const { announceActivity } = await import('../wire.mjs');
  // Wrap the member's own activity when we have it; a bare note URL is the
  // fallback, and renders as a plain boost rather than a group carry. The
  // group names itself as the audience (FEP-1b12).
  //
  // `activity` is the envelope as DELIVERED — a document the sender wrote,
  // which the group would otherwise re-sign and hand to every follower with
  // whatever addressing, tags and object body it carried. Only the note id was
  // ever verified (ingestNote fetched it from the author's origin and checked
  // the attribution), so only the note id is safe to pass on: send the bare
  // id unless the wrapper's own object id agrees with what we verified.
  const wrapperObject = (a) => {
    const inner = a?.object;
    const id = typeof inner === 'string' ? inner : inner?.id;
    return id === noteId ? a : null;
  };
  const act = announceActivity({
    urls: intake.urls,
    object: wrapperObject(activity) || wrapperObject(held?.activity) || noteId,
    serial: intake.serial++,
    audience: intake.urls.actor,
  });
  await intake.deliverer.deliverToAll(inboxes, act);
  // Marked carried before recorded: a failed outbox write costs one missing
  // entry, a failed status write would carry the same post twice.
  intake.store.updateStatus(noteId, { announcedAt: new Date().toISOString(), announceActivity: act });
  await intake.publisher.recordOutbox(act);
  intake.store.setPending(intake.store.getPending().filter(p => p.noteId !== noteId));
  intake.log(`amplified ${noteId} → ${inboxes.length} inbox(es)`);
  // The same carry, shown natively to the group's Bluesky followers.
  await intake.bskyGroup?.mirrorCarry(s)
    .catch(e => intake.log(`bluesky mirror of the carry failed: ${e.message}`));
}

// Is this actor in a group we are in? Each followed Group's membership is a
// public collection, read at most once a day and cached — a membership list
// is slow-moving, and this runs on arriving mail.
export async function isCoMember(intake, actor) {
  if (intake.config.kind === 'group') return false;      // a group has members, not peers
  const groups = intake.store.getContacts().following
    .filter(f => f.accepted && intake.store.getActors()[f.actor]?.type === 'Group')
    .map(f => f.actor);
  if (!groups.length) return false;
  const cache = intake.store.read('comembers.json', {});
  const fresh = Date.now() - CO_MEMBER_TTL_MS;
  let changed = false;
  for (const g of groups) {
    const held = cache[g];
    if (held && Date.parse(held.at || 0) > fresh) continue;
    const doc = await intake.fetchAP(g).catch(() => null);
    const list = doc?.followers ? await intake.collectionMembers(doc.followers) : null;
    // A list we could not read keeps whatever we had: losing it would demote
    // every co-member to a stranger for a day because one fetch failed.
    if (!list) continue;
    cache[g] = { at: new Date().toISOString(), members: list };
    changed = true;
  }
  if (changed) intake.store.write('comembers.json', cache);
  return groups.some(g => cache[g]?.members?.includes(actor));
}

// The actor ids in a (possibly paged) public collection, capped.
export async function collectionMembers(intake, url) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < 10 && out.length < CO_MEMBER_MAX; page++) {
    const doc = await intake.fetchAP(next).catch(() => null);
    if (!doc) return out.length ? out : null;
    for (const item of doc.orderedItems || doc.items || []) {
      if (typeof item === 'string') out.push(item);
    }
    next = doc.first && page === 0 ? doc.first : doc.next;
    if (typeof next === 'object') next = next?.id;
  }
  return out;
}

// Who an Announce for `author` goes to. Shared with the retract path: an Undo
// that reached a different set than the Announce did would leave the post
// standing for whoever the two sets disagreed about.
// The author's own target is dropped only when it serves nobody else — a
// shared inbox carries the whole server's members.
export function announceTargets(intake, author) {
  const byTarget = new Map();
  for (const f of intake.store.getContacts().followers) {
    const t = f.sharedInbox || f.inbox;
    if (!t) continue;
    if (!byTarget.has(t)) byTarget.set(t, new Set());
    byTarget.get(t).add(f.actor);
  }
  return [...byTarget]
    .filter(([, who]) => !(who.size === 1 && who.has(author)))
    .map(([t]) => t);
}
