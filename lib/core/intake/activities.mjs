// activities.mjs — one handler per inbound activity type. Each is reached
// from Intake.handle() after the sender passed the door checks, and returns a
// rejection reason or nothing.

import { dropFollower } from '../store.mjs';
import { emojisOf, pollOf, isContentType, trimActivity } from './activity.mjs';

// §7.6 Add / §7.9 Remove. The side effect would be to add or remove the object
// to/from the collection named in `target` — but only a collection we own AND
// that the sender is authorised to modify. No remote is granted write to our
// collections (membership is Follow/Undo, pins are ours to set), so there is
// nothing an inbound Add or Remove may change here. It is a valid activity,
// not garbage: acknowledge it, make no change, and never dead-letter it.
export function onAddRemove(intake, activity, actor) {
  const target = typeof activity.target === 'string' ? activity.target : activity.target?.id;
  const ours = target && [intake.urls.followers, intake.urls.following, intake.urls.featured]
    .filter(Boolean).includes(target);
  intake.log(ours
    ? `${activity.type} from ${actor} targets our ${target} — no remote may modify it; acknowledged`
    : `${activity.type} from ${actor} targets ${target || 'no collection of ours'}; nothing here to change`);
  return;   // accepted, no side effect
}

export async function onFollow(intake, activity, actor, { trusted = false } = {}) {
  const doc = await intake.fetchAP(actor);   // origin must vouch for the actor
  if (!doc) return `actor fetch failed (${actor})`;
  if (doc.id !== actor) return `actor id mismatch (${actor} vs ${doc.id})`;
  if (!doc.inbox) return `actor has no inbox (${actor})`;
  const contacts = intake.store.getContacts();
  const existing = contacts.followers.find(f => f.actor === actor);
  // NOTHING binds a delivered Follow to the actor it names. LDN bodies carry
  // no signature, and unlike Create, Delete and Update there is no object at
  // the origin to re-fetch and compare — dereferencing the actor proves only
  // that the actor EXISTS. So anyone at all could Append a Follow naming
  // anyone at all, and we would sign an Accept, deliver it to that person,
  // and send them everything published from then on.
  //
  // Until deliveries terminate somewhere their signature survives, a follow
  // we cannot verify is a REQUEST, waiting in the same queue a gated group
  // uses. The requester's client shows "Requested", which is the ordinary
  // locked-account state that manuallyApprovesFollowers tells it to expect.
  // `autoAcceptFollows: true` in config restores the old behaviour.
  // A GROUP is left alone: `approveJoins: false` is its operator saying, in
  // as many words, that anyone may join, and mute/eject are the remedy there.
  // A person has no such setting, so this is their default.
  //
  // A gateway-verified Follow (trust mode) is no longer unverifiable — the
  // door proved the sender — so it does not need the OK that unverifiability
  // alone demanded. An explicit `approveJoins` still holds: verified or not,
  // the operator asked to see joins.
  const unverifiedNeedsOk = intake.config.kind !== 'group' && !intake.config.autoAcceptFollows && !trusted;
  const mustApprove = intake.config.approveJoins || unverifiedNeedsOk;
  if (mustApprove && !existing) {
    const reqs = intake.store.getRequests();
    if (!reqs.some(r => r.actor === actor)) {
      reqs.unshift({
        actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox,
        activity: trimActivity(activity), at: new Date().toISOString(),
      });
      intake.store.setRequests(reqs.slice(0, 500));
      intake.store.addNotification({ type: 'follow-request', actor });
      await intake.republish({ pending: true });
    }
    intake.log(`join requested: ${actor}`);
    return;
  }
  if (existing) {
    // Deliberately NOT updating followId. An inbound Follow is unverifiable —
    // that is what the queue above exists for — so letting one rewrite the id
    // of a follower we already hold hands an attacker the exact value onUndo
    // matches on: POST a Follow naming any follower in the published
    // collection, then POST an Undo naming the id you just chose, and they are
    // gone permanently. A genuine refollow needs nothing from us but the
    // Accept below, which is idempotent.
  } else {
    // A Bluesky member who bridges later arrives here as a second, different
    // actor: the bridge follows on their behalf from bsky.brid.gy/ap/<did>,
    // while the native join is recorded under bsky.app/profile/<did>. Left
    // alone that is one person listed twice, carried twice, and ejectable
    // only half at a time. The bridged record supersedes the native one —
    // it reaches the fediverse side, which the native one never could.
    const bridgedDid = /^https:\/\/bsky\.brid\.gy\/ap\/(did:[^/]+)$/.exec(actor)?.[1];
    if (bridgedDid) {
      const before = contacts.followers.length;
      contacts.followers = contacts.followers.filter(f => f.bsky?.did !== bridgedDid);
      if (contacts.followers.length < before) {
        intake.log(`bluesky member ${bridgedDid} is bridged now — the native record gives way to it`);
      }
    }
    contacts.followers.push({
      actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox, followId: activity.id,
      ...(bridgedDid ? { bsky: { did: bridgedDid, bridged: true } } : {}),
    });
    intake.store.setContacts(contacts);
    intake.store.addNotification({ type: 'follow', actor });
    await intake.republish({ followers: true });
    intake.log(`new follower: ${actor}`);
  }
  const { acceptActivity } = await import('../wire.mjs');
  await intake.deliverer.deliver(doc.inbox,
    acceptActivity({ urls: intake.urls, followActivity: activity, serial: intake.serial++ }));
  intake.log(`Accept sent → ${doc.inbox}`);
}

