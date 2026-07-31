// podrdf.mjs — the RDF source of truth under /activitypods-js/fediverse/:
// settings, contacts, and one document per note. Same documents and AS2
// vocabulary as dk's local.mjs (plan: ap-pod-mapping.md).
//
// Parsed and serialised by rdflib, never by hand. Escaping, encoding and shape
// are exactly what a regex gets wrong quietly — a tab inside a literal, a '%'
// in a slug, a triple laid out in a form the pattern did not anticipate — and
// a hand-built serialiser writes the documents the hand-built parser reads
// back, so the two bugs cover for each other. See claude/plans/no-regex-rdf.md.
//
// The container it lives in is a Storage (lib/storage.mjs): a pod over HTTP or
// a directory. Callers still speak in absolute URLs, which is what the rest of
// the agent has.

import * as $rdf from 'rdflib';

const AS = $rdf.Namespace('https://www.w3.org/ns/activitystreams#');
const RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const XSD = $rdf.Namespace('http://www.w3.org/2001/XMLSchema#');
const TURTLE = 'text/turtle';

export class PodRdf {
  constructor({ storage }) {
    this.storage = storage;
    this.base = storage.base;
    this.fedi = this.base;
  }

  // Callers hold absolute URLs; the storage works in paths under its base.
  _rel(url) {
    if (!url.startsWith(this.fedi)) throw new Error(`${url} is not under ${this.fedi}`);
    return url.slice(this.fedi.length);
  }

  async get(url) {
    const r = await this.storage.read(this._rel(url));
    if (!r.ok) throw new Error(`pod GET ${url} → ${r.status}`);
    return r.body;
  }

  async put(url, body, contentType = TURTLE) {
    const r = await this.storage.write(this._rel(url), body, contentType);
    if (!r.ok) throw new Error(`pod PUT ${url} → ${r.why}`);
  }

  async delete(url) {
    if (!await this.storage.remove(this._rel(url))) throw new Error(`pod DELETE ${url} failed`);
  }

  // Child resource URLs of {fedi}{kind}/ (empty when the container is absent).
  async listNotes(kind) {
    const { names } = await this.storage.list(`${kind}/`);
    return names
      .filter(n => !n.endsWith('/') && !/\.(acl|meta)$/.test(n))
      .map(n => `${this.fedi}${kind}/${n}`);
  }

  _graph(url, ttl) {
    const g = $rdf.graph();
    $rdf.parse(ttl, g, url, TURTLE);
    return g;
  }

  // Inverse of writeNote for one resource.
  async readNote(url) {
    const g = this._graph(url, await this.get(url));
    const doc = $rdf.sym(url);
    const iri = (p) => g.any(doc, AS(p), null, doc)?.value;
    const str = (p) => g.any(doc, AS(p), null, doc)?.value;
    const attachments = g.each(doc, AS('attachment'), null, doc).map((a) => {
      const mediaType = g.any(a, AS('mediaType'), null, doc)?.value;
      const description = g.any(a, AS('name'), null, doc)?.value;
      return { url: a.value, mediaType: mediaType || '', ...(description ? { description } : {}) };
    });
    return {
      noteId: iri('url'), actor: iri('attributedTo'),
      published: str('published'), inReplyTo: iri('inReplyTo'), content: str('content'),
      ...(attachments.length ? { attachments } : {}),
    };
  }

  // Incoming or own post → one RDF resource. kind: 'timeline' | 'posts'
  async writeNote(kind, slug, { noteId, actor, published, content, inReplyTo, attachments }) {
    const url = `${this.fedi}${kind}/${slug}`;
    const doc = $rdf.sym(url);
    const g = $rdf.graph();
    g.add(doc, RDF('type'), AS('Note'), doc);
    g.add(doc, AS('url'), $rdf.sym(noteId), doc);
    g.add(doc, AS('attributedTo'), $rdf.sym(actor), doc);
    // Two-arg with a NamedNode is how rdflib takes a datatype; passing it
    // third silently yields an xsd:string, which would drop ^^xsd:dateTime
    // from every note published from here on.
    if (published) g.add(doc, AS('published'), $rdf.literal(published, XSD('dateTime')), doc);
    if (inReplyTo) g.add(doc, AS('inReplyTo'), $rdf.sym(inReplyTo), doc);
    g.add(doc, AS('content'), $rdf.literal(content || ''), doc);
    for (const a of attachments || []) {
      const at = $rdf.sym(a.url);
      g.add(doc, AS('attachment'), at, doc);
      g.add(at, RDF('type'), AS('Document'), doc);
      if (a.mediaType) g.add(at, AS('mediaType'), $rdf.literal(a.mediaType), doc);
      if (a.description) g.add(at, AS('name'), $rdf.literal(a.description), doc);
    }
    await this.put(url, $rdf.serialize(doc, g, url, TURTLE));
  }

  // Contacts doc — the followers/following truth, rebuilt whole each change.
  async writeContacts({ followers, following }) {
    const url = this.fedi + 'contacts';
    const doc = $rdf.sym(url);
    const me = $rdf.sym(url + '#me');
    const g = $rdf.graph();
    g.add(me, RDF('type'), AS('Person'), doc);
    for (const f of followers) g.add(me, AS('followers'), $rdf.sym(f.actor), doc);
    for (const f of following) g.add(me, AS('following'), $rdf.sym(f.actor), doc);
    await this.put(url, $rdf.serialize(doc, g, url, TURTLE));
  }

  // Settings doc — handle + pointer to the public face.
  async writeSettings({ handle, actorUrl }) {
    const url = this.fedi + 'settings';
    const doc = $rdf.sym(url);
    const me = $rdf.sym(url + '#me');
    const g = $rdf.graph();
    g.add(me, RDF('type'), AS('Person'), doc);
    g.add(me, AS('preferredUsername'), $rdf.literal(handle), doc);
    g.add(me, AS('url'), $rdf.sym(actorUrl), doc);
    await this.put(url, $rdf.serialize(doc, g, url, TURTLE));
  }
}
