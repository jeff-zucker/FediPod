// collection.mjs — the mechanics every AS2 collection on a pod shares.
//
// Not a resource itself: the outbox, the followers list and the block list are
// each their own document with their own meaning, and each has a module that
// says so. What they have in common is how a collection is written and walked,
// and that is here so it is written once.
//
// A paged collection is a HEAD carrying counts and bounds, plus page documents
// carrying the items. A remote server reads the small head and walks only as
// far as it needs, instead of pulling one enormous document.

const PUBLIC_READ = ['Read'];

/**
 * One page.
 *
 * `publicRead` is false for a page that already exists: the ACL is set when a
 * page is first created and not rewritten on every republish, because a page
 * is written on every change and its rule is not what changed.
 */
export async function writePage(pod, pageUrl, doc, { publicRead = false } = {}) {
  await pod.putJson(pageUrl, doc);
  if (publicRead) await pod.setAcl(pageUrl, PUBLIC_READ);
}

/** The head — counts, bounds, and the pointer at the first page. */
export async function writeHead(pod, url, doc, { publicRead = false } = {}) {
  await pod.putJson(url, doc);
  if (publicRead) await pod.setAcl(url, PUBLIC_READ);
}

/**
 * Remove a page that is no longer within bounds.
 *
 * Best-effort: a surplus page left behind is stale but harmless — the head no
 * longer points at it — where a failed publish over a delete is not.
 */
export async function dropPage(pod, pageUrl) {
  await pod.delete(pageUrl).catch(() => {});
}

/** A whole flat collection, written as one document. */
export async function writeFlat(pod, url, doc, { publicRead = false } = {}) {
  await pod.putJson(url, doc);
  if (publicRead) await pod.setAcl(url, PUBLIC_READ);
}

/**
 * Every item in a published collection, walking pages.
 *
 * Also reads a FLAT collection, so a collection published before this project
 * paged them is still readable — which matters because a rebuild reads these
 * to recover what a lost machine no longer has.
 *
 * `seen` guards a cycle and `max` a collection that lies about its own size;
 * both are the pod's data but not necessarily ours, since a restored backup or
 * a half-finished write can leave either.
 *
 * @returns items, or null when there is no collection there at all
 */
export async function readPaged(pod, headUrl, { max = 10_000, alsoItems = false } = {}) {
  const head = await pod.getJson(headUrl).catch(() => null);
  if (!head) return null;
  if (Array.isArray(head.orderedItems) && head.orderedItems.length) return head.orderedItems;
  if (alsoItems && Array.isArray(head.items) && head.items.length) return head.items;
  const items = [];
  const seen = new Set();
  let next = head.first;
  while (next && !seen.has(next) && items.length < max) {
    seen.add(next);
    const page = await pod.getJson(next).catch(() => null);
    if (!page) break;
    items.push(...(page.orderedItems || []));
    next = page.next;
  }
  return items;
}
