// publisher.mjs — builds/maintains the actor's public face on the remote pod
// (webfinger, actor doc, collections, notes) and mirrors truth into the local
// pod. The remote /ap/ tree is disposable: publishProfile() rebuilds it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wire from './wire.mjs';

const AGENT_VERSION = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')).version;

export class Publisher {
  constructor({ config, remote, local, store, deliverer, publicKeyPem, log = console.log, probeFetch = (u, i) => fetch(u, i),
  }) {
    this.config = config;
    this.remote = remote;
    this.local = local;
    this.store = store;
    this.deliverer = deliverer;
    this.publicKeyPem = publicKeyPem;
    this.urls = wire.apUrls(config.remotePod, config.root);
    this.probeFetch = probeFetch;
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
    }));
    await this.remote.setAcl(urls.actor, ['Read']);

    // inbox: public may only Append; owner (the agent) reads + drains.
    await this.remote.putJson(urls.inbox + '.keep', { keep: true }, 'application/json');
    await this.remote.setAcl(urls.inbox, ['Append']);

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
        headers: { accept: '*/*' },
        signal: AbortSignal.timeout(Number(process.env.AP_HTTP_TIMEOUT_MS) || 30_000),
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
    await this.remote.putJson(urls.actor, wire.tombstoneDoc(urls, deletedAt));
    await this.remote.setAcl(urls.actor, ['Read']);      // a Tombstone must stay fetchable
    this.store.setConfig({ ...this.store.getConfig(), retiredAt: deletedAt });
    await this.store.flush();
    this.log(`retired: Delete sent to ${inboxes.length} inbox(es), actor replaced with a Tombstone`);
    return { inboxes: inboxes.length, deletedAt };
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
    const note = wire.noteDoc({ urls, slug, content, published, inReplyTo, attachments });

    await this.remote.putJson(note.id, note);
    const outbox = this.store.read('outbox.json', []);
    outbox.unshift(note.id);
    this.store.write('outbox.json', outbox);
    await this.remote.putJson(urls.outbox, wire.orderedCollection(urls.outbox, outbox));

    await this.local.writeNote('posts', slug, {
      noteId: note.id, actor: urls.actor, published, content: note.content, inReplyTo, attachments,
    });
    this.store.addStatus({
      noteId: note.id, actor: urls.actor, content: note.content, published, inReplyTo,
      kind: 'post', slug, ...(attachments?.length ? { attachments } : {}),
    });

    const create = wire.createActivity(note, urls);
    const contacts = this.store.getContacts();
    const inboxes = contacts.followers.map(f => f.sharedInbox || f.inbox).filter(Boolean);
    await this.deliverer.deliverToAll(inboxes, create);
    this.log(`note published: ${note.id} → ${inboxes.length} inbox(es)`);
    return note;
  }
}
