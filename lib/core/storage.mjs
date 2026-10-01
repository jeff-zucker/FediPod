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
import { podOnly } from './pod-only.mjs';

const LDP = $rdf.Namespace('http://www.w3.org/ns/ldp#');
const slash = (u) => (u.endsWith('/') ? u : u + '/');

// A pod, local or remote. `fetchImpl` carries whatever authentication it needs.
export class HttpStorage {
  constructor(base, fetchImpl) {
    this.base = slash(base);
    this.fetchImpl = fetchImpl;
  }

  get kind() { return 'pod'; }

  // The same jail FileStorage has, and for the same reason: a path here can
  // carry `..`, encodeURI leaves both `.` and `/` alone, and fetch normalises
  // the segments away — so a name derived from remote input could name a
  // resource outside the container entirely. A prefix check is not enough on
  // its own: a concatenated URL always satisfies one.
  _url(p) {
    const u = new URL(encodeURI(p), this.base);
    if (!u.href.startsWith(this.base)) throw new Error(`path escapes the container: ${p}`);
    return u.href;
  }

  async list(sub = '', { etag } = {}) {
    const url = this._url(sub);
    const res = await this.fetchImpl(url, {
      headers: { accept: 'text/turtle', ...(etag ? { 'if-none-match': etag } : {}) },
    });
    if (res.status === 304) return { notModified: true, names: null, etag };
    // `missing` because a 404 is ambiguous over HTTP: a pod saying "no such
    // container" and a proxy answering for a dead backend look identical.
    // The caller decides whether absence is an answer here.
    if (res.status === 404) return { notModified: false, names: [], etag: null, missing: true };
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

  // `accept` is for callers reading something that is RDF but is wanted as it
  // was written: asking turtle-first for a JSON-LD document gets turtle back,
  // because the server is entitled to convert between two RDF syntaxes.
  async read(p, { etag, accept } = {}) {
    const res = await this.fetchImpl(this._url(p), {
      headers: {
        accept: accept || 'text/turtle, application/json;q=0.9, */*;q=0.8',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    });
    if (res.status === 304) return { ok: true, notModified: true, status: 304, body: null, etag };
    if (res.status >= 400) return { ok: false, notModified: false, status: res.status, body: null, etag: null };
    return { ok: true, notModified: false, status: res.status, body: await res.text(), etag: res.headers.get('etag') };
  }

  async write(p, body, contentType) {
    const url = this._url(p);                          // outside the try, as in FileStorage
    try {
      const res = await this.fetchImpl(url, {
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
    const url = this._url(p);                          // outside the try, as in FileStorage
    try {
      const res = await this.fetchImpl(url, { method: 'DELETE' });
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

export { podOnly };

/**
 * An account's state kept at its gateway, reached through the gateway's state
 * API (lib/gateway/state-api.mjs) with the token it handed out. `holder` is
 * this agent's lease id: the gateway takes a write only from the lease's
 * holder, and `onRefused` hears when it would not. What stays on the pod is
 * read and written on `pod`.
 *
 * For a person's copy (version 2) the copy holds only some documents
 * (`inCopy`); every other one lives on the pod alone. With `mirror`, every
 * write to a document in the copy is also written to the pod, so the pod is
 * never behind what this agent did. `publicConfig`, when given, turns the
 * settings into their public part, which is kept in the copy for the gateway
 * whenever the settings are written (lib/core/pod-only.mjs).
 */
export class StateApiStorage {
  constructor(base, { fetchImpl = globalThis.fetch, token, holder, pod = null, onRefused = null, inCopy = null, mirror = false, publicConfig = null, onFull = null, log = () => {} }) {
    this.base = slash(base);
    this.fetchImpl = fetchImpl;
    this.token = token;
    this.holder = holder;
    this.pod = pod;
    this.onRefused = onRefused;
    this.inCopy = inCopy;
    this.mirror = mirror;
    this.publicConfig = publicConfig;
    this.onFull = onFull;
    this.log = log;
  }

  get kind() { return 'copy'; }

  async _ask(p, init = {}) {
    const res = await this.fetchImpl(this.base + encodeURIComponent(p), {
      ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.headers || {}) },
    });
    // The gateway says on every answer whether the copy is full.
    const full = res.headers?.get?.('x-fedipod-full');
    if (full !== null && full !== undefined) this.onFull?.(full === '1');
    return res;
  }

  // On the pod alone: what never leaves it, and what this copy does not hold.
  _onPod(p) { return podOnly(p) || (!!this.inCopy && !this.inCopy(p)); }

  async list(sub = '', { etag } = {}) {
    if (sub) return { notModified: false, names: [], etag: null };
    const [copyTag, podTag] = String(etag || '').split('|');
    const res = await this._ask('', { headers: copyTag ? { 'if-none-match': copyTag } : {} });
    if (res.status >= 400) throw new Error(`the account's copy at the gateway is unreadable (HTTP ${res.status})`);
    const fromCopy = res.status === 304 ? null : (await res.json()).names;
    const newCopyTag = res.status === 304 ? copyTag : res.headers.get('etag');
    if (!this.inCopy || !this.pod) {
      if (res.status === 304) return { notModified: true, names: null, etag };
      return { notModified: false, names: fromCopy, etag: newCopyTag };
    }
    const fromPod = await this.pod.list('', { etag: podTag || null });
    if (res.status === 304 && fromPod.notModified) return { notModified: true, names: null, etag };
    // Not modified on one side is a full listing again, from both.
    const copyNames = fromCopy || (await (await this._ask('')).json()).names;
    const podNames = fromPod.notModified ? (await this.pod.list('')).names : fromPod.names || [];
    const names = [...new Set([...copyNames.filter((n) => this.inCopy(n) || podOnly(n)), ...podNames.filter((n) => this._onPod(n))])];
    return { notModified: false, names, etag: `${newCopyTag || ''}|${fromPod.etag || ''}` };
  }

  async read(p, opts = {}) {
    if (this._onPod(p)) return this.pod ? this.pod.read(p, opts) : { ok: false, notModified: false, status: 404, body: null, etag: null };
    const res = await this._ask(p, { headers: opts.etag ? { 'if-none-match': opts.etag } : {} });
    if (res.status === 304) return { ok: true, notModified: true, status: 304, body: null, etag: opts.etag };
    if (res.status >= 400) return { ok: false, notModified: false, status: res.status, body: null, etag: null };
    return { ok: true, notModified: false, status: res.status, body: await res.text(), etag: res.headers.get('etag') };
  }

  async _copyWrite(p, body, contentType) {
    try {
      const res = await this._ask(p, { method: 'PUT', headers: { 'content-type': contentType, 'x-fedipod-holder': this.holder }, body });
      if (res.status < 400) return { ok: true, retry: false, why: '' };
      if (res.status === 409) { this.onRefused?.(); return { ok: false, retry: false, why: 'another agent holds this account now', lost: true }; }
      return { ok: false, retry: res.status >= 500 || res.status === 429, why: `HTTP ${res.status}`, retryAfterMs: 0 };
    } catch (e) {
      return { ok: false, retry: true, why: e.message, retryAfterMs: 0 };
    }
  }

  async write(p, body, contentType = 'application/json') {
    if (this._onPod(p)) {
      const w = this.pod ? await this.pod.write(p, body, contentType) : { ok: false, retry: false, why: 'no pod for this document' };
      // The settings' public part, for the gateway's work for this account.
      if (w.ok && p === 'config.json' && this.publicConfig) {
        let doc = null;
        try { doc = JSON.parse(body); } catch { /* not JSON: nothing public to keep */ }
        if (doc) {
          const pub = await this._copyWrite('config-public.json', JSON.stringify(this.publicConfig(doc), null, 2) + '\n', 'application/json');
          if (!pub.ok) this.log(`the settings' public part was not kept at the gateway: ${pub.why}`);
        }
      }
      return w;
    }
    const w = await this._copyWrite(p, body, contentType);
    if (w.ok && this.mirror && this.pod) {
      const m = await this.pod.write(p, body, contentType);
      if (!m.ok) this.log(`${p} is at the gateway but not yet on the pod: ${m.why}`);
    }
    return w;
  }

  async remove(p) {
    if (this._onPod(p)) return this.pod ? this.pod.remove(p) : false;
    try {
      const res = await this._ask(p, { method: 'DELETE', headers: { 'x-fedipod-holder': this.holder } });
      if (res.status === 409) { this.onRefused?.(); return false; }
      const ok = res.status < 400 || res.status === 404;
      if (ok && this.mirror && this.pod) await this.pod.remove(p);
      return ok;
    } catch { return false; }
  }
}

// `file:` (or a bare path) is a directory; anything else is a pod.
export function storageFor(base, fetchImpl) {
  return /^https?:/i.test(base) ? new HttpStorage(base, fetchImpl) : new FileStorage(base);
}
