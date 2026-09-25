// type-index.mjs — an account's place, recorded in the person's public type
// index: the list Solid apps read to find what kind of thing lives where.
//
// The record is a registration saying there is an instance of `as:Actor` at the
// account's actor on the pod:
//
//   <#actor-…> a solid:TypeRegistration;
//     solid:forClass as:Actor;
//     solid:instance <…/ap/actor>.
//
// The instance is the actor at the pod, not a gateway's address for it, so the
// place can be read off it. It is also how the account is found again.
//
// Every write goes through the transport's checked writers: valid RDF, to the
// profile or a document its seeAlso names, or nothing.

const SOLID = 'http://www.w3.org/ns/solid/terms#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AS_ACTOR = 'https://www.w3.org/ns/activitystreams#Actor';
const PUBLIC_READ = ['Read'];

/** Where a new public type index goes when a person has none. */
export const newIndexUrl = (podBase) => `${podBase}settings/publicTypeIndex.ttl`;

/** The person's public type index, or null when their profile names none. */
export async function findPublicIndex(pod, podBase) {
  const docs = await pod.profileDocs(podBase);
  return pod.webIdValues(docs, SOLID + 'publicTypeIndex')[0] || null;
}

/** Every actor the index registers, as the instances it names. */
export async function actorsIn(pod, indexUrl) {
  const g = await pod.readRdf(indexUrl).catch(() => null);
  if (!g) return [];
  const out = [];
  for (const reg of g.each(null, pod.sym(SOLID + 'forClass'), pod.sym(AS_ACTOR))) {
    for (const inst of g.each(reg, pod.sym(SOLID + 'instance'), null)) out.push(inst.value);
  }
  return [...new Set(out)];
}

// One registration per actor, named by the actor, so registering again finds
// the same one.
function regFor(indexUrl, actorUrl) {
  let h = 0;
  for (const c of actorUrl) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${indexUrl}#actor-${h.toString(36)}`;
}

/** Add the account's registration, unless the index already has one for it. */
export async function register(pod, indexUrl, actorUrl) {
  const g = await pod.readRdf(indexUrl);
  if (!g) throw new Error(`no type index at ${indexUrl}`);
  if ((await actorsIn(pod, indexUrl)).includes(actorUrl)) return false;
  const reg = pod.sym(regFor(indexUrl, actorUrl));
  const status = await pod.writeRdfChecked(indexUrl, g, {
    inserts: [
      [reg, pod.sym(RDF_TYPE), pod.sym(SOLID + 'TypeRegistration')],
      [reg, pod.sym(SOLID + 'forClass'), pod.sym(AS_ACTOR)],
      [reg, pod.sym(SOLID + 'instance'), pod.sym(actorUrl)],
    ],
    mustDescribe: indexUrl,
  });
  if (status >= 300) throw new Error(`the type index at ${indexUrl} did not take the registration (${status})`);
  return true;
}

/**
 * Make a public type index and name it from the profile. Only ever called
 * after the person has said yes. An index already at the usual place is kept,
 * not overwritten; it is only named.
 */
export async function createPublicIndex(pod, podBase) {
  const url = newIndexUrl(podBase);
  const doc = pod.sym(url);
  const existing = await pod.readRdf(url).catch(() => null);
  if (!existing) {
    const status = await pod.writeRdfChecked(url, null, {
      inserts: [[doc, pod.sym(RDF_TYPE), pod.sym(SOLID + 'TypeIndex')],
        [doc, pod.sym(RDF_TYPE), pod.sym(SOLID + 'ListedDocument')]],
      mustDescribe: url,
    });
    if (status >= 300) throw new Error(`could not make a type index at ${url} (${status})`);
  }
  // Public, as the profile is: an app finds your things by reading it.
  await pod.setAcl(url, PUBLIC_READ);
  await pod.writeAboutWebId(podBase, {
    inserts: [[pod.sym(pod.webId), pod.sym(SOLID + 'publicTypeIndex'), doc]],
  });
  return url;
}

/**
 * The actors this person's index says live in this pod. Empty when there is no
 * index or nothing registered.
 */
export async function registeredActors(pod, podBase) {
  const index = await findPublicIndex(pod, podBase).catch(() => null);
  if (!index) return [];
  return (await actorsIn(pod, index)).filter(a => a.startsWith(podBase) && a.endsWith('ap/actor'));
}
