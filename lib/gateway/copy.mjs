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
// The pod lease while the copy exists, so an agent reading the pod directly
// finds the account busy and only reads. Held a day at a time and renewed by
// the round (renewPodLease): a copy that is lost frees the pod within a day.
const POD_HOLDER = 'gateway-copy';
const POD_LEASE_MS = 24 * 3600_000;
const POD_RENEW_BEFORE_MS = 6 * 3600_000;

// Keys are built from an account's directory key and a document's name, and
// the store puts a key into a URL as it stands, where `..` would climb out of
// the account. Only plain names are ever let through.
const SAFE_HANDLE = /^[a-z0-9][a-z0-9._@-]{0,200}$/u;
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}\.json$/u;
export const safeName = (n) => typeof n === 'string' && SAFE_NAME.test(n) && !n.includes('..');
export const safeHandle = (h) => typeof h === 'string' && SAFE_HANDLE.test(h) && !h.includes('..');
function account(h) {
  if (!safeHandle(h)) throw new Error(`not an account this gateway keeps: ${JSON.stringify(h)}`);
  return h;
}
const docKey = (h, name) => {
  if (!safeName(name)) throw new Error(`not a state document: ${JSON.stringify(name)}`);
  return `${account(h)}/d/${name}`;
};
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
export async function copyMeta(kv, h) { return (await readJson(kv, `${account(h)}/meta`)).doc; }

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
  return new Lease({ url: `copy:${account(h)}/lease`, fetchImpl: kvDocFetch(kv, `${h}/lease`), log, id });
}

/** Whether `holder` holds the copy's lease now. */
export async function holds(kv, h, holder) {
  const { doc } = await readJson(kv, `${account(h)}/lease`);
  return !!doc && doc.holder === holder && Date.now() < doc.expiresAt;
}

/**
 * Storage over the copy, for a PodStore. `holder` is who is writing, checked
 * against the copy's lease on every write; `pod` is the account's state
 * container on the pod (an HttpStorage), for what stays there.
 */
export class CopyStorage {
  // `podNames`: which of the pod-only documents to list (all, by default). The
  // gateway's own agents need only the key.
  constructor(kv, handle, { holder, pod = null, onRefused = null, podNames = null }) {
    this.kv = kv;
    this.h = account(handle);
    this.holder = holder;
    this.pod = pod;
    this.onRefused = onRefused;
    this.podNames = podNames;
  }

  get kind() { return 'copy'; }
  get base() { return `copy:${this.h}/`; }

  async list(sub = '', { etag } = {}) {
    if (sub) return { notModified: false, names: [], etag: null };
    const docs = (await this.kv.list(`${this.h}/d/`)).map((b) => ({ name: b.key.slice(`${this.h}/d/`.length), etag: b.etag }));
    // What stays on the pod is listed only where it can be read.
    const kept = this.pod ? ((await copyMeta(this.kv, this.h))?.podOnly || []).filter((n) => !this.podNames || this.podNames.includes(n)) : [];
    const names = [...docs.map((d) => d.name), ...kept.filter((n) => n !== 'lease.json')];
    const tag = `"${hashOf(JSON.stringify([docs.map((d) => `${d.name}:${d.etag}`).sort(), [...kept].sort()]))}"`;
    if (etag && etag === tag) return { notModified: true, names: null, etag };
    return { notModified: false, names, etag: tag };
  }

  async read(name, opts = {}) {
    if (!safeName(name)) return { ok: false, notModified: false, status: 404, body: null, etag: null };
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
    if (!safeName(name)) return { ok: false, retry: false, why: 'not a state document name' };
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
    if (!safeName(name)) return false;
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
 * Held for `ms` at a time and extended while its holder runs, so a long run
 * keeps it and a holder that died loses it within `ms`.
 */
export async function lockCopy(kv, h, { ms = 60_000, waitMs = 8_000, by = crypto.randomUUID() } = {}) {
  const key = `${account(h)}/lock`;
  const give = (etag) => {
    let tag = etag;
    const timer = setInterval(async () => {
      const r = await kv.set(key, JSON.stringify({ by, until: Date.now() + ms }), { ifMatch: tag }).catch(() => ({ ok: false }));
      if (r.ok) { tag = r.etag; return; }
      // Not extended: still ours means the store hiccuped, and the next tick
      // tries again with what it holds now; anybody else's, it has gone.
      const cur = await readJson(kv, key).catch(() => ({}));
      if (cur.doc?.by === by) tag = cur.etag; else clearInterval(timer);
    }, Math.max(1000, Math.floor(ms / 3)));
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      const cur = await readJson(kv, key);
      if (cur.doc?.by === by) await kv.delete(key);
    };
  };
  const until = Date.now() + waitMs;
  for (;;) {
    const got = await kv.set(key, JSON.stringify({ by, until: Date.now() + ms }), { ifNew: true });
    if (got.ok) return give(got.etag);
    const cur = await readJson(kv, key);
    // A lock whose holder died is taken over once its time is up.
    if (cur.doc && Date.now() > cur.doc.until) {
      const took = await kv.set(key, JSON.stringify({ by, until: Date.now() + ms }), { ifMatch: cur.etag });
      if (took.ok) return give(took.etag);
    }
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 150));
  }
}

