// pod-mail.mjs — fedipod.net working for a personal account without writing
// to its pod. Everything it would have written there goes into the pod's
// inbox instead, as one item per run, stamped with the account's door secret
// so the owner's FediPod knows it is fedipod.net's and applies it. Only the
// owner can read the inbox. The pod therefore has everything at once, and
// fedipod.net keeps nothing waiting for it.
//
// Two stand-ins, used together by account-agent.mjs:
//
// - MailStorage, under the account's PodStore: documents in the copy are read
//   and written there; any other document reads as absent (the gateway cannot
//   read the pod) and a write to it is only recorded. Every change, in the
//   copy or not, is recorded as a delta (lib/core/doc-delta.mjs).
// - mailSession, under the account's PodTransport: reads of the signing key
//   go to the key reader; reads of anything written earlier in the run come
//   from the run; other reads are plain public reads. Writes are recorded and
//   answered as a pod would answer them.
//
// flushMail then appends what was recorded as one item, numbered by the
// copy's `seq`, and keeps the public documents among it (pendingPublic) so an
// address at fedipod.net can show them before FediPod has applied the item.

import crypto from 'node:crypto';
import { deltaOf } from '../core/doc-delta.mjs';
import { podOnly, SLIM_DOCS, PUBLIC_CONFIG } from '../core/pod-only.mjs';
import { signReceipt } from './httpsig.mjs';
import { nextSeq } from './copy.mjs';
import { gatewayWritesName, MAX_GATEWAY_WRITES_BYTES } from '../core/intake/gateway-writes.mjs';
import * as podRoot from '../pod/root.mjs';

export const GATEWAY_WRITES = 'gateway-writes';
const ITEM_CT = 'application/activity+json';
const RECEIPT_CT = 'application/json';
// How long a public document fedipod.net wrote is served from here when the
// pod does not have it yet.
export const PENDING_PUBLIC_MS = 7 * 86400_000;

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const parse = (t) => { try { return t == null ? null : JSON.parse(t); } catch { return null; } };

/** Which names the copy holds for an account, from its meta. */
export const inCopyFor = (meta) => (name) => (meta?.full ? !podOnly(name) && name !== 'config.json' : SLIM_DOCS.has(name));

/**
 * Whether mail held for the account is read into its copy here: while an
 * outside app is signed in (a full copy), and always for a copy from before
 * version 2, which works as it did until its owner's FediPod starts it again.
 */
export const readsMailHere = (meta) => (meta?.v === 2 ? !!meta.full : true);

/** The storage the account's store works through at the gateway, for this copy. */
export const storageOver = (copy, meta) => (meta?.v === 2 ? new MailStorage(copy, { inCopy: inCopyFor(meta) }) : copy);

const absent = () => ({ ok: false, notModified: false, status: 404, body: null, etag: null });

export class MailStorage {
  /**
   * `copy`: the account's CopyStorage. `inCopy(name)`: whether the copy holds
   * that document. The settings are read from the public part the owner's
   * FediPod keeps in the copy (PUBLIC_CONFIG); a change to them is recorded
   * against the pod's own settings.
   */
  constructor(copy, { inCopy }) {
    this.copy = copy;
    this.inCopy = inCopy;
    this.before = new Map();   // name → text first seen (null: absent)
    this.after = new Map();    // name → text last written (null: removed)
  }

  get kind() { return 'copy'; }
  get base() { return this.copy.base; }

  _seen(name, text) { if (!this.before.has(name)) this.before.set(name, text); }

  async list(sub = '', opts = {}) {
    if (sub) return { notModified: false, names: [], etag: null };
    const l = await this.copy.list('', opts);
    if (l.notModified) return l;
    const names = l.names.filter((n) => this.inCopy(n) || podOnly(n));
    if (l.names.includes(PUBLIC_CONFIG)) names.push('config.json');
    return { ...l, names };
  }

