// c2s.mjs — ActivityPub client-to-server (§6): the spec's own write API,
// beside the Mastodon facade. A client POSTs an activity — or a bare object,
// which is wrapped in a Create (§6.2.1) — to this actor's outbox; the agent
// assigns ids, applies the side-effects and delivers. Every verb lands on the
// SAME helper the facade and admin surfaces use — this module re-implements
// no persistence and no delivery, so one write path stays one.
//
// GETs on the actor and outbox are redirects to the pod's documents wherever
// those are reachable, which is the Server. Standalone they are not: the actor
// published there names no address a local client could write to, and on a
// fronted account the published outbox address is the Gateway's write door,
// which does not answer a read. So on that build both are served here, to the
// client already talking to this agent.
//
// `dispatch` takes an activity and answers with { status, body, headers }; it
// touches no request or response. The HTTP handler below is one caller. The
// other is the inbox drain, handing over an activity the Gateway took at the
// outbox door on the owner's behalf and stamped as theirs.
//
// The inbox is the exception, and has to be. Deliveries land in a container on
// the pod which the drain empties as it handles each item, so reading that
// container tells the owner only what has not been dealt with yet. What was
// actually received is whole only in the archive, so §5.2's "the owner can
// read their own inbox" is served from there, by this agent, to the owner
// alone.

import * as social from '../core/social.mjs';
import * as wire from '../core/wire.mjs';
import { readLenient } from '../core/as2.mjs';
import { safeSlug } from '../core/publisher/notes.mjs';

const MAX_BODY = 512 * 1024;          // same ceiling the inbox drain enforces

// How many archived items one page of the inbox will read. A page is one
// month, and a month with more than this is served short rather than costing
// the pod an unbounded read; the log says when that happened.
const MAX_INBOX_PAGE = 500;

// How many recorded activities one page of the locally-served outbox carries.
const MAX_OUTBOX_PAGE = 50;

