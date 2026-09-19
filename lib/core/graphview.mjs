// graphview.mjs — what the handlers read.
//
// `parseAS2` produces quads. This turns them back into something a handler can
// read by name, so the thing being read is the GRAPH: every property access
// here is a lookup over statements, not a key on the JSON a stranger sent.
//
// That distinction is the whole point. A document can say the same thing in
// many ways — `"type": "Create"`, `"@type": "as:Create"`, a term aliased by the
// sender's own context — and all of them leave the same statement in the
// graph. Reading the graph means a handler sees one answer without knowing any
// of that happened.
//
// Names are resolved through the contexts we already hold, AS2 first. They are
// not hardcoded: `movedTo` is not in the AS2 context at all (it lives in
// miscellany), and `inbox` is `ldp:inbox` rather than an `as:` term, so a map
// written by hand would get both wrong.

import { CONTEXTS } from './contexts/index.mjs';
import { AS_CTX } from './wire.mjs';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

// Properties a handler treats as a collection. JSON-LD compaction would hand
// back a bare value when there is only one, and `Array.isArray` checks in the
// handlers then read it as empty. These always answer with an array.
// A stranger's document decides the shape of this graph, so the walk is capped
// rather than trusted to terminate on its own.
const MAX_DEPTH = 12;

const ALWAYS_LIST = new Set([
  'items', 'orderedItems', 'to', 'cc', 'bto', 'bcc', 'tag', 'attachment',
  'anyOf', 'oneOf', 'audience', 'attributedTo', 'alsoKnownAs',
]);

/** Expand `as:object` against a context's own prefix declarations. */
function expandIri(value, prefixes) {
  if (typeof value !== 'string') return null;
  if (/^https?:\/\//.test(value)) return value;
  const colon = value.indexOf(':');
  if (colon < 1) return null;
  const base = prefixes[value.slice(0, colon)];
  return base ? base + value.slice(colon + 1) : null;
}

/**
 * term -> { iri, list } over every context we hold, AS2 winning ties.
 *
 * Built once. A term already claimed by an earlier context is not overwritten,
 * and AS2 is walked first, so an extension cannot quietly redefine `object`.
 */
function buildTerms() {
  const terms = new Map();
  const order = [AS_CTX, ...Object.keys(CONTEXTS).filter(u => u !== AS_CTX)];
  for (const url of order) {
    const body = CONTEXTS[url]?.['@context'];
    // A context document's body is one term map, or a list mixing URLs of
    // other contexts with term maps — the litepub schema is the second shape.
    // The URLs are held on their own; only the maps carry terms.
    const maps = (Array.isArray(body) ? body : [body]).filter(c => c && typeof c === 'object');
    if (!maps.length) continue;
    const ctx = Object.assign({}, ...maps);
    const prefixes = {};
    for (const [k, v] of Object.entries(ctx)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v)) prefixes[k] = v;
    }
    for (const [name, def] of Object.entries(ctx)) {
      if (name.startsWith('@') || terms.has(name)) continue;
      const raw = typeof def === 'string' ? def : def?.['@id'];
      const iri = expandIri(raw, prefixes);
      if (!iri) continue;
      terms.set(name, { iri, list: def?.['@container'] === '@list', container: def?.['@container'] ?? null });
    }
  }
  return terms;
}

const TERMS = buildTerms();

/** iri -> shortest term naming it, so a type comes back as `Create`. */
const BY_IRI = (() => {
  const m = new Map();
  for (const [name, { iri }] of TERMS) {
    const held = m.get(iri);
    if (!held || name.length < held.length) m.set(iri, name);
  }
  return m;
})();

/**
 * iri -> every term naming it.
 *
 * More than one term can mean the same predicate: `items` and `orderedItems`
 * are both `as:items`, and only the list tells them apart. Emitting just the
 * shorter name would lose `orderedItems` — and with it the ordering, which is
 * the one thing an OrderedCollection is for.
 */
const NAMES_BY_IRI = (() => {
  const m = new Map();
  for (const [name, { iri, container }] of TERMS) {
    // `contentMap` and `content` are the same predicate, but a language map is
    // not another spelling of the plain term — emitting one as a bare string
    // would invent a value the document never carried.
    if (container === '@language' || container === '@index') continue;
    const held = m.get(iri);
    if (held) held.push(name); else m.set(iri, [name]);
  }
  return m;
})();

