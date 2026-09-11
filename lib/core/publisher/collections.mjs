// collections.mjs — the actor's published collections: the paged outbox and
// followers, following, featured, and the owner-only pending and blocked
// lists; and the outbox record a post or a boost goes into.

import crypto from 'node:crypto';
import * as wire from '../wire.mjs';
import * as podOutbox from '../../pod/outbox.mjs';
import * as podFollowers from '../../pod/followers.mjs';
import * as podFollowing from '../../pod/following.mjs';
import * as podFeatured from '../../pod/featured.mjs';
import * as podPrivate from '../../pod/private.mjs';

// The default for publishCollections: the whole public surface, ACLs included.
// A caller that knows what it changed narrows it; a caller that says nothing
// still gets everything, so a missed call site degrades to the old cost rather
// than silently publishing nothing.
export const ALL_COLLECTIONS = { followers: true, following: true, outbox: true, acls: true,
  pending: true, blocked: true };

// Publish the collections a change actually TOUCHED.
//
// Publishing all three on every follower event cost nine pod requests where
// two do: two reconcile reads, three collection PUTs, and three ACL PUTs
// whose bodies are a pure function of the WebID and the target URL and so
// are byte-identical to the ones written at setup. A new follower does not
// change what this actor follows, and it does not change the outbox.
//
// `acls` is true only on the default path, which is publishProfile: that is
// where the public surface is built, and where verifyPublicSurface already
// checks the world can read it.
//
// Reconciliation stays welded to the collection it guards. It is what stops a
// restored-and-behind machine publishing a short list over the pod's longer
// one — erasing followers it would then stop delivering to, and erasing the
// outbox that `rebuild` reads as its index — so a narrowed publish still runs
// the one belonging to whatever it is about to overwrite.
// Publish only the pages that actually changed.
//
// `known` is what we last wrote, so a post rewrites the newest page and the
// head and nothing else — where the flat collection rewrote the actor's whole
// history on every post. A page gets its ACL when it is first created; the
// container above it is owner-only, so it cannot be inherited.
// `force` is for the caller that publishes BECAUSE the pod does not have what
// the digests say it has. Without it a repair republish rewrote the head and
// skipped every page — the digests still matched the local record — so the
// head advertised a `first:` that 404s, readPublishedOutbox came back empty,
// rebuildStatuses recovered nothing, and the whole thing logged success. That
// happens to an actor with one post as surely as one with five thousand.
export async function publishOutbox(publisher, outbox, { acls = false, force = false } = {}) {
  const { urls } = publisher;
  const seen = publisher.store.read('published.json', {});
  const { pages, index } = wire.outboxPaging(outbox, seen.outboxIndex || []);
  const before = force ? {} : (seen.outboxPages || {});
  const after = {};
  let wrote = 0;

  for (let i = 0; i < pages.length; i++) {
    const n = i + 1;                                   // 1 = oldest
    const doc = wire.outboxPage(urls.outbox, n, pages[i]);
    const digest = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
    after[n] = digest;
    if (before[n] === digest) continue;                // sealed and unchanged
    await podOutbox.writePage(publisher.remote, wire.outboxPageId(urls.outbox, n), doc,
      { publicRead: !before[n] || acls });
    wrote++;
  }
  // Pages above the new count are orphans: the outbox shrank past them, and
  // left where they were they keep serving activities that have been taken
  // back. The head no longer points at them, so nothing walks to them — but
  // the URL is guessable and public.
  const stale = Object.keys(seen.outboxPages || {}).map(Number)
    .filter(n => Number.isFinite(n) && n > pages.length);
  for (const n of stale) {
    await podOutbox.dropPage(publisher.remote, wire.outboxPageId(urls.outbox, n));
  }
  // The head carries totalItems, so it moves whenever the outbox does. Four
  // lines, and constant however much you have posted.
  await podOutbox.writeHead(publisher.remote, urls,
    wire.outboxHead(urls.outbox, outbox.length, pages.length), { publicRead: acls });
  publisher.store.write('published.json',
    { ...publisher.store.read('published.json', {}), outboxPages: after, outboxIndex: index });
  return wrote;
}

// Every activity in the published outbox, walking the pages. Also understands
// the flat collection this used to write, so an actor published before paging
// is still readable — which matters because rebuild reads this to recover
// posts a lost machine no longer has.
export function readPublishedOutbox(publisher) { return podOutbox.readPublished(publisher.remote, publisher.urls); }

// The followers collection, paged like the outbox: a head that carries only
// the count and the page bounds, and page documents holding the actor IRIs —
// so a remote server reads a small head and walks pages instead of pulling one
// document that grows without limit. Regenerated from the in-memory follow
// graph: a follow extends the newest page and an unfollow leaves its page one
// short (wire.pageItems), so only the pages that changed are rewritten.
export async function publishFollowers(publisher, actors, { acls = false, force = false } = {}) {
  const { urls } = publisher;
  const seen = publisher.store.read('published.json', {});
  const { pages, index } = wire.followersPaging(actors, seen.followersIndex || []);
  const before = force ? {} : (seen.followersPages || {});
  const after = {};

  for (let i = 0; i < pages.length; i++) {
    const n = i + 1;
    const doc = wire.followersPage(urls.followers, n, pages[i], pages.length);
    const digest = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
    after[n] = digest;
    if (before[n] === digest) continue;                // unchanged page
    await podFollowers.writePage(publisher.remote, wire.followersPageId(urls.followers, n), doc,
      { publicRead: !before[n] || acls });
  }
  // Pages the collection shrank past would keep serving names that no longer
  // follow; the head stops pointing at them but the URL is guessable.
  const stale = Object.keys(seen.followersPages || {}).map(Number)
    .filter(n => Number.isFinite(n) && n > pages.length);
  for (const n of stale) {
    await podFollowers.dropPage(publisher.remote, wire.followersPageId(urls.followers, n));
  }
  await podFollowers.writeHead(publisher.remote, urls,
    wire.followersHead(urls.followers, actors.length, pages.length), { publicRead: acls });
  publisher.store.write('published.json',
    { ...publisher.store.read('published.json', {}), followersPages: after, followersIndex: index });
}

