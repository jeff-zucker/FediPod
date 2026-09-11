// c2s.mjs — ActivityPub client-to-server (§6): the spec's own write API,
// beside the Mastodon facade. A client POSTs an activity — or a bare object,
// which is wrapped in a Create (§6.2.1) — to this actor's outbox; the agent
// assigns ids, applies the side-effects and delivers. Every verb lands on the
// SAME helper the facade and admin surfaces use — this module re-implements
// no persistence and no delivery, so one write path stays one.
//
// GETs on the actor and outbox are redirects: the pod's documents are the
// canonical ones, and a second renderer here would only drift from them.
//
// The inbox is the exception, and has to be. Deliveries land in a container on
// the pod which the drain empties as it handles each item, so reading that
// container tells the owner only what has not been dealt with yet. What was
// actually received is whole only in the archive, so §5.2's "the owner can
// read their own inbox" is served from there, by this agent, to the owner
// alone.

import * as social from '../core/social.mjs';
import * as wire from '../core/wire.mjs';

const MAX_BODY = 512 * 1024;          // same ceiling the inbox drain enforces

// How many archived items one page of the inbox will read. A page is one
// month, and a month with more than this is served short rather than costing
// the pod an unbounded read; the log says when that happened.
const MAX_INBOX_PAGE = 500;

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
  constructor({ agent, log = console.log, auth }) {
    this.agent = agent;
    this.log = log;
    this.auth = auth;
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

  async handle(req, res, pathname, url) {   // eslint-disable-line no-unused-vars
    if (pathname !== '/ap/outbox' && pathname !== '/ap/actor' && pathname !== '/ap/inbox') return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { allow: pathname === '/ap/inbox' ? 'GET, OPTIONS' : 'GET, POST, OPTIONS' });
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
      if (!reader.ok) return this.send(res, reader.status, { error: reader.error });
      return this.sendInbox(res, url);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      // The pod's copy is the document; send the reader there.
      const target = pathname === '/ap/actor' ? this.urls.actor : this.urls.outbox;
      res.writeHead(303, { location: target, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    if (pathname !== '/ap/outbox' || req.method !== 'POST') {
      return this.send(res, 405, { error: 'POST the outbox; GET redirects to the pod' });
    }

    const who = await this.auth(req, pathname);
    if (!who.ok) return this.send(res, who.status, { error: who.error });

    // A viewer (another agent holds the lease) may not act — but the user
    // acting HERE outranks an idle active agent elsewhere, exactly as on the
    // facade: a write attempt claims the lease, and only a failed claim 503s.
    if (this.agent.viewer) {
      const took = await this.agent.requestTakeover?.();
      if (!took) return this.send(res, 503, { error: 'another agent is active for this pod — takeover failed, try again' });
    }

    let activity;
    try {
      activity = JSON.parse(await readBody(req));
    } catch (e) {
      return this.send(res, 400, { error: `unreadable body: ${e.message}` });
    }
    if (!activity || typeof activity !== 'object' || Array.isArray(activity) || !activity.type) {
      return this.send(res, 400, { error: 'a typed ActivityStreams object is required' });
    }
    // A bare object arrives without an activity around it; the server supplies
    // the Create (§6.2.1), carrying the object's own addressing up onto it.
    if (!ACTIVITY_TYPES.has(activity.type)) {
      activity = { type: 'Create', object: activity, to: activity.to, cc: activity.cc };
    }

    try {
      return await this.dispatch(res, activity);
    } catch (e) {
      this.log(`c2s ${activity.type}: ${e.message}`);
      return this.send(res, 422, { error: e.message || String(e) });
    }
  }

  // Addressing → the facade's four visibilities, inverting the table the
  // composer writes (wire.noteDoc). Addressing is required: a post whose
  // audience the client never stated is not guessed at in either direction.
  visibilityOf(activity, object) {
    const to = arr(activity.to ?? object?.to).map(idOf);
    const cc = arr(activity.cc ?? object?.cc).map(idOf);
    if (!to.length && !cc.length) return null;
    if (to.includes(wire.PUBLIC)) return 'public';
    if (cc.includes(wire.PUBLIC)) return 'unlisted';
    if (to.includes(this.urls.followers)) return 'private';
    return 'direct';
  }

  async dispatch(res, activity) {
    const agent = this.agent;
    const object = typeof activity.object === 'object' && activity.object !== null
      ? activity.object : null;
    const objectId = idOf(activity.object);

    switch (activity.type) {
      case 'Create': {
        const makes = object?.type || 'Note';
        if (!object || (makes !== 'Note' && makes !== 'Question')) {
          return this.send(res, 422, { error: 'only a Note or a Question (or a bare Note) can be created here' });
        }
        const visibility = this.visibilityOf(activity, object);
        if (!visibility) {
          return this.send(res, 400, { error: 'state the audience: to/cc must address someone (as:Public, your followers collection, or actors)' });
        }
        // `source.content` is the client's plain text when it sends one; bare
        // `content` is TREATED as plain text and escaped — markup survives as
        // visible characters rather than as markup. Documented v1 limit.
        const text = String(object.source?.content ?? object.content ?? '');
        if (!text.trim()) return this.send(res, 422, { error: 'the note has no content' });

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
            });
            return this.send(res, 201,
              { id: wire.createActivityId(question.id), object: question.id },
              { location: wire.createActivityId(question.id) });
          } catch (e) {
            return this.send(res, 422, { error: e.message });
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
        });
        return this.send(res, 201, { id: wire.createActivityId(note.id), object: note.id },
          { location: wire.createActivityId(note.id) });
      }

      case 'Update': {
        if (objectId === this.urls.actor) {
          return this.send(res, 422, { error: 'edit the profile on the admin surface; actor updates are not taken here' });
        }
        const s = this.byIri(objectId);
        if (!s) return this.send(res, 404, { error: 'no such note here' });
        if (s.actor !== this.urls.actor || s.kind !== 'post') {
          return this.send(res, 403, { error: 'not your note' });
        }
        const text = String(object?.source?.content ?? object?.content ?? '');
        if (!text.trim()) return this.send(res, 422, { error: 'the edit has no content' });
        const attachments = object?.attachment !== undefined
          ? arr(object.attachment).map((a) => ({
            url: a?.url, mediaType: a?.mediaType,
            ...(a?.name ? { description: a.name } : {}),
          })).filter((a) => a.url)
          : null;
        await agent.publisher.updateNote(s, {
          content: text, spoilerText: object?.summary || null, attachments,
        });
        return this.send(res, 200, { ok: true, object: s.noteId });
      }

      case 'Delete': {
        if (objectId === this.urls.actor) {
          return this.send(res, 422, { error: 'retiring the actor is done on the admin surface, where it asks twice' });
        }
        const s = this.byIri(objectId);
        if (!s) return this.send(res, 404, { error: 'no such note here' });
        if (s.actor !== this.urls.actor || s.kind !== 'post') {
          return this.send(res, 403, { error: 'not your note' });
        }
        const r = await social.deleteNote(agent, s);
        if (!r.ok) return this.send(res, 502, { error: r.error, stillPublished: r.stillPublished });
        return this.send(res, 200, { ok: true });
      }

      case 'Follow': {
        if (!objectId) return this.send(res, 400, { error: 'whom? object must name an actor' });
        // An acct: form or bare handle resolves through WebFinger; an https
        // IRI is fetched directly.
        if (/^acct:|^@|^[^/@]+@[^/@]+$/.test(objectId) && !/^https?:/.test(objectId)) {
          const r = await social.followHandle(agent, objectId.replace(/^acct:/, ''));
          const rec = this.store.getContacts().following.find((f) => f.actor === r.actor);
          return this.send(res, 201, { id: rec?.followActivity?.id, object: r.actor },
            rec?.followActivity?.id ? { location: rec.followActivity.id } : {});
        }
        const doc = await social.followActor(agent, objectId);
        const rec = this.store.getContacts().following.find((f) => f.actor === doc.id);
        return this.send(res, 201, { id: rec?.followActivity?.id, object: doc.id },
          rec?.followActivity?.id ? { location: rec.followActivity.id } : {});
      }

      case 'Like': {
        const s = this.byIri(objectId);
        if (!s) return this.send(res, 422, { error: 'that note is not held here — like what the timeline holds' });
        const updated = await social.favourite(agent, s);
        return this.send(res, 201, { id: updated.likeActivity?.id, object: s.noteId },
          updated.likeActivity?.id ? { location: updated.likeActivity.id } : {});
      }

      case 'Announce': {
        const s = this.byIri(objectId);
        if (!s) return this.send(res, 422, { error: 'that note is not held here — boost what the timeline holds' });
        const updated = await social.reblog(agent, s);
        return this.send(res, 201, { id: updated.announceActivity?.id, object: s.noteId },
          updated.announceActivity?.id ? { location: updated.announceActivity.id } : {});
      }

      case 'Undo': {
        // What is being unsaid — by the inner activity's id when the client
        // sends one, by its type+object when it re-states it instead.
        const inner = object;
        const innerId = idOf(activity.object);
        if (inner?.type === 'Block') {
          const target = idOf(inner.object);
          if (!target) return this.send(res, 400, { error: 'unblock whom?' });
          await social.unblockActor(agent, target);
          return this.send(res, 200, { ok: true, object: target });
        }
        const statuses = this.store.getStatuses();
        let s = innerId ? statuses.find((x) => x.likeActivity?.id === innerId) : null;
        if (!s && inner?.type === 'Like') s = this.byIri(idOf(inner.object));
        if (s?.favourited) {
          const updated = await social.unfavourite(agent, s);
          return this.send(res, 200, { ok: true, object: updated.noteId });
        }
        s = innerId ? statuses.find((x) => x.announceActivity?.id === innerId) : null;
        if (!s && inner?.type === 'Announce') s = this.byIri(idOf(inner.object));
        if (s?.reblogged) {
          const updated = await social.unreblog(agent, s);
          return this.send(res, 200, { ok: true, object: updated.noteId });
        }
        const following = this.store.getContacts().following;
        const rec = following.find((f) => f.followActivity?.id === innerId)
          || (inner?.type === 'Follow' ? following.find((f) => f.actor === idOf(inner.object)) : null);
        if (rec) {
          await social.unfollowActor(agent, rec.actor);
          return this.send(res, 200, { ok: true, object: rec.actor });
        }
        return this.send(res, 422, { error: 'nothing here matches what that Undo names' });
      }

      case 'Block': {
        if (!objectId) return this.send(res, 400, { error: 'block whom? object must name an actor' });
        await social.blockActor(agent, objectId);
        return this.send(res, 200, { ok: true, object: objectId });
      }

      case 'Add':
      case 'Remove': {
        // The one collection a client may edit is the pins (§7.6/§7.9 in the
        // other direction): target must be the featured collection.
        if (idOf(activity.target) !== this.urls.featured) {
          return this.send(res, 422, { error: 'the featured collection is the one Add/Remove edits here' });
        }
        const s = this.byIri(objectId);
        if (!s) return this.send(res, 404, { error: 'no such note here' });
        const updated = await social.pinStatus(agent, s, activity.type === 'Add');
        return this.send(res, 200, { ok: true, object: updated.noteId, pinned: !!updated.pinned });
      }

      case 'Accept':
      case 'Reject': {
        // Answering a held follow request: the object is the Follow (or the
        // requester). Which request is meant comes from the Follow's actor.
        const requester = object?.actor ? idOf(object.actor) : objectId;
        if (!requester) return this.send(res, 400, { error: 'whose request? object must name the Follow or its actor' });
        const r = activity.type === 'Accept'
          ? await social.admitRequest(agent, requester).catch((e) => ({ error: e.message }))
          : await social.refuseRequest(agent, requester).catch((e) => ({ error: e.message }));
        if (r.error) return this.send(res, 404, { error: r.error });
        return this.send(res, 200, { ok: true, object: requester });
      }

      case 'Move':
        return this.send(res, 422, { error: 'moving the account is done on the admin surface, where it asks twice' });

      default:
        return this.send(res, 422, { error: `no handler for ${activity.type}` });
    }
  }
}
