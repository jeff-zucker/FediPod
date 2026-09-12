// accessor.ts — a Community Solid Server DataAccessor over NextGraph.
//
// Every pod root has a wallet of its own on the host's daemon (wallets.ts).
// Inside it, every container has two Graph documents, found by their
// headers: a data document (about `css-nextgraph:data`, title the container
// URL) holding the triples of the RDF resources the container directly
// contains and, as files named by resource URL, its binary resources; and a
// meta document (about `css-nextgraph:meta`) holding CSS's metadata for each
// of those resources, subject by subject. A container's own metadata lives in
// its parent's meta document; a root's in its own. So a listing is one
// CONSTRUCT, a resource read is one CONSTRUCT or one file download, and the
// number of documents in a wallet is the number of containers, which is what
// every session start pays for.
//
// An RDF resource's triples are the ones whose subject is the resource's URL
// or a fragment of it; blank nodes are made fragments on the way in and
// blank nodes again on the way out. Triples about other subjects have no home
// in a shared graph and are refused with 409.
import type { Readable } from 'node:stream';
import arrayifyStream from 'arrayify-stream';
import { DataFactory } from 'n3';
import type { Quad } from '@rdfjs/types';
import {
  BasicRepresentation, CONTENT_TYPE_TERM, ConflictHttpError, INTERNAL_QUADS, NotFoundHttpError, NotImplementedHttpError, POSIX,
  RepresentationMetadata, UnsupportedMediaTypeHttpError, generateHttpErrorClass, getLoggerFor, guardedStreamFrom, isContainerIdentifier,
} from '@solid/community-server';
import type {
  DataAccessor, Guarded, IdentifierStrategy, Initializable, Representation, RepresentationConverter, ResourceIdentifier,
} from '@solid/community-server';
import { ABOUT_DATA, ABOUT_META, deskolemize, foreignSubject, ownSubjects, skolemize } from './pod-store';
import type { PodStore } from './pod-store';
import { WalletPods } from './wallets';
import type { PodStores } from './wallets';
import { MasterKey } from './masterkey';

const { namedNode } = DataFactory;

/**
 * What a pod answers while this server is locked. A request that waited
 * instead would hold a connection for as long as nobody unlocks, and enough
 * of them would be a server that cannot serve its own unlock page.
 */
const LockedHttpError = generateHttpErrorClass(503, 'ServiceUnavailable');

export interface NextGraphDataAccessorArgs {
  /** Decides roots and parents; a pod is everything under one root. */
  identifierStrategy: IdentifierStrategy;
  /** Where each pod's wallet file and its mnemonic are kept. Not pod data: the keys to it. */
  walletsDir: string;
  /** The daemon's PeerId, printed on its first start. */
  ngdPeerId: string;
  /** The daemon's client port on this machine. */
  ngdPort?: number;
  /**
   * The key each pod's wallet record is sealed under. One instance for the
   * server, so whatever offers the unlock hands the key to the same object
   * the accessor waits on. Without one the records are written in the clear.
   */
  masterKey?: MasterKey;
  /**
   * The server's converter. What it can turn into quads (Turtle, JSON-LD and
   * the rest) is stored as triples; what it cannot (media, ActivityPub JSON)
   * is stored as the bytes it came as. Without one, only quads become triples.
   */
  converter?: RepresentationConverter;
}

/** What the accessor keeps per open pod. */
interface Pod {
  store: PodStore;
  /** container URL → data document Nuri */
  data: Map<string, string>;
  /** container URL → meta document Nuri */
  meta: Map<string, string>;
}

const VERSION = '0.2.0';

/** The media types stored as triples. ActivityPub's application/activity+json is not one: the Fediverse needs those bytes back exact. */
export const RDF_TYPES = new Set([
  'text/turtle', 'application/ld+json', 'application/n-triples', 'application/n-quads', 'application/trig', 'text/n3',
  'application/rdf+xml', 'application/sparql-update', 'text/rdf+n3',
]);

export class NextGraphDataAccessor implements DataAccessor, Initializable {
  protected readonly logger = getLoggerFor(this);
  private readonly strategy: IdentifierStrategy;
  private readonly pods = new Map<string, Promise<Pod>>();
  private stores?: PodStores;
  private readonly args: NextGraphDataAccessorArgs;

  public constructor(args: NextGraphDataAccessorArgs) {
    this.args = args;
    this.strategy = args.identifierStrategy;
  }

  /** The tests hand in stores of their own; a server gets wallets on the daemon. */
  public useStores(stores: PodStores): this {
    this.stores = stores;
    return this;
  }

  /**
   * Opens every pod's wallet when the server starts, so no request waits the
   * seconds a wallet takes to open and connect. Registered on the server's
   * initializer list by the config; a pod whose wallet will not open is
   * logged and left for its first request to report.
   */
  public async initialize(): Promise<void> {
    // A server whose key has not been supplied yet still starts: opening waits
    // on the key, and a start that waited with it would never finish listening
    // — which is the page the key is typed into.
    if (this.args.masterKey && !this.args.masterKey.present) {
      const waiting = this.podStores().roots?.().length ?? 0;
      if (waiting) this.logger.warn(`${waiting} NextGraph wallet(s) stay closed until this server's master key is supplied`);
      return;
    }
    await this.openAll();
  }

