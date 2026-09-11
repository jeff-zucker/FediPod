// memory-store.mjs — the PodStore contract in memory, for the accessor tests:
// documents are arrays of quads plus file entries, subjects are matched the
// way the SPARQL filters would match them. `MemoryPods` hands one store per
// pod root and remembers it, so a second accessor over the same pods sees
// what the first wrote, as a restarted server would.
import { DataFactory } from 'n3';

function matches(filter, subject) {
  if (!filter) return true;
  return (filter.exact ?? []).includes(subject) || (filter.prefixes ?? []).some((p) => subject.startsWith(p));
}

export class MemoryPodStore {
  constructor() {
    this.docs = new Map(); // nuri → { title, about, quads: Quad[], files: [{name, nuri, bytes, contentType}] }
    this.calls = [];
  }

  async listDocs() {
    return [...this.docs.entries()].map(([nuri, d]) => ({ nuri, title: d.title, about: d.about }));
  }

  async createDoc(title, about) {
    const nuri = `did:ng:o:doc${this.docs.size + 1}:v:x`;
    this.docs.set(nuri, { title, about, quads: [], files: [] });
    this.calls.push(['createDoc', title, about]);
    return nuri;
  }

  doc(nuri) {
    const d = this.docs.get(nuri);
    if (!d) throw new Error(`no document ${nuri}`);
    return d;
  }

  async insert(nuri, quads) {
    this.doc(nuri).quads.push(...quads.map((q) => DataFactory.quad(q.subject, q.predicate, q.object)));
  }

  async construct(nuri, filter) {
    return this.doc(nuri).quads.filter((q) => matches(filter, q.subject.value));
  }

  async deleteSubjects(nuri, filter) {
    const d = this.doc(nuri);
    d.quads = d.quads.filter((q) => !matches(filter, q.subject.value));
  }

  async putFile(nuri, name, contentType, bytes) {
    const d = this.doc(nuri);
    const fileNuri = `did:ng:j:file${d.files.length + 1}`;
    d.files.push({ name, nuri: fileNuri, bytes: Buffer.from(bytes), contentType });
    return fileNuri;
  }

  async getFile(nuri, name) {
    const entry = [...this.doc(nuri).files].reverse().find((f) => f.name === name);
    return entry ? { bytes: entry.bytes, contentType: entry.contentType } : undefined;
  }
}

export class MemoryPods {
  constructor() {
    this.stores = new Map();
    this.opened = [];
  }

  async open(root, create) {
    this.opened.push([root, create]);
    let store = this.stores.get(root);
    if (!store && create) this.stores.set(root, store = new MemoryPodStore());
    return store;
  }
}
