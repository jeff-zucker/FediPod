// pod-remote.mjs — the browser's RemotePod: the agent's whole conversation with
// the pod, over the DPoP session instead of Node's transport.
//
// lib/remote.mjs cannot be bundled — it top-level-requires a Node-only grant
// module — so this reimplements the surface the agent uses, over session.fetch.
// The pod I/O, the ACL documents and the deletion deny-list all match
// lib/remote.mjs; when that file's logic changes, this follows. Only rdflib and
// the pure link parser are shared.
import * as $rdf from 'rdflib';
import { linkTargets, REL } from '../../lib/links.mjs';

const RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const ACL = $rdf.Namespace('http://www.w3.org/ns/auth/acl#');
const FOAF = $rdf.Namespace('http://xmlns.com/foaf/0.1/');
const AS = $rdf.Namespace('https://www.w3.org/ns/activitystreams#');
const LDP = $rdf.Namespace('http://www.w3.org/ns/ldp#');
const DC = $rdf.Namespace('http://purl.org/dc/terms/');
const POSIX = $rdf.Namespace('http://www.w3.org/ns/posix/stat#');
const ACP_NS = 'http://www.w3.org/ns/solid/acp#';

// Retry transient edge throttling (dropped connections, 429/503) with backoff.
const RETRY_MAX = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(5000, 400 * 2 ** n) + Math.floor(Math.random() * 250);

// The deletion deny-list, verbatim from lib/remote.mjs — a pod's identity,
// settings, discovery, access rules and lease are never deletable.
const PROTECTED = [
  [/\/profile(\/|$)/, 'the WebID document'],
  [/\/settings(\/|$)/, "the pod's own settings"],
  [/\/\.well-known(\/|$)/, 'discovery — the handle would stop resolving'],
  [/\.acl$/, 'an access-control document'],
  [/\.meta$/, 'a resource description the server itself reads'],
  [/\/lease\.json$/, 'the lease — two agents would drain the same inbox'],
];
export function protectedFromDeletion(url) {
  let p;
  try { p = new URL(url).pathname; } catch { throw new Error(`refusing to DELETE an unparsable URL: ${url}`); }
  if (p === '/' || p === '') throw new Error(`refusing to DELETE the pod root: ${url}`);
  for (const [re, why] of PROTECTED) if (re.test(p)) throw new Error(`refusing to DELETE ${url} — ${why}`);
}

export class BrowserRemotePod {
  constructor(session, { webId, log = () => {} }) {
    this.session = session;           // { fetch(url, init) } — the DPoP session
    this.webId = webId;
    this.log = log;
    this.aclUrls = new Map();
    this.aclFlavour = null;
    this.toPod = null;
    this._listCache = new Map();
  }

  setUrlMap(fn) { this.toPod = typeof fn === 'function' ? fn : null; }
  async warmup() { /* the DPoP session refreshes lazily */ }
  stats() { return { probes: 0 }; }

  async probe(url, init = {}) { return fetch(url, init); }         // credential-free, on purpose