  /**
   * Open every pod that has a wallet here. Called when the server starts, and
   * again by the unlock the moment a key arrives — a pod nobody has opened is
   * a pod that answers nothing.
   */
  public async openAll(): Promise<number> {
    const stores = this.podStores();
    const roots = stores.roots ? stores.roots() : [];
    let open = 0;
    await Promise.all(roots.map(async (root): Promise<void> => {
      try {
        await this.podFor({ path: root }, false);
        open += 1;
      } catch (error: unknown) {
        this.logger.warn(`could not open the NextGraph wallet of ${root}: ${String(error)}`);
      }
    }));
    if (roots.length) this.logger.info(`${open} of ${roots.length} NextGraph wallet(s) open`);
    return open;
  }

  /** Whether a key opens the records this server already holds — what the unlock asks before taking one. */
  public opensWith(key: Buffer): boolean {
    const stores = this.podStores();
    return stores.opens ? stores.opens(key) : true;
  }

  public async canHandle(_representation: Representation): Promise<void> {
    // Quads become triples in a graph, anything else a file: all of it is handled.
  }

  public async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const pod = await this.podFor(identifier, false);
    const metadata = await this.metadataOf(pod, identifier);
    const parent = this.strategy.getParentContainer(identifier);
    const doc = pod.data.get(parent.path);
    if (!doc) throw new NotFoundHttpError();
    if (metadata.contentType && metadata.contentType !== INTERNAL_QUADS) {
      const file = await pod.store.getFile(doc, identifier.path);
      if (!file) throw new NotFoundHttpError();
      return guardedStreamFrom([file.bytes]);
    }
    const quads = await pod.store.construct(doc, ownSubjects(identifier.path));
    return guardedStreamFrom(deskolemize(identifier.path, quads));
  }

  public async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const pod = await this.podFor(identifier, false);
    return this.metadataOf(pod, identifier);
  }

  public async* getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    const pod = await this.podFor(identifier, false);
    const doc = pod.meta.get(identifier.path);
    if (!doc) return;
    const bySubject = new Map<string, Quad[]>();
    for (const quad of await pod.store.construct(doc)) {
      const subject = quad.subject.value;
      // A root keeps its own metadata in its own meta document; that is not a child.
      if (subject === identifier.path) continue;
      let list = bySubject.get(subject);
      if (!list) bySubject.set(subject, list = []);
      list.push(quad);
    }
    for (const [subject, quads] of bySubject) {
      yield new RepresentationMetadata(namedNode(subject)).addQuads(quads);
    }
  }

  public async writeDocument(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata): Promise<void> {
    const pod = await this.podFor(identifier, true);
    const parent = this.strategy.getParentContainer(identifier);
    const doc = await this.ensureDocs(pod, parent, 'data');
    ({ data, metadata } = await this.asQuadsIfPossible(identifier, data, metadata));
    if (metadata.contentType === INTERNAL_QUADS) {
      const quads = skolemize(identifier.path, await arrayifyStream<Quad>(data));
      if (quads.some((q) => q.graph.termType !== 'DefaultGraph')) {
        throw new NotImplementedHttpError('Only triples in the default graph are supported.');
      }
      const foreign = foreignSubject(identifier.path, quads);
      if (foreign) {
        throw new ConflictHttpError(`${identifier.path} can only hold triples about itself; found subject ${foreign}`);
      }
      await pod.store.deleteSubjects(doc, ownSubjects(identifier.path));
      await pod.store.insert(doc, quads);
      // Not stored: on the way out every RDF resource is quads again.
      metadata.removeAll(CONTENT_TYPE_TERM);
    } else {
      const bytes = Buffer.concat((await arrayifyStream<Buffer | string>(data)).map((c) => (typeof c === 'string' ? Buffer.from(c) : c)));
      await pod.store.putFile(doc, identifier.path, metadata.contentType ?? 'application/octet-stream', bytes);
      metadata.set(POSIX.terms.size, `${bytes.length}`);
    }
    await this.replaceMetadata(pod, identifier, metadata);
  }

  public async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const pod = await this.podFor(identifier, true);
    await this.ensureDocs(pod, identifier, 'data');
    await this.ensureDocs(pod, identifier, 'meta');
    await this.replaceMetadata(pod, identifier, metadata);
  }

  public async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const pod = await this.podFor(identifier, false);
    await this.replaceMetadata(pod, identifier, metadata);
  }

  public async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const pod = await this.podFor(identifier, false);
    const home = pod.meta.get(this.metadataHome(identifier).path);
    if (!home) throw new NotFoundHttpError();
    await pod.store.deleteSubjects(home, { exact: [identifier.path] });
    if (!isContainerIdentifier(identifier)) {
      const doc = pod.data.get(this.strategy.getParentContainer(identifier).path);
      // A file entry cannot be removed from a document; without its metadata
      // the resource is gone, and a later write under the name is the newest entry.
      if (doc) await pod.store.deleteSubjects(doc, ownSubjects(identifier.path));
    }
    // A container's own documents stay: documents cannot be deleted. They are
    // empty by now (CSS deletes only empty containers) and are reused if the
    // container comes back.
  }

  /**
   * An RDF document becomes quads here; anything else is left as it came.
   * "RDF" is decided by the media type, not by what the converter could reach
   * through a chain: markdown reaches quads through HTML and RDFa and arrives
   * empty, which is a README lost.
   */
  private async asQuadsIfPossible(identifier: ResourceIdentifier, data: Guarded<Readable>, metadata: RepresentationMetadata):
  Promise<{ data: Guarded<Readable>; metadata: RepresentationMetadata }> {
    if (metadata.contentType === INTERNAL_QUADS || !this.args.converter) return { data, metadata };
    const type = metadata.contentTypeObject?.value ?? metadata.contentType;
    if (!type || !RDF_TYPES.has(type)) return { data, metadata };
    const input = { identifier, representation: new BasicRepresentation(data, metadata), preferences: { type: { [INTERNAL_QUADS]: 1 } } };
    try {
      const converted = await this.args.converter.handleSafe(input);
      return { data: converted.data, metadata: converted.metadata };
    } catch (error: unknown) {
      // A type the server has no parser for: the bytes are the resource.
      if (NotImplementedHttpError.isInstance(error) || UnsupportedMediaTypeHttpError.isInstance(error)) return { data, metadata };
      throw error;
    }
  }

  // ---- the pod behind an identifier

  private async podFor(identifier: ResourceIdentifier, create: boolean): Promise<Pod> {
    if (!this.strategy.supportsIdentifier(identifier)) throw new NotFoundHttpError();
    if (this.args.masterKey && !this.args.masterKey.present) {
      throw new LockedHttpError('this server is locked: its master key has not been supplied yet');
    }
    let root = identifier;
    while (!this.strategy.isRootContainer(root)) root = this.strategy.getParentContainer(root);
    let pending = this.pods.get(root.path);
    if (!pending) {
      const store = await this.podStores().open(root.path, create);
      if (!store) throw new NotFoundHttpError();
      pending = this.load(store);
      this.pods.set(root.path, pending);
      pending.catch(() => this.pods.delete(root.path));
    }
    return pending;
  }

  private podStores(): PodStores {
    if (!this.stores) {
      this.stores = new WalletPods({
        dir: this.args.walletsDir, peerId: this.args.ngdPeerId, port: this.args.ngdPort ?? 1440, version: VERSION,
        masterKey: this.args.masterKey,
        log: (message): void => { this.logger.info(message); },
      });
    }
    return this.stores;
  }

  /** The container → document maps, read from the documents' headers. */
  private async load(store: PodStore): Promise<Pod> {
    const pod: Pod = { store, data: new Map(), meta: new Map() };
    for (const doc of await store.listDocs()) {
      if (doc.about === ABOUT_DATA) pod.data.set(doc.title, doc.nuri);
      else if (doc.about === ABOUT_META) pod.meta.set(doc.title, doc.nuri);
    }
    return pod;
  }

  private async ensureDocs(pod: Pod, container: ResourceIdentifier, kind: 'data' | 'meta'): Promise<string> {
    const map = pod[kind];
    let nuri = map.get(container.path);
    if (!nuri) {
      nuri = await pod.store.createDoc(container.path, kind === 'data' ? ABOUT_DATA : ABOUT_META);
      map.set(container.path, nuri);
    }
    return nuri;
  }

  // ---- metadata, subject by subject in the parent's meta document

  /** The container whose meta document holds this resource's metadata. */
  private metadataHome(identifier: ResourceIdentifier): ResourceIdentifier {
    return this.strategy.isRootContainer(identifier) ? identifier : this.strategy.getParentContainer(identifier);
  }

  private async metadataOf(pod: Pod, identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    const doc = pod.meta.get(this.metadataHome(identifier).path);
    if (!doc) throw new NotFoundHttpError();
    const quads = await pod.store.construct(doc, { exact: [identifier.path] });
    if (quads.length === 0) throw new NotFoundHttpError();
    const metadata = new RepresentationMetadata(identifier).addQuads(quads);
    if (!isContainerIdentifier(identifier) && !metadata.contentType) metadata.contentType = INTERNAL_QUADS;
    return metadata;
  }

  private async replaceMetadata(pod: Pod, identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const doc = await this.ensureDocs(pod, this.metadataHome(identifier), 'meta');
    const quads = metadata.quads().filter((q) => q.graph.termType === 'DefaultGraph' &&
      q.subject.termType === 'NamedNode' && q.subject.value === identifier.path && q.object.termType !== 'BlankNode');
    await pod.store.deleteSubjects(doc, { exact: [identifier.path] });
    await pod.store.insert(doc, quads);
  }
}
