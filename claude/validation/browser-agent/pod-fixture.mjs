// pod-fixture.mjs — what a scratch pod is given so it looks like a person's
// real one. A fresh Community Solid Server pod has no public type index; a pod
// on solidcommunity.net does, and sign-up reads the profile for it. So a rig
// gives its scratch pod one the way the pod would already have it: the index
// document, public-read, and the profile naming it. Plain fetch, no library
// under test is used to make it.
//
// Runs in Node and in the bundled page alike: `fetchImpl` is an authenticated
// fetch for the pod's owner.

const SOLID = 'http://www.w3.org/ns/solid/terms#';

export async function givePublicTypeIndex(fetchImpl, { pod, webId }) {
  const base = pod.endsWith('/') ? pod : pod + '/';
  const index = `${base}settings/publicTypeIndex.ttl`;
  const put = async (url, body) => {
    const r = await fetchImpl(url, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body });
    if (r.status >= 300) throw new Error(`pod fixture: PUT ${url} → ${r.status}`);
  };
  await put(index, `@prefix solid: <${SOLID}> .\n<> a solid:TypeIndex, solid:ListedDocument .\n`);
  // Public, as on a real pod: an app finds the person's things by reading it.
  await put(`${index}.acl`,
    '@prefix acl: <http://www.w3.org/ns/auth/acl#> .\n@prefix foaf: <http://xmlns.com/foaf/0.1/> .\n'
    + `<#public> a acl:Authorization ; acl:agentClass foaf:Agent ; acl:accessTo <${index}> ; acl:mode acl:Read .\n`
    + `<#owner> a acl:Authorization ; acl:agent <${webId}> ; acl:accessTo <${index}> ; acl:mode acl:Read, acl:Write, acl:Control .\n`);
  // Named from the profile, as every pod that has one names it.
  const card = webId.split('#')[0];
  const r = await fetchImpl(card, { method: 'PATCH', headers: { 'content-type': 'text/n3' },
    body: `@prefix solid: <${SOLID}> .\n_:p a solid:InsertDeletePatch ; solid:inserts { <${webId}> solid:publicTypeIndex <${index}> . } .\n` });
  if (r.status >= 300) throw new Error(`pod fixture: PATCH ${card} → ${r.status}`);
  return index;
}
