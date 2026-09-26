// copy.mjs — a kept account's working copy at the gateway.
//
// While the gateway keeps an account running, the account's state documents
// (everything under ap-state/) live here, and every agent works from this copy:
// the owner's browser (through the state API, state-api.mjs), the keeper and
// the gateway's Mastodon API (in process). The pod is written from it every
// fifteen minutes (flushCopy), and at once when the copy is given up
// (dropCopy). What only the pod may hold never comes here: the signing key,
// the pod's own lease document, and the passwords and tokens of accounts on
// other servers.
//
// The lease that decides which agent acts lives in the copy too, and the copy
// is what enforces it: a state document is written only by the lease's holder.
// So two agents working from one copy never write over each other; whichever
// acts takes the lease, as two browsers do today.
//
// `kv` is a small key-value store with conditional writes: Netlify Blobs with
// strong consistency on Netlify (netlify/functions/front.mjs), a Map in a test
// (memoryKv below).
//   get(key) -> { text, etag } | null
//   set(key, text, { ifMatch, ifNew }) -> { ok, etag }
//   delete(key)
//   list(prefix) -> [{ key, etag }]

import crypto from 'node:crypto';
import { Lease } from '../core/lease.mjs';
import { podOnly } from '../core/pod-only.mjs';

export { podOnly };
// The holder id every writer at the gateway shares: the keeper, the Mastodon
// API and the mail it reads for an app. They are kept apart by lockCopy().
export const GATEWAY_HOLDER = 'gateway';
// The pod lease while the copy exists: taken for as long as the copy lives, so
// an agent reading the pod directly finds the account busy and only reads.
const POD_HOLDER = 'gateway-copy';
const FOREVER_MS = 10 * 365 * 86400_000;

const docKey = (h, name) => `${h}/d/${name}`;
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('base64url').slice(0, 22);

export function memoryKv() {
  const m = new Map();
  let n = 0;
  return {
    map: m,
    async get(key) { return m.has(key) ? { ...m.get(key) } : null; },
    async set(key, text, { ifMatch = null, ifNew = false } = {}) {
      const had = m.get(key);
      if (ifNew && had) return { ok: false };
      if (ifMatch && had?.etag !== ifMatch) return { ok: false };
      const etag = `"${++n}"`;
      m.set(key, { text: String(text), etag });
      return { ok: true, etag };
    },
    async delete(key) { m.delete(key); },
    async list(prefix) { return [...m].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, etag: v.etag })); },
  };
}

const readJson = async (kv, key) => {
  const got = await kv.get(key);
  if (!got) return { doc: null, etag: null };
  try { return { doc: JSON.parse(got.text), etag: got.etag }; } catch { return { doc: null, etag: got.etag }; }
};

/** Every account the gateway keeps a copy for. */
export async function listCopies(kv) { return (await kv.list('_copies/')).map((b) => b.key.slice('_copies/'.length)); }

/** What the gateway knows of an account's copy, or null when it keeps none. */
export async function copyMeta(kv, h) { return (await readJson(kv, `${h}/meta`)).doc; }

/**
 * A fetch for one document in the copy, answering GET and PUT as a pod would
 * (an ETag, If-Match, 412). The lease is read and written through it, so the
 * Lease class works on the copy unchanged.
 */
export function kvDocFetch(kv, key) {
  return async (_url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') {
      const got = await kv.get(key);
      if (!got) return new Response('', { status: 404 });
      return new Response(got.text, { status: 200, headers: { 'content-type': 'application/json', etag: got.etag } });
    }
    if (method === 'PUT') {
      const ifMatch = init.headers?.['if-match'] || init.headers?.get?.('if-match') || null;
      const r = await kv.set(key, String(init.body ?? ''), ifMatch ? { ifMatch } : {});
      if (!r.ok) return new Response('', { status: 412 });
      return new Response(null, { status: 204, headers: { etag: r.etag } });
    }
    return new Response('', { status: 405 });
  };
}

/** The lease on this account's copy, for a holder. */
export function copyLease(kv, h, { id, log = () => {} }) {
  return new Lease({ url: `copy:${h}/lease`, fetchImpl: kvDocFetch(kv, `${h}/lease`), log, id });
}

/** Whether `holder` holds the copy's lease now. */
export async function holds(kv, h, holder) {
  const { doc } = await readJson(kv, `${h}/lease`);
  return !!doc && doc.holder === holder && Date.now() < doc.expiresAt;
}