export async function onUndo(intake, activity, actor, { trusted = false } = {}) {
  // AS2 allows `object` to be a bare IRI, and that IRI is exactly the Follow
  // id we stored. Reading `.type` off a string gives undefined, so the whole
  // Undo was dropped — silently, since handle() reads that as handled, so no
  // dead letter was kept and the item was DELETEd. The follower stayed, we
  // kept delivering to them, and their server had recorded the unfollow as
  // done and would never resend. Only a TYPED non-Follow is not ours.
  if (typeof activity.object === 'object' && activity.object?.type
      && activity.object.type !== 'Follow') return;
  // And it must NAME something. Widening the type test to admit a bare IRI
  // also admitted `object: undefined`, `null` and `{}` — which land on the
  // no-followId carve-out below and evict, which is the very hole the
  // followId check was added to close. An Undo that identifies nothing is
  // not an Undo of ours.
  const named = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  // A gateway-verified Undo need not name a stored id — the door proved the
  // sender, so an Undo{Follow} that names us as its object is enough. An
  // unverified one must still identify something (the eviction-hole guard).
  if (!named && !trusted) return;
  // Deliveries arrive unordered: an Undo may land AFTER the refollow it
  // predates. It names the Follow id it revokes — only honor it when it
  // matches the follow we currently hold for that actor.
  const undoneId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const contacts = intake.store.getContacts();
  const rec = contacts.followers.find(f => f.actor === actor);
  // Withdrawing a request that was never answered: drop it, or it sits in the
  // operator's queue forever asking about someone who left.
  if (!rec) {
    const reqs = intake.store.getRequests();
    const pending = reqs.find(r => r.actor === actor);
    if (pending) {
      // Bound the same way the follower eviction below is, and for the same
      // reason: `actor` is a field in an unsigned body, so without a match
      // anyone could withdraw anyone else's waiting request. The victim's
      // server believes the Follow is still pending and never resends, so
      // they simply never get followed and nobody sees why.
      const theirs = pending.activity?.id;
      if (!trusted && (!theirs || named !== theirs)) {
        intake.log(`Undo from ${actor} does not name the request we hold — ignored`);
        return;
      }
      intake.store.setRequests(reqs.filter(r => r.actor !== actor));
      await intake.republish({ pending: true });
      intake.log(`join request withdrawn: ${actor}`);
    }
    return;
  }
  // An Undo must NAME the Follow it revokes, and name the one we hold.
  //
  // The follow id is the ONLY thing binding an Undo to the follower. LDN
  // bodies carry no signature, and unlike every other inbound type this path
  // dereferences nothing, so there is no origin to disagree. Matching works
  // because the id was chosen by their server and delivered in a Follow we
  // accepted: we publish the followers collection, but never the ids.
  //
  // Which means a record with NO id cannot be matched at all — and the
  // carve-out that used to let those through turned "we cannot tell" into
  // "anyone may evict". reconcileFollowers writes exactly such records when a
  // restored machine recovers its followers from the pod, so after a restore
  // every follower could be removed by one unauthenticated POST, permanently:
  // dropFollower leaves a mark and the next reconcile will not bring them
  // back, their server recorded no unfollow so it never resends, and neither
  // side has anything to notice.
  //
  // Unmatchable is refused now. The cost is a follower who really did leave
  // staying on the list until the operator ejects them, which is the right way
  // round: `eject` is one command, and the alternative was silent, permanent,
  // and available to anyone.
  // A gateway-verified Undo carries the sender's proof, so it is honored on
  // its own — the followId match below exists only because an UNVERIFIED Undo
  // is otherwise unbindable. A verified one needs no such crutch.
  if (trusted) {
    dropFollower(contacts, actor, 'undo-follow');
    intake.store.setContacts(contacts);
    await intake.republish({ followers: true });
    intake.log(`unfollowed by ${actor} (gateway-verified)`);
    return;
  }
  if (!rec.followId) {
    intake.log(`Undo from ${actor} cannot be matched — this follower was `
      + `${rec.recovered ? 'recovered from the pod' : 'recorded before follow ids were kept'}, `
      + `so its follow id is unknown. Ignored; \`fedipod eject ${actor}\` if they did leave.`);
    return;
  }
  if (undoneId !== rec.followId) {
    intake.log(`Undo from ${actor} does not name the follow we hold `
      + `(revokes ${undoneId || 'nothing'}, current is ${rec.followId}) — ignored`);
    return;
  }
  dropFollower(contacts, actor, 'undo-follow');
  intake.store.setContacts(contacts);
  await intake.republish({ followers: true });
  intake.log(`unfollowed by ${actor}`);
}

