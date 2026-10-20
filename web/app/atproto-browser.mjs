// atproto-browser.mjs — the Bluesky connection, in the browser.
//
// Same Atproto client the Node agent uses (lib/atproto.mjs). Two browser edges:
//
//  1. The credential lives in the owner-only pod state, on the pod only
//     (lib/core/pod-only.mjs), so it follows the owner to any browser they sign
//     in from. A record an earlier build kept in this browser's IndexedDB is
//     still read, and moveToPod() takes it to the pod.
//  2. The mirror can be paused (feedPaused) without disconnecting.
//
// Bluesky's API answers CORS, so the fetches go direct, not through the relay.
import { Atproto } from '../../lib/connections/atproto.mjs';
import { kvGet, kvDel } from './idb-kv.mjs';

const IDB_KEY = 'atproto';
const POD_DOC = 'atproto.json';

export class BrowserAtproto extends Atproto {
  constructor({ store, actorId = null, log = console.log } = {}) {
    super({ localDir: '/atproto', actorId, log });   // localDir unused; storage below
    this.store = store;
    this._idbRec = null;     // a record still in this browser, cached at boot
  }

  // The IndexedDB copy into memory, so read() stays synchronous as the base
  // class expects. The pod copy is already in the loaded store.
  // `fromPod`: the pod's record read as well (agent.mjs says when).
  async load({ fromPod = false } = {}) {
    this._idbRec = await kvGet(IDB_KEY).catch(() => null);
    if (fromPod) await this.store.refresh?.([POD_DOC], { ifChanged: true }).catch((e) => this.log(`Bluesky account: ${e.message}`));
    return this;
  }

  // Whichever backend holds it, tagged with where it lives. The stamped-record
  // guard is the base class's.
  read() {
    let rec = null; let where = null;
    const p = this.store.read(POD_DOC, null);
    if (p) { rec = p; where = 'pod'; } else if (this._idbRec) { rec = this._idbRec; where = 'browser'; }
    if (!rec) return null;
    if (rec.mintedFor && this.actorId && rec.mintedFor !== this.actorId) {
      this.log(`atproto belongs to ${rec.mintedFor} — not reusing it for ${this.actorId}`);
      return null;
    }
    return { ...rec, storage: where };
  }

  write(rec) {
    this.store.write(POD_DOC, { ...rec, storage: 'pod' }); this.store.flush?.().catch(() => {});
  }

  // A record still in this browser, onto the pod, and out of the browser once
  // the pod has it. One the pod already holds is newer there.
  async moveToPod() {
    const rec = this._idbRec;
    if (!rec || (rec.mintedFor && this.actorId && rec.mintedFor !== this.actorId)) return false;
    if (!this.store.read(POD_DOC, null)) {
      this.store.write(POD_DOC, { ...rec, storage: 'pod' });
      if (!await this.store.commit()) return false;
    }
    this._idbRec = null; await kvDel(IDB_KEY).catch(() => {});
    this.log('the Bluesky account moved from this browser to the pod');
    return true;
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
