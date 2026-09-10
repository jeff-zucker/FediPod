// discovery.mjs — the documents that make a handle resolve.
//
// These live at the HOST root, not in the actor's container, because that is
// the only place the fediverse looks: @name@host is resolved at
// https://host/.well-known/webfinger and nowhere else. A pod that does not own
// the root of its host can still publish them, but nothing will ever ask.
//
// Every one is public by definition — a discovery document nobody may read
// discovers nothing — so the Read rule is not a parameter here. It travels
// with the write because publishing one of these unreadable is a failure mode
// with an entire verification pass devoted to catching it.

const PUBLIC_READ = ['Read'];

// ---- the owner's agent ----

/** The JRD that answers `acct:name@host`. */
export async function writeWebfinger(pod, urls, jrd) {
  await pod.putJson(urls.webfinger, jrd, 'application/jrd+json');
  await pod.setAcl(urls.webfinger, PUBLIC_READ);
}

/** RFC 6415 host-meta: the LRDD template some implementations prefer. */
export async function writeHostMeta(pod, urls, xml) {
  const url = urls.base + '.well-known/host-meta';
  await pod.put(url, xml, 'application/xrd+xml');
  await pod.setAcl(url, PUBLIC_READ);
}

/**
 * NodeInfo, which is two documents: a pointer at the protocol-required root,
 * and the document itself in the actor's own tree.
 *
 * Four requests, one fact — "this pod answers nodeinfo". Split into separate
 * operations, a caller could write the pointer and not what it points at,
 * which is worse than neither.
 */
export async function writeNodeinfo(pod, urls, { pointer, doc }) {
  const pointerUrl = urls.base + '.well-known/nodeinfo';
  const docUrl = urls.home + 'ap/nodeinfo-2.0';
  await pod.putJson(pointerUrl, pointer, 'application/json');
  await pod.setAcl(pointerUrl, PUBLIC_READ);
  await pod.putJson(docUrl, doc, 'application/json');
  await pod.setAcl(docUrl, PUBLIC_READ);
  return docUrl;
}
