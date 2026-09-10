// notes.mjs — ap/notes/: the posts themselves, and the two documents each one
// drags with it.
//
// A published post is not one document. It is the Note, the Create activity
// that announced it, and a replies collection remote servers will dereference
// — and they have different lifetimes, which is the whole reason this file
// exists. Deleting a post REPLACES the Note with a Tombstone (a peer learns
// the post was deleted, rather than getting a bare 404 it reads as a temporary
// failure) while DELETING the Create outright, because the Create was an
// action that has been withdrawn rather than an object that still exists.
//
// The container is public-Read and the notes inherit it. The Tombstone is the
// exception that has to state its own rule: a private post lives in a
// different, owner-only container, so there is nothing public to inherit.

const PUBLIC_READ = ['Read'];

// ---- the owner's agent ----

/** The notes container itself, public-Read so everything under it inherits. */
export async function provisionContainer(pod, urls) {
  await pod.putJson(urls.notes + '.keep', { keep: true }, 'application/json');
  await pod.setAcl(urls.notes, PUBLIC_READ);
}

/** The Note. Inherits the container's rule; states none of its own. */
export const write = (pod, noteId, doc) => pod.putJson(noteId, doc);

/** The Create that announced it — its own document, at a derived id. */
export const writeCreate = (pod, createId, doc) => pod.putJson(createId, doc);

/**
 * An empty replies collection, written with the note.
 *
 * Remote servers dereference `replies`, and a dangling pointer that 404s is
 * worse than no pointer at all.
 */
export const writeEmptyReplies = (pod, repliesId, doc) => pod.putJson(repliesId, doc);

/** The replies collection as it stands. */
export const readReplies = (pod, repliesId) => pod.getJson(repliesId);
export const writeReplies = (pod, repliesId, doc) => pod.putJson(repliesId, doc);

/** One published note, as the pod currently serves it. */
export const read = (pod, noteId) => pod.getJson(noteId);

/**
 * Replace a note with a Tombstone, and keep it readable.
 *
 * The Read rule is stated explicitly here even though the public container
 * grants it: a private or direct post lives in the owner-only container, and
 * its Tombstone still has to be fetchable by the servers being told about the
 * deletion.
 */
export async function writeTombstone(pod, noteId, doc) {
  await pod.putJson(noteId, doc);
  await pod.setAcl(noteId, PUBLIC_READ);
}

/** Withdraw the Create. Returns whether the pod actually removed it. */
export const dropCreate = (pod, createId) => pod.delete(createId).catch(() => false);

/** The replies collection, once the note it belonged to is gone. */
export const dropReplies = (pod, repliesId) => pod.delete(repliesId).catch(() => {});

/**
 * What the container holds, with the derived documents filtered out.
 *
 * A listing returns the Note, its `-create` and its `-replies` alike; only the
 * first is a post, and handing the other two to a reader that expects posts
 * produces failures that read like corruption.
 */
export async function list(pod, urls) {
  const children = await pod.listContainer(urls.notes);
  return children
    .filter((c) => !/(-create|-replies)$/.test(c.url) && !c.url.endsWith('.keep'))
    // A defensive copy: the transport hands back the same array on a 304, so a
    // caller that sorts in place would corrupt it for every later reader.
    .map((c) => ({ ...c }));
}
