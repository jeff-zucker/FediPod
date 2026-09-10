// followers.mjs — ap/followers: who follows this actor, paged.
//
// Paged like the outbox, and for the same reason: a popular account's follower
// list is large, and a remote server should read a small head rather than pull
// all of it. Read back to reconcile — anyone the pod says follows us that we
// have no record of is a sign the local half is BEHIND the pod, and publishing
// blindly over them would drop them from the wire.

import * as collection from './collection.mjs';

// ---- the owner's agent ----

export const writePage = (pod, pageUrl, doc, opts) => collection.writePage(pod, pageUrl, doc, opts);
export const writeHead = (pod, urls, doc, opts) => collection.writeHead(pod, urls.followers, doc, opts);
export const dropPage = (pod, pageUrl) => collection.dropPage(pod, pageUrl);

/**
 * Every follower the pod currently publishes, or null if it publishes none.
 *
 * `alsoItems`, unlike the outbox: the flat followers collection this project
 * used to write put them under `items` rather than `orderedItems`.
 */
export const readPublished = (pod, urls) =>
  collection.readPaged(pod, urls.followers, { max: 100_000, alsoItems: true });
