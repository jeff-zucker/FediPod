// storage.mjs — a container of documents, and the two places one can live.
//
// The store and the RDF tree only ever do four things to a container: list its
// children, read one, write one, remove one. Everything else an LDP server
// offers — membership triples, content negotiation, status codes, auxiliary
// resources — exists to satisfy HTTP. So the filesystem implementation does
// not pretend to have any of it, and nothing serialises a container listing
// into RDF only to parse it straight back out.
//
// Paths are relative to the container's base ('config.json', 'posts/n1'), and
// a name ending in '/' is a child container, in both implementations.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as $rdf from 'rdflib';

const LDP = $rdf.Namespace('http://www.w3.org/ns/ldp#');
const slash = (u) => (u.endsWith('/') ? u : u + '/');

// A pod, local or remote. `fetchImpl` carries whatever authentication it needs.
export class HttpStorage {
  constructor(base, fetchImpl) {
    this.base = slash(base);
    this.fetchImpl = fetchImpl;
  }

  get kind() { return 'pod'; }

  async list(sub = '', { etag } = {}) {
    const url = this.base + sub;
    const res = await this.fetchImpl(url, {
      headers: { accept: 'text/turtle', ...(etag ? { 'if-none-match': etag } : {}) },
    });
    if (res.status === 304) return { notModified: true, names: null, etag };
    if (res.status === 404) return { notModified: false, names: [], etag: null };
    if (res.status >= 400) throw new Error(`container unreadable (HTTP ${res.status})`);
    const g = $rdf.graph();
    // Throws on malformed Turtle rather than quietly matching the wrong thing,
    // which is the entire reason this is not a regex.
    $rdf.parse(await res.text(), g, url, 'text/turtle');
    const here = $rdf.sym(url);
    const names = g.each(here, LDP('contains'), null, here)
      .map(n => n.value)
      .filter(u => u.startsWith(url) && u !== url)
      .map(u => decodeURIComponent(u.slice(url.length)));
    return { notModified: false, names, etag: res.headers.get('etag') };
  }

  async read(p, { etag } = {}) {
    const res = await this.fetchImpl(this.base + encodeURI(p), {
      headers: { accept: 'text/turtle, application/json;q=0.9, */*;q=0.8', ...(etag ? { 'if-none-match': etag } : {}) },
    });
    if (res.status === 304) return { ok: true, notModified: true, status: 304, body: null, etag };
    if (res.status >= 400) return { ok: false, notModified: false, status: res.status, body: null, etag: null };
    return { ok: true, notModified: false, status: res.status, body: await res.text(), etag: res.headers.get('etag') };
  }

  async write(p, body, contentType) {
    try {
      const res = await this.fetchImpl(this.base + encodeURI(p), {
        method: 'PUT', headers: { 'content-type': contentType }, body,
      });
      if (res.status < 400) return { ok: true, retry: false, why: '' };
      // A 4xx is an answer, not a hiccup: retrying a 403 or a 409 four more
      // times just spends the pod's write lock to be told the same thing.
      const retry = res.status >= 500 || res.status === 429;
      const ra = Number(res.headers?.get?.('retry-after'));
      return {
        ok: false, retry, why: `HTTP ${res.status}`,
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0,
      };
    } catch (e) {
      return { ok: false, retry: true, why: e.message, retryAfterMs: 0 };
    }
  }

  async remove(p) {
    try {
      const res = await this.fetchImpl(this.base + encodeURI(p), { method: 'DELETE' });
      return res.status < 400 || res.status === 404;
    } catch { return false; }
  }
}

// A directory. No server, so no round-trip and nothing to be unreachable —
// which is why a write here is never worth retrying: an EACCES will still be
// an EACCES in two seconds.
export class FileStorage {
  constructor(base) {
    this.base = slash(base.startsWith('file:') ? base : pathToFileURL(base).href);
    // resolve() drops the trailing separator, which the jail check below needs:
    // '/a/b/' + sep is '/a/b//', and nothing under it starts with that.
    this.dir = path.resolve(fileURLToPath(this.base));
  }

  get kind() { return 'files'; }

  _path(p) {
    const full = path.resolve(this.dir, decodeURIComponent(p));
    if (full !== this.dir && !full.startsWith(this.dir + path.sep)) {
      throw new Error(`path escapes the container: ${p}`);
    }
    return full;
  }

  async list(sub = '') {
    let entries;
    try { entries = await fsp.readdir(this._path(sub), { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return { notModified: false, names: [], etag: null }; throw e; }
    return {
      notModified: false, etag: null,
      names: entries.map(e => (e.isDirectory() ? e.name + '/' : e.name)),
    };
  }

  // The jail check is deliberately outside the try: a path that climbs out of
  // its container is a bug in the caller, and reporting it as "could not read"
  // would hide it. Only actual I/O is reported.
  async read(p) {
    const full = this._path(p);
    try {
      return { ok: true, notModified: false, status: 200, body: await fsp.readFile(full, 'utf8'), etag: null };
    } catch (e) {
      return { ok: false, notModified: false, status: e.code === 'ENOENT' ? 404 : 500, body: null, etag: null };
    }
  }

  // Written to a neighbour and renamed: rename is atomic on POSIX, so a reader
  // — or a backup — never sees half a document.
  async write(p, body) {
    const full = this._path(p);                      // throws on an escape
    try {
      await fsp.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      const tmp = `${full}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, body, { mode: 0o600 });
      await fsp.rename(tmp, full);
      return { ok: true, retry: false, why: '' };
    } catch (e) {
      return { ok: false, retry: false, why: e.message };
    }
  }

  async remove(p) {
    const full = this._path(p);                      // throws on an escape
    try { await fsp.rm(full, { force: true }); return true; }
    catch { return false; }
  }
}

// `file:` (or a bare path) is a directory; anything else is a pod.
export function storageFor(base, fetchImpl) {
  return /^https?:/i.test(base) ? new HttpStorage(base, fetchImpl) : new FileStorage(base);
}