  async fetch(url, init) {
    if (this.toPod) url = this.toPod(url);
    // solidcommunity.net sits behind an edge (Cloudflare) that throttles a burst
    // of requests: during first-boot provisioning the agent makes ~15 rapid
    // calls, and one comes back as a dropped connection ("Failed to fetch") or a
    // 429/503. A single dropped write used to abort the whole boot. Retry those
    // with escalating backoff — the throttle window clears in under a few seconds.
    // Safe to retry: a thrown request never reached the server, and a 429/503 was
    // refused, not applied.
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.session.fetch(url, init);
        if ((res.status === 429 || res.status === 503) && attempt < RETRY_MAX) { await sleep(backoff(attempt++)); continue; }
        return res;
      } catch (e) {
        if (attempt >= RETRY_MAX) throw e;
        this.log(`${init?.method || 'GET'} ${url} failed (${e.message}); retry ${attempt + 1}/${RETRY_MAX}`);
        await sleep(backoff(attempt++));
      }
    }
  }

  noteAclLink(url, res) {
    if (this.aclUrls.has(url)) return;
    const [acl] = linkTargets(res?.headers?.get?.('link'), REL.acl, url);
    if (acl) this.aclUrls.set(url, acl);
  }

  async put(url, body, contentType) {
    const res = await this.fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
    if (res.status >= 400) throw new Error(`PUT ${url} → ${res.status}`);
    this.noteAclLink(url, res);
    return res;
  }
  putJson(url, obj, contentType = 'application/activity+json') { return this.put(url, JSON.stringify(obj), contentType); }

  async getJson(url) {
    const res = await this.fetch(url, { headers: { accept: '*/*' } });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status >= 400) throw new Error(`GET ${url} → ${res.status}`);
    return res.json().catch(() => null);
  }

  async delete(url) {
    protectedFromDeletion(url);
    for (const acl of this.aclUrls.values()) if (acl === url) throw new Error(`refusing to DELETE an access-control document: ${url}`);
    const res = await this.fetch(url, { method: 'DELETE' });
    return res.status < 400 || res.status === 404;
  }

  async aclUrlFor(targetUrl) {
    const known = this.aclUrls.get(targetUrl);
    if (known) return known;
    try { this.noteAclLink(targetUrl, await this.fetch(targetUrl, { method: 'HEAD' })); } catch { /* absent */ }
    const resolved = this.aclUrls.get(targetUrl) || targetUrl + '.acl';
    this.aclUrls.set(targetUrl, resolved);
    return resolved;
  }

  async aclWritable(aclUrl) {
    if (this.aclFlavour !== null) return this.aclFlavour;
    this.aclFlavour = true;
    try {
      const res = await this.fetch(aclUrl, { headers: { accept: 'text/turtle' } });
      if (res.status < 300) {
        const g = $rdf.graph();
        $rdf.parse(await res.text(), g, aclUrl, 'text/turtle');
        if (g.statements.some((st) => st.predicate.value.startsWith(ACP_NS) || st.object.value.startsWith(ACP_NS))) {
          this.aclFlavour = false;
          this.log('this pod states access as ACP; its rules are left as they are');
        }
      }
    } catch { /* WAC is what we write */ }
    return this.aclFlavour;
  }

  aclDoc(targetUrl, publicModes, { appendAgents = [], aclUrl = null } = {}) {
    const url = aclUrl || targetUrl + '.acl';
    const doc = $rdf.sym(url); const target = $rdf.sym(targetUrl); const g = $rdf.graph();
    const authorize = (subject, agentPred, agent, modes) => {
      g.add(subject, RDF('type'), ACL('Authorization'), doc);
      g.add(subject, agentPred, agent, doc);
      g.add(subject, ACL('accessTo'), target, doc);
      g.add(subject, ACL('default'), target, doc);
      for (const m of modes) g.add(subject, ACL('mode'), ACL(m), doc);
    };
    if (publicModes.length) authorize($rdf.sym(url + '#public'), ACL('agentClass'), FOAF('Agent'), publicModes);
    appendAgents.forEach((webId, i) => authorize($rdf.sym(url + `#gw${i}`), ACL('agent'), $rdf.sym(webId), ['Append']));
    authorize($rdf.sym(url + '#owner'), ACL('agent'), $rdf.sym(this.webId), ['Read', 'Write', 'Control']);
    return $rdf.serialize(doc, g, url, 'text/turtle');
  }

  async setAcl(targetUrl, publicModes, opts = {}) {
    const url = await this.aclUrlFor(targetUrl);
    if (!await this.aclWritable(url)) return null;
    return this.put(url, this.aclDoc(targetUrl, publicModes, { ...opts, aclUrl: url }), 'text/turtle');
  }

  async listContainer(url) {
    const known = this._listCache.get(url);
    const res = await this.fetch(url, { headers: { accept: 'text/turtle', ...(known?.etag ? { 'if-none-match': known.etag } : {}) } });
    if (res.status === 304 && known) return known.children;
    if (res.status >= 400) return [];
    const body = await res.text();
    const g = $rdf.graph();
    try { $rdf.parse(body, g, url, 'text/turtle'); } catch { return known?.children ?? []; }
    const here = $rdf.sym(url); const seen = new Set(); const list = [];
    for (const child of g.each(here, LDP('contains'), null, here)) {
      const u = child.value;
      if (!u.startsWith(url) || u === url || /\.(acl|meta|receipt\.json)$/.test(u) || seen.has(u)) continue;
      seen.add(u);
      list.push({ url: u, size: Number(g.any(child, POSIX('size'), null, here)?.value || 0),
        modified: g.any(child, DC('modified'), null, here)?.value || null });
    }
    list.sort((a, b) => String(a.modified || '').localeCompare(String(b.modified || '')));
    this._listCache.set(url, { etag: res.headers.get('etag'), children: list });
    return list;
  }

  n3Patch(docUrl, inserts, deletes) {
    const block = (triples) => { const g = $rdf.graph(); for (const [s, p, o] of triples) g.add(s, p, o); return $rdf.serialize(null, g, docUrl, 'application/n-triples').trim(); };
    const clauses = [];
    if (deletes.length) clauses.push(`  solid:deletes { ${block(deletes)} }`);
    if (inserts.length) clauses.push(`  solid:inserts { ${block(inserts)} }`);
    return `@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n<> a solid:InsertDeletePatch;\n${clauses.join(';\n')}.\n`;
  }
  async patchDocument(docUrl, inserts, deletes) {
    let res;
    try { res = await this.fetch(docUrl, { method: 'PATCH', headers: { 'content-type': 'text/n3' }, body: this.n3Patch(docUrl, inserts, deletes) }); }
    catch { return false; }
    if (res.status < 300) return true;
    if (res.status === 405 || res.status === 415 || res.status === 501) return false;
    throw new Error(`PATCH ${docUrl} → ${res.status}`);
  }

  async linkAccountInProfile({ actorUrl, accountName, kind = 'person' }) {
    const docUrl = this.webId.split('#')[0];
    const res = await this.fetch(docUrl, { headers: { accept: 'text/turtle' } });
    if (res.status >= 400) throw new Error(`GET ${docUrl} → ${res.status}`);
    const g = $rdf.graph();
    $rdf.parse(await res.text(), g, docUrl, 'text/turtle');
    const doc = $rdf.sym(docUrl); const me = $rdf.sym(this.webId);
    if (!g.statementsMatching(me, null, null, doc).length) throw new Error(`profile at ${docUrl} does not mention ${this.webId}`);
    const actor = $rdf.sym(actorUrl);
    const wanted = [[me, FOAF('account'), actor], [actor, RDF('type'), FOAF('OnlineAccount')],
      [actor, RDF('type'), kind === 'group' ? AS('Group') : AS('Person')], [actor, FOAF('accountName'), $rdf.literal(accountName)]];
    const missing = wanted.filter(([s, p, o]) => !g.holds(s, p, o, doc));
    const stale = g.statementsMatching(actor, FOAF('accountName'), null, doc).filter((st) => st.object.value !== accountName);
    if (!missing.length && !stale.length) return false;
    const deletes = stale.map((st) => [st.subject, st.predicate, st.object]);
    if (await this.patchDocument(docUrl, missing, deletes)) return true;
    for (const st of stale) g.remove(st);
    for (const [s, p, o] of missing) g.add(s, p, o, doc);
    await this.put(docUrl, $rdf.serialize(doc, g, docUrl, 'text/turtle'), 'text/turtle');
    return true;
  }
}
