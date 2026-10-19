// fediacct-browser.mjs — connections to fediverse accounts the owner holds on
// OTHER servers, in the browser.
//
// Same FediAccounts client the Node agent uses (lib/fediacct.mjs): the same
// OAuth dance and authenticated calls. The credentials live in the owner-only
// pod state, on the pod only (lib/core/pod-only.mjs), so they follow the owner
// to any browser they sign in from. Records an earlier build kept in this
// browser's IndexedDB are still read, and moveToPod() takes them to the pod.
// App registrations and the short-lived OAuth "pending" state stay in
// IndexedDB (per browser), and the pending state is persisted so a connection
// survives the worker being idle-killed between the redirect out and the code
// coming back.
import { FediAccounts } from '../../lib/connections/fediacct.mjs';
import { kvAll, kvPut, kvDel } from './idb-kv.mjs';

const POD_DOC = 'fediaccts.json';   // { id: record }
const PEND_TTL_MS = 10 * 60_000;

export class BrowserFediAccounts extends FediAccounts {
  constructor({ store, actorId = null, log = console.log } = {}) {
    super({ localDir: '/fediaccts', actorId, log });   // localDir unused; storage below
    this.store = store;
    this._recs = new Map();     // records still in this browser (IndexedDB), id → record
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
    const p = this._podMap()[id];
    if (p) { rec = p; where = 'pod'; } else if (this._recs.has(id)) { rec = this._recs.get(id); where = 'browser'; }
    if (!rec) return null;
    if (rec.mintedFor && this.actorId && rec.mintedFor !== this.actorId) {
      this.log(`fediaccts/${id} belongs to ${rec.mintedFor} — not reusing it for ${this.actorId}`);
      return null;
    }
    return { ...rec, storage: where };
  }

  write(rec) {
    const clean = { ...rec, storage: 'pod' };
    const map = { ...this._podMap(), [clean.id]: clean };
    this.store.write(POD_DOC, map); this.store.flush?.().catch(() => {});
  }

  // The records still in this browser, onto the pod, and out of the browser
  // once the pod has them. One the pod already holds is newer there.
  async moveToPod() {
    const moving = [...this._recs.values()].filter((r) => !r.mintedFor || !this.actorId || r.mintedFor === this.actorId);
    if (!moving.length) return 0;
    const map = { ...this._podMap() };
    for (const r of moving) if (!(r.id in map)) map[r.id] = { ...r, storage: 'pod' };
    this.store.write(POD_DOC, map);
    if (!await this.store.commit()) return 0;
    for (const r of moving) { this._recs.delete(r.id); await kvDel('rec:' + r.id).catch(() => {}); }
    this.log(`${moving.length} connected account(s) moved from this browser to the pod`);
    return moving.length;
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
