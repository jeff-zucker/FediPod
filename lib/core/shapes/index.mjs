// shapes/index.mjs — validating an ActivityStreams document against the shapes
// beside this file.
//
// A shape says what a kind of document IS. Checking one against a document we
// were sent is a different question from whether we trust it: a forged actor,
// a receipt that does not bind, a reply naming a note we never wrote are each
// guarded elsewhere, and none of those guards is replaced here.
//
// NOTHING HERE REJECTS ANYTHING. A failure is recorded and the activity is
// handled exactly as it would have been. Every fediverse implementation writes
// slightly different documents, and a shape strict enough to catch something
// real is strict enough to reject somebody's quirk; which one cannot be known
// in advance, so it is learned from the record rather than guessed at. A shape
// earns enforcement by not firing.

import { Parser } from 'n3';
import Environment from '@rdfjs/environment';
import DataFactory from '@rdfjs/data-model/Factory.js';
import DatasetFactory from '@rdfjs/dataset/Factory.js';
import NamespaceFactory from '@rdfjs/namespace/Factory.js';
import TermSetFactory from '@rdfjs/term-set/Factory.js';
import TermMapFactory from '@rdfjs/term-map/Factory.js';
import ClownfaceFactory from 'clownface/Factory.js';
import SHACLValidator from 'rdf-validate-shacl';
import { SHAPES_TTL } from './text.mjs';

// The validator needs a full RDF/JS environment, not a bare factory. These
// pieces are what rdf-validate-shacl itself depends on, composed here rather
// than pulling in a packaged environment that reads files — this has to run in
// a service worker too.
const rdf = new Environment([DataFactory, DatasetFactory, NamespaceFactory, TermSetFactory, TermMapFactory, ClownfaceFactory]);

// The shapes document's own URL is the base, so `<#Create>` resolves to a
// fragment of it and no namespace is claimed.
const SHAPES_BASE = 'https://fedipod.invalid/shapes';

let validator;
let brokenReported = false;

/** The validator, built once. Reading and parsing the shapes is not per-document work. */
function shacl() {
  if (!validator) {
    const quads = new Parser({ baseIRI: SHAPES_BASE, format: 'text/turtle' }).parse(SHAPES_TTL);
    validator = new SHACLValidator(rdf.dataset(quads.map(asTerm)), { factory: rdf });
  }
  return validator;
}

/** jsonld and n3 each mint their own terms; the validator's environment must mint the ones it sees. */
function asTerm(q) {
  const term = (t) => {
    if (t.termType === 'NamedNode') return rdf.namedNode(t.value);
    if (t.termType === 'BlankNode') return rdf.blankNode(String(t.value).replace(/^_:/u, ''));
    if (t.termType === 'Literal') {
      return rdf.literal(t.value, t.language || (t.datatype ? rdf.namedNode(t.datatype.value) : undefined));
    }
    return rdf.defaultGraph();
  };
  return rdf.quad(term(q.subject), term(q.predicate), term(q.object));
}

/**
 * Check a document's graph against the shapes.
 *
 * `quads` is what `parseAS2` produced. Returns null when the document
 * conforms or when there was no graph to check, and otherwise a short record
 * of what did not fit — the failing node, the property, and the shape's own
 * words for it.
 *
 * Never throws. A validator that cannot run is not a reason to drop mail — but
 * it is said once, because a checker that silently passes everything is the
 * same silence this change exists to remove.
 */
export async function checkShapes(quads) {
  if (!Array.isArray(quads) || quads.length === 0) return null;
  let report;
  try {
    report = await shacl().validate(rdf.dataset(quads.map(asTerm)));
  } catch (e) {
    // A validator that cannot run must not read as "everything conforms" —
    // that is the same silence this whole change exists to remove. Said once,
    // then quiet, because a broken validator would otherwise say it per item.
    if (!brokenReported) {
      brokenReported = true;
      return { conforms: false, broken: true, results: [{ focus: null, path: null, message: `shape validation is not running: ${e.message}`, shape: null }] };
    }
    return null;
  }
  if (report.conforms) return null;
  return {
    conforms: false,
    results: report.results.slice(0, 10).map((r) => ({
      focus: r.focusNode?.value ?? null,
      path: r.path?.value ?? null,
      message: r.message?.[0]?.value ?? String(r.sourceConstraintComponent?.value ?? 'does not fit the shape'),
      shape: r.sourceShape?.value ?? null,
    })),
  };
}

/** The failure as one line, for a log or a dead-letter record. */
export function describeShapeFailure(failure) {
  if (!failure) return null;
  return failure.results
    .map((r) => `${r.path ? r.path.replace(/^.*[#/]/u, '') : 'node'}: ${r.message}`)
    .join('; ');
}