/** Index quads by subject, then by predicate. */
function indexQuads(quads) {
  const bySubject = new Map();
  const objects = new Set();
  // A BlankNode's `.value` has no `_:` on it, so blankness is recorded here
  // rather than guessed from the string. A blank node has no id, and handing a
  // handler `id: "b0"` would be handing it an identifier that means nothing.
  const blanks = new Set();
  for (const q of quads) {
    if (q.subject.termType === 'BlankNode') blanks.add(q.subject.value);
    if (q.object.termType === 'BlankNode') blanks.add(q.object.value);
    const s = q.subject.value;
    let preds = bySubject.get(s);
    if (!preds) bySubject.set(s, preds = new Map());
    let vals = preds.get(q.predicate.value);
    if (!vals) preds.set(q.predicate.value, vals = []);
    vals.push(q.object);
    if (q.object.termType === 'NamedNode' || q.object.termType === 'BlankNode') {
      objects.add(q.object.value);
    }
  }
  return { bySubject, objects, blanks };
}

/**
 * The document's own node, when the caller could not name it.
 *
 * A named subject nothing points at is the plain case. But an actor is
 * pointed at by its own key (`owner`), so it is never that; and taking "the
 * first typed subject" instead handed back a profile field — a blank
 * PropertyValue that happens to come first in quad order — for every
 * Mastodon actor with fields on it. Named subjects therefore come before
 * blank ones at every step, and a blank node is the root only when nothing
 * named exists at all.
 */
function findRoot({ bySubject, objects, blanks }) {
  const all = [...bySubject.keys()];
  const named = all.filter((s) => !blanks.has(s));
  // A subject nothing points at is the document's own node — named if there
  // is one, else blank: a client's Update carries no id of its own and is a
  // blank root above the named note it edits.
  const free = all.filter((s) => !objects.has(s));
  const freeNamed = free.find((s) => !blanks.has(s));
  if (freeNamed) return freeNamed;
  if (free.length) return free[0];
  // Everything is pointed at (an actor, through its key's owner): a typed
  // named subject, before any typed blank one.
  for (const s of named) if (bySubject.get(s).has(RDF_TYPE)) return s;
  for (const s of all) if (bySubject.get(s).has(RDF_TYPE)) return s;
  return named[0] ?? all[0] ?? null;
}

/** Walk an rdf:List into an ordered array. `orderedItems` depends on this. */
function readList(head, ctx, depth, path) {
  const out = [];
  const walked = new Set();
  let node = head;
  while (node && node !== RDF_NIL && !walked.has(node)) {
    walked.add(node);
    const preds = ctx.bySubject.get(node);
    if (!preds) break;
    const first = preds.get(RDF_FIRST)?.[0];
    if (first) {
      const value = toValue(first, ctx, depth, path);
      if (value !== null) out.push(value);
    }
    node = preds.get(RDF_REST)?.[0]?.value ?? null;
  }
  return out;
}

function isListHead(term, ctx) {
  if (term.termType !== 'BlankNode' && term.termType !== 'NamedNode') return false;
  return !!ctx.bySubject.get(term.value)?.has(RDF_FIRST);
}

/**
 * A term becomes what a handler expects to find there.
 *
 * A node we hold statements about becomes a nested view, which is what an
 * embedded object was in the JSON. A node we hold nothing about becomes its
 * IRI, which is what a bare reference was. Handlers already test which they
 * got (`typeof activity.object === 'object'`), so both stay readable.
 */