/**
 * Storage over the copy, for a PodStore. `holder` is who is writing, checked
 * against the copy's lease on every write; `pod` is the account's state
 * container on the pod (an HttpStorage), for what stays there.
 */
export class CopyStorage {
  constructor(kv, handle, { holder, pod = null, onRefused = null }) {
    this.kv = kv;
    this.h = handle;
    this.holder = holder;
    this.pod = pod;
    this.onRefused = onRefused;
  }

  get kind() { return 'copy'; }
  get base() { return `copy:${this.h}/`; }

  async list(sub = '', { etag } = {}) {
    if (sub) return { notModified: false, names: [], etag: null };
    const docs = (await this.kv.list(`${this.h}/d/`)).map((b) => ({ name: b.key.slice(`${this.h}/d/`.length), etag: b.etag }));
    // What stays on the pod is listed only where it can be read.
    const kept = this.pod ? (await copyMeta(this.kv, this.h))?.podOnly || [] : [];
    const names = [...docs.map((d) => d.name), ...kept.filter((n) => n !== 'lease.json')];
    const tag = `"${hashOf(JSON.stringify([docs.map((d) => `${d.name}:${d.etag}`).sort(), [...kept].sort()]))}"`;
    if (etag && etag === tag) return { notModified: true, names: null, etag };
    return { notModified: false, names, etag: tag };
  }

  async read(name, opts = {}) {
    if (podOnly(name)) {
      if (!this.pod) return { ok: false, notModified: false, status: 404, body: null, etag: null };
      return this.pod.read(name, opts);
    }
    const got = await this.kv.get(docKey(this.h, name));
    if (!got) return { ok: false, notModified: false, status: 404, body: null, etag: null };
    if (opts.etag && opts.etag === got.etag) return { ok: true, notModified: true, status: 304, body: null, etag: got.etag };
    return { ok: true, notModified: false, status: 200, body: got.text, etag: got.etag };
  }

  // A refusal is an answer, not a hiccup: the lease is someone else's.
  async _fenced() {
    if (await holds(this.kv, this.h, this.holder)) return null;
    this.onRefused?.();
    return { ok: false, retry: false, why: 'another agent holds this account now', lost: true };
  }

  async write(name, body) {
    if (podOnly(name)) {
      if (!this.pod) return { ok: false, retry: false, why: 'no pod for this document' };
      return this.pod.write(name, body, 'application/json');
    }
    const refused = await this._fenced();
    if (refused) return refused;
    const r = await this.kv.set(docKey(this.h, name), body);
    return r.ok ? { ok: true, retry: false, why: '', etag: r.etag } : { ok: false, retry: true, why: 'copy write failed' };
  }

  async remove(name) {
    if (podOnly(name)) return this.pod ? this.pod.remove(name) : false;
    if (await this._fenced()) return false;
    await this.kv.delete(docKey(this.h, name));
    return true;
  }
}

/**
 * A short lock for the gateway's own writers on one account, so a keeper run,
 * a post from an app and the mail read for an app take turns. Waits up to
 * `waitMs`; returns the release function, or null when it could not get it.
 */