  async read(name, opts = {}) {
    // The key, read where it lives; never recorded.
    if (podOnly(name)) return this.copy.read(name, opts);
    if (this.after.has(name)) {
      const t = this.after.get(name);
      return t == null ? absent() : { ok: true, notModified: false, status: 200, body: t, etag: null };
    }
    if (name === 'config.json') {
      const r = await this.copy.read(PUBLIC_CONFIG, {});
      this._seen(name, r.ok ? r.body : null);
      return r.ok ? { ...r, etag: null } : r;
    }
    if (!this.inCopy(name)) { this._seen(name, null); return absent(); }
    const r = await this.copy.read(name, opts);
    if (r.ok && !r.notModified) this._seen(name, r.body);
    else if (!r.ok) this._seen(name, null);
    return r;
  }

  async write(name, body) {
    if (podOnly(name)) return { ok: false, retry: false, why: 'kept on the pod only; fedipod.net never writes it' };
    if (!this.before.has(name)) this.before.set(name, null);
    this.after.set(name, body);
    if (name === 'config.json' || !this.inCopy(name)) return { ok: true, retry: false, why: '' };
    return this.copy.write(name, body);
  }

  async remove(name) {
    if (podOnly(name)) return false;
    if (!this.before.has(name)) this.before.set(name, null);
    this.after.set(name, null);
    if (name === 'config.json' || !this.inCopy(name)) return true;
    return this.copy.remove(name);
  }

  /** What changed, document by document: { name: delta }, or null when nothing did. */
  deltas() {
    const out = {};
    for (const [name, text] of this.after) {
      const d = deltaOf(parse(this.before.get(name) ?? null), parse(text));
      if (d) out[name] = d;
    }
    return Object.keys(out).length ? out : null;
  }
}

const isBinary = (b) => b instanceof ArrayBuffer || ArrayBuffer.isView(b) || (typeof Blob !== 'undefined' && b instanceof Blob);
async function bodyOf(b) {
  if (b == null) return { text: null };
  if (typeof b === 'string') return { text: b };
  if (typeof Blob !== 'undefined' && b instanceof Blob) return { base64: Buffer.from(await b.arrayBuffer()).toString('base64') };
  if (isBinary(b)) return { base64: Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString('base64') };
  return { text: String(b) };
}
const headerOf = (init, name) => {
  const h = init?.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? h[k] : null;
};

/**
 * The session under a personal account's PodTransport at fedipod.net.
 * `keyUrl`: the account's signing-key document; `keyFetch`: the key reader's
 * authenticated fetch. `publicFetch`: a plain fetch, for public documents.
 */
export function mailSession({ keyUrl, keyFetch, publicFetch = globalThis.fetch }) {
  const writes = [];             // { method, url, contentType, text | base64 } in order
  const latest = new Map();      // url → the last write to it, for reading back within the run
  return {
    writes,
    async fetch(url, init = {}) {
      url = String(url);
      const method = String(init.method || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        const w = latest.get(url);
        if (w) {
          if (w.method === 'DELETE') return new Response(null, { status: 404 });
          const body = method === 'HEAD' ? null : (w.text ?? Buffer.from(w.base64, 'base64'));
          return new Response(body, { status: 200, headers: { 'content-type': w.contentType || 'application/octet-stream' } });
        }
        if (url === keyUrl) return keyFetch(url, init);
        return publicFetch(url, { method, headers: { accept: headerOf(init, 'accept') || '*/*' } });
      }
      // A POST makes a new document whose name the pod would choose; named
      // here instead, and recorded as the PUT that makes it.
      if (method === 'POST') {
        const slug = headerOf(init, 'slug');
        url = url.replace(/\/?$/u, '/') + (slug && /^[A-Za-z0-9._-]{1,64}$/u.test(slug) ? slug : crypto.randomUUID());
      }
      const recorded = { method: method === 'POST' ? 'PUT' : method, url, contentType: headerOf(init, 'content-type') || null,
        ...(method === 'DELETE' ? {} : await bodyOf(init.body)) };
      writes.push(recorded);
      latest.set(url, recorded);
      if (method === 'DELETE') return new Response(null, { status: 205 });
      if (method === 'PATCH') return new Response(null, { status: 205 });
      return new Response(null, { status: 201, headers: method === 'POST' ? { location: url } : {} });
    },
  };
}

