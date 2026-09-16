// as2.mjs — the one place ActivityStreams bytes become something to handle.
//
// An AS2 document IS a JSON-LD document; ActivityStreams 2.0 Core says so. We
// read it as one. Expanding it to a graph is what makes the document mean the
// same thing however its sender chose to write it — `"type": "Create"` and
// `"@type": "as:Create"` are the same statement, and only a JSON-LD reader
// knows that.
//
// The graph is what the handlers read, through lib/core/graphview.mjs. `doc`,
// the copy compacted against the standard context, is kept for the callers
// that republish what they read rather than act on it — compaction alone drops
// any term the sender defined in its own context, so it is the weaker read.
//
// What we STORE and SEND is untouched by any of this. Bytes go into the pod as
// they arrived, and lib/core/wire.mjs builds what we send as compacted AS2
// with a plain string @context, as it always did. This is a reading layer.
//
// Every document goes through the processor. There is no shortcut for the
// common shape: one that skipped it would not be read as JSON-LD, and would
// produce no graph, so nothing could be validated against it.
//
// CONTEXTS ARE NEVER FETCHED. The loader serves the ones the fediverse
// actually uses and refuses every other URL. That refusal is the point: this
// code runs on documents a stranger wrote, in the same path the SSRF guards
// protect, and expanding one would otherwise mean dereferencing a URL of their
// choosing. A document naming a context we do not hold is not lost for it —
// `groundContext` reads it against the contexts we hold and says so in
// `degraded` — but nothing is ever fetched to make that happen.

import jsonld from 'jsonld';
import { AS_CTX } from './wire.mjs';
import { CONTEXTS } from './contexts/index.mjs';
import { graphView } from './graphview.mjs';

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
// Pleroma and Akkoma name their own copy of the litepub schema, one URL per
// instance. Every copy is the same document, held here under the litepub
// namespace, so a per-instance URL names that entry.
const LITEPUB = 'http://litepub.social/ns';
export const heldKey = (url) => (typeof url === 'string' && /\/schemas\/litepub-0\.1\.jsonld$/u.test(url) ? LITEPUB : url);

export function contextLoader(url) {
  const doc = CONTEXTS[heldKey(url)];
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
 * Rewrite a document's `@context` to one we can read without fetching anything.
 *
 * A document carrying no `@context` is not a puzzle: AS2 Core §2.1 says a
 * consumer meeting `application/activity+json` without one MUST assume the
 * normative context still applies. That is what this does. A document naming a
 * context we do not hold keeps every entry we DO hold — inline objects
 * included, since those need no fetch — and loses only the unfetchable ones,
 * so a Mastodon post with an unknown extension still reads as a post.
 *
 * Nothing here dereferences a URL. The result names only contexts already on
 * disk, so the guarantee that a stranger's document cannot make us reach out
 * survives the fallback.
 */
export function groundContext(input) {
  const ctx = input['@context'];
  const held = (c) => typeof c === 'string' ? Object.hasOwn(CONTEXTS, heldKey(c)) : (c && typeof c === 'object');
  let kept;
  if (ctx === undefined || ctx === null) kept = [];
  else if (Array.isArray(ctx)) kept = ctx.filter(held);
  else kept = held(ctx) ? [ctx] : [];
  if (!kept.some(c => c === AS_CTX)) kept.unshift(AS_CTX);
  return { ...input, '@context': kept.length === 1 ? kept[0] : kept };
}

/**
 * Read AS2 bytes, and when they cannot be read as JSON-LD as written, read
 * them against the contexts we do hold.
 *
 * A delivery naming a context we do not hold, or carrying none at all, is
 * still a delivery somebody sent. It is now grounded rather than refused, so
 * `graph` is present for anything that is JSON at all — which is what lets the
 * handlers read the graph instead of the document. `degraded` still carries
 * the reason the document could not be read exactly as written, so a caller
 * records what happened instead of letting it pass unnoticed.
 *
 * `doc` and `graph` are null only when the bytes are not JSON at all, which is
 * what the plain read would have concluded too.
 */
export async function readLenient(raw) {
  // The document's own node is the one its `id` names. Handed to the view
  // as the root, so a document that points at itself — every actor does,
  // through its key's `owner` — is still read as itself.
  let input = null;
  try { input = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? null); } catch { /* not JSON either */ }
  const own = input && typeof input === 'object' ? (input.id ?? input['@id']) : null;
  const root = typeof own === 'string' && /^https?:\/\//u.test(own) ? own : null;
  try {
    const { doc, graph } = await parseAS2(raw);
    return { doc, graph, view: graphView(graph, { root }), degraded: null };
  } catch (e) {
    if (!input || typeof input !== 'object') return { doc: null, graph: null, view: null, degraded: e.message };
    // Grounded, so a graph exists for every document that is JSON at all.
    //
    // `doc` stays the bytes as they were parsed, NOT the grounded compaction.
    // Compacting shortens an IRI to whatever term names it — `#Public` comes
    // back as `as:Public` — and the callers that still read `doc` republish
    // what they read, so rewriting it here silently changed what they posted.
    try {
      const { graph } = await parseAS2(groundContext(input));
      return { doc: input, graph, view: graphView(graph, { root }), degraded: e.message };
    } catch (inner) {
      // Grounding names only held contexts, so reaching here means the document
      // is malformed JSON-LD rather than unfetchable. Hand back what a plain
      // read would have seen, with no graph, as this always did.
      return { doc: input, graph: null, view: null, degraded: `${e.message}; grounded read also failed: ${inner.message}` };
    }
  }
}
