// remote.mjs — authenticated I/O against the remote pod, via CSS
// client-credentials + DPoP (vendor/idp-grant.cjs, extracted from
// data-kitchen's "remember this IdP" machinery — plain Node, no Electron).

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const vendorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor');
const { mintCredential, discoverTokenEndpoint, createGrantSession, revokeCredentialViaAccount } =
  require(path.join(vendorDir, 'idp-grant.cjs'));

export { mintCredential, discoverTokenEndpoint, revokeCredentialViaAccount };

// A pod that answers 429 or 503 is asking to be left alone; Retry-After says
// for how long. Every request to this pod goes through one cooldown, so a
// server under strain gets silence rather than each timer discovering the
// refusal separately. Requests during the window fail fast — no socket is
// opened — and the callers' existing retry paths take it from there.
const COOLDOWN_DEFAULT_MS = 60_000;
const COOLDOWN_MAX_MS = 30 * 60_000;

function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return COOLDOWN_DEFAULT_MS;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 1) * 1000, COOLDOWN_MAX_MS);
  const when = Date.parse(raw);                       // HTTP-date form
  if (Number.isFinite(when)) return Math.min(Math.max(when - Date.now(), 1000), COOLDOWN_MAX_MS);
  return COOLDOWN_DEFAULT_MS;
}

export class RemotePod {
  constructor(credential, { log = () => {} } = {}) {
    this.session = createGrantSession(credential);
    this.webId = credential.webId;
    this.pausedUntil = 0;
    this.log = log;
  }

  async warmup() { return this.session.warmup(); }

  async fetch(url, init) {
    const left = this.pausedUntil - Date.now();
    if (left > 0) {
      throw new Error(`pod asked us to back off — ${Math.ceil(left / 1000)}s left of its Retry-After`);
    }
    const res = await this.session.fetch(url, init);
    if (res.status === 429 || res.status === 503) {
      const ms = retryAfterMs(res);
      this.pausedUntil = Date.now() + ms;
      this.log(`pod returned ${res.status} — pausing all requests for ${Math.round(ms / 1000)}s`);
    }
    return res;
  }

  async put(url, body, contentType) {
    const res = await this.session.fetch(url, {
      method: 'PUT', headers: { 'content-type': contentType }, body,
    });
    if (res.status >= 400) throw new Error(`PUT ${url} → ${res.status}`);
    return res;
  }

  async putJson(url, obj, contentType = 'application/activity+json') {
    return this.put(url, JSON.stringify(obj), contentType);
  }

  async getJson(url) {
    const res = await this.session.fetch(url, { headers: { accept: '*/*' } });
    if (res.status >= 400) return null;
    return res.json().catch(() => null);
  }

  async delete(url) {
    const res = await this.session.fetch(url, { method: 'DELETE' });
    return res.status < 400 || res.status === 404;
  }

  // Child documents of an LDP container (URLs under it, excluding aux docs).
  // Revalidated: the inbox is polled every two minutes and is usually
  // unchanged, so ask conditionally and let the server answer 304.
  async listContainer(url) {
    this._listCache ||= new Map();
    const known = this._listCache.get(url);
    const res = await this.fetch(url, {
      headers: { accept: 'text/turtle', ...(known?.etag ? { 'if-none-match': known.etag } : {}) },
    });
    if (res.status === 304 && known) return known.children;
    if (res.status >= 400) return [];
    const text = await res.text();
    const children = new Set();
    for (const m of text.matchAll(/<([^>]+)>/g)) {
      const child = new URL(m[1], url).href;
      if (child.startsWith(url) && child !== url && !/\.(acl|meta)$/.test(child)) children.add(child);
    }
    const list = [...children];
    this._listCache.set(url, { etag: res.headers.get('etag'), children: list });
    return list;
  }

  // WAC doc granting the public `publicModes` on target, owner full control.
  // An empty publicModes list yields an owner-only document.
  aclDoc(targetUrl, publicModes) {
    const pub = publicModes.length
      ? `<#public> a acl:Authorization;\n  acl:agentClass foaf:Agent;\n  acl:accessTo <${targetUrl}>;\n  acl:default <${targetUrl}>;\n  acl:mode ${publicModes.map(m => 'acl:' + m).join(', ')}.\n`
      : '';
    return `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n@prefix foaf: <http://xmlns.com/foaf/0.1/>.\n${pub}<#owner> a acl:Authorization;\n  acl:agent <${this.webId}>;\n  acl:accessTo <${targetUrl}>;\n  acl:default <${targetUrl}>;\n  acl:mode acl:Read, acl:Write, acl:Control.\n`;
  }

  async setAcl(targetUrl, publicModes) {
    return this.put(targetUrl + '.acl', this.aclDoc(targetUrl, publicModes), 'text/turtle');
  }
}