// Public: under the account's own folder, outside what only its owner reads.
const isPublicDoc = (url, podHome) => url.startsWith(podHome) && !url.endsWith('.acl')
  && !/\/ap\/private\/|\/ap-state\/|\/ap\/inbox\//u.test(url.slice(podHome.length - 1));

/**
 * Append what one run recorded to the pod inbox as one stamped item. `rec` is
 * the directory row (podHome, actorUrl, hmacSecret, gatewayWebId, inboxUrl).
 * Returns { seq } or { none: true } when there was nothing to send, and
 * throws when the pod would not take it, so the caller can tell.
 */
// Changes with no pod write among them (mail read in for an app, mostly)
// wait here at most until the fifteen-minute round, and go in one item then:
// a pod is not asked for an item every time an app checks.
const pendingKey = (h) => `${h}/pending-deltas`;
async function appendPending(kv, h, deltas) {
  for (let i = 0; i < 20; i++) {
    const got = await kv.get(pendingKey(h));
    const list = got ? JSON.parse(got.text) : [];
    list.push({ at: Date.now(), deltas });
    const r = got ? await kv.set(pendingKey(h), JSON.stringify(list), { ifMatch: got.etag }) : await kv.set(pendingKey(h), JSON.stringify(list), { ifNew: true });
    if (r.ok) return;
  }
  throw new Error('changes could not be set aside for the pod');
}
async function takePending(kv, h) {
  for (let i = 0; i < 20; i++) {
    const got = await kv.get(pendingKey(h));
    if (!got) return [];
    // Emptied rather than deleted, so a change set aside meanwhile is seen.
    const r = await kv.set(pendingKey(h), '[]', { ifMatch: got.etag });
    if (r.ok) return JSON.parse(got.text);
  }
  return [];
}
// Every change to a document, in order: one, or a list.
function mergeDeltas(pending, deltas) {
  const out = {};
  for (const one of [...pending.map((p) => p.deltas), deltas || {}]) {
    for (const [name, d] of Object.entries(one || {})) (out[name] ||= []).push(d);
  }
  for (const k of Object.keys(out)) if (out[k].length === 1) [out[k]] = out[k];
  return Object.keys(out).length ? out : null;
}

export async function flushMail(ctx, handle, rec, { storage = null, session = null, log = () => {}, defer = false } = {}) {
  const fresh = storage?.deltas() || null;
  const writes = session?.writes || [];
  if (defer && !writes.length && ctx.copyKv) {
    if (!fresh) return { none: true };
    await appendPending(ctx.copyKv, handle, fresh);
    return { deferred: true };
  }
  const pending = ctx.copyKv ? await takePending(ctx.copyKv, handle) : [];
  const deltas = mergeDeltas(pending, fresh);
  if (!deltas && !writes.length) return { none: true };
  try {
    return await handToPod(ctx, handle, rec, deltas, writes, log);
  } catch (e) {
    // Not handed over: what was set aside is set aside again, for next time.
    if (pending.length) for (const p of pending) await appendPending(ctx.copyKv, handle, p.deltas).catch(() => {});
    throw e;
  }
}

/** What was set aside for an account's pod, handed over now (the round asks). */
export async function flushPending(ctx, handle, rec, { log = () => {} } = {}) {
  return flushMail(ctx, handle, rec, { log });
}

