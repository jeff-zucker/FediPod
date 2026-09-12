// as2.mjs — the one place ActivityStreams bytes become something to handle.
//
// An AS2 document IS a JSON-LD document; ActivityStreams 2.0 Core says so. We
// read it as one. Expanding it to a graph is what makes the document mean the
// same thing however its sender chose to write it — `"type": "Create"` and
// `"@type": "as:Create"` are the same statement, and only a JSON-LD reader
// knows that. Compacting it back against the standard context is what lets the
// handlers stay as they are: whatever arrived, they see an ordinary document.
//
// What we STORE and SEND is untouched by any of this. Bytes go into the pod as
// they arrived, and lib/core/wire.mjs builds what we send as compacted AS2
// with a plain string @context, as it always did. This is a reading layer.
//
// Every document goes through the processor. There is no shortcut for the
// common shape: one that skipped it would not be read as JSON-LD, and would
// produce no graph, so nothing could be validated against it.
//
// CONTEXTS ARE NEVER FETCHED. `contextsFor` serves the fourteen the fediverse
// actually uses and refuses every other URL. That refusal is the point: this
// code runs on documents a stranger wrote, in the same path the SSRF guards
// protect, and expanding one would otherwise mean dereferencing a URL of their
// choosing. A document naming a context we do not hold is refused with a
// reason, which is a visible drop rather than a silent one.

import jsonld from 'jsonld';
import { AS_CTX } from './wire.mjs';
import { CONTEXTS } from './contexts/index.mjs';

export { CONTEXTS };

/** Why a document could not be read. Carried to the caller so a drop is explained. */
export class AS2Error extends Error {
  constructor(reason, { context = null } = {}) {
    super(reason);
    this.name = 'AS2Error';
    this.context = context;
  }
}

/**
 * A loader over the contexts we hold, and nothing else.
 *
 * jsonld calls this for every `@context` URL in a document. Anything not in
 * the map throws rather than being fetched, so a document cannot make this
 * process reach out to an address its sender picked.
 */
export function contextLoader(url) {
  const doc = CONTEXTS[url];
  if (!doc) {
    return Promise.reject(new AS2Error(`context not held here: ${url}`, { context: url }));
  }
  return Promise.resolve({ contextUrl: null, documentUrl: url, document: doc });
}

/**
 * Read AS2 bytes.
 *
 * Returns `{ doc, graph }` — the document compacted against the standard
 * context, which is what handlers read, and its quads, which is what a shape
 * is validated against. Throws AS2Error when the document cannot be read as
 * JSON-LD at all.
 *
 * `raw` is a string or a parsed object; both arrive here in practice.
 */
export async function parseAS2(raw) {
  let input;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw);
    } catch (e) {
      throw new AS2Error(`not JSON: ${e.message}`);
    }
  } else {
    input = raw;
  }
  if (!input || typeof input !== 'object') throw new AS2Error('not a JSON object');

  // A document with no @context expands to nothing at all — every term is
  // dropped, and the result is an empty graph rather than an error. Silently
  // reading a delivery as "no statements" is the worst of the outcomes, so it
  // is named here instead.
  if (input['@context'] === undefined) throw new AS2Error('no @context');

  const options = { documentLoader: contextLoader };
  let graph;
  let doc;
  try {
    graph = await jsonld.toRDF(input, options);          // RDF/JS quads, which is what a shape is checked against
    doc = await jsonld.compact(input, AS_CTX, options);
  } catch (e) {
    if (e instanceof AS2Error) throw e;
    // jsonld wraps a loader rejection; recover ours so the caller can say which
    // context was missing rather than reporting a library's own phrasing.
    const cause = e?.details?.cause ?? e?.cause;
    if (cause instanceof AS2Error) throw cause;
    throw new AS2Error(`not readable as JSON-LD: ${e.message}`);
  }
  return { doc, graph };
}

/**
 * Read AS2 bytes, and when they cannot be read as JSON-LD, read them the way
 * this project always did.
 *
 * A delivery naming a context we do not hold, or carrying none at all, is
 * still a delivery somebody sent. Refusing it here would lose mail that
 * arrives perfectly well today, so the JSON-LD read is an improvement on the
 * plain one and never a gate in front of it. `degraded` carries the reason
 * when the improvement did not happen, so a caller can record it instead of
 * letting it pass unnoticed.
 *
 * `doc` is null only when the bytes are not JSON at all, which is what the
 * plain read would have concluded too.
 */
export async function readLenient(raw) {
  try {
    const { doc, graph } = await parseAS2(raw);
    return { doc, graph, degraded: null };
  } catch (e) {
    let doc = null;
    try { doc = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? null); } catch { /* not JSON either */ }
    return { doc: (doc && typeof doc === 'object') ? doc : null, graph: null, degraded: e.message };
  }
}