// Every actor in the published followers collection, walking pages. Also reads
// the flat collection this used to write, so an actor published before paging
// still reconciles.
export function readPublishedFollowers(publisher) { return podFollowers.readPublished(publisher.remote, publisher.urls); }

export async function publishCollections(publisher, which = ALL_COLLECTIONS) {
  const { urls } = publisher;
  const contacts = publisher.store.getContacts();
  if (which.followers) {
    // Reconcile walks the published pages, so — like the outbox — pay for it
    // only when the local record of what is up there is missing (a restore or
    // a copied machine), not on every ordinary save.
    const knownF = publisher.store.read('published.json', {}).followersIndex;
    if (which.force || !Array.isArray(knownF)) await publisher.reconcileFollowers(contacts);
    // Bluesky-only members are not AP actors; the published collection
    // lists only what a remote server could dereference.
    const actors = contacts.followers.filter(f => !f.bsky).map(f => f.actor);
    await publisher.publishFollowers(actors, { acls: which.acls, force: which.force });
  }
  if (which.following) {
    await podFollowing.write(publisher.remote, urls,
      wire.orderedCollection(urls.following, contacts.following.filter(f => f.accepted).map(f => f.actor)),
      { publicRead: which.acls });
  }
  if (which.pending) await publisher.publishPending();
  if (which.blocked) await publisher.publishBlocked();
  if (which.outbox) {
    const outbox = publisher.store.read('outbox.json', []);
    // Reconcile reads every published page, which is the expensive part of a
    // profile save. It is worth paying only when we are about to write pages
    // we did not write: on a repair, or on a machine whose state no longer
    // records what it put up there — which is exactly the restored backup the
    // reconcile exists for. With an intact record our copy IS what the pod
    // has, and re-reading it to confirm that is a page walk for nothing.
    const known = publisher.store.read('published.json', {}).outboxIndex;
    if (which.force || !Array.isArray(known)) await publisher.reconcileOutbox(outbox);
    await publisher.publishOutbox(outbox, { acls: which.acls, force: which.force });
  }
}

// FEP-4ccd: the follows in limbo, as owner-only collections of the Follow
// activities themselves. Inside the private container so its ACL is
// inherited — and published only where that ACL provably holds, the same
// bar private posts clear. A Bluesky-only request has no Follow activity a
// remote server could ever act on, so it is not listed.
export async function publishPending(publisher) {
  if (await publisher.privateReady() !== true) return;
  const { urls } = publisher;
  const contacts = publisher.store.getContacts();
  await podPrivate.writePending(publisher.remote, urls, {
    followers: wire.orderedCollection(urls.pendingFollowers,
      publisher.store.getRequests().filter(r => r.activity && !r.bsky).map(r => r.activity)),
    following: wire.orderedCollection(urls.pendingFollowing,
      contacts.following.filter(f => !f.accepted && f.followActivity)
        .map(f => f.followActivity).reverse()),
  });
}

// FEP-c648: the blocked actors, as an owner-only collection. Actors only —
// domain blocks are ours, and the FEP does not carry them.
export async function publishBlocked(publisher) {
  if (await publisher.privateReady() !== true) return;
  const { urls } = publisher;
  const actors = [...(publisher.store.getBlocklist().actors || [])].reverse();
  await podPrivate.writeBlocked(publisher.remote, urls, wire.orderedCollection(urls.blocked, actors));
}

// The outbox is the public record of everything this actor has said, boosts
// included. A Create goes in as its note id, which dereferences; an Announce
// has only a fragment id, so the activity itself goes in the collection —
// legal AS2, and what Mastodon serves.
export async function recordOutbox(publisher, item) {
  const outbox = publisher.store.read('outbox.json', []);
  outbox.unshift(item);
  publisher.store.write('outbox.json', outbox);
  await publisher.publishOutbox(outbox);
}

// Taking something out of the outbox is a DECISION — a post deleted, a boost
// undone. It leaves a mark for the same reason dropFollower does: the pod's
// copy is rewritten right after, but a rewrite that fails would otherwise let
// the next reconcile put the entry back. Bounded, like the follower one.
export async function unrecordOutbox(publisher, matches) {
  const before = publisher.store.read('outbox.json', []);
  const outbox = before.filter(i => !matches(i));
  const gone = before.filter(i => matches(i))
    .map(i => (typeof i === 'string' ? i : i?.id)).filter(Boolean);
  if (gone.length) {
    const marks = publisher.store.read('outbox-removed.json', []).filter(r => !gone.includes(r.id));
    const at = new Date().toISOString();
    publisher.store.write('outbox-removed.json',
      [...marks, ...gone.map(id => ({ id, at }))].slice(-500));
  }
  publisher.store.write('outbox.json', outbox);
  await publisher.publishOutbox(outbox);
}

// The pinned posts, as the actor's featured collection — the one document a
// remote server reads when it shows this profile's pins.
export async function publishFeatured(publisher) {
  const ids = publisher.store.getStatuses().filter(s => s.kind === 'post' && s.pinned).map(s => s.noteId);
  await podFeatured.write(publisher.remote, publisher.urls, wire.orderedCollection(publisher.urls.featured, ids));
  return ids.length;
}
