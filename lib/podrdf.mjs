// podrdf.mjs — the RDF source of truth under /activitypods-js/fediverse/ on
// the remote pod, written through the authenticated session. Same documents
// and AS2 vocabulary as dk's local.mjs (plan: ap-pod-mapping.md); only the
// transport differs — an injected authenticated fetch instead of a
// gate-token loopback fetch.

const AS = 'https://www.w3.org/ns/activitystreams#';
const PREFIXES = `@prefix as: <${AS}>.\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.\n`;

function lit(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '') + '"';
}

export class PodRdf {
  constructor({ base, fetchImpl }) {
    this.base = base.endsWith('/') ? base : base + '/';   // e.g. https://pod/activitypods-js/fediverse/
    this.fedi = this.base;
    this.fetchImpl = fetchImpl;
  }

  async get(url) {
    const res = await this.fetchImpl(url, { headers: { accept: 'text/turtle' } });
    if (res.status >= 400) throw new Error(`pod GET ${url} → ${res.status}`);
    return res.text();
  }

  async put(url, body, contentType = 'text/turtle') {
    const res = await this.fetchImpl(url, {
      method: 'PUT', headers: { 'content-type': contentType }, body,
    });
    if (res.status >= 400) throw new Error(`pod PUT ${url} → ${res.status}`);
  }

  async delete(url) {
    const res = await this.fetchImpl(url, { method: 'DELETE' });
    if (res.status >= 400 && res.status !== 404) throw new Error(`pod DELETE ${url} → ${res.status}`);
  }

  // Child resource URLs of {fedi}{kind}/ (empty when the container is absent).
  async listNotes(kind) {
    const base = `${this.fedi}${kind}/`;
    let ttl;
    try { ttl = await this.get(base); }
    catch (e) { if (/ 404$/.test(e.message)) return []; throw e; }
    const urls = new Set();
    for (const m of ttl.matchAll(/<([^>]*)>/g)) {
      let u;
      try { u = new URL(m[1], base).href; } catch { continue; }
      if (u.startsWith(base) && u !== base && !u.endsWith('/') && !/\.(acl|meta)$/.test(u)) urls.add(u);
    }
    return [...urls];
  }

  // Inverse of writeNote for one resource (the exact shape this class writes).
  async readNote(url) {
    const ttl = await this.get(url);
    const iri = (p) => (ttl.match(new RegExp(`as:${p} <([^>]+)>`)) || [])[1];
    const str = (p) => {
      const m = ttl.match(new RegExp(`as:${p} "((?:[^"\\\\]|\\\\.)*)"`));
      return m ? m[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)) : undefined;
    };
    return {
      noteId: iri('url'), actor: iri('attributedTo'),
      published: str('published'), inReplyTo: iri('inReplyTo'), content: str('content'),
    };
  }

  // Incoming or own post → one RDF resource. kind: 'timeline' | 'posts'
  async writeNote(kind, slug, { noteId, actor, published, content, inReplyTo }) {
    let ttl = PREFIXES +
      `<> a as:Note ;\n` +
      `  as:url <${noteId}> ;\n` +
      `  as:attributedTo <${actor}> ;\n` +
      (published ? `  as:published ${lit(published)}^^xsd:dateTime ;\n` : '') +
      (inReplyTo ? `  as:inReplyTo <${inReplyTo}> ;\n` : '') +
      `  as:content ${lit(content || '')} .\n`;
    await this.put(`${this.fedi}${kind}/${slug}`, ttl);
  }

  // Contacts doc — the followers/following truth, rebuilt whole each change.
  async writeContacts({ followers, following }) {
    let ttl = PREFIXES + `<#me> a as:Person`;
    if (followers.length) ttl += ` ;\n  as:followers ${followers.map(f => `<${f.actor}>`).join(', ')}`;
    if (following.length) ttl += ` ;\n  as:following ${following.map(f => `<${f.actor}>`).join(', ')}`;
    await this.put(this.fedi + 'contacts', ttl + ' .\n');
  }

  // Settings doc — handle + pointer to the public face.
  async writeSettings({ handle, actorUrl }) {
    const ttl = PREFIXES +
      `<#me> a as:Person ;\n  as:preferredUsername ${lit(handle)} ;\n  as:url <${actorUrl}> .\n`;
    await this.put(this.fedi + 'settings', ttl);
  }
}
