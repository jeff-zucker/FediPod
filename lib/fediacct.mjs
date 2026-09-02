// fediacct.mjs — the agent's connections to fediverse accounts the owner holds
// on OTHER servers. The agent is an API client of an existing Mastodon-API
// account, the same relationship a Mastodon app has to this agent, and the same
// one atproto.mjs has to a Bluesky account. Nothing here is a second identity:
// no key, no pod, nothing published.
//
// One credential per account at AP_HOME/fediaccts/<id>.json (0600, atomic,
// stamped with the actor it was connected for — the keys.json rules). A file
// stamped for someone else is skipped rather than fatal, so one stray record
// cannot cost the owner the whole roster.
//
// An access token here is full access to that account on that server, so it
// never reaches pod state: config.json gets the handle and the host, nothing
// more.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './home.mjs';
import { safeFetch, retryAfterMs } from './safefetch.mjs';

const DIR = 'fediaccts';
const APPS = '_apps';
const SCOPES = 'read write';
const STATE_TTL_MS = 10 * 60_000;
const CLIENT_NAME = 'FediPod';

// The id becomes a file name, and both halves come from a remote server's own
// answer. `--handle ../escape` is the shape of bug this project has already
// paid for once, so the result is checked rather than trusted.
export function safeId(user, host) {
  const id = `${String(user || '').trim()}@${String(host || '').trim()}`
    .toLowerCase().replace(/[^a-z0-9.@_-]/g, '-');
  if (!/^[a-z0-9][a-z0-9.@_-]{0,80}$/.test(id) || id.includes('..')) return null;
  return id;
}

// A host as we will address it: bare authority, no scheme, no path, no case.
export function cleanHost(host) {
  const raw = String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+(:\d+)?$/i.test(raw) ? raw.toLowerCase() : null;
}

export class FediAccounts {
  constructor({ localDir, actorId = null, log = console.log, fetcher = null }) {
    this.dir = path.join(localDir, DIR);
    this.actorId = actorId;
    this.log = log;
    // Injectable for tests; the default is the politeness stack, which also
    // refuses private addresses — a connected account is on the public web.
    this.fetcher = fetcher || ((url, init) => safeFetch(url, init));
    this.pausedUntil = new Map();          // host → epoch ms
    this.pending = new Map();              // state nonce → { host, redirectUri, at }
  }

  // ---- records ----

  _path(id) { return path.join(this.dir, `${id}.json`); }

