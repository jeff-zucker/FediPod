// fediacct-browser.mjs — connections to fediverse accounts the owner holds on
// OTHER servers, in the browser.
//
// Same FediAccounts client the Node agent uses (lib/fediacct.mjs): the same
// OAuth dance and authenticated calls. What the browser adds is the owner's
// per-connection storage choice, the same one Bluesky has:
//
//  - "browser": the credential lives in IndexedDB on this device (default).
//  - "pod": it lives in the owner-only pod state, so it follows the owner to
//    any browser they sign in from.
//
// A record carries which backend it lives in; list() merges both, and moving a
// connection is a re-write to the other backend. App registrations and the
// short-lived OAuth "pending" state stay in IndexedDB (per browser), and the
// pending state is persisted so a connection survives the worker being
// idle-killed between the redirect out and the code coming back.
import { FediAccounts } from '../../lib/connections/fediacct.mjs';
import { kvAll, kvPut, kvDel } from './idb-kv.mjs';

const POD_DOC = 'fediaccts.json';   // { id: record } for pod-stored connections
const PEND_TTL_MS = 10 * 60_000;

export class BrowserFediAccounts extends FediAccounts {
  constructor({ store, actorId = null, log = console.log } = {}) {
    super({ localDir: '/fediaccts', actorId, log });   // localDir unused; storage below
    this.store = store;
    this._recs = new Map();     // browser (IndexedDB) records, id → record
    this._apps = new Map();     // host → app registration
  }

  async load() {
    const all = await kvAll().catch(() => ({}));
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('rec:')) this._recs.set(k.slice(4), v);
      else if (k.startsWith('app:')) this._apps.set(k.slice(4), v);
      else if (k.startsWith('pend:')) this.pending.set(k.slice(5), v);
    }
    const now = Date.now();
    for (const [s, p] of this.pending) if (now - p.at > PEND_TTL_MS) { this.pending.delete(s); kvDel('pend:' + s).catch(() => {}); }
    return this;
  }

  _podMap() { return this.store.read(POD_DOC, {}) || {}; }

  // ---- records, across both backends ----
  ids() { return [...new Set([...this._recs.keys(), ...Object.keys(this._podMap())])]; }

  read(id) {
    let rec = null; let where = null;
    if (this._recs.has(id)) { rec = this._recs.get(id); where = 'browser'; }
    else { const p = this._podMap()[id]; if (p) { rec = p; where = 'pod'; } }
    if (!rec) return null;
    if (rec.mintedFor && this.actorId && rec.mintedFor !== this.actorId) {
      this.log(`fediaccts/${id} belongs to ${rec.mintedFor} — not reusing it for ${this.actorId}`);
      return null;
    }
    return { ...rec, storage: where };
  }

  write(rec) {
    const where = rec.storage || 'browser';
    const clean = { ...rec, storage: where };
    if (where === 'pod') {
      const map = { ...this._podMap(), [clean.id]: clean };
      this.store.write(POD_DOC, map); this.store.flush?.().catch(() => {});
      this._recs.delete(clean.id); kvDel('rec:' + clean.id).catch(() => {});
    } else {
      this._recs.set(clean.id, clean); kvPut('rec:' + clean.id, clean).catch((e) => this.log(`fediacct persist: ${e.message}`));
      const map = this._podMap();
      if (clean.id in map) { delete map[clean.id]; this.store.write(POD_DOC, map); this.store.flush?.().catch(() => {}); }
    }
  }

  // Best-effort: tell the server to revoke our token (RFC 7009), so a
  // disconnect actually invalidates it there — not just locally. Mirrors
  // atproto's deleteSession. Called before remove(); a failure never blocks the
  // local removal. For a pod-stored connection this is what lets one device
  // revoke a token another device (a stolen phone) is holding.
  async revoke(id) {
    const rec = this.read(id);
    const app = this._apps.get(rec?.host);
    if (!rec?.token || !app?.clientId) return;
    try {
      await this._fetch(rec.host, `https://${rec.host}/oauth/revoke`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, token: rec.token }).toString(),
      });
      this.log(`revoked our token at ${rec.host}`);
    } catch (e) { this.log(`revoke at ${rec.host} failed (removing locally anyway): ${e.message}`); }
  }

  remove(id) {
    const had = this._recs.has(id) || (id in this._podMap());
    if (!had) return false;
    this._recs.delete(id); kvDel('rec:' + id).catch(() => {});
    const map = this._podMap();
    if (id in map) { delete map[id]; this.store.write(POD_DOC, map); this.store.flush?.().catch(() => {}); }
    this.log(`Fediverse account disconnected: ${id}`);
    return true;
  }

  // Carry the storage location out to the record page.
  roster() { return this.list().map(r => ({ id: r.id, handle: r.handle, host: r.host, addedAt: r.addedAt || null, enabled: r.enabled !== false, storage: r.storage })); }
  status() {
    return this.list().map(r => ({
      id: r.id, handle: r.handle, host: r.host, enabled: r.enabled !== false,
      needsReconnect: !!r.needsReconnect, storage: r.storage,
      cooldownFor: Math.max(0, Math.round(((this.pausedUntil.get(r.host) || 0) - Date.now()) / 1000)),
    }));
  }

  // Move a connection between backends (the Options menu's Storage control).
  setStorage(id, where) { const rec = this.read(id); if (rec && (where === 'pod' || where === 'browser')) { this.write({ ...rec, storage: where }); return this.roster().find(r => r.id === id) || null; } return null; }

  // One app registration per host, remembered — over IndexedDB.
  async appFor(host, redirectUri) {
    const cached = this._apps.get(host);
    if (cached && cached.redirectUri === redirectUri && cached.clientId && cached.clientSecret) return cached;
    const res = await this._fetch(host, `https://${host}/api/v1/apps`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'FediPod', redirect_uris: redirectUri, scopes: 'read write', website: 'https://github.com/jeff-zucker/FediPod' }),
    });
    const body = await this._json(res, host);
    if (!body.client_id || !body.client_secret) throw new Error(`${host} registered no client`);
    const app = { host, redirectUri, clientId: body.client_id, clientSecret: body.client_secret };
    this._apps.set(host, app); await kvPut('app:' + host, app).catch(() => {});
    return app;
  }

  // Persist the pending state across the redirect (the worker may be idle-killed).
  async begin(opts) {
    const r = await super.begin(opts);
    await kvPut('pend:' + r.state, this.pending.get(r.state)).catch(() => {});
    return r;
  }

  async complete({ state, code }) {
    if (!this.pending.has(state)) {
      const p = await kvAll().then((a) => a['pend:' + state]).catch(() => null);
      if (p) this.pending.set(state, p);
    }
    const row = await super.complete({ state, code });
    await kvDel('pend:' + state).catch(() => {});
    return row;
  }
}
