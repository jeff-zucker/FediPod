// pod-store.ts — the seven operations the accessor needs from a pod's
// NextGraph store, and the pure helpers over them. One implementation talks
// to the SDK (sdk-store.ts); the tests use an in-memory one.
import { DataFactory } from 'n3';
import type { Quad, Quad_Subject, Quad_Object } from '@rdfjs/types';

const { namedNode, blankNode } = DataFactory;

/** Which subjects a construct or delete touches: exact IRIs, and IRI prefixes. */
export interface SubjectFilter {
  exact?: string[];
  prefixes?: string[];
}

export interface DocInfo {
  nuri: string;
  title: string;
  about: string;
}

export interface FileEntry {
  name: string;
  nuri: string;
}

export interface PodStore {
  /** Every document in the pod's private store, with its header. */
  listDocs: () => Promise<DocInfo[]>;
  /** Makes a Graph document and sets its header; returns its Nuri. */
  createDoc: (title: string, about: string) => Promise<string>;
  insert: (nuri: string, quads: Quad[]) => Promise<void>;
  construct: (nuri: string, filter?: SubjectFilter) => Promise<Quad[]>;
  deleteSubjects: (nuri: string, filter: SubjectFilter) => Promise<void>;
  /** Adds a file entry under `name`; an existing name gets a second entry. */
  putFile: (nuri: string, name: string, contentType: string, bytes: Buffer) => Promise<string>;
  /** The newest entry under `name`, or undefined. */
  getFile: (nuri: string, name: string) => Promise<{ bytes: Buffer; contentType?: string } | undefined>;
}

/** The header `about` values that mark the two documents a container has. */
export const ABOUT_DATA = 'css-nextgraph:data';
export const ABOUT_META = 'css-nextgraph:meta';

/** A SPARQL string literal: quotes and backslashes escaped. */
export function sparqlString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n')}"`;
}

/** The FILTER expression for a subject filter, or undefined when it selects everything. */
export function subjectFilterExpression(filter: SubjectFilter | undefined, variable = '?s'): string | undefined {
  if (!filter) return undefined;
  const parts = [
    ...(filter.exact ?? []).map((iri) => `${variable} = <${iri}>`),
    ...(filter.prefixes ?? []).map((prefix) => `STRSTARTS(STR(${variable}), ${sparqlString(prefix)})`),
  ];
  return parts.length ? parts.join(' || ') : undefined;
}

/** Whether a subject IRI belongs to a filter. */
export function subjectMatches(filter: SubjectFilter | undefined, subject: string): boolean {
  if (!filter) return true;
  return (filter.exact ?? []).includes(subject) || (filter.prefixes ?? []).some((p) => subject.startsWith(p));
}

/** The subject filter for one resource: the resource itself and its fragments. */
export function ownSubjects(resource: string): SubjectFilter {
  return { exact: [resource], prefixes: [`${resource}#`] };
}

const GENID = '#genid';

/**
 * Blank nodes cannot be attributed to a resource once they sit in a graph
 * shared by a container's resources, so on the way in each becomes a fragment
 * IRI of the resource (`<resource>#genid<n>`), and on the way out those come
 * back as blank nodes. The names are the resource's own, not a vocabulary.
 */
export function skolemize(resource: string, quads: Quad[]): Quad[] {
  const names = new Map<string, Quad_Subject>();
  const term = <T extends Quad_Subject | Quad_Object>(t: T): T => {
    if (t.termType !== 'BlankNode') return t;
    let n = names.get(t.value);
    if (!n) {
      n = namedNode(`${resource}${GENID}${names.size + 1}`);
      names.set(t.value, n);
    }
    return n as unknown as T;
  };
  return quads.map((q) => DataFactory.quad(term(q.subject), q.predicate, term(q.object), q.graph));
}

export function deskolemize(resource: string, quads: Quad[]): Quad[] {
  const prefix = `${resource}${GENID}`;
  const term = <T extends Quad_Subject | Quad_Object>(t: T): T => {
    if (t.termType !== 'NamedNode' || !t.value.startsWith(prefix)) return t;
    return blankNode(`b${t.value.slice(prefix.length)}`) as unknown as T;
  };
  return quads.map((q) => DataFactory.quad(term(q.subject), q.predicate, term(q.object), q.graph));
}

/** The first subject that is not the resource's own, or undefined. */
export function foreignSubject(resource: string, quads: Quad[]): string | undefined {
  for (const q of quads) {
    if (q.subject.termType !== 'NamedNode') return q.subject.value;
    if (!subjectMatches(ownSubjects(resource), q.subject.value)) return q.subject.value;
  }
  return undefined;
}