  ids() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter(n => n.endsWith('.json') && !n.startsWith('_')).map(n => n.slice(0, -5));
  }

  read(id) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(this._path(id), 'utf8')); } catch { return null; }
    if (rec?.mintedFor && this.actorId && rec.mintedFor !== this.actorId) {
      this.log(`fediaccts/${id}.json belongs to ${rec.mintedFor} — not reusing it for ${this.actorId}`);
      return null;
    }
    return rec;
  }

  write(rec) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this._path(rec.id), rec);
  }

  list() { return this.ids().map(id => this.read(id)).filter(Boolean); }

  connected() { return this.list().some(r => r.token && r.enabled !== false); }

  // What may be written to pod state: who, where, and whether it is polled.
  roster() {
    return this.list().map(r => ({
      id: r.id, handle: r.handle, host: r.host,
      addedAt: r.addedAt || null, enabled: r.enabled !== false,
    }));
  }

  status() {
    return this.list().map(r => ({
      id: r.id, handle: r.handle, host: r.host,
      enabled: r.enabled !== false,
      needsReconnect: !!r.needsReconnect,
      cooldownFor: Math.max(0, Math.round(((this.pausedUntil.get(r.host) || 0) - Date.now()) / 1000)),
    }));
  }

  setEnabled(id, on) {
    const rec = this.read(id);
    if (!rec) return null;
    this.write({ ...rec, enabled: !!on });
    return this.roster().find(r => r.id === id) || null;
  }

  remove(id) {
    if (!this.read(id)) return false;
    try { fs.rmSync(this._path(id)); } catch { return false; }
    this.log(`Fediverse account disconnected: ${id}`);
    return true;
  }

  // ---- HTTP ----

  async _fetch(host, url, init) {
    const left = (this.pausedUntil.get(host) || 0) - Date.now();
    if (left > 0) throw new Error(`${host} asked us to back off — ${Math.ceil(left / 1000)}s left`);
    const res = await this.fetcher(url, init);
    if (res.status === 429 || res.status === 503) {
      const ms = retryAfterMs(res) ?? 60_000;
      this.pausedUntil.set(host, Date.now() + ms);
      this.log(`${host} answered ${res.status} — pausing for ${Math.round(ms / 1000)}s`);
    }
    return res;
  }

  async _json(res, host) {
    const body = await res.json().catch(() => ({}));
    if (res.status >= 400) {
      const err = new Error(body.error_description || body.error || `${host} answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  // ---- the OAuth dance, as the client ----

  // One app registration per host, remembered. The redirect_uri is part of what
  // was registered, so an agent that moved to another port re-registers rather
  // than sending the server a redirect it will refuse.
  async appFor(host, redirectUri) {
    const file = path.join(this.dir, APPS, `${host}.json`);
    try {
      const app = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (app.redirectUri === redirectUri && app.clientId && app.clientSecret) return app;
    } catch { /* not registered here yet */ }
    const res = await this._fetch(host, `https://${host}/api/v1/apps`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME, redirect_uris: redirectUri,
        scopes: SCOPES, website: 'https://github.com/jeff-zucker/FediPod',
      }),
    });
    const body = await this._json(res, host);
    if (!body.client_id || !body.client_secret) throw new Error(`${host} registered no client`);
    const app = { host, redirectUri, clientId: body.client_id, clientSecret: body.client_secret };
    fs.mkdirSync(path.join(this.dir, APPS), { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, app);
    return app;
  }

  // Step one: where to send the browser. The state nonce is single-use and
  // short-lived — without one, any page the owner visits could hand our
  // callback somebody else's authorization code and bind THEIR account here.
  async begin({ host, redirectUri }) {
    const h = cleanHost(host);
    if (!h) throw new Error('that is not a server address');
    const app = await this.appFor(h, redirectUri);
    const state = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > STATE_TTL_MS) this.pending.delete(k);
    this.pending.set(state, { host: h, redirectUri, at: now });
    const u = new URL(`https://${h}/oauth/authorize`);
    u.searchParams.set('client_id', app.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES);
    u.searchParams.set('state', state);
    return { url: u.href, state, host: h };
  }

  // Step two: the code comes back. Exchange it, ask the server who we now are,
  // and only then write anything.
  async complete({ state, code }) {
    const pend = this.pending.get(state);
    if (!pend || Date.now() - pend.at > STATE_TTL_MS) throw new Error('that sign-in has expired — start again');
    this.pending.delete(state);
    const { host, redirectUri } = pend;
    const app = await this.appFor(host, redirectUri);
    const res = await this._fetch(host, `https://${host}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri,
        client_id: app.clientId, client_secret: app.clientSecret, scope: SCOPES,
      }),
    });
    const tok = await this._json(res, host);
    if (!tok.access_token) throw new Error(`${host} returned no token`);
    const me = await this.whoami(host, tok.access_token);
    const id = safeId(me.username, host);
    if (!id) throw new Error(`${host} answered with a name we cannot file safely`);
    this.write({
      id, host, token: tok.access_token, scope: tok.scope || SCOPES,
      handle: `@${me.username}@${host}`, acct: me.acct || me.username,
      accountId: String(me.id), actorUrl: me.url || null,
      name: me.display_name || me.username, icon: me.avatar || null,
      addedAt: new Date().toISOString(), enabled: true,
      ...(this.actorId ? { mintedFor: this.actorId } : {}),
    });
    this.log(`Fediverse account connected: @${me.username}@${host}`);
    return this.roster().find(r => r.id === id);
  }

  async whoami(host, token) {
    const res = await this._fetch(host, `https://${host}/api/v1/accounts/verify_credentials`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const me = await this._json(res, host);
    if (!me.username) throw new Error(`${host} did not say who we are`);
    return me;
  }

  // ---- authenticated calls on behalf of one connected account ----

  // Returns the Response, so a caller can read rate-limit headers. A 401 means
  // the token was revoked on the far side: the account is marked rather than
  // deleted, because the owner should be told rather than quietly dropped.
  async api(id, pathname, init = {}) {
    const rec = this.read(id);
    if (!rec?.token) throw new Error(`no connected account ${id}`);
    const url = pathname.startsWith('https://') ? pathname : `https://${rec.host}${pathname}`;
    const res = await this._fetch(rec.host, url, {
      ...init,
      headers: { ...(init.headers || {}), authorization: `Bearer ${rec.token}` },
    });
    if (res.status === 401) {
      if (!rec.needsReconnect) this.write({ ...rec, needsReconnect: true });
      const err = new Error(`${rec.handle} no longer accepts our token — reconnect it`);
      err.status = 401;
      throw err;
    }
    if (rec.needsReconnect && res.status < 400) this.write({ ...rec, needsReconnect: false });
    return res;
  }

  async apiJson(id, pathname, init = {}) {
    const rec = this.read(id);
    const res = await this.api(id, pathname, init);
    return this._json(res, rec?.host || id);
  }
}
