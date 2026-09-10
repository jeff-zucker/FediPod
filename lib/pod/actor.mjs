// actor.mjs — ap/actor and the documents that speak for it.
//
// "Actor" here always means the ActivityPub actor DOCUMENT — the thing remote
// servers fetch to learn this identity's inbox, keys and collections. It is
// not the party performing an operation; a transport carries that as its
// `role`.
//
// The actor is public, and its Read rule travels with every write for the same
// reason it does in discovery.mjs: an actor nobody can fetch is an identity
// nobody can follow, and the failure is silent from this side.

const PUBLIC_READ = ['Read'];

// ---- the owner's agent ----

/** Publish the actor document. */
export async function write(pod, urls, doc) {
  await pod.putJson(urls.actor, doc);
  await pod.setAcl(urls.actor, PUBLIC_READ);
}

/** What this pod currently publishes as its actor, or null if nothing does. */
export function read(pod, urls) {
  return pod.getJson(urls.actor);
}

/**
 * Replace the actor with a Tombstone.
 *
 * Still public-Read, deliberately: a retired actor that 404s reads to a remote
 * server as a temporary failure worth retrying, where a Tombstone reads as an
 * answer.
 */
export async function writeTombstone(pod, urls, doc) {
  await pod.putJson(urls.actor, doc);
  await pod.setAcl(urls.actor, PUBLIC_READ);
}

/**
 * Publish the actor carrying `movedTo`.
 *
 * The same document in the same place — but named apart from `write` because
 * what it means is not "the profile changed", it is "this identity is now
 * somewhere else", and a caller should have to say which it intends.
 */
export async function writeMoved(pod, urls, doc) {
  await pod.putJson(urls.actor, doc);
  await pod.setAcl(urls.actor, PUBLIC_READ);
}

/** The human half: a page a person can open and follow from. */
export async function writeProfilePage(pod, urls, html) {
  await pod.put(urls.profileHtml, html, 'text/html');
  await pod.setAcl(urls.profileHtml, PUBLIC_READ);
}

/**
 * Record the actor in the pod owner's WebID profile, as `foaf:account`.
 *
 * The inverse of the actor's own `alsoKnownAs`: together they let a reader of
 * either document verify the other, rather than taking one side's word.
 *
 * Delegated to the transport, which reads the profile, refuses to write if the
 * parsed graph does not mention the WebID, and patches exactly the statements
 * involved rather than rewriting a document full of things that are not ours.
 */
export function linkInWebIdProfile(pod, { actorUrl, accountName, kind = 'person' }) {
  return pod.linkAccountInProfile({ actorUrl, accountName, kind });
}

// ---- anyone at all ----

/**
 * The OIDC issuer a published actor names, read without credentials.
 *
 * Asked of a stranger's pod during sign-in, before there is any session to ask
 * with — so a plain fetch, and a null rather than a throw when the actor is
 * not there or says nothing.
 */
export async function readIssuer(actorUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(actorUrl, { headers: { accept: 'application/activity+json' } });
    if (res.status >= 400) return null;
    const doc = await res.json();
    return doc?.endpoints?.oauthAuthorizationEndpoint || null;
  } catch { return null; }
}
