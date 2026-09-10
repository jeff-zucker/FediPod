// notifications.mjs — being told when the inbox changes, instead of asking.
//
// A pod that offers Solid Notifications lets a client open a socket and hear
// about a container the moment it changes, which is the difference between
// mail arriving and mail being noticed two minutes later. Discovering that
// service takes two unauthenticated reads of the pod's own description, and
// then one authenticated POST to subscribe.
//
// This is the ONLY module here that parses RDF itself, which is why it is its
// own file: a service that only ever appends to an inbox can import inbox.mjs
// without pulling a parser in behind it.

import * as $rdf from 'rdflib';
import { readCapped } from './http.mjs';
import { linkTargets, REL } from './links.mjs';

const RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const NOTIFY = $rdf.Namespace('http://www.w3.org/ns/solid/notifications#');
const WS_CHANNEL = 'WebSocketChannel2023';

// ---- anyone at all: a pod describes its own services publicly ----

/**
 * Where this pod describes the services it offers.
 *
 * The pod says so on any response about one of its resources; the well-known
 * path is only what a pod that says nothing has always used. Unauthenticated
 * on purpose — this is a public fact about the server, asked before there is
 * anything to authenticate about.
 */
export async function storageDescriptionUrl(podBase, { fetchImpl = fetch, headers = {}, timeoutMs = 20_000 } = {}) {
  try {
    const head = await fetchImpl(podBase, {
      method: 'HEAD', headers, signal: AbortSignal.timeout(timeoutMs),
    });
    const [found] = linkTargets(head.headers.get('link'), REL.storageDescription, podBase);
    if (found) return found;
  } catch { /* the well-known path below */ }
  return podBase + '.well-known/solid';
}

/**
 * The websocket channel service this pod offers, or null when it offers none.
 *
 * Asked of rdflib rather than pattern-matched: the description is RDF, and the
 * gap between "a string that appears in the document" and "the service this
 * pod actually advertises" is where quiet bugs live. A pod may name the type
 * on the service, or name the service's channelType — both are asked for.
 */
export async function readWebSocketChannel(descUrl, { fetchImpl = fetch, headers = {}, timeoutMs = 20_000 } = {}) {
  const res = await fetchImpl(descUrl, {
    headers: { accept: 'text/turtle', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const g = $rdf.graph();
  try {
    $rdf.parse(await readCapped(res), g, descUrl, 'text/turtle');
  } catch (e) {
    return { channel: null, error: `service description unparsable (${e.message})` };
  }
  const channel = g.each(null, RDF('type'), NOTIFY(WS_CHANNEL), null).map((n) => n.value).find(Boolean)
    || g.each(null, NOTIFY('channelType'), NOTIFY(WS_CHANNEL), null).map((n) => n.value).find(Boolean);
  return { channel: channel || null, error: channel ? null : `no ${WS_CHANNEL} service` };
}

// ---- the owner's agent ----

/**
 * Subscribe to changes on the inbox.
 *
 * `podTopicUrl` is POD-SPACE, and the parameter is named that way because
 * getting it wrong fails in a way nothing else here does: the topic travels in
 * the BODY, so the advertised-to-pod url map a transport applies to the
 * request LINE never reaches it. An identity whose ids are advertised
 * elsewhere would name a container the pod cannot grant read on, and the
 * subscription comes back 403.
 */
export async function subscribeToInbox(pod, { channelUrl, podTopicUrl, ...rest }) {
  return pod.fetch(channelUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/ld+json' },
    body: JSON.stringify({
      '@context': ['https://www.w3.org/ns/solid/notification/v1'],
      type: `http://www.w3.org/ns/solid/notifications#${WS_CHANNEL}`,
      topic: podTopicUrl,
      ...rest,
    }),
  });
}