export async function onCreate(intake, activity, actor) {
  const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!objectId) return 'Create without object id';
  if (intake.store.isBlocked(objectId)) return `blocked domain (${objectId})`;
  if (!intake.sameIdentity(objectId, actor)) return `object/actor identity mismatch (${objectId})`;
  // The delivered copy is untrusted for CONTENT, but its addressing is
  // enough to decide whether to bother fetching the origin's copy.
  const envelope = typeof activity.object === 'object' ? { ...activity, ...activity.object } : activity;
  if (!intake.concernsUs(envelope, actor)) return `not addressed to us (${objectId})`;
  // The check onAnnounce has had all along. A re-delivered Create — a remote
  // retry, a group fan-out, or our own sweep seeing an item whose DELETE was
  // refused — cost a fresh signed GET to the origin and rewrote the private
  // RDF note every time, because addStatus only dedupes AFTER the deref.
  // Gated around the INGEST alone: a group must still reach amplify below,
  // which is separately idempotent on announcedAt.
  // Only a status that came from an INGEST counts as already done. TagFeed
  // writes a bare `kind:'tag'` row straight into the index — no pod RDF note,
  // no mention notification, no replies-collection entry — so treating that
  // as ingested loses all three when the same note is then delivered to us.
  const ingested = intake.store.getStatuses()
    .some(x => x.noteId === objectId && (x.kind === 'timeline' || x.kind === 'mention'));
  if (!ingested) {
    const rejected = await intake.ingestNote(objectId, actor);
    if (rejected) return rejected;
  }
  // A group carries its members' posts onward. Only reached from Create, so an
  // inbound Announce is never re-announced. The activity is passed through
  // untouched — FEP-1b12 wants the original wrapped, not a summary of it.
  if (intake.config.kind === 'group') await intake.amplify(objectId, { activity });
}

// A boost: ingest the boosted note when the booster is someone we follow —
// that's what following means, their boosts widen the timeline. Anything
// else is unsolicited and only logged.
// A group we follow announces a Delete: the carrier moderating away a post
// it carried. Honored only within what the carry itself established — the
// announcer is a group we follow AND the post reached us via that same
// group — so no new party is trusted and nothing is dereferenced. Our own
// posts are never removed by anyone's moderation.
export async function onAnnouncedDelete(intake, actor, del) {
  const followed = intake.store.getContacts().following.some(f => f.actor === actor && f.accepted);
  if (!followed) { intake.log(`announced Delete from unfollowed ${actor} — ignored`); return; }
  const targetId = typeof del.object === 'string' ? del.object : del.object?.id;
  if (!targetId) return 'announced Delete without an object';
  const s = intake.store.getStatuses().find(x => x.noteId === targetId);
  if (!s || s.kind === 'post' || s.via !== actor) return;
  await intake.forget(s);
  intake.log(`moderated away by ${actor}: ${targetId}`);
}

