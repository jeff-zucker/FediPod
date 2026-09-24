// own.mjs — the outbox as its owner reads it, and the owner's liked list.
//
// The public outbox is what a stranger may see: posts and boosts, and what
// withdrew them. ActivityPub's outbox is every message the actor produced,
// filtered by who is asking (§5.1), so its owner is owed the rest as well —
// likes, follows, undos, follower decisions, followers-only and direct posts.
// That view lives in the private container, whose owner-only rule it inherits,
// and is what the outbox address answers its signed-in owner.
//
// Everything this actor sends passes through the deliverer, which hands each
// fresh activity here (Deliverer.onSent), so nothing has to remember to record
// itself. What is never sent — a block or a pin posted by a client — is
// recorded by the client-to-server dispatcher.
//
// `liked` (§5.5) is the objects this actor has liked and not taken back,
// kept beside it under the same rule.

import crypto from 'node:crypto';
import * as wire from '../wire.mjs';
import * as collection from '../../pod/collection.mjs';

const OWN = 'outbox-own.json';
const LIKED = 'liked.json';

// A Create is kept by its object's id, as the public outbox keeps it, so the
// two can be matched when a post is withdrawn; anything else is kept whole.
const localForm = (a) => (a?.type === 'Create' && (typeof a.object === 'string' ? a.object : a.object?.id)) || a;

export function recordOwn(publisher, activity) {
  const { urls, store } = publisher;
  if (!activity?.type || activity.actor !== urls.actor) return false;
  const item = localForm(activity);
  const id = wire.outboxItemId(item);
  const own = store.read(OWN, []);
  if (id && own.some(i => wire.outboxItemId(i) === id)) return false;   // a retry, or said twice
  own.unshift(item);
  store.write(OWN, own);
  if (activity.type === 'Like' || (activity.type === 'Undo' && activity.object?.type === 'Like')) {
    backfillLiked(publisher);
    const object = wire.outboxItemId(activity.type === 'Like' ? activity.object : activity.object.object);
    if (object) {
      const liked = store.read(LIKED, []).filter(o => o !== object);
      if (activity.type === 'Like') liked.unshift(object);
      store.write(LIKED, liked);
    }
  }
  schedule(publisher);
  return true;
}

// An account that liked things before the list existed: the likes it still
// holds (a timeline row marked favourited, with the Like that was sent) are
// its liked list to begin with. Once only — a list that exists, even empty,
// is the record from then on.
export function backfillLiked(publisher) {
  const { store } = publisher;
  if (store.read(LIKED, null) !== null) return 0;
  const liked = (store.getStatuses?.() || [])
    .filter(s => s.favourited && s.noteId)
    .sort((x, y) => String(y.published || '').localeCompare(String(x.published || '')))
    .map(s => s.noteId);
  store.write(LIKED, [...new Set(liked)]);
  schedule(publisher);
  return liked.length;
}

// A post deleted or a boost withdrawn leaves the owner's view as it leaves the
// public one; the Delete or Undo that did it is already recorded, having been
// sent.
export function unrecordOwn(publisher, matches) {
  const own = publisher.store.read(OWN, []);
  const kept = own.filter(i => !matches(i));
  if (kept.length === own.length) return;
  publisher.store.write(OWN, kept);
  schedule(publisher);
}

// Recording never waits on the pod: a like is answered when it is sent, and
// the pages follow. One publish at a time, the last one covering every record
// made while it waited.
function schedule(publisher) {
  if (publisher._ownQueued) return;
  publisher._ownQueued = true;
  publisher._ownChain = (publisher._ownChain || Promise.resolve()).then(async () => {
    publisher._ownQueued = false;
    try { await publishOwn(publisher); }
    catch (e) { publisher.log?.(`owner's outbox view not published: ${e.message}`); }
  });
}

export function ownSettled(publisher) { return publisher._ownChain || Promise.resolve(); }

export async function publishOwn(publisher) {
  const { urls, store, remote } = publisher;
  const seen = store.read('published.json', {});
  const own = store.read(OWN, []);
  const out = wire.outboxPaging(own, seen.ownIndex || []);
  const ownPages = await writePages(remote, seen.ownPages, out.pages.map((items, i) => ({
    id: wire.outboxPageId(urls.ownOutbox, i + 1), doc: wire.outboxPage(urls.ownOutbox, i + 1, items),
  })));
  await collection.writeHead(remote, urls.ownOutbox, wire.outboxHead(urls.ownOutbox, own.length, out.pages.length));

  const liked = store.read(LIKED, []);
  const lk = wire.followersPaging(liked, seen.likedIndex || []);
  const likedPages = await writePages(remote, seen.likedPages, lk.pages.map((items, i) => ({
    id: wire.followersPageId(urls.liked, i + 1), doc: wire.followersPage(urls.liked, i + 1, items, lk.pages.length),
  })));
  await collection.writeHead(remote, urls.liked, wire.followersHead(urls.liked, liked.length, lk.pages.length));

  store.write('published.json', { ...store.read('published.json', {}),
    ownPages, ownIndex: out.index, likedPages, likedIndex: lk.index });
}

// Only the pages that changed, and none past the new end. No rule is written:
// the private container's owner-only rule is inherited.
async function writePages(remote, before = {}, pages) {
  const after = {};
  for (const [i, { id, doc }] of pages.entries()) {
    const n = i + 1;
    after[n] = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
    if (before[n] !== after[n]) await collection.writePage(remote, id, doc);
  }
  for (const n of Object.keys(before).map(Number).filter(n => Number.isFinite(n) && n > pages.length)) {
    await collection.dropPage(remote, pages[0].id.replace(/-\d+$/u, `-${n}`));
  }
  return after;
}
