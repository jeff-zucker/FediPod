// outbox.mjs — ap/outbox: everything this actor has published, paged.
//
// Public by definition, and read by strangers rather than by us: a remote
// server walks it to backfill an account it has just met. It is also what a
// rebuild reads to recover posts a lost machine no longer has, which is why
// readPublished tolerates the flat shape this project used to write.

import * as collection from './collection.mjs';

// ---- the owner's agent ----

export const writePage = (pod, pageUrl, doc, opts) => collection.writePage(pod, pageUrl, doc, opts);
export const writeHead = (pod, urls, doc, opts) => collection.writeHead(pod, urls.outbox, doc, opts);
export const dropPage = (pod, pageUrl) => collection.dropPage(pod, pageUrl);

/** Every activity the pod currently publishes, or null if it publishes none. */
export const readPublished = (pod, urls) =>
  collection.readPaged(pod, urls.outbox, { max: 10_000 });