// §6 names activities; anything else with a type is an object to wrap.
const ACTIVITY_TYPES = new Set([
  'Create', 'Update', 'Delete', 'Follow', 'Like', 'Announce', 'Undo',
  'Block', 'Add', 'Remove', 'Accept', 'Reject', 'Move',
]);

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const idOf = (v) => (typeof v === 'string' ? v : v?.id || null);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class C2S {
  constructor({ agent, log = console.log, auth, scheme = null, mount = '' }) {
    this.agent = agent;
    this.log = log;
    this.auth = auth;
    // What this agent calls itself, for the actor it serves a local client.
    // The same two values oidc-auth rebuilds the DPoP `htu` from, so the two
    // surfaces agree on the address a client just used.
    this.scheme = scheme;
    this.mount = mount;
  }

  get store() { return this.agent.store; }
  get urls() { return this.agent.publisher?.urls; }

  send(res, status, obj, headers = {}) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(obj));
    return true;
  }

  byIri(iri) {
    return iri ? this.store.getStatuses().find((s) => s.noteId === iri) : null;
  }

  /** The months the archive holds, newest first. One container listing. */
  async archiveMonths() {
    const archive = this.agent.intake?.archive;
    if (!archive) return [];
    const { names } = await archive.list('');
    return (names || [])
      .map((n) => n.replace(/\/$/u, ''))
      .filter((n) => /^\d{4}-\d{2}$/u.test(n))
      .sort()
      .reverse();
  }

  /**
   * The owner's own inbox, §5.2. Paged by month because that is how the
   * archive is stored, so a page costs one listing and a read per item and no
   * page is dearer for another month being large.
   */
  async sendInbox(res, url) {
    const id = `${this.urls.base}ap/inbox`;
    const page = url?.searchParams?.get('page') || null;
    let months;
    try {
      months = await this.archiveMonths();
    } catch (e) {
      return this.send(res, 502, { error: `the archive could not be read: ${e.message}` });
    }

    if (!page) {
      if (!months.length && this.store.getConfig()?.archiveInbox === false) {
        this.log('inbox read: nothing to show — this identity does not keep what it receives');
      }
      return this.send(res, 200, {
        '@context': wire.AS_CTX, id, type: 'OrderedCollection',
        ...(months.length ? { first: `${id}?page=${months[0]}` } : { orderedItems: [] }),
      });
    }
    if (!/^\d{4}-\d{2}$/u.test(page)) {
      return this.send(res, 400, { error: 'page names a month, written 2026-09' });
    }

    const archive = this.agent.intake?.archive;
    let names = [];
    try {
      // The trailing slash matters: without it this names a document, not the
      // container, and a pod answers about the wrong thing.
      ({ names } = await archive.list(`${page}/`));
    } catch (e) {
      return this.send(res, 502, { error: `the archive could not be read: ${e.message}` });
    }
    const files = (names || []).filter((n) => n.endsWith('.json')).sort();
    if (files.length > MAX_INBOX_PAGE) {
      this.log(`inbox read: ${page} holds ${files.length} items; serving the first ${MAX_INBOX_PAGE}`);
    }
    const kept = [];
    for (const file of files.slice(0, MAX_INBOX_PAGE)) {
      // Read as written: these records are JSON-LD, and the default read asks
      // turtle-first, which a server is free to answer with turtle.
      const read = await archive.read(`${page}/${file}`, { accept: '*/*' });
      if (!read?.ok || !read.body) continue;
      try {
        const record = JSON.parse(read.body);
        // The record wraps the bytes as they arrived; the activity is those
        // bytes, not a retelling of them.
        kept.push({ at: record.receivedAt || '', activity: JSON.parse(record.raw) });
      } catch { /* a record that will not parse is not one that can be served */ }
    }
    kept.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const older = months.filter((m) => m < page)[0] || null;
    return this.send(res, 200, {
      '@context': wire.AS_CTX,
      id: `${id}?page=${page}`,
      type: 'OrderedCollectionPage',
      partOf: id,
      ...(older ? { next: `${id}?page=${older}` } : {}),
      orderedItems: kept.map((k) => k.activity),
    });
  }

  // The actor a client-to-server client on this machine reads. The same
  // document the pod holds, but for the fields naming where a write goes —
  // the outbox and the two OAuth endpoints — and for `id`, which names this
  // address so the client files its credential here and comes back. The pod's
  // id stays on as an alias; the two are one identity.
  // What this agent calls itself, to the client that just asked. The Host
  // passed the Authorities firewall before any route ran, so whichever alias
  // the client used is one this agent answers on. The scheme is read off the
  // connection unless the caller named one: only the Server passes a scheme,
  // and standalone this listener is its own TLS.
  localOrigin(req) {
    const host = req.headers.host;
    if (!host) return null;
    const scheme = this.scheme
      || (req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http');
    return `${scheme}://${host}${this.mount}/`;
  }

  /**
   * The owner's own outbox, from what this agent recorded. The pod holds the
   * published copy and it stays the canonical one; this is served only where
   * that copy cannot be read by the client asking.
   */
  sendLocalOutbox(res, url, origin, { owner = false } = {}) {
    const id = `${origin}ap/outbox`;
    // newest first; the owner's view is every message, the public one what a
    // stranger may see
    const outbox = this.store.read(owner ? 'outbox-own.json' : 'outbox.json', []);
    const page = url?.searchParams?.get('page') || null;
    const ct = { 'content-type': 'application/activity+json; charset=utf-8' };
    if (!page) {
      return this.send(res, 200, {
        '@context': wire.AS_CTX, id, type: 'OrderedCollection', totalItems: outbox.length,
        ...(outbox.length ? { first: `${id}?page=1` } : { orderedItems: [] }),
      }, ct);
    }
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) {
      return this.send(res, 400, { error: 'page is a whole number from 1' });
    }
    const start = (n - 1) * MAX_OUTBOX_PAGE;
    const items = outbox.slice(start, start + MAX_OUTBOX_PAGE);
    return this.send(res, 200, {
      '@context': wire.AS_CTX,
      id: `${id}?page=${n}`,
      type: 'OrderedCollectionPage',
      partOf: id,
      ...(start + items.length < outbox.length ? { next: `${id}?page=${n + 1}` } : {}),
      // A post is recorded by its object id and published as the Create beside
      // it — the same mapping the pod's copy uses, from the same helper.
      orderedItems: items.map(wire.outboxWireItem),
    }, ct);
  }

  sendLocalActor(req, res, origin) {
    const pub = this.agent.publisher;
    const cfg = pub.config || {};
    const gw = cfg.gateway;
    const gwActive = gw && gw.url && gw.mode && gw.mode !== 'off';
    const doc = pub.actorDocFor({
      inbox: gwActive ? gw.url : (cfg.inboxUrl || null),
      clientOrigin: origin,
    });
    // A client files its credential under the id it reads here and comes back
    // to that address for everything after, so this document has to name
    // itself. The pod's id stays on as an alias rather than being dropped —
    // the two are one identity. Nothing published ever carries this id: every
    // activity the dispatcher builds names the pod's actor.
    const canonical = doc.id;
    doc.id = `${origin}ap/actor`;
    doc.alsoKnownAs = [...new Set([...(doc.alsoKnownAs || []), canonical])];
    const body = JSON.stringify(doc);
    res.writeHead(200, {
      'content-type': 'application/activity+json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  async handle(req, res, pathname, url) {   // eslint-disable-line no-unused-vars
    if (pathname !== '/ap/outbox' && pathname !== '/ap/actor' && pathname !== '/ap/inbox') return false;
    if (req.method === 'OPTIONS') {
      // Accept-Post is what a client such as dokieli reads to choose a format;
      // naming JSON only is what makes it send JSON-LD rather than HTML.
      res.writeHead(204, pathname === '/ap/inbox' ? { allow: 'GET, OPTIONS' }
        : { allow: 'GET, POST, OPTIONS', 'accept-post': 'application/ld+json, application/activity+json' });
      res.end(); return true;
    }
    if (!this.agent.configured() || !this.urls) {
      return this.send(res, 409, { error: 'agent not configured' });
    }
    if (pathname === '/ap/inbox') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return this.send(res, 405, { error: "deliveries go to this actor's inbox on the pod, which the "
          + 'actor document names; this address is the owner reading their own' });
      }
      const reader = await this.auth(req, pathname);
      if (!reader.ok) return this.send(res, reader.status, { error: reader.error }, reader.headers || {});
      return this.sendInbox(res, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // The owner, signed in, reads every message the actor produced (§5.1:
      // the outbox is filtered by who asks). Anyone else reads the public one.
      const owner = pathname === '/ap/outbox' && req.headers.authorization
        ? (await this.auth(req, pathname)).ok : false;
      // Where the client surface answers on an address a stranger can reach,
      // the pod's copies already name it and are the documents. Standalone
      // they are not reachable by the client asking, so it is answered here.
      const local = this.agent.publisher?.clientOrigin ? null : this.localOrigin(req);
      if (local && pathname === '/ap/actor') return this.sendLocalActor(req, res, local);
      if (local && pathname === '/ap/outbox') return this.sendLocalOutbox(res, url, local, { owner });
      // The pod's copy is the document; send the reader there.
      const onPod = (u) => (this.urls.toPod ? this.urls.toPod(u) : u);
      const target = pathname === '/ap/actor' ? this.urls.actor
        : owner ? onPod(this.urls.ownOutbox) : this.urls.outbox;
      res.writeHead(303, { location: target, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (pathname !== '/ap/outbox' || req.method !== 'POST') {
      return this.send(res, 405, { error: 'POST the outbox; GET redirects to the pod' });
    }

    const who = await this.auth(req, pathname);
    if (!who.ok) return this.send(res, who.status, { error: who.error }, who.headers || {});

    // A viewer (another agent holds the lease) may not act — but the user
    // acting HERE outranks an idle active agent elsewhere, exactly as on the
    // facade: a write attempt claims the lease, and only a failed claim 503s.
    if (this.agent.viewer) {
      const took = await this.agent.requestTakeover?.();
      if (!took) return this.send(res, 503, { error: 'another agent is active for this pod — takeover failed, try again' });
    }

    // Read as JSON-LD, so a client may send its activity with whatever context
    // it likes and still be understood. What is read is the GRAPH: `dispatch`
    // takes decisions from it and the publisher builds the document that is
    // actually posted, so nothing a client sent is republished verbatim and a
    // term it aliased still means what it says.
    // `raw` is the document as the client wrote it. The graph is what
    // decisions are taken from; the bytes are what an object that is stored
    // as sent (publishObject) is stored from — a read against our contexts
    // rewrites a stranger's terms to full IRIs, which is right for reading and
    // wrong for keeping.
    let activity; let raw = null;
    try {
      const body = await readBody(req);
      try { raw = JSON.parse(body); } catch { raw = null; }
      const read = await readLenient(body);
      activity = read.view ?? read.doc;
    } catch (e) {
      return this.send(res, 400, { error: `unreadable body: ${e.message}` });
    }
    if (!activity || typeof activity !== 'object' || Array.isArray(activity) || !activity.type) {
      return this.send(res, 400, { error: 'a typed ActivityStreams object is required' });
    }
    // The name the client asks for its new document (LDP's Slug), taken when
    // it is plain and free — it is what lets the client know the address of
    // what it made before anything answers.
    const slug = safeSlug(req.headers.slug) || null;
    const r = await this.dispatch(activity, { slug, raw });
    return this.send(res, r.status, r.body, r.headers);
  }

  // Addressing → the facade's four visibilities, inverting the table the
  // composer writes (wire.addressing). Nothing stated is a public post — what
  // every client means by a post with no audience chosen, and what a client
  // that never addresses (dokieli's annotations) needs.
  visibilityOf(activity, object) {
    const to = arr(activity.to ?? object?.to).map(idOf);
    const cc = arr(activity.cc ?? object?.cc).map(idOf);
    if (!to.length && !cc.length) return 'public';
    if (to.includes(wire.PUBLIC)) return 'public';
    if (cc.includes(wire.PUBLIC)) return 'unlisted';
    if (to.includes(this.urls.followers)) return 'private';
    return 'direct';
  }

  // `serial` and `at` name what this activity will make: the outbox door
  // chose them and told the client, so they are used as given. A client
  // posting here directly gets fresh ones.
  async dispatch(activity, { slug = null, raw = null, serial = Date.now(), at = new Date().toISOString() } = {}) {
    const reply = (status, body, headers = {}) => ({ status, body, headers });
    if (!activity || typeof activity !== 'object' || Array.isArray(activity) || !activity.type) {
      return reply(400, { error: 'a typed ActivityStreams object is required' });
    }
    // A bare object arrives without an activity around it; the server supplies
    // the Create (§6.2.1), carrying the object's own addressing up onto it.
    if (!ACTIVITY_TYPES.has(activity.type)) {
      activity = { type: 'Create', object: activity, to: activity.to, cc: activity.cc };
    }
    try {
      return await this._dispatch(activity, { slug, raw, reply, serial, at });
    } catch (e) {
      this.log(`c2s ${activity?.type}: ${e.message}`);
      return reply(422, { error: e.message || String(e) });
    }
  }

  // The actors a client addressed by id, beyond the audience words: the ones
  // in to/cc are listed and delivered to; the ones in bto/bcc are delivered
  // to and never listed (§6).
  addressedActors(activity, object) {
    const pick = (...fields) => [...new Set(fields.flatMap((f) => arr(activity[f] ?? object?.[f]).map(idOf)))]
      .filter((a) => typeof a === 'string' && /^https?:\/\//u.test(a)
        && a !== wire.PUBLIC && a !== this.urls.followers && a !== this.urls.actor);
    return { also: pick('to', 'cc'), deliverTo: pick('bto', 'bcc') };
  }

  async _dispatch(activity, { slug, raw, reply, serial, at }) {
    const agent = this.agent;
    // §6: every post to the outbox answers 201 with the new activity's id.
    const made = (id, body = {}) => reply(201, { id, ...body }, { location: id });
    // What is never sent anywhere — a person's block, a pin — is still a
    // message this actor produced, so the owner's outbox records it here.
    const kept = (type, extra) => {
      const act = { id: `${this.urls.actor}#${type.toLowerCase()}-${serial}`, type, actor: this.urls.actor, published: at, ...extra };
      agent.publisher.recordOwn?.(act);
      return act.id;
    };
    const object = typeof activity.object === 'object' && activity.object !== null
      ? activity.object : null;
    const objectId = idOf(activity.object);

    switch (activity.type) {
      case 'Create': {
        const makes = object?.type || 'Note';
        if (!object) return reply(422, { error: 'a Create carries the object it creates' });
        const visibility = this.visibilityOf(activity, object);
        const { also, deliverTo } = this.addressedActors(activity, object);
        // Not a Note and not a poll: stored as sent, under this actor, and
        // the Create around it delivered — a Web Annotation, for one.
        if (makes !== 'Note' && makes !== 'Question') {
          const asSent = raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (ACTIVITY_TYPES.has(raw.type) ? (raw.object && typeof raw.object === 'object' ? raw.object : null) : raw)
            : null;
          const made = await agent.publisher.publishObject(asSent || object, { visibility, slug, also, deliverTo });
          return reply(201, { id: made.createId, object: made.id }, { location: made.createId });
        }
        // `source.content` is the client's plain text when it sends one; bare
        // `content` is TREATED as plain text and escaped — markup survives as
        // visible characters rather than as markup. Documented v1 limit.
        const text = String(object.source?.content ?? object.content ?? '');
        if (!text.trim()) return reply(422, { error: 'the note has no content' });

        // A Question is a poll: the choices are in oneOf (pick one) or anyOf
        // (pick several), each naming itself, and endTime is when it shuts.
        if (makes === 'Question') {
          const one = arr(object.oneOf);
          const many = arr(object.anyOf);
          const titles = (one.length ? one : many).map((c) => String(c?.name ?? '').trim()).filter(Boolean);
          try {
            const question = await agent.publisher.publishQuestion(text, {
              options: titles,
              multiple: !one.length && many.length > 0,
              expiresAt: object.endTime || null,
              inReplyTo: idOf(object.inReplyTo) || undefined,
              visibility,
              spoilerText: object.summary || null,
              sensitive: object.sensitive === true,
              slug,
            });
            return reply(201,
              { id: wire.createActivityId(question.id), object: question.id },
              { location: wire.createActivityId(question.id) });
          } catch (e) {
            return reply(422, { error: e.message });
          }
        }

        const attachments = arr(object.attachment).map((a) => ({
          url: a?.url, mediaType: a?.mediaType,
          ...(a?.name ? { description: a.name } : {}),
        })).filter((a) => a.url);
        const note = await agent.publisher.publishNote(text, {
          inReplyTo: idOf(object.inReplyTo) || undefined,
          attachments,
          visibility,
          spoilerText: object.summary || null,
          sensitive: object.sensitive === true,
          slug, also, deliverTo,
        });
        return reply(201, { id: wire.createActivityId(note.id), object: note.id },
          { location: wire.createActivityId(note.id) });
      }

      case 'Update': {
        if (objectId === this.urls.actor) {
          return reply(422, { error: 'edit the profile on the admin surface; actor updates are not taken here' });
        }
        const s = this.byIri(objectId);
        if (!s) return reply(404, { error: 'no such note here' });
        if (s.actor !== this.urls.actor || s.kind !== 'post') {
          return reply(403, { error: 'not your note' });
        }
        const text = String(object?.source?.content ?? object?.content ?? '');
        if (!text.trim()) return reply(422, { error: 'the edit has no content' });
        const attachments = object?.attachment !== undefined
          ? arr(object.attachment).map((a) => ({
            url: a?.url, mediaType: a?.mediaType,
            ...(a?.name ? { description: a.name } : {}),
          })).filter((a) => a.url)
          : null;
        await agent.publisher.updateNote(s, {
          content: text, spoilerText: object?.summary || null,
          sensitive: object?.sensitive === undefined ? null : object.sensitive === true, attachments,
          updated: at,
        });
        return made(wire.updateActivityId(s.noteId, at), { object: s.noteId });
      }

      case 'Delete': {
        if (objectId === this.urls.actor) {
          return reply(422, { error: 'retiring the actor is done on the admin surface, where it asks twice' });
        }
        const s = this.byIri(objectId);
        if (!s) return reply(404, { error: 'no such note here' });
        if (s.actor !== this.urls.actor || s.kind !== 'post') {
          return reply(403, { error: 'not your note' });
        }
        const r = await social.deleteNote(agent, s);
        if (!r.ok) return reply(502, { error: r.error, stillPublished: r.stillPublished });
        return made(wire.deleteActivityId(s.noteId), { object: s.noteId });
      }

      case 'Follow': {
        if (!objectId) return reply(400, { error: 'whom? object must name an actor' });
        // An acct: form or bare handle resolves through WebFinger; an https
        // IRI is fetched directly.
        if (/^acct:|^@|^[^/@]+@[^/@]+$/.test(objectId) && !/^https?:/.test(objectId)) {
          const r = await social.followHandle(agent, objectId.replace(/^acct:/, ''), { serial });
          const rec = this.store.getContacts().following.find((f) => f.actor === r.actor);
          return made(rec?.followActivity?.id, { object: r.actor });
        }
        const doc = await social.followActor(agent, objectId, { serial });
        const rec = this.store.getContacts().following.find((f) => f.actor === doc.id);
        return made(rec?.followActivity?.id, { object: doc.id });
      }

      case 'Like': {
        const s = this.byIri(objectId);
        if (!s) return reply(422, { error: 'that note is not held here — like what the timeline holds' });
        const updated = await social.favourite(agent, s, { serial });
        return made(updated.likeActivity?.id, { object: s.noteId });
      }

      case 'Announce': {
        const s = this.byIri(objectId);
        if (!s) return reply(422, { error: 'that note is not held here — boost what the timeline holds' });
        const updated = await social.reblog(agent, s, { serial });
        return made(updated.announceActivity?.id, { object: s.noteId });
      }

      case 'Undo': {
        // What is being unsaid — by the inner activity's id when the client
        // sends one, by its type+object when it re-states it instead.
        const inner = object;
        const innerId = idOf(activity.object);
        const undone = `${this.urls.actor}#undo-${serial}`;
        if (inner?.type === 'Block') {
          const target = idOf(inner.object);
          if (!target) return reply(400, { error: 'unblock whom?' });
          await social.unblockActor(agent, target, { serial });
          // A group's unban was sent, and recorded as it went; a person's is not.
          if (this.store.getConfig()?.kind !== 'group') {
            kept('Undo', { object: { type: 'Block', actor: this.urls.actor, object: target } });
          }
          return made(undone, { object: target });
        }
        const statuses = this.store.getStatuses();
        let s = innerId ? statuses.find((x) => x.likeActivity?.id === innerId) : null;
        if (!s && inner?.type === 'Like') s = this.byIri(idOf(inner.object));
        if (s?.favourited) {
          const updated = await social.unfavourite(agent, s, { serial });
          return made(undone, { object: updated.noteId });
        }
        s = innerId ? statuses.find((x) => x.announceActivity?.id === innerId) : null;
        if (!s && inner?.type === 'Announce') s = this.byIri(idOf(inner.object));
        if (s?.reblogged) {
          const updated = await social.unreblog(agent, s, { serial });
          return made(undone, { object: updated.noteId });
        }
        const following = this.store.getContacts().following;
        const rec = following.find((f) => f.followActivity?.id === innerId)
          || (inner?.type === 'Follow' ? following.find((f) => f.actor === idOf(inner.object)) : null);
        if (rec) {
          await social.unfollowActor(agent, rec.actor, { serial });
          return made(undone, { object: rec.actor });
        }
        return reply(422, { error: 'nothing here matches what that Undo names' });
      }

      case 'Block': {
        if (!objectId) return reply(400, { error: 'block whom? object must name an actor' });
        await social.blockActor(agent, objectId, { serial });
        // A group's ban was sent to its members; a person's never goes anywhere.
        const id = this.store.getConfig()?.kind === 'group'
          ? `${this.urls.actor}#block-${serial}` : kept('Block', { object: objectId });
        return made(id, { object: objectId });
      }

      case 'Add':
      case 'Remove': {
        // The one collection a client may edit is the pins (§7.6/§7.9 in the
        // other direction): target must be the featured collection.
        if (idOf(activity.target) !== this.urls.featured) {
          return reply(422, { error: 'the featured collection is the one Add/Remove edits here' });
        }
        const s = this.byIri(objectId);
        if (!s) return reply(404, { error: 'no such note here' });
        const updated = await social.pinStatus(agent, s, activity.type === 'Add');
        return made(kept(activity.type, { object: updated.noteId, target: this.urls.featured }),
          { object: updated.noteId, pinned: !!updated.pinned });
      }

      case 'Accept':
      case 'Reject': {
        // Answering a held follow request: the object is the Follow (or the
        // requester). Which request is meant comes from the Follow's actor.
        const requester = object?.actor ? idOf(object.actor) : objectId;
        if (!requester) return reply(400, { error: 'whose request? object must name the Follow or its actor' });
        const r = activity.type === 'Accept'
          ? await social.admitRequest(agent, requester, { serial }).catch((e) => ({ error: e.message }))
          : await social.refuseRequest(agent, requester, { serial }).catch((e) => ({ error: e.message }));
        if (r.error) return reply(404, { error: r.error });
        return made(`${this.urls.actor}#${activity.type.toLowerCase()}-${serial}`, { object: requester });
      }

      case 'Move':
        return reply(422, { error: 'moving the account is done on the admin surface, where it asks twice' });

      default:
        return reply(422, { error: `no handler for ${activity.type}` });
    }
  }
}
