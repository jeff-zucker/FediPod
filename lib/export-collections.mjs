// export-collections.mjs — the account's collections as paged Turtle AS2
// collections: `as:Collection` / `as:OrderedCollectionPage` documents whose
// pages carry `as:items` arcs plus the activity's own triples. Produced ON
// DEMAND — for a migration, or for any AS2/RDF reader — so the live pod pays
// nothing to keep this shape fresh. The layout matches the one kept by
// https://github.com/jg10-mastodon-social/solid-activitypub-netlify.
//
// Fidelity: their skeleton plus AS2-subset activity triples (type, actor,
// object, published, to/cc, content, inReplyTo, attachment). Media blobs,
// DMs, pins and standalone note documents have no place in that layout and
// are not carried.
//
// Serialised by rdflib, never by hand — the podrdf.mjs rule.

import * as $rdf from 'rdflib';

const AS = $rdf.Namespace('https://www.w3.org/ns/activitystreams#');
const RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const XSD = $rdf.Namespace('http://www.w3.org/2001/XMLSchema#');
const TURTLE = 'text/turtle';
const PAGE_SIZE = 20;

// Doc IRIs need a base even when the target is a directory; links between the
// export's own documents relativise against it, so the files stay portable.
export const DIR_BASE = 'https://fedipod-export.invalid/';

const sym = (v) => { try { return typeof v === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(v) ? $rdf.sym(v) : null; } catch { return null; } };
const typeNode = (t) => (typeof t === 'string' && /^[A-Za-z]+$/.test(t) ? AS(t) : null);

// The object-ish AS2-subset fields, shared by activities, embedded objects,
// and bare Notes an outbox names by IRI.
function addObjectFields(g, doc, s, o) {
  const t = typeNode(o.type);
  if (t) g.add(s, RDF('type'), t, doc);
  const by = sym(typeof o.attributedTo === 'string' ? o.attributedTo : o.attributedTo?.id);
  if (by) g.add(s, AS('attributedTo'), by, doc);
  if (o.published) g.add(s, AS('published'), $rdf.literal(o.published, XSD('dateTime')), doc);
  if (typeof o.content === 'string') g.add(s, AS('content'), $rdf.literal(o.content), doc);
  const irt = sym(typeof o.inReplyTo === 'string' ? o.inReplyTo : o.inReplyTo?.id);
  if (irt) g.add(s, AS('inReplyTo'), irt, doc);
  for (const at of [].concat(o.attachment || [])) {
    const au = sym(at?.url);
    if (!au) continue;
    g.add(s, AS('attachment'), au, doc);
    g.add(au, RDF('type'), AS('Document'), doc);
    if (at.mediaType) g.add(au, AS('mediaType'), $rdf.literal(at.mediaType), doc);
    if (at.name) g.add(au, AS('name'), $rdf.literal(at.name), doc);
  }
}

// One activity's (or bare object's) AS2-subset triples into the page document.
function addActivity(g, doc, a) {
  const s = sym(a.id);
  if (!s) return false;
  addObjectFields(g, doc, s, a);
  const actor = sym(typeof a.actor === 'string' ? a.actor : a.actor?.id);
  if (actor) g.add(s, AS('actor'), actor, doc);
  for (const key of ['to', 'cc']) {
    for (const addr of [].concat(a[key] || [])) {
      const n = sym(addr);
      if (n) g.add(s, AS(key), n, doc);
    }
  }
  const o = a.object;
  if (typeof o === 'string') {
    const n = sym(o);
    if (n) g.add(s, AS('object'), n, doc);
  } else if (o && typeof o === 'object' && sym(o.id)) {
    const n = sym(o.id);
    g.add(s, AS('object'), n, doc);
    addObjectFields(g, doc, n, o);
  }
  return true;
}