export async function onAnnounce(intake, activity, actor, objectId) {
  if (!objectId) return 'Announce without object id';
  const followed = intake.store.getContacts().following.some(f => f.actor === actor && f.accepted);
  if (!followed) { intake.log(`Announce from unfollowed ${actor} — ignored`); return; }
  if (intake.store.isBlocked(objectId)) return `blocked domain (${objectId})`;
  const existing = intake.store.getStatuses().find(s => s.noteId === objectId);
  if (existing) {
    // Known, but possibly as a lesser kind — a stranger's mention, a tag or
    // search mirror — none of which the home timeline shows. A carry from
    // someone we follow is exactly what promotes it there.
    if (!['timeline', 'post'].includes(existing.kind)) {
      intake.store.updateStatus(objectId, { kind: 'timeline', via: actor });
      intake.log(`promoted to timeline (carried by ${actor}): ${objectId}`);
    }
    return;
  }
  return intake.ingestNote(objectId, actor, { via: actor });
}

// Mastodon sends these constantly; ignoring them left deleted posts standing
// for good. Two guards, because a forged Delete would otherwise erase anyone's
// content: it must come from the object's own origin, and the object must
// really be gone there. An origin we cannot reach is a retry, never a delete.
export async function onDelete(intake, activity, actor) {
  const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!objectId) return 'Delete without object id';
  if (!intake.sameIdentity(objectId, actor)) return `Delete crosses identities (${objectId})`;
  // `objectId === actor` is NOT evidence we care: it is true of EVERY account
  // deletion, and Mastodon broadcasts those constantly. Taking it as known
  // meant a signed dereference to a stranger's server for each one.
  if (!intake.known(objectId)) return;                    // nothing of ours to remove
  const gone = await intake.isGone(objectId);
  if (gone === null) throw new Error(`cannot confirm ${objectId} is gone — will retry`);
  if (!gone) return `Delete for something still published (${objectId})`;

  if (objectId === actor) {                             // the account itself
    const contacts = intake.store.getContacts();
    dropFollower(contacts, actor, 'account-deleted');
    contacts.following = contacts.following.filter(f => f.actor !== actor);
    intake.store.setContacts(contacts);
    // One publish for the lot. Each forget() used to run its own
    // unrecordOutbox, and each of those republished the outbox — so a group
    // that had carried M of this actor's posts paid M full page sweeps for a
    // single inbox item. The Undo deliveries stay per-Announce, because each
    // Announce needs its own; only the pod write is collected.
    const retracted = [];
    for (const s of intake.store.getStatuses().filter(s => s.actor === actor)) {
      await intake.forget(s, { collect: retracted });
    }
    if (retracted.length) {
      const gone = new Set(retracted);
      await intake.publisher.unrecordOutbox(i => gone.has(i?.id));
    }
    // Both: an account deletion drops them from followers AND following.
    await intake.republish({ followers: true, following: true });
    intake.log(`account deleted upstream: ${actor}`);
    return;
  }
  const s = intake.store.getStatuses().find(x => x.noteId === objectId);
  if (s) await intake.forget(s);
  intake.log(`deleted upstream: ${objectId}`);
}

// An edited post, or a changed profile. Verified the only way we can: by
// refetching at the origin and believing that, not the delivered copy.
export async function onUpdate(intake, activity, actor) {
  const objectId = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  if (!objectId) return 'Update without object id';
  if (!intake.sameIdentity(objectId, actor)) return `Update crosses identities (${objectId})`;
  if (objectId === actor) {                             // display name, avatar, bio
    // The same guard onDelete has, for the same reason: the inbox is
    // public-Append, so without it anyone can name any host and make us spend
    // a signed GET on it — and because the failure below THROWS rather than
    // returning a rejection, one planted item buys five of them, plus five
    // pod reads and the head of the inbox held for five sweeps.
    if (!intake.known(actor)) return;                     // nothing of ours to update
    const doc = await intake.fetchAP(actor);
    if (!doc) throw new Error(`cannot refetch ${actor} — will retry`);
    intake.store.cacheActor(actor, doc);                  // fetchAP caches Persons; Groups too
    intake.log(`profile updated: ${actor}`);
    return;
  }
  const s = intake.store.getStatuses().find(x => x.noteId === objectId);
  if (!s) return;                                       // not one we hold
  const note = await intake.fetchAP(objectId);
  if (!note) throw new Error(`cannot refetch ${objectId} — will retry`);
  if (note.id !== objectId || !isContentType(note.type)) return `object not verifiable content (${objectId}, ${note.type})`;
  const { attachmentsOf, titledContent } = await import('../wire.mjs');
  const content = titledContent(note);
  const attachments = attachmentsOf(note);
  const freshPoll = pollOf(note);
  const freshEmojis = emojisOf(note);
  intake.store.updateStatus(objectId, {
    content, ...(attachments.length ? { attachments } : {}),
    emojis: freshEmojis.length ? freshEmojis : undefined,
    // The edit's own stamp when the note carries one; tallies and the
    // content warning follow the edit too. A poll refresh keeps our vote.
    editedAt: note.updated || new Date().toISOString(),
    spoiler: note.summary ? String(note.summary).replace(/<[^>]*>/g, '') : undefined,
    ...(freshPoll ? {
      poll: { ...freshPoll, voted: !!s.poll?.voted, ownVotes: s.poll?.ownVotes || [] },
    } : {}),
  });
  intake.log(`edited upstream: ${objectId}`);
}

