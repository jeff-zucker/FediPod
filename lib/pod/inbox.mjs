// inbox.mjs — ap/inbox/: what arrives, and who may touch it.
//
// One file for the whole inbox, because the inbox is where two different
// parties meet and neither half is comprehensible alone: a delivery gateway
// may only ADD to it, holding at most an Append token; the owner's agent
// lists, reads and removes, holding the pod's own credential. Splitting them
// by who does them would put the two ends of one contract in two files.

const DELIVERY_CT = 'application/activity+json';
const RECEIPT_CT = 'application/json';

// ---- a delivery gateway: appends verified mail, and can do nothing else ----

/**
 * PUT one document into a pod inbox, with an Append token when the caller
 * holds one and anonymously when it does not.
 *
 * Sending no `authorization` header is not the same as sending an empty one:
 * `Bearer undefined` is a credential the pod will reject, where absence is a
 * public Append the pod may well allow. This is the one place that gets to
 * decide that, because it lived in two adapters and had to be right in both.
 *
 * @returns {Promise<boolean>} whether it landed
 */
export async function appendWithToken(url, body, contentType, { appendToken = null, fetchImpl = fetch } = {}) {
  const headers = { 'content-type': contentType,
    ...(appendToken ? { authorization: `Bearer ${appendToken}` } : {}) };
  const r = await fetchImpl(url, { method: 'PUT', headers, body }).catch(() => null);
  return !!r && r.status < 400;
}

/**
 * The delivery itself, named by the hash of its own bytes.
 *
 * Content-addressed on purpose: the same activity delivered twice writes the
 * same document twice, so a retrying origin cannot produce duplicates in
 * someone's inbox.
 *
 * A failure here must reach the ORIGIN as a 5xx so it retries over its own
 * ladder — that is what preserves the pod's buffer property without the
 * gateway holding any state of its own.
 */
export async function appendVerifiedDelivery(podPut, inboxUrl, hash, raw) {
  return podPut(inboxUrl + hash, raw, DELIVERY_CT);
}

/**
 * The verification receipt, written beside the delivery it vouches for.
 *
 * Best-effort by design: a delivery that landed but whose receipt did not is
 * read as unverified at the drain, which is a lesser thing than losing it.
 */
export async function writeReceiptBeside(podPut, inboxUrl, hash, receipt) {
  await podPut(inboxUrl + hash + '.receipt.json', JSON.stringify(receipt), RECEIPT_CT)
    .catch(() => {});
}

// ---- the owner's agent: brings it into being and decides who may post ----

/**
 * The canary that makes the container exist.
 *
 * Written without an access rule of its own, because the rule that matters is
 * the container's and is stated separately — see setPosture, which a caller
 * must reach for deliberately rather than inherit by accident.
 */
export async function writeKeep(pod, urls) {
  await pod.putJson(urls.inbox + '.keep', { keep: true }, 'application/json');
}

/**
 * Who may deliver here.
 *
 *   'open'                 anyone may Append — an inbox the fediverse can post to
 *   'closed'               nobody may — a quiesced actor, still resolving, taking no mail
 *   { gatewayWebId }       only that WebID may — mail arrives through a door that
 *                          verifies it first, and nobody may go round the door
 *
 * One operation because the three are one decision, and they were made in five
 * places: the profile publish, three separate methods, and the manage surface
 * reaching past all of them to set the ACL directly. A posture set in one of
 * those and not the others is an inbox that is open when it should be shut.
 */
export async function setPosture(pod, urls, posture) {
  if (posture === 'open') return pod.setAcl(urls.inbox, ['Append']);
  if (posture === 'closed') return pod.setAcl(urls.inbox, []);
  const webId = posture?.gatewayWebId;
  if (!webId) throw new Error(`inbox.setPosture: unknown posture ${JSON.stringify(posture)}`);
  // Public loses Append; the door keeps it. Both halves in one write, because
  // between two writes the inbox is either open to everyone or shut to the door.
  return pod.setAcl(urls.inbox, [], { appendAgents: [webId] });
}
