// warm-start.mjs — what a browser worker's last start read, kept in this
// browser so that a restart moments later need not read the pod again.
//
// A browser stops an idle service worker after about thirty seconds, and a
// client in a background tab wakes it about once a minute. Each wake was a
// whole sign-in against the pod. Kept here: where the account lives, its state
// documents as the pod holds them (bytes and ETags), and when the last full
// start and the last inbox drain were. A document is marked pending before it
// is written to the pod and confirmed after, so a worker stopped in between
// re-reads that one document rather than trusting a copy the pod has moved
// past. Signing out deletes the database.
const DB = 'fedipod-warm';

export const WARM_GAP_MS = 5 * 60_000;       // a restart this soon after the last is the same visit
export const FULL_EVERY_MS = 60 * 60_000;    // a full start still happens at least hourly
export const DRAIN_EVERY_MS = 2 * 60_000;    // the inbox drain's own fallback cadence

export const isWarm = (meta, now = Date.now()) =>
  !!meta && now - meta.wakeAt < WARM_GAP_MS && now - meta.fullAt < FULL_EVERY_MS;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta'); r.result.createObjectStore('docs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

// One transaction, then the connection is closed, so a sign-out can delete
// the database without waiting on a worker that still holds it open.
async function tx(stores, mode, work) {
  const db = await open();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(stores, mode);
      let out;
      Promise.resolve(work(t)).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
}

const docKey = (webId, name) => `${webId}\n${name}`;
const range = (webId) => IDBKeyRange.bound(`${webId}\n`, `${webId}\n￿`);
const ask = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

export const warmMeta = (webId) => tx('meta', 'readonly', (t) => ask(t.objectStore('meta').get(webId)).then((m) => m || null));

export const saveMeta = (webId, patch) => tx('meta', 'readwrite', async (t) => {
  const s = t.objectStore('meta');
  const had = (await ask(s.get(webId))) || {};
  s.put({ ...had, ...patch }, webId);
});

export const saveDoc = (webId, name, doc) => tx('docs', 'readwrite', (t) => {
  t.objectStore('docs').put({ name, ...doc }, docKey(webId, name));
});

export const dropDoc = (webId, name) => tx('docs', 'readwrite', (t) => {
  t.objectStore('docs').delete(docKey(webId, name));
});

export const loadDocs = (webId) => tx('docs', 'readonly', (t) => ask(t.objectStore('docs').getAll(range(webId))));

// Everything the pod held at a load, in place of whatever was kept before.
export const replaceDocs = (webId, docs, listingEtag) => tx(['docs', 'meta'], 'readwrite', async (t) => {
  const d = t.objectStore('docs');
  d.delete(range(webId));
  for (const doc of docs) d.put({ ...doc, pending: false }, docKey(webId, doc.name));
  const m = t.objectStore('meta');
  const had = (await ask(m.get(webId))) || {};
  m.put({ ...had, listingEtag: listingEtag || null }, webId);
});

export function deleteWarm() {
  return new Promise((res) => {
    let rq; try { rq = indexedDB.deleteDatabase(DB); } catch { res(); return; }
    rq.onsuccess = rq.onerror = rq.onblocked = () => res();
  });
}

/**
 * Keep `store`'s documents in step with the pod, for `webId`. Before a write
 * or removal the document is marked pending; after it lands, the bytes the
 * pod now holds are kept. A load replaces the whole copy.
 */
export function keepInStep(store, webId, log = () => {}) {
  const fail = (e) => log(`warm copy: ${e?.message || e}`);
  store.onWriting = (name) => saveDoc(webId, name, { text: null, etag: null, pending: true }).catch(fail);
  store.onSettled = (name) => {
    const text = store.lastText.get(name);
    (text == null ? dropDoc(webId, name) : saveDoc(webId, name, { text, etag: store.etags.get(name) || null, pending: false }))
      .catch(fail);
  };
  store.onLoaded = () => {
    const docs = [...store.lastText].map(([name, text]) => ({ name, text, etag: store.etags.get(name) || null }));
    replaceDocs(webId, docs, store.etags.get('')).catch(fail);
  };
}

/**
 * Put a kept copy into `store`, and answer the names of documents it caught
 * mid-write: those, and only those, need reading from the pod again. While the
 * lease stayed with this browser nothing else wrote the state, so the rest is
 * what the pod holds. With any pending, the container's ETag is left out too,
 * so a later full load lists it afresh.
 */
export function takeUp(store, docs, listingEtag) {
  const pending = docs.filter((d) => d.pending).map((d) => d.name);
  store.restore({ docs: docs.filter((d) => !d.pending && d.text != null), listingEtag: pending.length ? null : listingEtag });
  return pending;
}
