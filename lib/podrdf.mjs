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

/**
 * The fields writeNote takes, lifted off an AS2 document.
 *
 * Here rather than at six call sites: the list is exactly what the wire
 * document carries beyond the basics, and a caller that forgot one would write
 * a note whose RDF quietly says less than the JSON beside it — which is the
 * whole failure this was meant to end.
 */
export function noteFieldsFrom(doc) {
  if (!doc || typeof doc !== 'object') return {};
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => typeof x === 'string');
  const mentions = arr2(doc.tag).filter((t) => t?.type === 'Mention' && t.href)
    .map((t) => ({ href: t.href, ...(t.name ? { name: t.name } : {}) }));
  const opts = arr2(doc.oneOf).length ? arr2(doc.oneOf) : arr2(doc.anyOf);
  return {
    ...(arr(doc.to).length ? { to: arr(doc.to) } : {}),
    ...(arr(doc.cc).length ? { cc: arr(doc.cc) } : {}),
    ...(mentions.length ? { mentions } : {}),
    ...(typeof doc.replies === 'string' ? { replies: doc.replies } : {}),
    ...(doc.summary ? { summary: doc.summary } : {}),
    ...(doc.updated ? { updated: doc.updated } : {}),
    ...(opts.length ? { poll: {
      multiple: arr2(doc.anyOf).length > 0,
      options: opts.map((o) => ({ name: o?.name, votes: Number(o?.replies?.totalItems || 0) })),
      ...(doc.endTime ? { endTime: doc.endTime } : {}),
      ...(doc.votersCount != null ? { votersCount: Number(doc.votersCount) } : {}),
    } } : {}),
  };
}
const arr2 = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter((x) => x && typeof x === 'object');

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
      // `.<pid>.tmp` is what FileStorage.write leaves if it is interrupted
      // between the write and the rename. It is not a note, and handing one to
      // the parser produces a failure that reads like a corrupt document.
      .filter(n => !n.endsWith('/') && !/\.(acl|meta)$/.test(n) && !/\.\d+\.tmp$/.test(n))
      .map(n => `${this.fedi}${kind}/${n}`);
  }

  _graph(url, ttl) {
    const g = $rdf.graph();
    $rdf.parse(ttl, g, url, TURTLE);
    return g;
  }

  // Inverse of writeNote for one resource.
  //
  // Every field below `content` is OPTIONAL on the way out, because it is
  // optional on the way in: notes written before this document carried
  // addressing have none of it, and every reader of this tree reads a pod's
  // whole history. An absent field is absent, never a guess.
  async readNote(url) {
    const g = this._graph(url, await this.get(url));
    const doc = $rdf.sym(url);
    const iri = (p) => g.any(doc, AS(p), null, doc)?.value;
    const str = (p) => g.any(doc, AS(p), null, doc)?.value;
    const all = (p) => g.each(doc, AS(p), null, doc).map((n) => n.value);
    const attachments = g.each(doc, AS('attachment'), null, doc).map((a) => {
      const mediaType = g.any(a, AS('mediaType'), null, doc)?.value;
      const description = g.any(a, AS('name'), null, doc)?.value;
      return { url: a.value, mediaType: mediaType || '', ...(description ? { description } : {}) };
    });
    const mentions = g.each(doc, AS('tag'), null, doc)
      .filter((t) => g.holds(t, RDF('type'), AS('Mention'), doc))
      .map((t) => ({
        href: g.any(t, AS('href'), null, doc)?.value,
        name: g.any(t, AS('name'), null, doc)?.value,
      }))
      .filter((m) => m.href);
    const to = all('to'); const cc = all('cc');
    const options = ['oneOf', 'anyOf'].flatMap((p) => g.each(doc, AS(p), null, doc).map((o) => ({
      name: g.any(o, AS('name'), null, doc)?.value,
      votes: Number(g.any(g.any(o, AS('replies'), null, doc), AS('totalItems'), null, doc)?.value || 0),
    })));
    const multiple = g.each(doc, AS('anyOf'), null, doc).length > 0;
    return {
      noteId: iri('url'), actor: iri('attributedTo'),
      published: str('published'), inReplyTo: iri('inReplyTo'), content: str('content'),
      ...(attachments.length ? { attachments } : {}),
      ...(to.length ? { to } : {}),
      ...(cc.length ? { cc } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(iri('replies') ? { replies: iri('replies') } : {}),
      ...(str('summary') ? { summary: str('summary') } : {}),
      ...(str('updated') ? { updated: str('updated') } : {}),
      ...(options.length ? { poll: {
        options, multiple,
        ...(str('endTime') ? { endTime: str('endTime') } : {}),
        ...(str('votersCount') ? { votersCount: Number(str('votersCount')) } : {}),
      } } : {}),
    };
  }

  // Incoming or own post → one RDF resource. kind: 'timeline' | 'posts'
  //
  // What is recorded here used to be a REDUCTION of the wire document: no
  // addressing, no mentions, no replies pointer, no content warning, no edit
  // stamp. A query against this tree could not tell a public post from a direct
  // message, which is most of what anyone would want to ask it. Everything the
  // wire document carries is carried here now — see noteFieldsFrom, which lifts
  // it off an AS2 document so no call site has to remember the list.
  async writeNote(kind, slug, {
    noteId, actor, published, content, inReplyTo, attachments,
    to, cc, mentions, replies, summary, updated, poll,
  }) {
    const url = `${this.fedi}${kind}/${slug}`;
    const doc = $rdf.sym(url);
    const g = $rdf.graph();
    // A poll is a Question, not a Note — the difference is the whole point of
    // the document, and a reader that saw `Note` would never look for options.
    g.add(doc, RDF('type'), poll ? AS('Question') : AS('Note'), doc);
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
    // Addressing. Without it a public post, a followers-only post and a direct
    // message are indistinguishable in this tree.
    for (const t of to || []) g.add(doc, AS('to'), $rdf.sym(t), doc);
    for (const c of cc || []) g.add(doc, AS('cc'), $rdf.sym(c), doc);
    for (const m of mentions || []) {
      if (!m?.href) continue;
      const tag = $rdf.blankNode();
      g.add(doc, AS('tag'), tag, doc);
      g.add(tag, RDF('type'), AS('Mention'), doc);
      g.add(tag, AS('href'), $rdf.sym(m.href), doc);
      if (m.name) g.add(tag, AS('name'), $rdf.literal(m.name), doc);
    }
    if (replies) g.add(doc, AS('replies'), $rdf.sym(replies), doc);
    if (summary) g.add(doc, AS('summary'), $rdf.literal(summary), doc);
    if (updated) g.add(doc, AS('updated'), $rdf.literal(updated, XSD('dateTime')), doc);
    if (poll) {
      const pred = poll.multiple ? 'anyOf' : 'oneOf';
      for (const o of poll.options || []) {
        const opt = $rdf.blankNode();
        g.add(doc, AS(pred), opt, doc);
        g.add(opt, RDF('type'), AS('Note'), doc);
        if (o.name) g.add(opt, AS('name'), $rdf.literal(o.name), doc);
        const tally = $rdf.blankNode();
        g.add(opt, AS('replies'), tally, doc);
        g.add(tally, RDF('type'), AS('Collection'), doc);
        g.add(tally, AS('totalItems'), $rdf.literal(String(o.votes || 0), XSD('nonNegativeInteger')), doc);
      }
      if (poll.endTime) g.add(doc, AS('endTime'), $rdf.literal(poll.endTime, XSD('dateTime')), doc);
      if (poll.votersCount != null) {
        g.add(doc, AS('votersCount'), $rdf.literal(String(poll.votersCount), XSD('nonNegativeInteger')), doc);
      }
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
