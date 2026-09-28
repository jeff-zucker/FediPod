// received.mjs — the inbox as its owner reads it (ActivityPub §5.2): every
// delivery the account accepted, kept on the pod as a paged OrderedCollection
// in the private container, beside the archive that keeps each delivery's
// bytes. The door and the agent's own /ap/inbox serve these documents.
//
// Pages fill from the oldest end, PAGE_SIZE to a page, and a full page is
// never written again: an accepted delivery rewrites the newest page and the
// small head, and nothing else. Activities ride inline, so a reader gets what
// arrived without a fetch per item — a Like or a Follow has no address its
// origin answers anyway. Past ITEM_MAX_CHARS the item is the activity's id
// alone, so one enormous delivery cannot make a page of them enormous.
//
// §5.2 also says an activity delivered twice is listed once. The archive
// already collapses identical bytes; this keeps the last SEEN_MAX ids and
// drops a repeat that arrived with different addressing.
//
// Written only while the archive is on — an owner who chose not to keep what
// arrives keeps nothing here either — and only once the private container is
// proved private, the bar every owner-only document clears. Recorded meanwhile,
// and published the first time the bar is met.

import * as wire from '../wire.mjs';
import * as collection from '../../pod/collection.mjs';

export const PAGE_SIZE = wire.FOLLOWERS_PAGE_SIZE;
export const SEEN_MAX = 500;
export const ITEM_MAX_CHARS = 32 * 1024;
// Recorded but unpublished items are held in state; past this many the oldest
// are let go (the archive still has them) rather than growing state forever.
const HELD_MAX = PAGE_SIZE * 5;
const RECEIVED = 'received.json';

const fresh = () => ({ sealed: 0, open: [], total: 0, seen: [] });

const keeps = (intake) => !!intake.archive && !!intake.urls?.ownInbox
  && intake.store.getConfig?.()?.archiveInbox !== false;

/** Record one accepted delivery. False when it was a repeat, or nothing is kept. */
export function recordReceived(intake, activity) {
  if (!keeps(intake) || !activity || typeof activity !== 'object') return false;
  const st = { ...fresh(), ...intake.store.read(RECEIVED, {}) };
  const id = typeof activity.id === 'string' ? activity.id : null;
  if (id && st.seen.includes(id)) return false;
  st.open.push(id && JSON.stringify(activity).length > ITEM_MAX_CHARS ? id : activity);
  if (st.open.length > HELD_MAX) st.open.splice(0, st.open.length - HELD_MAX);
  st.total += 1;
  if (id) {
    st.seen.push(id);
    if (st.seen.length > SEEN_MAX) st.seen.splice(0, st.seen.length - SEEN_MAX);
  }
  intake.store.write(RECEIVED, st);
  intake._receivedDirty = true;
  return true;
}

/** Write what was recorded since the last publish: the newest page(s) and the head. */
export async function publishReceived(intake) {
  if (!intake._receivedDirty || !keeps(intake)) return;
  const ready = intake.publisher?.privateReady;
  if (typeof ready === 'function' && await ready.call(intake.publisher) !== true) return;
  const { remote, urls } = intake;
  const st = { ...fresh(), ...intake.store.read(RECEIVED, {}) };
  // Every full page first (several when the bar was met late), then the open one.
  do {
    const n = st.sealed + 1;
    const items = st.open.slice(0, PAGE_SIZE);
    await collection.writePage(remote, wire.followersPageId(urls.ownInbox, n),
      wire.followersPage(urls.ownInbox, n, items, n));
    if (items.length < PAGE_SIZE) break;
    st.sealed = n;
    st.open = st.open.slice(PAGE_SIZE);
    intake.store.write(RECEIVED, st);
  } while (st.open.length);
  const pages = Math.max(1, st.sealed + (st.open.length ? 1 : 0));
  await collection.writeHead(remote, urls.ownInbox, wire.followersHead(urls.ownInbox, st.total, pages));
  intake.store.write(RECEIVED, st);
  intake._receivedDirty = false;
}