/**
 * Make the copy from the pod. `pod` is the account's state container, read
 * with the keeper's identity; `podFetch` the same identity's fetch, for the
 * pod's lease. Refused while an agent reading the pod directly is acting.
 * Returns { ok } or { ok: false, why }; a copy half made is taken away again,
 * and the pod's lease given back. The caller holds lockCopy for the account.
 */
export async function fillCopy(kv, h, { pod, podFetch, stateUrl, webId = null, log = () => {} }) {
  if (await copyMeta(kv, h)) return { ok: true, already: true };
  const podLease = new Lease({ url: stateUrl + 'lease.json', fetchImpl: podFetch, log, id: POD_HOLDER });
  if (!await podLease.acquire()) return { ok: false, why: 'the account is active on another device' };
  const undo = async (why) => {
    for (const b of await kv.list(`${h}/d/`).catch(() => [])) await kv.delete(b.key).catch(() => {});
    await podLease.release().catch(() => {});
    return { ok: false, why };
  };
  try {
    // Whatever an interrupted give-up left behind is not this copy.
    for (const b of await kv.list(`${h}/d/`)) await kv.delete(b.key);
    const listing = await pod.list('');
    if (listing.missing) return await undo('no account state on the pod');
    const names = listing.names.filter(safeName);
    const flushed = {};
    // Six at a time: the whole state is read once, and quickly.
    const wanted = names.filter((n) => !podOnly(n));
    for (let i = 0; i < wanted.length; i += 6) {
      const got = await Promise.all(wanted.slice(i, i + 6).map(async (name) => [name, await pod.read(name, { accept: 'application/json' })]));
      const bad = got.find(([, r]) => !r.ok);
      if (bad) return await undo(`${bad[0]} could not be read (HTTP ${bad[1].status})`);
      for (const [name, r] of got) {
        const set = await kv.set(docKey(h, name), r.body);
        flushed[name] = { etag: set.etag, hash: hashOf(r.body) };
      }
    }
    await kv.set(`${h}/flushed`, JSON.stringify(flushed));
    const podLeaseUntil = Date.now() + POD_LEASE_MS;
    await podLease.write({ holder: POD_HOLDER, expiresAt: podLeaseUntil });
    await kv.set(`${h}/meta`, JSON.stringify({ filledAt: Date.now(), webId, stateUrl, podOnly: names.filter(podOnly), podLeaseUntil }));
    await kv.set(`_copies/${h}`, String(Date.now()));
    log(`copy @${h}: made from the pod (${Object.keys(flushed).length} documents)`);
    return { ok: true };
  } catch (e) {
    return undo(e.message);
  }
}

/** The pod's lease, held another day when this one is running out; the round asks. */
export async function renewPodLease(kv, h, { podFetch, log = () => {}, now = Date.now() } = {}) {
  const { doc: meta, etag } = await readJson(kv, `${account(h)}/meta`);
  if (!meta?.stateUrl || (meta.podLeaseUntil || 0) - now > POD_RENEW_BEFORE_MS) return false;
  const podLeaseUntil = now + POD_LEASE_MS;
  await new Lease({ url: meta.stateUrl + 'lease.json', fetchImpl: podFetch, log, id: POD_HOLDER })
    .write({ holder: POD_HOLDER, expiresAt: podLeaseUntil });
  await kv.set(`${h}/meta`, JSON.stringify({ ...meta, podLeaseUntil }), etag ? { ifMatch: etag } : {});
  return true;
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
  const docs = (await kv.list(`${account(h)}/d/`)).filter((b) => safeName(b.key.slice(`${h}/d/`.length)));
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
 * take everything or its lease could not be freed, in which case nothing is
 * deleted. The record of what the pod holds goes first, so a give-up cut off
 * part way can never lead a later write-back to remove the pod's documents.
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
  try { await podLease.write({ holder: POD_HOLDER, expiresAt: 0 }); } catch (e) {
    return { ok: false, why: `the pod's lease could not be freed (${e.message})` };
  }
  await kv.delete(`_copies/${h}`);
  await kv.delete(`${h}/meta`);
  await kv.delete(`${h}/flushed`);
  for (const b of await kv.list(`${h}/`)) await kv.delete(b.key);
  log(`copy @${h}: given up; the pod holds everything`);
  return { ok: true };
}