// A collection into documents: a head at <name>/collection.ttl pointing
// as:first at the newest page, pages at <name>/pages/<slot>.ttl chained
// as:next toward the older ones — the direction their layout walks. Items:
// activity objects (triples added) or bare IRIs (followers).
export function collectionDocs(name, items, base) {
  const headUrl = `${base}${name}/collection.ttl`;
  const slots = [];
  const seen = new Set();
  const pages = [];
  for (let i = 0; i < items.length; i += PAGE_SIZE) pages.push(items.slice(i, i + PAGE_SIZE));
  if (!pages.length) pages.push([]);
  for (const page of pages) {
    const first = page.find(it => typeof it === 'object' && it?.published);
    let slot = String(first ? Date.parse(first.published) || 0 : 0);
    while (seen.has(slot)) slot += 'x';
    seen.add(slot);
    slots.push(slot);
  }
  const pageUrl = (i) => `${base}${name}/pages/${slots[i]}.ttl`;
  const docs = [];

  const hg = $rdf.graph();
  const head = $rdf.sym(headUrl);
  hg.add(head, RDF('type'), AS('Collection'), head);
  hg.add(head, AS('first'), $rdf.sym(pageUrl(0)), head);
  docs.push({ path: `${name}/collection.ttl`, turtle: $rdf.serialize(head, hg, headUrl, TURTLE) });

  let carried = 0;
  pages.forEach((page, i) => {
    const url = pageUrl(i);
    const g = $rdf.graph();
    const doc = $rdf.sym(url);
    g.add(doc, RDF('type'), AS('OrderedCollectionPage'), doc);
    if (i + 1 < pages.length) g.add(doc, AS('next'), $rdf.sym(pageUrl(i + 1)), doc);
    for (const item of page) {
      if (typeof item === 'string') {
        const n = sym(item);
        if (n) { g.add(doc, AS('items'), n, doc); carried++; }
      } else if (item && addActivity(g, doc, item)) {
        g.add(doc, AS('items'), $rdf.sym(item.id), doc);
        carried++;
      }
    }
    docs.push({ path: `${name}/pages/${slots[i]}.ttl`, turtle: $rdf.serialize(doc, g, url, TURTLE) });
  });
  return { docs, carried, pages: pages.length };
}

// The whole export. Inputs arrive as plain data so the CLI and the tests
// assemble them the same way; `storage` is a lib/storage.mjs container.
export async function exportCollections({ outboxItems = [], followers = [], inboxEntries = [], storage, base = DIR_BASE, log = console.log, resolve = null }) {
  const out = { written: 0 };
  // A published outbox may hold bare note IRIs rather than embedded
  // activities; with a resolver those are fetched once each so their triples
  // travel in the page instead of a pointer to a pod that may be retiring.
  if (resolve) {
    const resolved = [];
    for (const it of outboxItems) {
      if (typeof it !== 'string') { resolved.push(it); continue; }
      const doc = await resolve(it).catch(() => null);
      resolved.push(doc && doc.id ? doc : it);
    }
    outboxItems = resolved;
  }
  const write = async (name, items) => {
    const { docs, carried, pages } = collectionDocs(name, items, base);
    for (const d of docs) {
      const w = await storage.write(d.path, d.turtle, TURTLE);
      if (!w.ok) throw new Error(`write ${d.path}: ${w.why || 'failed'}`);
      out.written++;
    }
    out[name] = { items: carried, pages };
  };

  await write('outbox', outboxItems);
  await write('followers', followers);
  // Newest first, like the outbox — receivedAt rides in each archive entry.
  const inbox = [...inboxEntries]
    .sort((a, b) => String(b.receivedAt || '').localeCompare(String(a.receivedAt || '')))
    .map(e => { try { return { published: e.receivedAt, ...JSON.parse(e.raw) }; } catch { return null; } })
    .filter(Boolean);
  await write('inbox', inbox);
  if (!inbox.length) log('inbox: no archived mail yet — history begins when the archive does');
  log('carries what the collection layout can hold — media blobs, DMs, pins and standalone notes are not representable and were not exported');
  return out;
}
