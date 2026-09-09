// idb-kv.mjs — a tiny per-origin key/value store on IndexedDB, for the browser
// agent's "on this device, never the pod" storage: a connected account's
// credential when the owner chooses to keep it in this browser rather than let
// it follow them to their pod. Shared by atproto-browser and fediacct-browser.
const DB = 'fedipod-accounts';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function kvGet(key) {
  const db = await open();
  return new Promise((res, rej) => { const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key); rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => rej(rq.error); });
}
export async function kvAll() {
  const db = await open();
  return new Promise((res, rej) => {
    const out = {}; const cur = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
    cur.onerror = () => rej(cur.error);
  });
}
export async function kvPut(key, val) {
  const db = await open();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
export async function kvDel(key) {
  const db = await open();
  return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
}