// A literal's `.value` is its LEXICAL form, which is a string whatever the
// literal meant: `false` written in JSON-LD arrives here as the four characters
// "false", and `42` as two digits. Every handler downstream then reads a string
// where the document said a boolean or a number — and `!!"false"` is true, which
// is how a moderator's reopen was applied as another close.
//
// So the two datatypes whose lexical form lies about the value are turned back.
// Everything else is left exactly as it was, dates above all: a timestamp is
// carried, compared and republished as its string everywhere in this project,
// and "helpfully" turning it into a Date would break all of it.
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NUMERIC = new Set(['integer', 'decimal', 'double', 'float', 'long', 'int', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte'].map(t => XSD + t));

function fromLiteral(term) {
  const type = term.datatype?.value || '';
  if (type === `${XSD}boolean`) {
    // The lexical space of xsd:boolean is exactly these four. Anything else is
    // not a boolean the document can have meant, so it stays as it was written.
    if (term.value === 'true' || term.value === '1') return true;
    if (term.value === 'false' || term.value === '0') return false;
    return term.value;
  }
  if (NUMERIC.has(type)) {
    const n = Number(term.value);
    // A numeric literal that will not parse is malformed; handing back NaN
    // would lose what the document actually said.
    return Number.isFinite(n) ? n : term.value;
  }
  return term.value;
}

function toValue(term, ctx, depth, path) {
  if (term.termType === 'Literal') return fromLiteral(term);
  if (isListHead(term, ctx)) return readList(term.value, ctx, depth, path);
  const preds = ctx.bySubject.get(term.value);
  if (preds && preds.size) return makeView(term.value, ctx, depth + 1, path);
  return term.termType === 'BlankNode' ? null : term.value;
}

function readProperty(subject, name, ctx, depth = 0, path = new Set()) {
  const preds = ctx.bySubject.get(subject);
  if (!preds) return undefined;

  if (name === 'id') return ctx.blanks.has(subject) ? undefined : subject;
  if (name === 'type') {
    const types = (preds.get(RDF_TYPE) ?? []).map(t => BY_IRI.get(t.value) ?? t.value);
    if (!types.length) return undefined;
    return types.length === 1 ? types[0] : types;
  }

  const term = TERMS.get(name);
  if (!term) return undefined;
  const values = preds.get(term.iri);
  if (!values || !values.length) return undefined;

  // `items` and `orderedItems` are the same predicate; the list is what tells
  // them apart, so asking for the ordered one only answers when it is ordered.
  const listed = values.filter(v => isListHead(v, ctx));
  if (term.list) {
    if (!listed.length) return undefined;
    return readList(listed[0].value, ctx, depth, path);
  }
  if (listed.length === values.length && listed.length === 1) return readList(listed[0].value, ctx, depth, path);

  const out = values.map(v => toValue(v, ctx, depth, path)).filter(v => v !== null);
  if (ALWAYS_LIST.has(name)) return out.flat();
  return out.length === 1 ? out[0] : out;
}

/**
 * Build the plain object for one node.
 *
 * Materialised rather than proxied on purpose. A lazy reader would still be
 * reading the graph, but it would be an exotic object, and the handlers pass
 * what they read on to things that spread it, serialise it and structuredClone
 * it into the store — all of which a Proxy either breaks or quietly truncates.
 * What comes out here is an ordinary object whose every value came from a
 * statement.
 *
 * `depth` and `seen` are the guards. The graph is built from a stranger's
 * document, so it can be cyclic or enormous; a node already on the path
 * becomes its IRI rather than being walked again.
 */
function makeView(subject, ctx, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH || seen.has(subject)) {
    return ctx.blanks.has(subject) ? null : subject;
  }
  const preds = ctx.bySubject.get(subject);
  if (!preds) return ctx.blanks.has(subject) ? null : subject;

  const path = new Set(seen).add(subject);
  const out = {};
  const id = readProperty(subject, 'id', ctx, depth, path);
  if (id !== undefined) out.id = id;
  const type = readProperty(subject, 'type', ctx, depth, path);
  if (type !== undefined) out.type = type;

  for (const predicate of preds.keys()) {
    if (predicate === RDF_TYPE || predicate === RDF_FIRST || predicate === RDF_REST) continue;
    // A predicate no context we hold names cannot be asked for by name, so it
    // is left out rather than carried under an IRI no handler would look up.
    for (const name of NAMES_BY_IRI.get(predicate) ?? []) {
      if (name === 'id' || name === 'type') continue;
      const value = readProperty(subject, name, ctx, depth, path);
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

/**
 * A reader over `parseAS2`'s quads.
 *
 * Returns null when there is nothing to read, which is the same answer the
 * document-shaped read gave for bytes that were not a document.
 */
export function graphView(quads, { root = null } = {}) {
  if (!quads || !quads.length) return null;
  const ctx = indexQuads(quads);
  // The root the caller names is used only when the graph has it as a
  // subject: a document whose `id` names something it says nothing about
  // still reads as whatever it does describe.
  const subject = (root && ctx.bySubject.has(root)) ? root : findRoot(ctx);
  if (!subject) return null;
  const view = makeView(subject, ctx);
  return (view && typeof view === 'object') ? view : null;
}

export { TERMS, BY_IRI };
