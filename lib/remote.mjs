// remote.mjs — authenticated I/O against the remote pod, via CSS
// client-credentials + DPoP (vendor/idp-grant.cjs, extracted from
// data-kitchen's "remember this IdP" machinery — plain Node, no Electron).

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as $rdf from 'rdflib';

const LDP = $rdf.Namespace('http://www.w3.org/ns/ldp#');
const DC = $rdf.Namespace('http://purl.org/dc/terms/');
const POSIX = $rdf.Namespace('http://www.w3.org/ns/posix/stat#');
const RDF = $rdf.Namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#');
const ACL = $rdf.Namespace('http://www.w3.org/ns/auth/acl#');
const FOAF = $rdf.Namespace('http://xmlns.com/foaf/0.1/');

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

// A pod's ability to BE a pod. Not data, and never ours to remove: delete one
// of these and the pod does not degrade, it stops — and it cannot be repaired
// by the tool that broke it, because that tool can no longer authenticate. A
// pod was crippled exactly this way.
//
// Here rather than in any one script, because every DELETE this project sends
// goes through RemotePod.delete — so this is the one place that cannot be
// routed around. A DENY-list, not an allow-prefix: the next script will have a
// different prefix and the same list of things it must never touch.
const PROTECTED = [
  [/\/profile(\/|$)/, 'the WebID document — nothing could authenticate as this pod again'],
  [/\/settings(\/|$)/, "the pod's own settings"],
  [/\/\.well-known(\/|$)/, 'discovery — the handle would stop resolving'],
  [/\.acl$/, 'an access-control document — what it governs becomes unreachable'],
  [/\.meta$/, 'a resource description the server itself reads'],
];

export function protectedFromDeletion(url) {
  let p;
  try { p = new URL(url).pathname; } catch { throw new Error(`refusing to DELETE an unparsable URL: ${url}`); }
  if (p === '/' || p === '') throw new Error(`refusing to DELETE the pod root: ${url}`);
  for (const [re, why] of PROTECTED) {
    if (re.test(p)) {
      throw new Error(`refusing to DELETE ${url} — ${why}. Deny-list: lib/remote.mjs.`);
    }
  }
}

export class RemotePod {
  constructor(credential, { log = () => {}, home = null } = {}) {
    this.session = createGrantSession(credential, home ? {
      backoffFile: path.join(home, 'backoff.json'),
      tokenFile: path.join(home, 'token.json'),
    } : {});
    this.webId = credential.webId;
    this.pausedUntil = 0;
    this.log = log;
  }

  async warmup() { return this.session.warmup(); }

  // What we have asked of this pod, for /status and for answering an operator.
  stats() {
    return { ...this.session.stats(), pausedFor: Math.max(0, Math.round((this.pausedUntil - Date.now()) / 1000)) };
  }

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

  // Everything below goes through this.fetch, never session.fetch directly:
  // that is the only place the Retry-After cooldown is both OBSERVED and ARMED.
  // Writing straight to the session meant a pod could answer 429 to every PUT
  // and DELETE we sent without any of them ever being recorded as a refusal,
  // and meant a cooldown armed by a read did not stop a publish burst.
  async put(url, body, contentType) {
    const res = await this.fetch(url, {
      method: 'PUT', headers: { 'content-type': contentType }, body,
    });
    if (res.status >= 400) throw new Error(`PUT ${url} → ${res.status}`);
    return res;
  }

  async putJson(url, obj, contentType = 'application/activity+json') {
    return this.put(url, JSON.stringify(obj), contentType);
  }

  // A read that FAILED is not a document that is ABSENT. Returning null for
  // both let a 429 read as "no replies yet", and the caller then rewrote the
  // collection from empty — erasing every reply already recorded. Only a real
  // 404/410 is absence; anything else throws and the caller retries later.
  async getJson(url) {
    const res = await this.fetch(url, { headers: { accept: '*/*' } });
    if (res.status === 404 || res.status === 410) return null;
    if (res.status >= 400) throw new Error(`GET ${url} → ${res.status}`);
    return res.json().catch(() => null);
  }

  async delete(url) {
    protectedFromDeletion(url);
    const res = await this.fetch(url, { method: 'DELETE' });
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
    // rdflib, not a regex: a container listing is RDF, and the gap between
    // "any angle-bracketed thing in the document" and "what this container
    // actually contains" is where quiet bugs live. claude/plans/no-regex-rdf.md
    //
    // CSS puts dc:modified and posix:size on every child of the same listing,
    // so age and weight cost nothing extra — which is what lets the drain work
    // oldest-first and lets a backlog be measured without reading any of it.
    const g = $rdf.graph();
    $rdf.parse(await res.text(), g, url, 'text/turtle');
    const here = $rdf.sym(url);
    const seen = new Set();
    const list = [];
    for (const child of g.each(here, LDP('contains'), null, here)) {
      const u = child.value;
      if (!u.startsWith(url) || u === url || /\.(acl|meta)$/.test(u) || seen.has(u)) continue;
      seen.add(u);
      list.push({
        url: u,
        size: Number(g.any(child, POSIX('size'), null, here)?.value || 0),
        modified: g.any(child, DC('modified'), null, here)?.value || null,
      });
    }
    // Oldest first. An LDP listing is a set, so without this the drain works
    // in whatever order the graph happened to parse — a mention from last week
    // after one from today, and no way to make progress predictable.
    list.sort((a, b) => String(a.modified || '').localeCompare(String(b.modified || '')));
    this._listCache.set(url, { etag: res.headers.get('etag'), children: list });
    return list;
  }

  // WAC doc granting the public `publicModes` on target, owner full control.
  // An empty publicModes list yields an owner-only document.
  //
  // Built and serialised by rdflib, like every other document this project
  // writes — see claude/plans/no-regex-rdf.md. This was the last site still
  // assembling Turtle from template literals, and it is the highest-consequence
  // RDF here: an ACL that comes out malformed, or naming the wrong subject,
  // either locks the owner out or leaves the private trees world-readable.
  // $rdf.sym() also throws on an illegal IRI, so a pod URL with something odd
  // in it fails here rather than silently producing a document that means
  // something else.
  aclDoc(targetUrl, publicModes) {
    const url = targetUrl + '.acl';
    const doc = $rdf.sym(url);
    const target = $rdf.sym(targetUrl);
    const g = $rdf.graph();
    const authorize = (subject, agentPred, agent, modes) => {
      g.add(subject, RDF('type'), ACL('Authorization'), doc);
      g.add(subject, agentPred, agent, doc);
      g.add(subject, ACL('accessTo'), target, doc);
      g.add(subject, ACL('default'), target, doc);
      for (const m of modes) g.add(subject, ACL('mode'), ACL(m), doc);
    };
    if (publicModes.length) {
      authorize($rdf.sym(url + '#public'), ACL('agentClass'), FOAF('Agent'), publicModes);
    }
    authorize($rdf.sym(url + '#owner'), ACL('agent'), $rdf.sym(this.webId),
      ['Read', 'Write', 'Control']);
    return $rdf.serialize(doc, g, url, 'text/turtle');
  }

  async setAcl(targetUrl, publicModes) {
    return this.put(targetUrl + '.acl', this.aclDoc(targetUrl, publicModes), 'text/turtle');
  }
}
