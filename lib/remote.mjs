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
const AS = $rdf.Namespace('https://www.w3.org/ns/activitystreams#');

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
// The parser is shared with the outbound path; see lib/safefetch.mjs.
import { retryAfterMs, readCapped } from './safefetch.mjs';
import { linkTargets, REL } from './links.mjs';

// A pod whose access rules are ACP policies, not WAC authorizations. This
// agent writes WAC; over an ACP resource that would be noise where the pod's
// real rules used to be, so it stops instead.
const ACP_NS = 'http://www.w3.org/ns/solid/acp#';

// The inbox is public-Append, so the listing's size is in other people's
// hands; reading it whole must still have a ceiling.
const LISTING_MAX_BYTES = 10 * 1024 * 1024;

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
  // The single-active-agent lock. It is on the pod precisely because the
  // private half need not be — a lease only one machine can reach coordinates
  // nothing — so it survives moving the state off, and nothing ever deletes it:
  // release() writes an expiry, it does not remove the document. Two agents
  // both believing they hold it is silent, destructive, duplicated inbox
  // draining.
  [/\/lease\.json$/, 'the lease — two agents would drain the same inbox'],
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
  constructor(credential, { log = () => {}, home = null, session = null } = {}) {
    // An injected session replaces the credential-backed one, and everything
    // below it — the cooldown, the deny-list, the url map — is unchanged. That
    // is how the agent runs inside a pod server: same class, no token to mint.
    this.session = session || createGrantSession(credential, home ? {
      backoffFile: path.join(home, 'backoff.json'),
      tokenFile: path.join(home, 'token.json'),
    } : {});
    this.webId = credential.webId;
    this.pausedUntil = 0;
    this.probeCount = 0;
    this.log = log;
    // Where each resource's access control lives, as the pod itself said. WAC
    // forbids working it out from the resource's own URL, so it is asked for
    // and remembered rather than assembled.
    this.aclUrls = new Map();
    this.aclFlavour = null;      // null until the first write asks what this pod speaks
    // A fronted identity advertises ids on a shared domain but writes to the
    // pod. run-agent installs the fronted→pod mapping here, so every request
    // built from an advertised id lands on the pod — one choke point, and
    // publisher/social/intake stay unaware. Unset → identity, byte-for-byte
    // the unfronted behaviour.
    this.toPod = null;
  }

  // Install the advertised→pod url map for a fronted identity (urls.toPod).
  setUrlMap(fn) { this.toPod = typeof fn === 'function' ? fn : null; }

  async warmup() { return this.session.warmup(); }

  // What we have asked of this pod, for /status and for answering an operator.
  stats() {
    return {
      ...this.session.stats(),
      probes: this.probeCount,
      pausedFor: Math.max(0, Math.round((this.pausedUntil - Date.now()) / 1000)),
    };
  }

  // A deliberately CREDENTIAL-FREE request: it asks what a stranger would see,
  // so it cannot go through session.fetch without answering a different
  // question. It still belongs to this pod, though — it opens a socket to it
  // and takes one of its workers — so it observes the same Retry-After window
  // and is counted. Ten of these ride on every profile save, and none of them
  // used to appear in /status, which made podRequests under-report by design.
  async probe(url, init = {}) {
    const left = this.pausedUntil - Date.now();
    if (left > 0) {
      throw new Error(`pod asked us to back off — ${Math.ceil(left / 1000)}s left of its Retry-After`);
    }
    this.probeCount++;
    const res = await fetch(url, init);
    if (res.status === 429 || res.status === 503) {
      const ms = retryAfterMs(res) ?? 60_000;
      this.pausedUntil = Date.now() + ms;
      this.log(`pod returned ${res.status} to an unauthenticated probe — pausing for ${Math.round(ms / 1000)}s`);
    }
    return res;
  }

  async fetch(url, init) {
    const left = this.pausedUntil - Date.now();
    if (left > 0) {
      throw new Error(`pod asked us to back off — ${Math.ceil(left / 1000)}s left of its Retry-After`);
    }
    // Fronted identity: an advertised id maps to its pod location here, so the
    // request lands on the pod. A no-op for a pod-native id or an unfronted
    // identity (toPod unset).
    if (this.toPod) url = this.toPod(url);
    const res = await this.session.fetch(url, init);
    if (res.status === 429 || res.status === 503) {
      const ms = retryAfterMs(res) ?? 60_000;   // no header: our own cooldown
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
    // Writing a document is usually the step before setting its access, and
    // the answer to the write already says where that lives. Taking it here
    // spares the extra request the ACL write would otherwise make.
    this.noteAclLink(url, res);
    return res;
  }

  /** Remember an access-control location the pod volunteered on a response. */
  noteAclLink(url, res) {
    if (this.aclUrls.has(url)) return;
    const [acl] = linkTargets(res?.headers?.get?.('link'), REL.acl, url);
    if (acl) this.aclUrls.set(url, acl);
  }

  /**
   * Where this resource's access control lives. The pod says so on any
   * response about the resource; a pod that says nothing is taken to keep it
   * at the usual suffix, which is what every server this runs against does.
   */
  async aclUrlFor(targetUrl) {
    const known = this.aclUrls.get(targetUrl);
    if (known) return known;
    try {
      const res = await this.fetch(targetUrl, { method: 'HEAD' });
      this.noteAclLink(targetUrl, res);
    } catch { /* unreachable or no such resource yet: the suffix below */ }
    const resolved = this.aclUrls.get(targetUrl) || targetUrl + '.acl';
    this.aclUrls.set(targetUrl, resolved);
    return resolved;
  }

  /**
   * Whether writing a WAC document here is meaningful. Asked once per pod, on
   * the first access-control write. A pod that answers with ACP policies is
   * left alone: replacing them with authorizations it does not read would take
   * away the rules actually protecting it.
   */
  async aclWritable(aclUrl) {
    if (this.aclFlavour !== null) return this.aclFlavour;
    this.aclFlavour = true;
    try {
      const res = await this.fetch(aclUrl, { headers: { accept: 'text/turtle' } });
      if (res.status < 300) {
        const g = $rdf.graph();
        $rdf.parse(await res.text(), g, aclUrl, 'text/turtle');
        const acp = g.statements.some(st => st.predicate.value.startsWith(ACP_NS)
          || st.object.value.startsWith(ACP_NS));
        if (acp) {
          this.aclFlavour = false;
          this.log('this pod states access as ACP policies, which this agent does not write — '
            + 'its access rules are left exactly as they are, and nothing here is published private');
        }
      }
    } catch { /* absent, unreadable or unparsable: WAC is what we write */ }
    return this.aclFlavour;
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
    // The pattern list above knows the usual name for an access-control
    // document. One the pod named itself is just as fatal to remove.
    for (const acl of this.aclUrls.values()) {
      if (acl === url) throw new Error(`refusing to DELETE an access-control document: ${url}`);
    }
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
    let body;
    try {
      body = await readCapped(res, LISTING_MAX_BYTES);
    } catch (e) {
      this.log(`listing at ${url}: ${e.message} — using the last known listing`);
      return known?.children ?? [];
    }
    const g = $rdf.graph();
    $rdf.parse(body, g, url, 'text/turtle');
    const here = $rdf.sym(url);
    const seen = new Set();
    const list = [];
    for (const child of g.each(here, LDP('contains'), null, here)) {
      const u = child.value;
      // `.receipt.json` is a verification receipt a gateway wrote beside an
      // inbox item — read with the item, never enumerated as an item itself.
      if (!u.startsWith(url) || u === url || /\.(acl|meta|receipt\.json)$/.test(u) || seen.has(u)) continue;
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
  aclDoc(targetUrl, publicModes, { appendAgents = [], aclUrl = null } = {}) {
    const url = aclUrl || targetUrl + '.acl';
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
    // Named agents granted Append but not public: this is how the inbox is
    // locked to a gateway — public loses Append, the gateway's WebID keeps it.
    appendAgents.forEach((webId, i) =>
      authorize($rdf.sym(url + `#gw${i}`), ACL('agent'), $rdf.sym(webId), ['Append']));
    authorize($rdf.sym(url + '#owner'), ACL('agent'), $rdf.sym(this.webId),
      ['Read', 'Write', 'Control']);
    return $rdf.serialize(doc, g, url, 'text/turtle');
  }

  async setAcl(targetUrl, publicModes, opts = {}) {
    const url = await this.aclUrlFor(targetUrl);
    if (!await this.aclWritable(url)) return null;
    return this.put(url, this.aclDoc(targetUrl, publicModes, { ...opts, aclUrl: url }), 'text/turtle');
  }

  // The WebID profile advertises the actor as an account:
  //   <webId> foaf:account <actor> .
  //   <actor> a foaf:OnlineAccount, as:Person|as:Group ; foaf:accountName "@handle@host" .
  // Read–check–write through rdflib. Returns false when the profile already
  // says all of it. The parsed graph must mention the WebID before anything is
  // written back — an empty or foreign body must never become the new profile.
  async linkAccountInProfile({ actorUrl, accountName, kind = 'person' }) {
    const docUrl = this.webId.split('#')[0];
    const res = await this.fetch(docUrl, { headers: { accept: 'text/turtle' } });
    if (res.status >= 400) throw new Error(`GET ${docUrl} → ${res.status}`);
    const g = $rdf.graph();
    $rdf.parse(await res.text(), g, docUrl, 'text/turtle');
    const doc = $rdf.sym(docUrl);
    const me = $rdf.sym(this.webId);
    if (!g.statementsMatching(me, null, null, doc).length) {
      throw new Error(`profile at ${docUrl} does not mention ${this.webId} — not rewriting it`);
    }
    const actor = $rdf.sym(actorUrl);
    const wanted = [
      [me, FOAF('account'), actor],
      [actor, RDF('type'), FOAF('OnlineAccount')],
      [actor, RDF('type'), kind === 'group' ? AS('Group') : AS('Person')],
      [actor, FOAF('accountName'), $rdf.literal(accountName)],
    ];
    const missing = wanted.filter(([s, p, o]) => !g.holds(s, p, o, doc));
    // A handle change leaves the old accountName behind; ours is replaced.
    const stale = g.statementsMatching(actor, FOAF('accountName'), null, doc)
      .filter(st => st.object.value !== accountName);
    if (!missing.length && !stale.length) return false;
    // A patch touches these statements and nothing else. Rewriting the whole
    // profile re-serialises statements that are not ours — the OIDC issuer
    // among them — and a server is entitled to refuse a write that would.
    const deletes = stale.map(st => [ st.subject, st.predicate, st.object ]);
    if (await this.patchDocument(docUrl, missing, deletes)) return true;
    for (const st of stale) g.remove(st);
    for (const [s, p, o] of missing) g.add(s, p, o, doc);
    await this.put(docUrl, $rdf.serialize(doc, g, docUrl, 'text/turtle'), 'text/turtle');
    return true;
  }

  /**
   * An N3 Patch of exactly these statements, or false when the pod will not
   * take one and the caller should write the document instead.
   *
   * The statements are serialised by rdflib; only the wrapper naming what is
   * being patched is assembled here, because N3's braces have no rdflib form.
   */
  n3Patch(docUrl, inserts, deletes) {
    const block = (triples) => {
      const g = $rdf.graph();
      for (const [s, p, o] of triples) g.add(s, p, o);
      return $rdf.serialize(null, g, docUrl, 'application/n-triples').trim();
    };
    const clauses = [];
    if (deletes.length) clauses.push(`  solid:deletes { ${block(deletes)} }`);
    if (inserts.length) clauses.push(`  solid:inserts { ${block(inserts)} }`);
    return `@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n`
      + `<> solid:patches <${docUrl}>;\n${clauses.join(';\n')}.\n`;
  }

  async patchDocument(docUrl, inserts, deletes) {
    let res;
    try {
      res = await this.fetch(docUrl, {
        method: 'PATCH',
        headers: { 'content-type': 'text/n3' },
        body: this.n3Patch(docUrl, inserts, deletes),
      });
    } catch {
      return false;   // no PATCH on this transport at all
    }
    if (res.status < 300) return true;
    // The pod cannot patch. Anything else — a 409 saying what we meant to
    // remove is not there any more — is a real answer, and rewriting the whole
    // document over the top of it would destroy whatever changed it.
    if (res.status === 405 || res.status === 415 || res.status === 501) return false;
    throw new Error(`PATCH ${docUrl} → ${res.status}`);
  }
}
