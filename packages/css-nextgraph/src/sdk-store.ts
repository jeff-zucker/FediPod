// sdk-store.ts — PodStore over an open SDK session: SPARQL for the graphs,
// the chunked upload and the streamed download for files, the document
// header for the title and kind of each document.
import { DataFactory, Writer } from 'n3';
import type { Quad, Quad_Object, Quad_Subject } from '@rdfjs/types';
import type { Sdk } from './sdk';
import type { DocInfo, FileEntry, PodStore, SubjectFilter } from './pod-store';
import { subjectFilterExpression } from './pod-store';

const { namedNode, literal, blankNode } = DataFactory;

interface RdfJsTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

function toTerm(t: RdfJsTerm): Quad_Subject | Quad_Object {
  switch (t.termType) {
    case 'NamedNode': return namedNode(t.value);
    case 'BlankNode': return blankNode(t.value);
    case 'Literal': return literal(t.value, t.language || (t.datatype ? namedNode(t.datatype.value) : undefined));
    default: throw new Error(`unexpected term ${t.termType}`);
  }
}

export class SdkPodStore implements PodStore {
  private readonly files = new Map<string, FileEntry[]>();

  public constructor(private readonly ng: Sdk, private readonly sessionId: number, private readonly privateStore: string) {}

  public async listDocs(): Promise<DocInfo[]> {
    // The store's own graph lists its documents with ldp:contains, NextGraph's
    // own use of the term.
    const res = await this.ng.sparql_query(this.sessionId,
      `SELECT ?doc WHERE { <${this.privateStore.replace(/:v:.*$/u, '')}> <http://www.w3.org/ns/ldp#contains> ?doc }`, undefined, this.privateStore);
    const docs: DocInfo[] = [];
    for (const row of res.results?.bindings ?? []) {
      const nuri: string = row.doc.value;
      const header = await this.ng.fetch_header(this.sessionId, nuri);
      docs.push({ nuri, title: header?.title ?? '', about: header?.about ?? '' });
    }
    return docs;
  }

  public async createDoc(title: string, about: string): Promise<string> {
    const nuri: string = await this.ng.doc_create(this.sessionId, 'Graph', 'data:graph', 'store', undefined, undefined);
    await this.ng.update_header(this.sessionId, nuri, title, about);
    return nuri;
  }

  public async insert(nuri: string, quads: Quad[]): Promise<void> {
    if (quads.length === 0) return;
    const triples = new Writer({ format: 'N-Triples' }).quadsToString(quads.map((q) => DataFactory.quad(q.subject, q.predicate, q.object)));
    await this.ng.sparql_update(this.sessionId, `INSERT DATA { ${triples} }`, nuri);
  }

  public async construct(nuri: string, filter?: SubjectFilter): Promise<Quad[]> {
    const expr = subjectFilterExpression(filter);
    const where = expr ? `?s ?p ?o . FILTER(${expr})` : '?s ?p ?o';
    const rows: Array<{ subject: RdfJsTerm; predicate: RdfJsTerm; object: RdfJsTerm }> =
      await this.ng.sparql_query(this.sessionId, `CONSTRUCT { ?s ?p ?o } WHERE { ${where} }`, undefined, nuri);
    return rows.map((q) => DataFactory.quad(toTerm(q.subject) as Quad_Subject, namedNode(q.predicate.value), toTerm(q.object)));
  }

  public async deleteSubjects(nuri: string, filter: SubjectFilter): Promise<void> {
    const expr = subjectFilterExpression(filter);
    if (!expr) return;
    await this.ng.sparql_update(this.sessionId, `DELETE { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER(${expr}) }`, nuri);
  }

  public async putFile(nuri: string, name: string, contentType: string, bytes: Buffer): Promise<string> {
    const uploadId = await this.ng.upload_start(this.sessionId, nuri, contentType);
    const chunk = 1024 * 1024;
    for (let i = 0; i < bytes.length; i += chunk) {
      const part = bytes.subarray(i, i + chunk);
      await this.ng.upload_chunk(this.sessionId, uploadId, part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength), nuri);
    }
    const end = await this.ng.upload_chunk(this.sessionId, uploadId, [], nuri);
    const ref = end?.V0?.FileUploaded;
    if (!ref) throw new Error('NextGraph did not answer the upload with a file reference');
    await this.ng.app_request_with_nuri_command(nuri, 'FilePut', this.sessionId, { AddFile: { filename: name, object: ref } });
    const fileNuri = `did:ng:j:${keyish(ref.id.Blake3Digest32)}:k:${keyish(ref.key.ChaCha20Key)}`;
    (await this.fileList(nuri)).push({ name, nuri: fileNuri });
    return fileNuri;
  }

  public async getFile(nuri: string, name: string): Promise<{ bytes: Buffer; contentType?: string } | undefined> {
    const entries = await this.fileList(nuri);
    const entry = [...entries].reverse().find((e) => e.name === name);
    if (!entry) return undefined;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let contentType: string | undefined;
      this.ng.file_get(this.sessionId, entry.nuri, nuri, (file: { V0: { FileMeta?: { content_type: string }; FileBinary?: number[]; Error?: string } | 'EndOfStream' }) => {
        const v = file.V0;
        if (v === 'EndOfStream') resolve({ bytes: Buffer.concat(chunks), contentType });
        else if (v.FileMeta) contentType = v.FileMeta.content_type;
        else if (v.FileBinary) chunks.push(Buffer.from(v.FileBinary));
        else if (v.Error) reject(new Error(v.Error));
      }).catch(reject);
    });
  }

  /** The document's file entries, read once from its state and kept current by putFile (this process is the only writer). */
  private async fileList(nuri: string): Promise<FileEntry[]> {
    let list = this.files.get(nuri);
    if (list) return list;
    list = await new Promise<FileEntry[]>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const timer = setTimeout(() => reject(new Error('NextGraph did not send the document state')), 15000);
      this.ng.doc_subscribe(nuri.slice(0, 53), this.sessionId, (response: { V0?: { State?: { files?: FileEntry[] } } }) => {
        if (response.V0?.State) {
          clearTimeout(timer);
          resolve((response.V0.State.files ?? []).map((f) => ({ name: f.name, nuri: f.nuri })));
          if (unsub) unsub();
        }
      }).then((u: () => void) => { unsub = u; }).catch(reject);
    });
    this.files.set(nuri, list);
    return list;
  }
}

function keyish(bytes: number[]): string {
  return Buffer.from([...bytes].reverse().concat(0)).toString('base64url');
}
