// private.mjs — a post written for a private category, and nobody else.
//
// The forum cannot write access rules on somebody else's pod, so it publishes
// WHO the rule must name — the category's reader list, readable only by those
// same people — and this writes the rule on the author's own pod. A private
// category's posts go into one container per category, so one rule covers
// every post the author has made there and rewriting it on each post is what
// keeps an ejected member from reading the rest.
//
// If any step here fails the post must not be written. A post that lands
// without its rule is a public post in a category that told its author it was
// private, which is the whole thing this exists to prevent.

const ACL_CT = 'text/turtle';
const ACCEPT = 'application/activity+json, application/ld+json, application/json;q=0.9';
// A WebID or a target this writes into a rule. Anything else — a space, an
// angle bracket, a javascript: url — would end the IRI early and change what
// the document says.
const iri = (u) => typeof u === 'string' && /^https?:\/\/[^\s<>"'\\{}|^`]+$/u.test(u);
const safe = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40);

// The one container a person's posts in one category live in. Named for the
// category so two forums, and two categories of one forum, never share a rule.
export function placeFor(categoryId) {
  const u = new URL(categoryId);
  const name = u.pathname.replace(/\/?ap\/actor\/?$/u, '').split('/').filter(Boolean).pop() || 'forum';
  return `ap/private/${safe(u.host)}-${safe(name)}/`;
}

// Who the category says may read it. Read with the reader's own login: the
// list is restricted to the people on it, so a non-member is refused and a
// category with no list at all is not private. Null means open; an empty
// answer means private and not yours to write in.
export async function readersOf(categoryBase, session) {
  const url = categoryBase + 'ap/members';
  const r = await session.fetch(url, { headers: { accept: ACCEPT } }).catch(() => null);
  if (!r) throw new Error('your pod could not reach the forum to ask who may read this category');
  if (r.status === 404 || r.status === 410) return null;
  if (r.status === 401 || r.status === 403) return [];
  if (!r.ok) throw new Error(`the forum did not say who may read this category (HTTP ${r.status})`);
  const doc = await r.json().catch(() => null);
  const list = (doc?.orderedItems || doc?.items || []).filter(iri);
  return list;
}

// Where the rule for a container lives, as the pod itself says.
async function aclUrlOf(session, target) {
  const r = await session.fetch(target, { method: 'HEAD' }).catch(() => null);
  const link = r?.headers?.get('link') || '';
  const said = /<([^>]+)>\s*;\s*rel\s*=\s*"?acl"?/iu.exec(link);
  return said ? new URL(said[1], target).href : target + '.acl';
}

// The rule itself: the owner in full, the named readers reading, nobody else.
// Written out here rather than with a library because this page loads nothing,
// and because the shape is fixed and short enough to read in one look.
export function aclDoc(target, owner, readers) {
  if (!iri(target)) throw new Error('that is not a usable address to protect');
  if (!iri(owner)) throw new Error('your pod did not give a usable WebID');
  const named = readers.filter(iri);
  const rule = (frag, who, modes) => `<#${frag}>\n`
    + '    a acl:Authorization;\n'
    + `    acl:agent <${who}>;\n`
    + `    acl:accessTo <${target}>;\n`
    + `    acl:default <${target}>;\n`
    + `    acl:mode ${modes.map(m => `acl:${m}`).join(', ')}.\n`;
  return '@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n\n'
    + rule('owner', owner, ['Read', 'Write', 'Control'])
    + named.map((who, i) => rule(`r${i}`, who, ['Read'])).join('');
}

// Make the container exist and say who may read it. Returns the container's
// address on the pod. Throws rather than leaving either half undone.
export async function prepare(session, container, owner, readers) {
  const keep = await session.fetch(container + '.keep', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keep: true }),
  }).catch(() => null);
  if (!keep?.ok) throw new Error(`your pod would not make a private place for these posts (HTTP ${keep?.status || '?'})`);
  const aclUrl = await aclUrlOf(session, container);
  const put = await session.fetch(aclUrl, {
    method: 'PUT', headers: { 'content-type': ACL_CT }, body: aclDoc(container, owner, readers),
  }).catch(() => null);
  if (!put?.ok) throw new Error(`your pod would not keep these posts private (HTTP ${put?.status || '?'}) — nothing was posted`);
  return container;
}
