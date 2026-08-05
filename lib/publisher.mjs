// publisher.mjs — builds/maintains the actor's public face on the remote pod
// (webfinger, actor doc, collections, notes) and mirrors truth into the local
// pod. The remote /ap/ tree is disposable: publishProfile() rebuilds it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wire from './wire.mjs';
import { USER_AGENT } from './ua.mjs';
import { HTTP_TIMEOUT_MS } from './safefetch.mjs';

const ACCEPT_AP = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';
// The default for publishCollections: the whole public surface, ACLs included.
// A caller that knows what it changed narrows it; a caller that says nothing
// still gets everything, so a missed call site degrades to the old cost rather
// than silently publishing nothing.
const REBUILD_MAX_PER_RUN = 200;
const ALL_COLLECTIONS = { followers: true, following: true, outbox: true, acls: true };
const AGENT_VERSION = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;

export class Publisher {
  constructor({ config, remote, local, store, deliverer, publicKeyPem, log = console.log,
    probeFetch = null, resolveMention = null, privateOnPod = true,
  }) {
    this.config = config;
    this.remote = remote;
    this.local = local;
    this.store = store;
    this.deliverer = deliverer;
    this.publicKeyPem = publicKeyPem;
    this.urls = wire.apUrls(config.remotePod, config.root);
    // Credential-free by design — it asks what a stranger sees — but routed
    // through the pod's own cooldown and accounting, because it is still a
    // socket opened to that pod. Tests inject their own.
    this.probeFetch = probeFetch || ((u, i) => this.remote.probe(u, i));
    this.resolveMention = resolveMention;
    this.privateOnPod = privateOnPod;
    this.log = log;
  }