async function handToPod(ctx, handle, rec, deltas, writes, log) {
  if (!rec.hmacSecret) throw new Error('this account has no door secret, so fedipod.net cannot stamp what it hands the pod');
  // Items the drain will read whole: a run too big for one (pictures,
  // mostly) is handed over in several, each numbered.
  const limit = Math.floor(MAX_GATEWAY_WRITES_BYTES * 0.7);
  const parts = [];
  let cur = { writes: [], size: deltas ? JSON.stringify(deltas).length : 0, deltas };
  for (const w of writes) {
    const size = JSON.stringify(w).length;
    if (cur.size + size > limit && (cur.writes.length || cur.deltas)) { parts.push(cur); cur = { writes: [], size: 0, deltas: null }; }
    cur.writes.push(w); cur.size += size;
  }
  parts.push(cur);
  const inboxUrl = rec.inboxUrl || rec.podHome + 'ap/inbox/';
  let seq = 0;
  for (const part of parts) {
    seq = await nextSeq(ctx.copyKv, handle);
    const item = { type: 'fedipod:GatewayWrites', seq, at: new Date().toISOString(),
      ...(part.writes.length ? { writes: part.writes } : {}), ...(part.deltas ? { deltas: part.deltas } : {}) };
    const raw = JSON.stringify(item);
    const hash = sha256hex(raw);
    const receipt = signReceipt({ v: 1, verified: true, method: GATEWAY_WRITES, actor: rec.actorUrl, keyId: null,
      checks: ['gateway'], reason: 'gateway', gateway: rec.gatewayWebId || null, seq, hash }, rec.hmacSecret);
    const url = inboxUrl + gatewayWritesName(seq, hash.slice(0, 32));
    if (!await ctx.podPut(handle, url, raw, ITEM_CT)) throw new Error('the pod inbox would not take what fedipod.net did for the account');
    await ctx.podPut(handle, url + '.receipt.json', JSON.stringify(receipt), RECEIPT_CT);
    // The public documents among it, served from here until the pod has them.
    for (const w of part.writes) {
      if (!ctx.pendingPublic || !isPublicDoc(w.url, rec.podHome)) continue;
      if (w.method === 'DELETE') await ctx.pendingPublic.delete(handle, w.url).catch(() => {});
      else if (w.method === 'PUT') await ctx.pendingPublic.set(handle, w.url, { seq, at: Date.now(), contentType: w.contentType, text: w.text ?? null, base64: w.base64 ?? null }).catch(() => {});
    }
  }
  log(`@${handle}: ${writes.length} pod write(s) and ${Object.keys(deltas || {}).length} document change(s) handed to the pod (up to ${seq})`);
  return { seq, items: parts.length };
}

/**
 * A public document fedipod.net wrote and the pod may not have yet, as a
 * Response, or null. Dropped after PENDING_PUBLIC_MS.
 */
export async function pendingPublicResponse(ctx, handle, url) {
  const p = await ctx.pendingPublic?.get(handle, url).catch(() => null);
  if (!p) return null;
  if (Date.now() - p.at > PENDING_PUBLIC_MS) { await ctx.pendingPublic.delete(handle, url).catch(() => {}); return null; }
  const body = p.text ?? (p.base64 ? Buffer.from(p.base64, 'base64') : null);
  return new Response(body, { status: 200, headers: { 'content-type': p.contentType || 'application/octet-stream' } });
}

const freshPending = async (ctx, handle, url) => {
  const p = ctx.pendingPublic ? await ctx.pendingPublic.get(handle, url).catch(() => null) : null;
  return p && Date.now() - p.at <= PENDING_PUBLIC_MS ? p : null;
};

/**
 * A public document for an address at fedipod.net: the newer one fedipod.net
 * handed the pod, while the pod may not have it yet; else the pod's.
 */
export async function readPublicOrPending(ctx, handle, read, url, opts) {
  const p = await freshPending(ctx, handle, url);
  if (p && p.text != null) return { status: 200, text: p.text, type: p.contentType || null };
  return podRoot.readPublicDocument(read, url, opts);
}

/** A picture at an address here: from here while the pod may not have it yet, else a pointer to the pod. */
export async function mediaAnswer(ctx, handle, podTarget, edge) {
  const p = await freshPending(ctx, handle, podTarget);
  if (p?.base64) return { status: 200, headers: { 'content-type': p.contentType || 'application/octet-stream', ...edge }, body: Buffer.from(p.base64, 'base64') };
  return { status: 302, headers: { location: podTarget, ...edge }, body: '' };
}

/** The owner's FediPod has applied everything up to `seq`: what it covers goes. */
export async function appliedUpTo(ctx, handle, seq) {
  if (!ctx.pendingPublic?.list) return 0;
  let n = 0;
  for (const { url, value } of await ctx.pendingPublic.list(handle)) {
    if (value?.seq <= seq || Date.now() - (value?.at || 0) > PENDING_PUBLIC_MS) { await ctx.pendingPublic.delete(handle, url).catch(() => {}); n++; }
  }
  return n;
}
