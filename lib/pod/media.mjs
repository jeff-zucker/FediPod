// media.mjs — ap/media/: the bytes an attachment points at.
//
// The only tree here holding things that are not documents. Public-Read,
// because an attachment url travels inside a post to servers that will fetch
// it without credentials — and unlike an actor or a note, nothing checks that
// the url belongs to the identity that posted it, which is why media stays on
// the pod even for an identity whose ids are advertised elsewhere: proxying
// blobs would be pure cost for no verification gained.

const PUBLIC_READ = ['Read'];

// ---- the owner's agent ----

export async function provisionContainer(pod, urls) {
  await pod.putJson(urls.media + '.keep', { keep: true }, 'application/json');
  await pod.setAcl(urls.media, PUBLIC_READ);
}

/**
 * One uploaded file.
 *
 * Takes the container as given: an upload into a container that was never
 * provisioned is a 404, or worse a file nobody outside can read, so the caller
 * ensures the container first — see provisionContainer, and the `exists` probe
 * in containers.mjs that keeps a worker restart from re-provisioning.
 */
export const write = (pod, url, bytes, contentType) => pod.put(url, bytes, contentType);
