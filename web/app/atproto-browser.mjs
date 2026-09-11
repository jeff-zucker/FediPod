// atproto-browser.mjs — the Bluesky connection, in the browser.
//
// Same Atproto client the Node agent uses (lib/atproto.mjs). Two browser edges:
//
//  1. Storage is the owner's choice, per connection. "browser" keeps the
//     credential in IndexedDB on this device (default — a full-access token
//     stays here); "pod" keeps it in the owner-only pod state so it follows the
//     owner to any browser they sign in from. The record carries which, and
//     read/write route to that backend; moving between them is just a re-write.
//  2. The mirror can be paused (feedPaused) without disconnecting.
//
// Bluesky's API answers CORS, so the fetches go direct, not through the relay.
import { Atproto } from '../../lib/connections/atproto.mjs';
import { kvGet, kvPut, kvDel } from './idb-kv.mjs';

const IDB_KEY = 'atproto';
const POD_DOC = 'atproto.json';

export class BrowserAtproto extends Atproto {
  constructor({ store, actorId = null, log = console.log } = {}) {
    super({ localDir: '/atproto', actorId, log });   // localDir unused; storage below
    this.store = store;
    this._idbRec = null;     // the browser-stored record, cached at boot
  }

  // The IndexedDB copy into memory, so read() stays synchronous as the base
  // class expects. The pod copy is already in the loaded store.
  async load() { this._idbRec = await kvGet(IDB_KEY).catch(() => null); return this; }

  // Whichever backend holds it, tagged with where it lives. The stamped-record
  // guard is the base class's.
  read() {
    let rec = null; let where = null;
    if (this._idbRec) { rec = this._idbRec; where = 'browser'; }
    else { const p = this.store.read(POD_DOC, null); if (p) { rec = p; where = 'pod'; } }
    if (!rec) return null;
    if (rec.mintedFor && this.actorId && rec.mintedFor !== this.actorId) {
      this.log(`atproto belongs to ${rec.mintedFor} — not reusing it for ${this.actorId}`);
      return null;
    }
    return { ...rec, storage: where };
  }

  // Write to the record's chosen backend (default browser), and clear the other
  // so a moved credential leaves no copy behind.
  write(rec) {
    const where = rec.storage || 'browser';
    const clean = { ...rec, storage: where };
    if (where === 'pod') {
      this.store.write(POD_DOC, clean); this.store.flush?.().catch(() => {});
      this._idbRec = null; kvDel(IDB_KEY).catch(() => {});
    } else {
      this._idbRec = clean; kvPut(IDB_KEY, clean).catch((e) => this.log(`atproto persist: ${e.message}`));
      this.store.write(POD_DOC, null); this.store.flush?.().catch(() => {});
    }
  }

  status() {
    const rec = this.read();
    return {
      connected: !!rec?.did, service: rec?.service || null, handle: rec?.handle || null,
      did: rec?.did || null, lastError: this.lastError,
      cooldownFor: Math.max(0, Math.round((this.pausedUntil - Date.now()) / 1000)),
      storage: rec?.storage || null, feedPaused: !!rec?.feedPaused,
    };
  }

  // The mirror runs unless paused; the account stays connected either way.
  feedActive() { return this.connected() && !this.read()?.feedPaused; }
  setFeedPaused(on) { const rec = this.read(); if (rec) this.write({ ...rec, feedPaused: !!on }); }

  // Move the credential between backends (the Options menu's Storage control).
  setStorage(where) { const rec = this.read(); if (rec && (where === 'pod' || where === 'browser')) this.write({ ...rec, storage: where }); }

  async disconnect() {
    const rec = this.read();
    if (rec?.refreshJwt) {
      await this._fetch(`${rec.service}/xrpc/com.atproto.server.deleteSession`, {
        method: 'POST', headers: { authorization: `Bearer ${rec.refreshJwt}` },
      }).catch(() => {});
    }
    this._idbRec = null; await kvDel(IDB_KEY).catch(() => {});
    this.store.write(POD_DOC, null); await this.store.flush?.().catch(() => {});
    this.log('bluesky disconnected');
  }
}