// The other answer to a Follow, and it was dropped on the floor. Their server
// has recorded that we do not follow them; ours went on saying we did, and
// published it — so the two disagreed permanently, and a retry would never
// come because as far as they are concerned the question was answered.
//
// It has to answer the Follow we actually SENT. Only the type was checked, so
// one Append per account you follow — from anyone, naming no particular
// follow — severed every one of them at once, and silently: their server
// never hears about it, so nothing ever retries and nothing looks wrong until
// the timeline goes quiet. `followActivity` is stored by followActor
// (lib/social.mjs) for exactly this kind of comparison.
export async function onReject(intake, activity, actor, { trusted = false } = {}) {
  if (activity.object?.type && activity.object.type !== 'Follow') return;
  const contacts = intake.store.getContacts();
  const rec = contacts.following.find(f => f.actor === actor);
  if (!rec) return;                                   // nothing of ours to undo
  const named = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const ours = rec.followActivity?.id;
  // A gateway receipt bound to this actor is the other way to believe it —
  // the door checked a signature and said whose (see receiptVouchesFor).
  if (!trusted) {
    if (!ours) {
      intake.log(`Reject from ${actor}: no follow id on record to match it against — ignored`);
      return;
    }
    if (named !== ours) {
      intake.log(`Reject from ${actor} answers ${named || 'nothing'}, not the follow we sent — ignored`);
      return;
    }
  }
  contacts.following = contacts.following.filter(f => f.actor !== actor);
  intake.store.setContacts(contacts);
  await intake.republish({ following: true, pending: true });
  intake.log(`follow rejected by ${actor}`);
}

// Someone we follow has moved. Their server will stop delivering from the old
// actor, so without this we keep an entry that can never produce another post
// and never learn where they went. The new account is not followed
// automatically — that is a Follow only the owner should send — but it is
// recorded and raised, so it can be acted on.
export async function onMove(intake, activity, actor) {
  const target = typeof activity.target === 'string' ? activity.target : activity.target?.id;
  if (!target) return 'Move without a target';
  const contacts = intake.store.getContacts();
  const rec = contacts.following.find(f => f.actor === actor);
  if (!rec) return;                                   // not someone we follow
  // Believed only if the actor we follow says so at its OWN origin: a Move is
  // otherwise a redirect anyone could Append.
  const doc = await intake.fetchAP(actor);
  if (!doc) throw new Error(`cannot confirm ${actor} moved — will retry`);
  const movedTo = typeof doc.movedTo === 'string' ? doc.movedTo : doc.movedTo?.id;
  if (movedTo !== target) return `Move not corroborated by ${actor} (says ${movedTo || 'nothing'})`;
  rec.movedTo = target;
  intake.store.setContacts(contacts);
  intake.store.addNotification({ type: 'move', actor, target });
  intake.log(`${actor} moved to ${target} — follow the new account to keep seeing them`);
}

export async function onAccept(intake, activity, actor, { trusted = false } = {}) {
  const contacts = intake.store.getContacts();
  const rec = contacts.following.find(f => f.actor === actor);
  // It has to answer the Follow we actually sent. followActor stores that
  // activity for the later Undo, so the id is here to compare against; without
  // the check any Accept from an actor we happen to follow flips the flag,
  // including one answering a Follow we never made.
  const named = typeof activity.object === 'string' ? activity.object : activity.object?.id;
  const ours = rec?.followActivity?.id;
  // `named &&` used to be part of this, so an Accept naming NOTHING sailed
  // past — which is the easy one to send, and it marks a request to a locked
  // account as accepted when it is still sitting in their queue.
  if (ours && named !== ours && !trusted) {
    intake.log(`Accept from ${actor} answers ${named || 'nothing'}, not the follow we sent — ignored`);
    return;
  }
  if (rec && !rec.accepted) {
    rec.accepted = true;
    intake.store.setContacts(contacts);
    await intake.republish({ following: true, pending: true });
    intake.log(`follow accepted by ${actor}`);
  }
}
