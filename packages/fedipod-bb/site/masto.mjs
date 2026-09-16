// masto.mjs — replying from a Mastodon account, in the browser: the same
// OAuth steps the FediPod agent takes for a connected account (register an
// app on the reader's server, send them to approve it, exchange the code),
// then posting through that server's API. The token stays in this browser
// and goes nowhere else.

const SCOPES = 'read:accounts read:search write:statuses';
const CLIENT_NAME = 'FediPod-BB';
const STATE_TTL_MS = 10 * 60_000;

export const cleanHost = (s) => {
  const h = String(s || '').trim().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '').toLowerCase();
  return /^[a-z0-9.-]+\.[a-z0-9-]+(:\d+)?$/u.test(h) ? h : null;
};

// The server in a Fediverse handle: @you@host, you@host, or the address of a
// profile page there.
export const hostOfHandle = (s) => {
  const t = String(s || '').trim();
  const m = /^@?[^@\s/]+@([^@\s/]+)$/u.exec(t);
  return cleanHost(m ? m[1] : t);
};

// What a server speaks, asked of the server itself: the Mastodon API (Mastodon,
// Pleroma, Akkoma, GoToSocial, Friendica, a FediPod DeviceAgent or Server),
// Lemmy's, or nothing this page can sign in to.
export async function serverKind(host, f = globalThis.fetch.bind(globalThis)) {
  const ok = async (path) => {
    try { const r = await f(`https://${host}${path}`, { headers: { accept: 'application/json' } }); return r.ok; } catch { return false; }
  };
  if (await ok('/api/v1/instance')) return 'mastodon-api';
  if (await ok('/api/v3/site')) return 'lemmy';
  return 'unknown';
}

export class MastoLogin {
  // `storage` is localStorage-shaped; `fetch` is the page's.
  constructor({ fetch: f = globalThis.fetch.bind(globalThis), storage, redirectUri }) {
    this.fetch = f;
    this.storage = storage;
    this.redirectUri = redirectUri;
  }

  _read(k) { try { return JSON.parse(this.storage.getItem('bb:' + k) || 'null'); } catch { return null; } }
  _write(k, v) { this.storage.setItem('bb:' + k, JSON.stringify(v)); }
  _drop(k) { this.storage.removeItem('bb:' + k); }

  account() { return this._read('account'); }
  signOut() { this._drop('account'); }

  async _json(res, host) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error_description || body.error || `${host} answered ${res.status}`);
    return body;
  }

  async appFor(host) {
    const apps = this._read('apps') || {};
    const known = apps[host];
    if (known?.redirectUri === this.redirectUri && known.clientId) return known;
    const res = await this.fetch(`https://${host}/api/v1/apps`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: this.redirectUri, scopes: SCOPES, website: 'https://github.com/jeff-zucker/FediPod' }),
    });
    const body = await this._json(res, host);
    if (!body.client_id || !body.client_secret) throw new Error(`${host} registered no client`);
    const app = { host, redirectUri: this.redirectUri, clientId: body.client_id, clientSecret: body.client_secret };
    this._write('apps', { ...apps, [host]: app });
    return app;
  }

  // Where to send the reader. The state is single-use and short-lived, so a
  // code handed back to this page by anyone else binds nothing.
  async begin(hostInput) {
    const host = cleanHost(hostInput);
    if (!host) throw new Error('that is not a server address');
    const app = await this.appFor(host);
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    const state = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    this._write('pending', { state, host, at: Date.now() });
    const u = new URL(`https://${host}/oauth/authorize`);
    u.searchParams.set('client_id', app.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', SCOPES);
    u.searchParams.set('state', state);
    return u.href;
  }

  // The code comes back: exchange it, ask who this is, and only then keep it.
  async complete({ state, code }) {
    const pend = this._read('pending');
    this._drop('pending');
    if (!pend || pend.state !== state || Date.now() - pend.at > STATE_TTL_MS) throw new Error('that sign-in has expired — start again');
    const { host } = pend;
    const app = await this.appFor(host);
    const res = await this.fetch(`https://${host}/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri,
        client_id: app.clientId, client_secret: app.clientSecret, scope: SCOPES }),
    });
    const tok = await this._json(res, host);
    if (!tok.access_token) throw new Error(`${host} returned no token`);
    const me = await this._json(await this.fetch(`https://${host}/api/v1/accounts/verify_credentials`,
      { headers: { authorization: `Bearer ${tok.access_token}` } }), host);
    const account = { host, token: tok.access_token, handle: `@${me.username}@${host}`, name: me.display_name || me.username, url: me.url || null };
    this._write('account', account);
    return account;
  }

  // The id a post has on the reader's own server, found by its address.
  async statusIdFor(url) {
    const a = this.account();
    if (!a) throw new Error('not signed in');
    const u = new URL(`https://${a.host}/api/v2/search`);
    u.searchParams.set('q', url); u.searchParams.set('resolve', 'true'); u.searchParams.set('type', 'statuses'); u.searchParams.set('limit', '1');
    const body = await this._json(await this.fetch(u.href, { headers: { authorization: `Bearer ${a.token}` } }), a.host);
    return body.statuses?.[0]?.id || null;
  }

  // Post from the reader's account: the category is named so it receives
  // the post; a reply names the post it answers by its id on that server.
  async post({ text, mention, inReplyToUrl = null }) {
    const a = this.account();
    if (!a) throw new Error('not signed in');
    const status = mention && !text.includes(mention) ? `${mention} ${text}` : text;
    const inReplyTo = inReplyToUrl ? await this.statusIdFor(inReplyToUrl) : null;
    if (inReplyToUrl && !inReplyTo) throw new Error(`${a.host} could not find the post you are answering`);
    const body = { status, visibility: 'public', ...(inReplyTo ? { in_reply_to_id: inReplyTo } : {}) };
    const made = await this._json(await this.fetch(`https://${a.host}/api/v1/statuses`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
      body: JSON.stringify(body),
    }), a.host);
    return { id: made.id, url: made.url || made.uri || null, uri: made.uri || null };
  }
}