export async function lockCopy(kv, h, { ms = 60_000, waitMs = 8_000, by = crypto.randomUUID() } = {}) {
  const key = `${h}/lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    const got = await kv.set(key, JSON.stringify({ by, until: Date.now() + ms }), { ifNew: true });
    if (got.ok) return async () => { const cur = await readJson(kv, key); if (cur.doc?.by === by) await kv.delete(key); };
    const cur = await readJson(kv, key);
    // A lock whose holder died is taken over once its time is up.
    if (cur.doc && Date.now() > cur.doc.until) {
      const took = await kv.set(key, JSON.stringify({ by, until: Date.now() + ms }), { ifMatch: cur.etag });
      if (took.ok) return async () => { const c = await readJson(kv, key); if (c.doc?.by === by) await kv.delete(key); };
    }
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
  }
}

/**
 * Make the copy from the pod. `pod` is the account's state container, read
 * with the keeper's identity; `podFetch` the same identity's fetch, for the
 * pod's lease. Refused while an agent reading the pod directly is acting.
 * Returns { ok } or { ok: false, why }.
 */
export async function fillCopy(kv, h, { pod, podFetch, stateUrl, webId = null, log = () => {} }) {
  if (await copyMeta(kv, h)) return { ok: true, already: true };
  const podLease = new Lease({ url: stateUrl + 'lease.json', fetchImpl: podFetch, log, id: POD_HOLDER });
  if (!await podLease.acquire()) return { ok: false, why: 'the account is active on another device' };
  const listing = await pod.list('');
  if (listing.missing) return { ok: false, why: 'no account state on the pod' };
  const names = listing.names.filter((n) => n.endsWith('.json'));
  const flushed = {};
  for (const name of names.filter((n) => !podOnly(n))) {
    const r = await pod.read(name, { accept: 'application/json' });
    if (!r.ok) {
      await podLease.release().catch(() => {});
      return { ok: false, why: `${name} could not be read (HTTP ${r.status})` };
    }
    const set = await kv.set(docKey(h, name), r.body);
    flushed[name] = { etag: set.etag, hash: hashOf(r.body) };
  }
  await kv.set(`${h}/flushed`, JSON.stringify(flushed));
  // Held for as long as the copy lives; given back by dropCopy.
  await podLease.write({ holder: POD_HOLDER, expiresAt: Date.now() + FOREVER_MS });
  await kv.set(`${h}/meta`, JSON.stringify({ filledAt: Date.now(), webId, stateUrl, podOnly: names.filter(podOnly) }));
  await kv.set(`_copies/${h}`, String(Date.now()));
  log(`copy @${h}: made from the pod (${Object.keys(flushed).length} documents)`);
  return { ok: true };
}

/**
 * Write what changed in the copy to the pod. Returns how many documents were
 * written or removed; a document the pod refused is tried again next time.
 *
 * What the pod holds is recorded per document as the copy's version of it and
 * a hash of its content: a document whose version is unchanged is not read at
 * all, and one whose content is unchanged is not sent.
 */
export async function flushCopy(kv, h, { pod, log = () => {} }) {
  const docs = await kv.list(`${h}/d/`);
  const { doc: had, etag: flushedEtag } = await readJson(kv, `${h}/flushed`);
  const flushed = { ...(had || {}) };
  let n = 0;
  let changed = false;
  for (const b of docs) {
    const name = b.key.slice(`${h}/d/`.length);
    if (flushed[name]?.etag === b.etag) continue;
    const got = await kv.get(b.key);
    if (!got) continue;
    const hash = hashOf(got.text);
    if (flushed[name]?.hash !== hash) {
      const w = await pod.write(name, got.text, 'application/json');
      if (!w.ok) { log(`copy @${h}: ${name} not written to the pod (${w.why})`); continue; }
      n++;
    }
    flushed[name] = { etag: b.etag, hash };
    changed = true;
  }
  const present = new Set(docs.map((b) => b.key.slice(`${h}/d/`.length)));
  for (const name of Object.keys(flushed)) {
    if (present.has(name)) continue;
    if (await pod.remove(name)) { delete flushed[name]; n++; changed = true; }
  }
  if (changed) {
    const saved = await kv.set(`${h}/flushed`, JSON.stringify(flushed), flushedEtag ? { ifMatch: flushedEtag } : {});
    // Another flush got there first: its record stands, and anything this one
    // wrote twice is written again next time, which is harmless.
    if (!saved.ok) log(`copy @${h}: another flush recorded first`);
  }
  if (n) log(`copy @${h}: ${n} document(s) written to the pod`);
  return n;
}

/**
 * Give the copy up: everything written to the pod, the pod's lease freed, the
 * copy deleted. Returns { ok } or { ok: false, why } when the pod would not
 * take everything, in which case nothing is deleted.
 */
export async function dropCopy(kv, h, { pod, podFetch, stateUrl, log = () => {} }) {
  const meta = await copyMeta(kv, h);
  if (!meta) return { ok: true, already: true };
  await flushCopy(kv, h, { pod, log });
  const docs = await kv.list(`${h}/d/`);
  const { doc: flushed } = await readJson(kv, `${h}/flushed`);
  const behind = docs.filter((b) => flushed?.[b.key.slice(`${h}/d/`.length)]?.etag !== b.etag);
  if (behind.length) return { ok: false, why: `${behind.length} document(s) could not be written to the pod` };
  const podLease = new Lease({ url: (stateUrl || meta.stateUrl) + 'lease.json', fetchImpl: podFetch, log, id: POD_HOLDER });
  await podLease.write({ holder: POD_HOLDER, expiresAt: 0 }).catch(() => {});
  for (const b of await kv.list(`${h}/`)) await kv.delete(b.key);
  await kv.delete(`_copies/${h}`);
  log(`copy @${h}: given up; the pod holds everything`);
  return { ok: true };
}