  // Idempotent: (re)write webfinger + actor + collections + container ACLs.
  //
  // ~34 pod requests, so it does not run when it would rewrite the same bytes.
  // Every document below is derived from the actor doc, the handle, the host,
  // whether the actor is quiesced (which decides the inbox ACL) and the agent
  // version (which rides in nodeinfo) — so if none of those moved, there is
  // nothing to say. Phanpy's editor submits the whole form on every save, so
  // "saved without changing anything" is the common case, not a rare one.
  //
  // `force` is for the callers that publish precisely BECAUSE the pod does not
  // have what the digest says it has: the repair path, and the explicit
  // republish button. Without it, an actor lost from the pod would match the
  // digest, be skipped, and leave the agent reporting success while nobody can
  // resolve it.
  async publishProfile({ force = false } = {}) {
    const { urls } = this;
    const host = new URL(urls.base).host;

    const actorDoc = wire.actorDoc({
      urls, handle: this.config.handle, name: this.config.name, publicKeyPem: this.publicKeyPem,
      movedTo: this.config.movedTo || null, kind: this.config.kind,
      approveJoins: !!this.config.approveJoins,
      summary: this.config.summary || null, icon: this.config.icon || null,
      image: this.config.image || null, fields: this.config.fields || [],
      webId: this.remote.webId || null,
    });
    const surface = crypto.createHash('sha256').update(JSON.stringify({
      actor: actorDoc, handle: this.config.handle, host,
      quiesced: !!this.config.quiescedAt, version: AGENT_VERSION,
    })).digest('hex').slice(0, 32);
    if (!force && this.store.read('published.json', {}).surfaceDigest === surface) {
      this.log('profile unchanged — nothing republished');
      return { unreachable: [], updated: 0, skipped: true };
    }

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

    const actor = actorDoc;                 // built above, for the digest
    await this.remote.putJson(urls.actor, actor);
    await this.remote.setAcl(urls.actor, ['Read']);

    // WebID → actor: the profile card lists the actor as a foaf:account.
    // Best-effort — a profile that cannot be read or edited does not stop the
    // publish, it is logged and the rest of the surface still goes up.
    try {
      const wrote = await this.remote.linkAccountInProfile({
        actorUrl: urls.actor,
        accountName: `@${this.config.handle}@${host}`,
        kind: this.config.kind,
      });
      if (wrote) this.log('WebID profile now lists the actor as a foaf:account');
    } catch (e) {
      this.log(`WebID profile not updated with the actor link: ${e.message}`);
    }

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

    await this.publishCollections({ ...ALL_COLLECTIONS, force });
    const updated = await this.announceProfileChange(actor);
    await this.local.writeSettings({ handle: this.config.handle, actorUrl: urls.actor });
    await this.ensurePrivateAcls();
    const unreachable = await this.verifyPublicSurface();
    // Last, and merged: announceProfileChange writes this document too.
    //
    // Only when the surface came back readable. Recording it regardless meant a
    // publish that half-landed still matched the digest, so the NEXT save — the
    // one the operator makes because the first did not work — was skipped as a
    // no-op and reported success. The digest is a record of what is up there,
    // and an unreachable document is not up there.
    if (!unreachable.length) {
      this.store.write('published.json',
        { ...this.store.read('published.json', {}), surfaceDigest: surface });
    }
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
    // Only trees that are actually ON the pod. With the default local
    // privateRoot the fediverse tree lives on disk, so probing it was a request
    // that could only ever 404, on every start.
    const onPod = [this.urls.home, this.urls.state,
      ...(this.privateOnPod === false ? [] : [this.urls.fediverse])];
    for (const url of onPod) {
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
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
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
      webId: this.remote.webId || null,
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
          // Said explicitly, because onUndo reads it: the pod publishes WHO
          // follows, never the id of the Follow that did it, so a recovered
          // record has nothing an Undo can be matched against and must not be
          // evictable by one naming anything at all.
          followId: null,
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
      published = await this.readPublishedOutbox() || [];
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

    const published = await this.readPublishedOutbox().catch(() => null);
    if (published) {
      indexed = true;
      for (const item of published) {
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
    // Capped per run: a long-lived actor's rebuild is otherwise one pod request
    // per post it has ever made, in one burst. What is left is picked up by
    // running it again — the merge is idempotent, so that is safe to repeat.
    let budget = REBUILD_MAX_PER_RUN;
    for (const id of ids) {
      if (budget <= 0) { this.log(`rebuild: stopping at ${REBUILD_MAX_PER_RUN} this run — run it again for the rest`); break; }
      if (have.has(id) || removed.has(id)) continue;
      budget--;
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
  // Publish only the pages that actually changed.
  //
  // `known` is what we last wrote, so a post rewrites the newest page and the
  // head and nothing else — where the flat collection rewrote the actor's whole
  // history on every post. A page gets its ACL when it is first created; the
  // container above it is owner-only, so it cannot be inherited.
  // `force` is for the caller that publishes BECAUSE the pod does not have what
  // the digests say it has. Without it a repair republish rewrote the head and
  // skipped every page — the digests still matched the local record — so the
  // head advertised a `first:` that 404s, readPublishedOutbox came back empty,
  // rebuildStatuses recovered nothing, and the whole thing logged success. That
  // happens to an actor with one post as surely as one with five thousand.
  async publishOutbox(outbox, { acls = false, force = false } = {}) {
    const { urls } = this;
    const seen = this.store.read('published.json', {});
    const { pages, index } = wire.outboxPaging(outbox, seen.outboxIndex || []);
    const before = force ? {} : (seen.outboxPages || {});
    const after = {};
    let wrote = 0;

    for (let i = 0; i < pages.length; i++) {
      const n = i + 1;                                   // 1 = oldest
      const doc = wire.outboxPage(urls.outbox, n, pages[i]);
      const digest = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
      after[n] = digest;
      if (before[n] === digest) continue;                // sealed and unchanged
      await this.remote.putJson(wire.outboxPageId(urls.outbox, n), doc);
      if (!before[n] || acls) await this.remote.setAcl(wire.outboxPageId(urls.outbox, n), ['Read']);
      wrote++;
    }
    // Pages above the new count are orphans: the outbox shrank past them, and
    // left where they were they keep serving activities that have been taken
    // back. The head no longer points at them, so nothing walks to them — but
    // the URL is guessable and public.
    const stale = Object.keys(seen.outboxPages || {}).map(Number)
      .filter(n => Number.isFinite(n) && n > pages.length);
    for (const n of stale) {
      await this.remote.delete(wire.outboxPageId(urls.outbox, n)).catch(() => {});
    }
    // The head carries totalItems, so it moves whenever the outbox does. Four
    // lines, and constant however much you have posted.
    await this.remote.putJson(urls.outbox,
      wire.outboxHead(urls.outbox, outbox.length, pages.length));
    if (acls) await this.remote.setAcl(urls.outbox, ['Read']);
    this.store.write('published.json',
      { ...this.store.read('published.json', {}), outboxPages: after, outboxIndex: index });
    return wrote;
  }

  // Every activity in the published outbox, walking the pages. Also understands
  // the flat collection this used to write, so an actor published before paging
  // is still readable — which matters because rebuild reads this to recover
  // posts a lost machine no longer has.
  async readPublishedOutbox() {
    const head = await this.remote.getJson(this.urls.outbox).catch(() => null);
    if (!head) return null;
    if (Array.isArray(head.orderedItems) && head.orderedItems.length) return head.orderedItems;
    const items = [];
    let next = head.first;
    const seen = new Set();
    while (next && !seen.has(next) && items.length < 10_000) {
      seen.add(next);
      const page = await this.remote.getJson(next).catch(() => null);
      if (!page) break;
      items.push(...(page.orderedItems || []));
      next = page.next;
    }
    return items;
  }

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
      // Reconcile reads every published page, which is the expensive part of a
      // profile save. It is worth paying only when we are about to write pages
      // we did not write: on a repair, or on a machine whose state no longer
      // records what it put up there — which is exactly the restored backup the
      // reconcile exists for. With an intact record our copy IS what the pod
      // has, and re-reading it to confirm that is a page walk for nothing.
      const known = this.store.read('published.json', {}).outboxIndex;
      if (which.force || !Array.isArray(known)) await this.reconcileOutbox(outbox);
      await this.publishOutbox(outbox, { acls: which.acls, force: which.force });
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
    await this.publishOutbox(outbox);
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
    await this.publishOutbox(outbox);
  }

  // Media container on the remote pod — public-Read like notes, created lazily
  // at first upload (idempotent; the flag only saves round-trips).
  async ensureMediaContainer() {
    if (this._mediaReady) return;
    await this.remote.putJson(this.urls.media + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(this.urls.media, ['Read']);
    this._mediaReady = true;
  }

  // The owner-only container that followers-only and direct posts live in.
  // Its ACL is set once; every note under it inherits.
  async ensurePrivateContainer() {
    if (this._privateContainer) return;
    await this.remote.putJson(this.urls.privateNotes + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(this.urls.privateNotes, []);
    this._privateContainer = true;
  }

  // Whether the pod actually enforces that ACL: a bare, unauthenticated read
  // of the private container's canary must be refused. Returns true, or the
  // reason private posts stay off. A definite answer is cached for the run; a
  // network failure is not, so a pod that was briefly unreachable is asked
  // again rather than refused forever.
  async privateReady() {
    if (this._privateVerdict !== undefined) return this._privateVerdict;
    try {
      await this.ensurePrivateContainer();
      const r = await (this.probeFetch || fetch)(this.urls.privateNotes + '.keep', { redirect: 'manual' });
      this._privateVerdict = (r.status === 401 || r.status === 403) ? true
        : `this pod serves private documents to strangers (HTTP ${r.status}) — private posts stay off it`;
      return this._privateVerdict;
    } catch (e) {
      return `could not verify that the pod protects private posts (${e.message})`;
    }
  }

  // Compose → wire note on remote pod + RDF truth locally + deliver Create.
  async publishNote(content, { inReplyTo, attachments, visibility = 'public', spoilerText = null } = {}) {
    const { urls } = this;
    const priv = visibility === 'private' || visibility === 'direct';
    if (priv) {
      const ready = await this.privateReady();
      if (ready !== true) throw new Error(ready);
    }
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
    const note = wire.noteDoc({ urls, slug, content, published, inReplyTo, attachments, mentions,
      visibility, summary: spoilerText, container: priv ? urls.privateNotes : urls.notes });

    await this.remote.putJson(note.id, note);
    // Empty, but present: a dangling `replies` that 404s is worse than none.
    await this.remote.putJson(wire.repliesId(note.id), wire.collection(wire.repliesId(note.id), []));
    // The outbox is the PUBLIC index; a private or direct post is not in it.
    if (!priv) await this.recordOutbox(note.id);

    await this.local.writeNote('posts', slug, {
      noteId: note.id, actor: urls.actor, published, content: note.content, inReplyTo, attachments,
    });
    this.store.addStatus({
      noteId: note.id, actor: urls.actor, content: note.content, published, inReplyTo,
      kind: 'post', slug, text: content, visibility,
      ...(spoilerText ? { spoiler: spoilerText } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(note.tag?.length ? { mentions: note.tag.map(t => ({ href: t.href, name: t.name })) } : {}),
    });

    const create = wire.createActivity(note, urls);
    // Published as its own document: a group that carries this post wraps the
    // whole activity, and the receiving server resolves it by fetching this id.
    // It inherits the notes container's public-Read acl:default.
    await this.remote.putJson(create.id, create);
    const contacts = this.store.getContacts();
    // A direct post goes to the people it names and to nobody else.
    const inboxes = [...new Set([
      ...(visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
      ...mentions.map(m => m.inbox),
    ].filter(Boolean))];
    await this.deliverer.deliverToAll(inboxes, create);
    this.log(`note published: ${note.id} → ${inboxes.length} inbox(es)`);
    return note;
  }

  // The pinned posts, as the actor's featured collection — the one document a
  // remote server reads when it shows this profile's pins.
  async publishFeatured() {
    const ids = this.store.getStatuses().filter(s => s.kind === 'post' && s.pinned).map(s => s.noteId);
    await this.remote.putJson(this.urls.featured, wire.orderedCollection(this.urls.featured, ids));
    await this.remote.setAcl(this.urls.featured, ['Read']);
    return ids.length;
  }

  // An edit keeps the note's id, slug and published time; `updated` is the
  // edit's own stamp. The pod documents are overwritten in place — the Create
  // too, so a group's Announce resolves to the edited text — and an Update
  // goes everywhere the Create went.
  async updateNote(s, { content, spoilerText = null, attachments = null } = {}) {
    const { urls } = this;
    const updated = new Date().toISOString();
    const inText = new Set(wire.mentionsIn(content));
    const mentions = [];
    for (const handle of inText) {
      if (!this.resolveMention) break;
      const doc = await this.resolveMention(handle).catch(() => null);
      if (!doc?.id) { this.log(`mention @${handle} did not resolve — left as text`); continue; }
      mentions.push({ handle, actor: doc.id, inbox: doc.endpoints?.sharedInbox || doc.inbox });
    }
    const atts = attachments ?? s.attachments ?? [];
    // The note stays in the container its visibility put it in; a recovered
    // post may carry no slug, but the note id already contains it.
    const container = String(s.noteId).startsWith(urls.privateNotes) ? urls.privateNotes : urls.notes;
    const slug = s.slug || String(s.noteId).slice(container.length);
    const note = wire.noteDoc({
      urls, slug, content, published: s.published, inReplyTo: s.inReplyTo,
      attachments: atts, mentions, visibility: s.visibility || 'public',
      summary: spoilerText, updated, container,
    });
    await this.remote.putJson(note.id, note);
    await this.remote.putJson(wire.createActivityId(note.id), wire.createActivity(note, urls));
    if (s.slug) {
      await this.local.writeNote('posts', s.slug, {
        noteId: note.id, actor: urls.actor, published: s.published, content: note.content,
        inReplyTo: s.inReplyTo, attachments: atts,
      });
    }
    const patched = this.store.updateStatus(s.noteId, {
      content: note.content, text: content, editedAt: updated,
      spoiler: spoilerText || undefined,
      attachments: atts.length ? atts : undefined,
      mentions: note.tag?.length ? note.tag.map(t => ({ href: t.href, name: t.name })) : undefined,
    });
    const update = wire.updateActivity(note, urls);
    const contacts = this.store.getContacts();
    const inboxes = [...new Set([
      ...(s.visibility === 'direct' ? [] : contacts.followers.map(f => f.sharedInbox || f.inbox)),
      ...mentions.map(m => m.inbox),
    ].filter(Boolean))];
    await this.deliverer.deliverToAll(inboxes, update);
    this.log(`note edited: ${note.id} → ${inboxes.length} inbox(es)`);
    return patched;
  }
}
