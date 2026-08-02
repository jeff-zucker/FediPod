// publisher.mjs — builds/maintains the actor's public face on the remote pod
// (webfinger, actor doc, collections, notes) and mirrors truth into the local
// pod. The remote /ap/ tree is disposable: publishProfile() rebuilds it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wire from './wire.mjs';
import { USER_AGENT } from './ua.mjs';

const ACCEPT_AP = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
// The default for publishCollections: the whole public surface, ACLs included.
// A caller that knows what it changed narrows it; a caller that says nothing
// still gets everything, so a missed call site degrades to the old cost rather
// than silently publishing nothing.
const ALL_COLLECTIONS = { followers: true, following: true, outbox: true, acls: true };
const AGENT_VERSION = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;

export class Publisher {
  constructor({ config, remote, local, store, deliverer, publicKeyPem, log = console.log,
    probeFetch = (u, i) => fetch(u, i), resolveMention = null,
  }) {
    this.config = config;
    this.remote = remote;
    this.local = local;
    this.store = store;
    this.deliverer = deliverer;
    this.publicKeyPem = publicKeyPem;
    this.urls = wire.apUrls(config.remotePod, config.root);
    this.probeFetch = probeFetch;
    this.resolveMention = resolveMention;
    this.log = log;
  }

  // Idempotent: (re)write webfinger + actor + collections + container ACLs.
  async publishProfile() {
    const { urls } = this;
    const host = new URL(urls.base).host;

    await this.remote.putJson(urls.webfinger,
      wire.jrd({ handle: this.config.handle, host, actor: urls.actor }), 'application/jrd+json');
    await this.remote.setAcl(urls.webfinger, ['Read']);

    const hostMetaUrl = urls.base + '.well-known/host-meta';
    await this.remote.put(hostMetaUrl, wire.hostMeta(urls.base), 'application/xrd+xml');
    await this.remote.setAcl(hostMetaUrl, ['Read']);

    // NodeInfo: pointer at the protocol-required root, document in our tree.
    const nodeinfoDocUrl = urls.home + 'ap/nodeinfo-2.0';
    const localPosts = this.store.getStatuses().filter(s => s.kind === 'post').length;
    await this.remote.putJson(urls.base + '.well-known/nodeinfo',
      wire.nodeinfoPointer(nodeinfoDocUrl), 'application/json');
    await this.remote.setAcl(urls.base + '.well-known/nodeinfo', ['Read']);
    await this.remote.putJson(nodeinfoDocUrl,
      wire.nodeinfoDoc({ version: AGENT_VERSION, localPosts }), 'application/json');
    await this.remote.setAcl(nodeinfoDocUrl, ['Read']);

    const actor = wire.actorDoc({
      urls, handle: this.config.handle, name: this.config.name, publicKeyPem: this.publicKeyPem,
      movedTo: this.config.movedTo || null, kind: this.config.kind,
      approveJoins: !!this.config.approveJoins,
      summary: this.config.summary || null, icon: this.config.icon || null,
      image: this.config.image || null, fields: this.config.fields || [],
    });
    await this.remote.putJson(urls.actor, actor);
    await this.remote.setAcl(urls.actor, ['Read']);

    // inbox: public may only Append; owner (the agent) reads + drains. A
    // quiesced actor keeps its name resolving but takes no more mail, so a
    // republish must not re-open the door.
    await this.remote.putJson(urls.inbox + '.keep', { keep: true }, 'application/json');
    if (this.config.quiescedAt) {
      await this.remote.setAcl(urls.inbox, []);
      this.log('inbox left closed — this actor is quiesced');
    } else {
      await this.remote.setAcl(urls.inbox, ['Append']);
    }

    // notes live under a public-Read container (acl:default covers new notes).
    await this.remote.putJson(urls.notes + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(urls.notes, ['Read']);

    await this.publishCollections();
    const updated = await this.announceProfileChange(actor);
    await this.local.writeSettings({ handle: this.config.handle, actorUrl: urls.actor });
    await this.ensurePrivateAcls();
    const unreachable = await this.verifyPublicSurface();
    this.log(wire.webfingerHost(urls.base)
      ? `profile published: @${this.config.handle}@${host} → ${urls.actor}`
      : `profile published → ${urls.actor} — NOT discoverable as @${this.config.handle}@${host}: `
        + 'this pod is a path on a shared host, and WebFinger is only answered at a host root');
    return { unreachable, updated };
  }

  // Fires when the document differs from the one last published — including
  // the first time, when there is nothing to differ from.
  //
  // Every call to publishProfile is already a DELIBERATE republish: setup, a
  // rename, an edit through the client or /config, `describe`, a key rotation,
  // or an actor document found missing from the pod. Starting the agent does not
  // call it. So the digest is not there to survive restarts — it is there for
  // the republish that changes nothing, which /config does whenever you save a
  // field the actor document does not carry.
  //
  // A silent first publish was considered and is WRONG here: it would spend a
  // real edit doing nothing but recording a digest, and that edit is exactly the
  // one whose invisibility this fixes.
  async announceProfileChange(actor) {
    const digest = crypto.createHash('sha256').update(JSON.stringify(actor)).digest('hex').slice(0, 32);
    const seen = this.store.read('published.json', {});
    if (seen.actorDigest === digest) return 0;
    this.store.write('published.json', { ...seen, actorDigest: digest, at: new Date().toISOString() });
    const inboxes = [...new Set(this.store.getContacts().followers
      .map(f => f.sharedInbox || f.inbox).filter(Boolean))];
    if (!inboxes.length) return 0;
    await this.deliverer.deliverToAll(inboxes,
      wire.updateActorActivity({ urls: this.urls, actor, serial: Date.now() }));
    this.log(`profile changed — Update delivered to ${inboxes.length} inbox(es)`);
    return inboxes.length;
  }

  // The mirror of ensurePrivateAcls, and the check this project lacked: these
  // documents MUST be readable by strangers or no server can see the actor.
  // A publish that dies half-way, or an ACL write that is accepted without
  // taking effect, is otherwise indistinguishable from success — the agent
  // reports itself configured and federating while nobody can find it.
  async verifyPublicSurface() {
    const { urls } = this;
    const targets = [
      ['webfinger', urls.webfinger],
      ['host-meta', urls.base + '.well-known/host-meta'],
      ['actor', urls.actor],
      ['notes', urls.notes],
      ['followers', urls.followers],
      ['following', urls.following],
      ['outbox', urls.outbox],
    ];
    const unreachable = [];
    for (const [name, url] of targets) {
      if (!await this.publiclyReadable(url)) unreachable.push(name);
    }
    if (unreachable.length) {
      this.log(`FEDERATION: ${unreachable.join(', ')} not readable without credentials — `
        + 'other servers cannot resolve or fetch this actor');
    }
    return unreachable;
  }

  // An ACL write that silently failed — or was changed afterwards by anything
  // else touching the pod — leaves the private trees, signing keys included,
  // world-readable. bootstrap writes them once at setup and never returns, so
  // this runs on every connect: probe UNauthenticated, rewrite whatever
  // answers, and say so loudly if the rewrite does not take.
  async ensurePrivateAcls() {
    for (const url of [this.urls.home, this.urls.state, this.urls.fediverse]) {
      if (!await this.publiclyReadable(url)) continue;
      this.log(`${url} was readable without credentials — rewriting its ACL`);
      try {
        await this.remote.setAcl(url, []);
      } catch (e) {
        this.log(`SECURITY: ${url} is public and its ACL could not be rewritten: ${e.message}`);
        continue;
      }
      if (await this.publiclyReadable(url)) {
        this.log(`SECURITY: ${url} is STILL readable without credentials — check the pod's ACLs`);
      }
    }
  }

  // Deliberately credential-free: this asks what a stranger would see.
  // accept: */* matters — asking for turtle makes the server answer 501 on the
  // JSON documents (webfinger, actor), which reads as "unreachable" when the
  // world can in fact see them perfectly well.
  async publiclyReadable(url) {
    try {
      const res = await this.probeFetch(url, {
        headers: { accept: '*/*', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 15_000),
      });
      return res.status < 400;
    } catch { return false; }     // unreachable is not a finding here
  }

  // Retire this identity for good: tell everyone who follows us to drop the
  // account, then leave a Tombstone where the actor was. The inbox stays
  // publicly Append-able on purpose — closing it would make deliveries 401,
  // which Mastodon treats as failure and retries, the opposite of the point.
  // A Delete stops well-behaved servers; anything that keeps delivering gets a
  // cheap 201 into a container we no longer read.
  async retireActor() {
    const { urls } = this;
    const contacts = this.store.getContacts();
    const inboxes = [...new Set(contacts.followers.map(f => f.sharedInbox || f.inbox).filter(Boolean))];
    const deletedAt = new Date().toISOString();
    await this.deliverer.deliverToAll(inboxes, wire.deleteActorActivity(urls, Date.parse(deletedAt)));
    await this.remote.putJson(urls.actor, wire.tombstoneDoc(urls, deletedAt, this.config.kind));
    await this.remote.setAcl(urls.actor, ['Read']);      // a Tombstone must stay fetchable
    this.store.setConfig({ ...this.store.getConfig(), retiredAt: deletedAt });
    await this.store.flush();
    this.log(`retired: Delete sent to ${inboxes.length} inbox(es), actor replaced with a Tombstone`);
    return { inboxes: inboxes.length, deletedAt };
  }

  // Stop accepting mail without giving up the name: deliveries get an immediate
  // 401 rather than a 201 into storage nobody will ever drain. WebFinger,
  // host-meta and the actor stay published, so the handle still resolves.
  async closeInbox() {
    await this.remote.setAcl(this.urls.inbox, []);
    const at = new Date().toISOString();
    this.store.setConfig({ ...this.store.getConfig(), quiescedAt: at });
    await this.store.flush();
    this.log(`inbox closed — @${this.config.handle} still resolves but accepts nothing`);
    return at;
  }

  // Undo closeInbox: mail flows again and the actor is no longer quiesced.
  async openInbox() {
    await this.remote.setAcl(this.urls.inbox, ['Append']);
    const { quiescedAt, ...rest } = this.store.getConfig() || {};
    this.store.setConfig(rest);
    this.config.quiescedAt = undefined;
    await this.store.flush();
    this.log(`inbox re-opened — @${this.config.handle} is taking mail again`);
  }

  // Tell the fediverse the account lives somewhere else now. Well-behaved
  // servers migrate their followers to the target and stop delivering here.
  async publishMove(target) {
    const { urls } = this;
    const contacts = this.store.getContacts();
    const inboxes = [...new Set(contacts.followers.map(f => f.sharedInbox || f.inbox).filter(Boolean))];
    const at = new Date().toISOString();
    await this.deliverer.deliverToAll(inboxes, wire.moveActivity(urls, target, Date.parse(at)));
    this.config.movedTo = target;                       // so the republish below carries it
    this.store.setConfig({ ...this.store.getConfig(), movedTo: target, movedAt: at });
    await this.remote.putJson(urls.actor, wire.actorDoc({
      urls, handle: this.config.handle, name: this.config.name,
      publicKeyPem: this.publicKeyPem, movedTo: target, kind: this.config.kind,
      approveJoins: !!this.config.approveJoins,
      summary: this.config.summary || null, icon: this.config.icon || null,
      image: this.config.image || null, fields: this.config.fields || [],
    }));
    await this.remote.setAcl(urls.actor, ['Read']);
    await this.store.flush();
    this.log(`moved to ${target}: Move sent to ${inboxes.length} inbox(es), actor now advertises movedTo`);
    return { inboxes: inboxes.length, target, movedAt: at };
  }

  // Anyone the pod says follows us that we have no record of, and never
  // deliberately removed. In the steady state there is nobody: the pod's list is
  // written from this one. They appear when the local half is BEHIND the pod —
  // a restored backup, a home copied off a dead machine — and republishing
  // blindly would delete them from the wire and, worse, stop delivering to them.
  //
  // Removals are what makes this safe to do unconditionally: `dropFollower`
  // records every unfollow, ejection and account deletion, so a returning name
  // is either genuinely still a follower or genuinely a mistake we made.
  async reconcileFollowers(contacts) {
    let published = [];
    try {
      const res = await this.remote.fetch(this.urls.followers, { headers: { accept: 'application/json' } });
      if (!res.ok) return 0;
      const doc = await res.json();
      published = doc?.orderedItems || doc?.items || [];
    } catch { return 0; }                       // no list to reconcile against

    const known = new Set(contacts.followers.map(f => f.actor));
    const removed = new Set((contacts.removedFollowers || []).map(r => r.actor));
    const missing = published.filter(a => typeof a === 'string' && !known.has(a) && !removed.has(a));
    if (!missing.length) return 0;

    // An inbox is what delivery needs, and only the actor document has it — so
    // recovering a follower costs one fetch each. Capped: a list this wrong is
    // a restore, and the rest catch up on the next publish.
    let recovered = 0;
    for (const actor of missing.slice(0, 200)) {
      try {
        const res = await this.deliverer.signedFetch(actor, { headers: { accept: ACCEPT_AP } });
        if (!res.ok) continue;
        const doc = await res.json();
        if (!doc?.inbox) continue;
        contacts.followers.push({
          actor, inbox: doc.inbox, sharedInbox: doc.endpoints?.sharedInbox || null, recovered: true,
        });
        recovered++;
      } catch { /* unreachable now; it will be there next time */ }
    }
    if (recovered) {
      this.store.setContacts(contacts);
      this.log(`reconciled ${recovered} follower(s) the pod knew about and this machine did not `
        + '— a restored or copied state was behind');
    }
    return recovered;
  }

  // The same argument as reconcileFollowers, for the other published list. It
  // matters more: the outbox is the INDEX a statuses rebuild reads, so a
  // republish from a restored-and-behind machine would destroy the record of
  // everything this actor ever posted — and destroy it before anyone noticed
  // there was anything to recover.
  //
  // Safe for the same reason: `unrecordOutbox` leaves a tombstone, so an entry
  // the pod still carries is one this machine has not heard of, never one it
  // deliberately took back.
  async reconcileOutbox(outbox) {
    let published = [];
    try {
      const doc = await this.remote.getJson(this.urls.outbox);
      published = doc?.orderedItems || doc?.items || [];
    } catch { return 0; }
    if (!Array.isArray(published) || !published.length) return 0;

    const idOf = (i) => (typeof i === 'string' ? i : i?.id || null);
    const known = new Set(outbox.map(idOf).filter(Boolean));
    const removed = new Set((this.store.read('outbox-removed.json', [])).map(r => r.id));
    const missing = published.filter((i) => {
      const id = idOf(i);
      return id && !known.has(id) && !removed.has(id);
    });
    if (!missing.length) return 0;
    // Newest first, like recordOutbox leaves it; the pod's copy is already in
    // that order, so appending the tail is enough to keep both sorted.
    outbox.push(...missing);
    this.store.write('outbox.json', outbox);
    this.log(`reconciled ${missing.length} outbox entr(ies) the pod carried and this machine did not`);
    return missing.length;
  }

  // Recover this actor's own posts from the pod's public face. The private half
  // lives on this machine now, so a restored backup or a replaced machine loses
  // statuses.json while the pod still serves every note. Followers already come
  // back; this is the other half of the same gap.
  //
  // The INDEX is ap/outbox, not the ap/notes/ listing, and that difference is
  // the safety argument. Deleting a post rewrites the outbox in one PUT, so an
  // entry still there is a post that still stands. The note DOCUMENT can outlive
  // its own deletion — deleteNote's `remote.delete` is a request that can fail —
  // so walking the container can bring back something its author took down.
  // `fromNotes` is for when you would rather have that than lose the post; it is
  // not the default, and it says so where it is offered.
  //
  // MERGE ONLY. A status this machine already holds is left exactly as it is:
  // it carries local facts — favourited, reblogged, the activities an Undo has
  // to name — that the pod knows nothing about. That is also what makes the
  // failure modes harmless: a listing that fails returns nothing, and nothing
  // is what an empty listing recovers.
  async rebuildStatuses({ fromNotes = false } = {}) {
    const { urls } = this;
    const ids = new Set();
    const boosts = [];
    let indexed = false;

    const doc = await this.remote.getJson(urls.outbox).catch(() => null);
    if (doc) {
      indexed = true;
      for (const item of (doc.orderedItems || doc.items || [])) {
        if (typeof item === 'string') { if (item.startsWith(urls.notes)) ids.add(item); }
        else if (item?.type === 'Announce') boosts.push(item);
      }
    }
    if (fromNotes) {
      // Three documents are published per post — the note, `-create` and
      // `-replies` — plus a `.keep`. Which is which is settled by reading the
      // document below, not by its name: a slug is a date and eight hex
      // characters and says nothing about what it holds.
      for (const child of await this.remote.listContainer(urls.notes).catch(() => [])) {
        if (/(-create|-replies|\/\.keep)$/.test(child.url)) continue;
        ids.add(child.url);
      }
      indexed = true;
    }
    if (!indexed) return { indexed: 0, recovered: 0, reblogs: 0, landed: false, why: 'the pod would not answer for its outbox' };

    const statuses = this.store.getStatuses();
    const have = new Set(statuses.map(s => s.noteId));
    const removed = new Set(this.store.read('outbox-removed.json', []).map(r => r.id));
    const recovered = [];
    for (const id of ids) {
      if (have.has(id) || removed.has(id)) continue;
      const note = await this.remote.getJson(id).catch(() => null);
      if (note?.type !== 'Note' || note.id !== id || note.attributedTo !== urls.actor) continue;
      const attachments = wire.attachmentsOf(note);
      const mentions = (Array.isArray(note.tag) ? note.tag : [])
        .filter(t => t?.type === 'Mention' && t.href)
        .map(t => ({ href: t.href, name: t.name }));
      recovered.push({
        noteId: note.id, actor: urls.actor, content: note.content || '',
        published: note.published || null,
        ...(note.inReplyTo ? { inReplyTo: note.inReplyTo } : {}),
        kind: 'post', slug: note.id.slice(urls.notes.length),
        ...(attachments.length ? { attachments } : {}),
        ...(mentions.length ? { mentions } : {}),
        recovered: true,
      });
    }

    // A boost is only recoverable for a post we can name — the Announce carries
    // the activity a later Undo needs, but not the boosted post's text, which
    // belongs to whoever wrote it.
    const merged = [...statuses, ...recovered];
    let reblogs = 0;
    for (const act of boosts) {
      const object = typeof act.object === 'string' ? act.object : act.object?.id;
      const s = object && merged.find(x => x.noteId === object);
      if (!s || s.reblogged) continue;
      s.reblogged = true;
      s.announceActivity = act;
      reblogs++;
    }
    if (!recovered.length && !reblogs) return { indexed: ids.size, recovered: 0, reblogs: 0, landed: true };

    // Written whole and sorted, the way backfillStatuses does it: addStatus
    // unshifts and fires the streaming event, so a loop of it would arrive
    // backwards and push every recovered post at connected clients as new.
    merged.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    const kept = merged.slice(0, 1000);
    this.store.write('statuses.json', kept);
    const landed = await this.store.commit();

    // The RDF mirror is the other thing a lost machine took with it, and it is
    // what backfillStatuses reads on a fresh state. Best effort: a post in
    // statuses.json is already the recovery that matters.
    let rdf = 0;
    for (const s of recovered) {
      try {
        await this.local.writeNote('posts', s.slug, {
          noteId: s.noteId, actor: s.actor, published: s.published,
          content: s.content, inReplyTo: s.inReplyTo, attachments: s.attachments,
        });
        rdf++;
      } catch (e) { this.log(`rebuild: RDF for ${s.slug} not written (${e.message})`); }
    }
    this.log(`rebuilt ${recovered.length} post(s) and ${reblogs} boost(s) from the pod`
      + `${landed ? '' : ' — THE STATE WRITE DID NOT LAND'}`);
    return {
      indexed: ids.size, recovered: recovered.length, reblogs, rdf, landed,
      dropped: Math.max(0, merged.length - kept.length),
    };
  }

  // Publish the collections a change actually TOUCHED.
  //
  // Publishing all three on every follower event cost nine pod requests where
  // two do: two reconcile reads, three collection PUTs, and three ACL PUTs
  // whose bodies are a pure function of the WebID and the target URL and so
  // are byte-identical to the ones written at setup. A new follower does not
  // change what this actor follows, and it does not change the outbox.
  //
  // `acls` is true only on the default path, which is publishProfile: that is
  // where the public surface is built, and where verifyPublicSurface already
  // checks the world can read it.
  //
  // Reconciliation stays welded to the collection it guards. It is what stops a
  // restored-and-behind machine publishing a short list over the pod's longer
  // one — erasing followers it would then stop delivering to, and erasing the
  // outbox that `rebuild` reads as its index — so a narrowed publish still runs
  // the one belonging to whatever it is about to overwrite.
  async publishCollections(which = ALL_COLLECTIONS) {
    const { urls } = this;
    const contacts = this.store.getContacts();
    if (which.followers) {
      await this.reconcileFollowers(contacts);
      await this.remote.putJson(urls.followers,
        wire.orderedCollection(urls.followers, contacts.followers.map(f => f.actor)));
      if (which.acls) await this.remote.setAcl(urls.followers, ['Read']);
    }
    if (which.following) {
      await this.remote.putJson(urls.following,
        wire.orderedCollection(urls.following, contacts.following.filter(f => f.accepted).map(f => f.actor)));
      if (which.acls) await this.remote.setAcl(urls.following, ['Read']);
    }
    if (which.outbox) {
      const outbox = this.store.read('outbox.json', []);
      await this.reconcileOutbox(outbox);
      await this.remote.putJson(urls.outbox, wire.orderedCollection(urls.outbox, outbox));
      if (which.acls) await this.remote.setAcl(urls.outbox, ['Read']);
    }
    if (which.followers || which.following) await this.local.writeContacts(contacts);
  }

  // The outbox is the public record of everything this actor has said, boosts
  // included. A Create goes in as its note id, which dereferences; an Announce
  // has only a fragment id, so the activity itself goes in the collection —
  // legal AS2, and what Mastodon serves.
  async recordOutbox(item) {
    const outbox = this.store.read('outbox.json', []);
    outbox.unshift(item);
    this.store.write('outbox.json', outbox);
    await this.remote.putJson(this.urls.outbox, wire.orderedCollection(this.urls.outbox, outbox));
  }

  // Taking something out of the outbox is a DECISION — a post deleted, a boost
  // undone. It leaves a mark for the same reason dropFollower does: the pod's
  // copy is rewritten right after, but a rewrite that fails would otherwise let
  // the next reconcile put the entry back. Bounded, like the follower one.
  async unrecordOutbox(matches) {
    const before = this.store.read('outbox.json', []);
    const outbox = before.filter(i => !matches(i));
    const gone = before.filter(i => matches(i))
      .map(i => (typeof i === 'string' ? i : i?.id)).filter(Boolean);
    if (gone.length) {
      const marks = this.store.read('outbox-removed.json', []).filter(r => !gone.includes(r.id));
      const at = new Date().toISOString();
      this.store.write('outbox-removed.json',
        [...marks, ...gone.map(id => ({ id, at }))].slice(-500));
    }
    this.store.write('outbox.json', outbox);
    await this.remote.putJson(this.urls.outbox, wire.orderedCollection(this.urls.outbox, outbox));
  }

  // Media container on the remote pod — public-Read like notes, created lazily
  // at first upload (idempotent; the flag only saves round-trips).
  async ensureMediaContainer() {
    if (this._mediaReady) return;
    await this.remote.putJson(this.urls.media + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(this.urls.media, ['Read']);
    this._mediaReady = true;
  }

  // Compose → wire note on remote pod + RDF truth locally + deliver Create.
  async publishNote(content, { inReplyTo, attachments } = {}) {
    const { urls } = this;
    const published = new Date().toISOString();
    const slug = published.slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex');
    // A mention nobody can resolve stays plain text rather than failing the post.
    // The reply's own text decides who is mentioned: trim a handle out and that
    // person is not notified, which is what every fediverse client leads people
    // to expect. A Group named in the parent is the one thing carried forward
    // regardless — drop it and the group stops carrying the thread.
    const inText = new Set(wire.mentionsIn(content));
    const carried = inReplyTo
      ? (this.store.getStatuses().find(s => s.noteId === inReplyTo)?.mentions || [])
        .map(m => String(m.name || '').replace(/^@/, '')).filter(Boolean)
      : [];
    const mentions = [];
    for (const handle of [...new Set([...inText, ...carried])]) {
      if (!this.resolveMention) break;
      const doc = await this.resolveMention(handle).catch(() => null);
      if (!doc?.id) { this.log(`mention @${handle} did not resolve — left as text`); continue; }
      if (!inText.has(handle) && doc.type !== 'Group') continue;   // author trimmed them out
      mentions.push({ handle, actor: doc.id, inbox: doc.endpoints?.sharedInbox || doc.inbox });
    }
    const note = wire.noteDoc({ urls, slug, content, published, inReplyTo, attachments, mentions });

    await this.remote.putJson(note.id, note);
    // Empty, but present: a dangling `replies` that 404s is worse than none.
    await this.remote.putJson(wire.repliesId(note.id), wire.collection(wire.repliesId(note.id), []));
    await this.recordOutbox(note.id);

    await this.local.writeNote('posts', slug, {
      noteId: note.id, actor: urls.actor, published, content: note.content, inReplyTo, attachments,
    });
    this.store.addStatus({
      noteId: note.id, actor: urls.actor, content: note.content, published, inReplyTo,
      kind: 'post', slug, ...(attachments?.length ? { attachments } : {}),
      ...(note.tag?.length ? { mentions: note.tag.map(t => ({ href: t.href, name: t.name })) } : {}),
    });

    const create = wire.createActivity(note, urls);
    // Published as its own document: a group that carries this post wraps the
    // whole activity, and the receiving server resolves it by fetching this id.
    // It inherits the notes container's public-Read acl:default.
    await this.remote.putJson(create.id, create);
    const contacts = this.store.getContacts();
    const inboxes = [...new Set([
      ...contacts.followers.map(f => f.sharedInbox || f.inbox),
      ...mentions.map(m => m.inbox),
    ].filter(Boolean))];
    await this.deliverer.deliverToAll(inboxes, create);
    this.log(`note published: ${note.id} → ${inboxes.length} inbox(es)`);
    return note;
  }
}
