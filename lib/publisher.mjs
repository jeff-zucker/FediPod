// publisher.mjs — builds/maintains the actor's public face on the remote pod
// (webfinger, actor doc, collections, notes) and mirrors truth into the local
// pod. The remote /ap/ tree is disposable: publishProfile() rebuilds it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wire from './wire.mjs';
import { USER_AGENT } from './ua.mjs';

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

    await this.remote.putJson(urls.actor, wire.actorDoc({
      urls, handle: this.config.handle, name: this.config.name, publicKeyPem: this.publicKeyPem,
      movedTo: this.config.movedTo || null, kind: this.config.kind,
      approveJoins: !!this.config.approveJoins,
      summary: this.config.summary || null, icon: this.config.icon || null,
      image: this.config.image || null, fields: this.config.fields || [],
    }));
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
    await this.local.writeSettings({ handle: this.config.handle, actorUrl: urls.actor });
    await this.ensurePrivateAcls();
    const unreachable = await this.verifyPublicSurface();
    this.log(wire.webfingerHost(urls.base)
      ? `profile published: @${this.config.handle}@${host} → ${urls.actor}`
      : `profile published → ${urls.actor} — NOT discoverable as @${this.config.handle}@${host}: `
        + 'this pod is a path on a shared host, and WebFinger is only answered at a host root');
    return { unreachable };
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

  async publishCollections() {
    const { urls } = this;
    const contacts = this.store.getContacts();
    const outbox = this.store.read('outbox.json', []);
    await this.remote.putJson(urls.followers,
      wire.orderedCollection(urls.followers, contacts.followers.map(f => f.actor)));
    await this.remote.setAcl(urls.followers, ['Read']);
    await this.remote.putJson(urls.following,
      wire.orderedCollection(urls.following, contacts.following.filter(f => f.accepted).map(f => f.actor)));
    await this.remote.setAcl(urls.following, ['Read']);
    await this.remote.putJson(urls.outbox, wire.orderedCollection(urls.outbox, outbox));
    await this.remote.setAcl(urls.outbox, ['Read']);
    await this.local.writeContacts(contacts);
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

  async unrecordOutbox(matches) {
    const outbox = this.store.read('outbox.json', []).filter(i => !matches(i));
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
