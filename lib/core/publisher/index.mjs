// publisher.mjs — builds/maintains the actor's public face on the remote pod:
// webfinger, actor doc, collections, notes. The /ap/ tree is disposable:
// publishProfile() rebuilds it.
//
// This file is the actor's public face — the actor document, discovery,
// ACLs, the inbox posture, Move and retire. The rest is in the modules
// beside it: collections.mjs (the published collections and the outbox
// record), restore.mjs (catching up with the pod), notes.mjs (a note going
// up), questions.mjs (polls) — each a set of functions taking the Publisher
// as their first argument, reached here through one-line delegations.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as wire from '../wire.mjs';
import { USER_AGENT } from '../../shared/ua.mjs';
import { HTTP_TIMEOUT_MS } from '../../shared/safefetch.mjs';
import * as containers from '../../pod/containers.mjs';
import * as discovery from '../../pod/discovery.mjs';
import * as podActor from '../../pod/actor.mjs';
import * as podInbox from '../../pod/inbox.mjs';
import * as podFeatured from '../../pod/featured.mjs';
import * as podPolicy from '../../pod/policy.mjs';
import * as podNotes from '../../pod/notes.mjs';
import * as collections from './collections.mjs';
import { ALL_COLLECTIONS } from './collections.mjs';
import * as restore from './restore.mjs';
import * as notes from './notes.mjs';
import * as questions from './questions.mjs';
import * as own from './own.mjs';
import { recordPlace } from '../place.mjs';

const AGENT_VERSION = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../package.json'), 'utf8')).version;

export class Publisher {
  constructor({ config, remote, store, deliverer, publicKeyPem, assertionKey = null, log = console.log,
    probeFetch = null, resolveMention = null, resolveActor = null, clientOrigin = null,
  }) {
    this.config = config;
    this.remote = remote;
    this.store = store;
    this.deliverer = deliverer;
    // Everything this actor sends goes on the outbox its owner reads.
    if (deliverer) deliverer.onSent = (a) => own.recordOwn(this, a);
    this.publicKeyPem = publicKeyPem;
    this.assertionKey = assertionKey;      // Ed25519 public half, multibase; null = no proofs
    // Where this identity's client surface answers, when that is an address a
    // stranger can reach. Null on a laptop, where the surface is on loopback
    // and advertising it to the world would name somewhere nobody can go.
    this.clientOrigin = clientOrigin;
    // A fronted identity (config.gateway.frontActor) advertises its ids on a
    // shared domain; the map tells RemotePod where each writes on the pod.
    const publicBase = config.gateway?.frontActor
      ? config.gateway.frontActor.replace(/ap\/actor\/?$/, '') : null;
    this.urls = wire.apUrls(config.remotePod, config.root, { publicBase });
    if (this.urls.toPod && this.remote?.setUrlMap) this.remote.setUrlMap(this.urls.toPod);
    // Credential-free by design — it asks what a stranger sees — but routed
    // through the pod's own cooldown and accounting, because it is still a
    // socket opened to that pod. Tests inject their own.
    this.probeFetch = probeFetch || ((u, i) => this.remote.probe(u, i));
    this.resolveMention = resolveMention;
    // An actor or object by its address, verified at its origin — how a reply
    // finds the inbox of the person it answers.
    this.resolveActor = resolveActor;
    // Per-poll rewrite windows, keyed by question id. See POLL_REWRITE_MS.
    this.pollTimers = new Map();
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
  // The Gateway's outbox door for this account, when a Gateway is attached:
  // beside its inbox door, or under the fronted actor.
  gatewayOutbox() {
    const gw = this.config.gateway;
    if (!(gw && gw.url && gw.mode && gw.mode !== 'off')) return null;
    if (gw.frontActor) return String(gw.frontActor).replace(/ap\/actor\/?$/u, 'ap/outbox');
    return String(gw.url).replace(/ap\/inbox\/?$/u, 'ap/outbox');
  }

  // Every actor document this identity publishes, from one place: the
  // profile publish and a Move both write it, and a Move that rebuilt it
  // by hand dropped the gateway inbox, the outbox door and the collections.
  // `clientOrigin` is overridden only by the agent serving a client its own
  // local actor: standalone, the published document cannot name a loopback
  // address, but a client already talking to that address can be told it.
  actorDocFor({ priv = false, moderators = null, inbox = null, movedTo = this.config.movedTo || null,
    clientOrigin = this.clientOrigin } = {}) {
    const { urls } = this;
    return wire.actorDoc({
      urls, handle: wire.publicHandle(this.config), name: this.config.name, publicKeyPem: this.publicKeyPem,
      movedTo, kind: this.config.kind,
      approveJoins: wire.followsNeedApproval(this.config),
      assertionKey: this.assertionKey,
      summary: this.config.summary || null, icon: this.config.icon || null,
      image: this.config.image || null, fields: this.config.fields || [],
      webId: this.remote.webId || null,
      aliases: this.config.aliases || [],
      // A group says whether only its moderators may open posts (Lemmy's
      // term); a person's actor carries nothing of the kind.
      postingRestrictedToMods: this.config.kind === 'group' ? !!this.config.postingRestrictedToMods : null,
      moderators,
      pendingFollowers: priv ? urls.pendingFollowers : null,
      // Named only where the private folder is proved to keep it private.
      liked: priv ? urls.liked : null,
      ownerOutbox: priv ? urls.ownOutbox : null,
      pendingFollowing: priv ? urls.pendingFollowing : null,
      blocked: priv ? urls.blocked : null,
      inbox,
      // The agent's own outbox endpoint, where it is reachable: a client
      // following the actor must arrive somewhere that will take a write.
      // Otherwise the Gateway's outbox door, when one is attached.
      outbox: clientOrigin ? `${clientOrigin}ap/outbox` : this.gatewayOutbox(),
      // How a client-to-server client finds the way in with nothing configured
      // by hand. Advertised only where the surface is publicly reachable.
      oauthAuthorize: clientOrigin ? `${clientOrigin}oauth/authorize` : null,
      oauthToken: clientOrigin ? `${clientOrigin}oauth/token` : null,
    });
  }

  // The human half: a page a browser can open and follow from. The actor
  // document is for servers; this is the address you hand to a person. It
  // shows who the account is, its fields, when it joined and what it pinned;
  // the counts and the posts live in the collections. Written only when its
  // content changed.
  async publishProfilePage({ force = false } = {}) {
    const { urls } = this;
    const host = new URL(urls.base).host;
    // When the account was made. Accounts from before this was recorded take
    // the date of their oldest post, or today.
    if (!this.config.createdAt) {
      const oldest = this.store.getStatuses().filter(s => s.kind === 'post' && s.published)
        .map(s => s.published).sort()[0];
      this.config.createdAt = oldest || new Date().toISOString();
      this.store.setConfig?.({ ...this.store.getConfig?.(), createdAt: this.config.createdAt });
    }
    const pinned = this.store.getStatuses()
      .filter(s => s.kind === 'post' && s.pinned && s.visibility !== 'private' && s.visibility !== 'direct')
      .sort((a, b) => String(b.published).localeCompare(String(a.published)))
      .slice(0, 5)
      .map(s => ({ content: s.content, published: s.published, url: s.noteId }));
    // The address as the world knows it: at the Gateway for a fronted
    // identity, on the pod's host otherwise, the actor id where no host can
    // answer for a handle.
    const frontActor = this.config.gateway?.frontActor;
    const address = frontActor ? `@${wire.publicHandle(this.config)}@${new URL(frontActor).host}`
      : (wire.webfingerHost(urls.base) ? `@${this.config.handle}@${host}` : urls.actor);
    const html = wire.profilePageHtml({
      name: this.config.name || this.config.handle,
      address,
      summary: this.config.summary ? wire.contentHtml(this.config.summary) : null,
      icon: this.config.icon || null,
      image: this.config.image || null,
      fields: this.config.fields || [],
      joined: this.config.createdAt,
      pinned,
      kind: this.config.kind,
    });
    const digest = crypto.createHash('sha256').update(html).digest('hex').slice(0, 32);
    const seen = this.store.read('published.json', {});
    if (!force && seen.pageDigest === digest) return false;
    await podActor.writeProfilePage(this.remote, urls, html);
    this.store.write('published.json', { ...this.store.read('published.json', {}), pageDigest: digest });
    return true;
  }

  async publishProfile({ force = false } = {}) {
    const { urls } = this;
    const host = new URL(urls.base).host;

    // The owner-only collections (FEP-4ccd, FEP-c648) are advertised only
    // where "owner-only" is real — the pod must provably enforce the private
    // container's ACL, the same bar private posts clear.
    const priv = await this.privateReady() === true;
    const moderators = (this.config.moderators || []).length ? urls.moderators : null;
    // An advertised inbox gateway (config.gateway.mode past 'off') becomes the
    // actor's inbox; deliveries reach the pod inbox through it. Absent → today.
    const gw = this.config.gateway;
    const gwActive = gw && gw.url && gw.mode && gw.mode !== 'off';
    // A forum's category advertises the forum's one inbox (config.inboxUrl):
    // deliveries to any category land there, and the forum routes them.
    const actorDoc = this.actorDocFor({ priv, moderators, inbox: gwActive ? gw.url : (this.config.inboxUrl || null) });
    const surface = crypto.createHash('sha256').update(JSON.stringify({
      actor: actorDoc, handle: this.config.handle, host,
      quiesced: !!this.config.quiescedAt, version: AGENT_VERSION,
      moderators: this.config.moderators || [],
    })).digest('hex').slice(0, 32);
    // The human page has its own gate: it changes with pins and the joined
    // date as well as with the profile, and costs one write when it does.
    await this.publishProfilePage({ force });
    if (!force && this.store.read('published.json', {}).surfaceDigest === surface) {
      this.log('profile unchanged — nothing republished');
      return { unreachable: [], updated: 0, skipped: true };
    }

    // Discovery is the pod's, and a pod has one WebFinger document: a forum's
    // category (config.forum names the forum) is not the pod's identity, so it
    // writes none — the forum's own actor, or a Gateway, answers for it.
    if (!this.config.forum) {
      await discovery.writeWebfinger(this.remote, urls,
        wire.jrd({ handle: this.config.handle, host, actor: urls.actor, page: urls.profileHtml }));
      await discovery.writeHostMeta(this.remote, urls, wire.hostMeta(urls.base));

      const nodeinfoDocUrl = urls.home + 'ap/nodeinfo-2.0';
      const localPosts = this.store.getStatuses().filter(s => s.kind === 'post').length;
      await discovery.writeNodeinfo(this.remote, urls, {
        pointer: wire.nodeinfoPointer(nodeinfoDocUrl),
        doc: wire.nodeinfoDoc({ version: AGENT_VERSION, localPosts }),
      });
    }

    const actor = actorDoc;                 // built above, for the digest
    await podActor.write(this.remote, urls, actor);

    // FEP-1b12: the moderator roster, public — it is what a recipient
    // validates a group's announced moderation against.
    if (moderators) {
      await podFeatured.writeModerators(this.remote, urls,
        wire.orderedCollection(urls.moderators, this.config.moderators));
    }
    // The gateway policy doc: the PUBLIC data a keyless gateway reads to decide
    // what concerns this identity. Written only while a gateway is advertised.
    if (gwActive) await this.publishGatewayPolicy();

    // WebID → actor: the profile card lists the actor as a foaf:account.
    // Best-effort — a profile that cannot be read or edited does not stop the
    // publish, it is logged and the rest of the surface still goes up.
    if (this.config.forum) { /* a category is not the pod owner's account */ } else try {
      const wrote = await podActor.linkInWebIdProfile(this.remote, {
        actorUrl: urls.actor,
        accountName: `@${this.config.handle}@${host}`,
        kind: this.config.kind,
        // Where a Solid client posts: dokieli reads `as:outbox` off the WebID.
        outbox: this.clientOrigin ? `${this.clientOrigin}ap/outbox` : this.gatewayOutbox(),
      });
      if (wrote) this.log('WebID profile now lists the actor as a foaf:account');
    } catch (e) {
      this.log(`WebID profile not updated with the actor link: ${e.message}`);
    }
    // Where the account lives, in the owner's public type index — only where
    // they already have one; an index is made only on their yes, at sign-up.
    if (!this.config.forum) {
      await recordPlace(this.remote, urls.base, urls.home + 'ap/actor')
        .then((r) => { if (r === 'registered') this.log('the public type index now records where the account lives'); })
        .catch((e) => this.log(`type index not updated with the account's place: ${e.message}`));
    }

    // inbox: public may only Append; owner (the agent) reads + drains. A
    // quiesced actor keeps its name resolving but takes no more mail, so a
    // republish must not re-open the door.
    await podInbox.writeKeep(this.remote, urls);
    await podInbox.setPosture(this.remote, urls, this.config.quiescedAt ? 'closed' : 'open');
    if (this.config.quiescedAt) this.log('inbox left closed — this actor is quiesced');

    // notes live under a public-Read container (acl:default covers new notes).
    await podNotes.provisionContainer(this.remote, urls);

    await this.publishCollections({ ...ALL_COLLECTIONS, force });
    const updated = await this.announceProfileChange(actor, { force });
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
    // Named as the fediverse sees it: a fronted actor's name and host are the
    // front's, not the pod's.
    const pubName = wire.publicHandle(this.config);
    const pubHost = this.config.gateway?.frontActor ? new URL(this.config.gateway.frontActor).host : host;
    this.log(this.config.gateway?.frontActor || wire.webfingerHost(urls.base)
      ? `profile published: @${pubName}@${pubHost} → ${urls.actor}`
      : `profile published → ${urls.actor} — NOT discoverable as @${pubName}@${pubHost}: `
        + 'this pod is a suffix-based host, and WebFinger is only answered at a host root');
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
  async announceProfileChange(actor, { force = false } = {}) {
    const digest = crypto.createHash('sha256').update(JSON.stringify(actor)).digest('hex').slice(0, 32);
    const seen = this.store.read('published.json', {});
    // A forced republish is the operator saying TELL THE WORLD — the digest
    // gate is for silent no-op saves, not for that.
    if (seen.actorDigest === digest && !force) return 0;
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
      // Discovery documents are the pod's, not a forum category's (see publishProfile).
      ...(this.config.forum ? [] : [['webfinger', urls.webfinger], ['host-meta', urls.base + '.well-known/host-meta']]),
      ['actor', urls.actor],
      ['notes', urls.notes],
      ['followers', urls.followers],
      ['following', urls.following],
      ['featured', urls.featured],
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
    const findings = await containers.repairPrivateAcls(this.remote,
      [this.urls.home, this.urls.state],
      { isPublic: (u) => this.publiclyReadable(u) });
    // What a finding MEANS is ours to say; the library just reports.
    for (const f of findings) {
      this.log(`${f.url} was readable without credentials — rewriting its ACL`);
      if (f.error) { this.log(`SECURITY: ${f.url} is public and its ACL could not be rewritten: ${f.error}`); continue; }
      if (f.stillPublic) this.log(`SECURITY: ${f.url} is STILL readable without credentials — check the pod's ACLs`);
    }
  }

  // Deliberately credential-free: this asks what a stranger would see.
  // accept: */* matters — asking for turtle makes the server answer 501 on the
  // JSON documents (webfinger, actor), which reads as "unreachable" when the
  // world can in fact see them perfectly well.
  publiclyReadable(url) {
    return containers.probePublicReadability(this.probeFetch, url,
      { headers: { 'user-agent': USER_AGENT }, timeoutMs: HTTP_TIMEOUT_MS });
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
    await podActor.writeTombstone(this.remote, urls, wire.tombstoneDoc(urls, deletedAt, this.config.kind));
    this.store.setConfig({ ...this.store.getConfig(), retiredAt: deletedAt });
    await this.store.flush();
    this.log(`retired: Delete sent to ${inboxes.length} inbox(es), actor replaced with a Tombstone`);
    return { inboxes: inboxes.length, deletedAt };
  }

  // Stop accepting mail without giving up the name: deliveries get an immediate
  // 401 rather than a 201 into storage nobody will ever drain. WebFinger,
  // host-meta and the actor stay published, so the handle still resolves.
  async closeInbox() {
    await podInbox.setPosture(this.remote, this.urls, 'closed');
    const at = new Date().toISOString();
    this.store.setConfig({ ...this.store.getConfig(), quiescedAt: at });
    await this.store.flush();
    this.log(`inbox closed — @${this.config.handle} still resolves but accepts nothing`);
    return at;
  }

  // Undo closeInbox: mail flows again and the actor is no longer quiesced.
  async openInbox() {
    await podInbox.setPosture(this.remote, this.urls, 'open');
    const { quiescedAt, ...rest } = this.store.getConfig() || {};
    this.store.setConfig(rest);
    this.config.quiescedAt = undefined;
    await this.store.flush();
    this.log(`inbox re-opened — @${this.config.handle} is taking mail again`);
  }

  // Lock the inbox to a gateway: the public loses Append, so nothing reaches
  // the pod except through the gateway's verify-at-the-door. Reversible with
  // openInbox (public-Append) — the one-call rollback.
  async lockInboxToGateway(gatewayWebId) {
    await podInbox.setPosture(this.remote, this.urls, { gatewayWebId });
    this.log(`inbox locked to gateway ${gatewayWebId} — public delivery is refused`);
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
    const gw = this.config.gateway;
    const gwActive = gw && gw.url && gw.mode && gw.mode !== 'off';
    const priv = await this.privateReady() === true;
    const moderators = (this.config.moderators || []).length ? urls.moderators : null;
    await podActor.writeMoved(this.remote, urls, this.actorDocFor({
      priv, moderators, inbox: gwActive ? gw.url : null, movedTo: target,
    }));
    await this.store.flush();
    this.log(`moved to ${target}: Move sent to ${inboxes.length} inbox(es), actor now advertises movedTo`);
    return { inboxes: inboxes.length, target, movedAt: at };
  }

  // The gateway policy: a small PUBLIC document a keyless inbox gateway reads
  // to decide, at the edge, what to forward and what to drop. It carries only
  // public facts — the actor/followers URLs, the REAL pod inbox to forward to,
  // the accepted-following list (already public) and a mirror of the blocklist.
  // Publishing the blocklist here makes it public; that is a deliberate part of
  // running a gateway, surfaced to the operator in the admin UI.
  async publishGatewayPolicy() {
    const { urls } = this;
    const contacts = this.store.getContacts();
    const bl = this.store.getBlocklist();
    await podPolicy.write(this.remote, urls, {
      v: 1,
      actorUrl: urls.actor,
      followersUrl: urls.followers,
      followingUrl: urls.following,
      inboxUrl: urls.inbox,                 // the pod inbox the gateway forwards to
      notesPrefix: urls.notes,
      kind: this.config.kind || 'person',
      following: contacts.following.filter(f => f.accepted && !f.bsky).map(f => f.actor),
      blocklist: { domains: bl.domains || [], actors: bl.actors || [] },
    });
  }

  // collections.mjs
  publishOutbox(...a) { return collections.publishOutbox(this, ...a); }
  readPublishedOutbox(...a) { return collections.readPublishedOutbox(this, ...a); }
  publishFollowers(...a) { return collections.publishFollowers(this, ...a); }
  readPublishedFollowers(...a) { return collections.readPublishedFollowers(this, ...a); }
  publishCollections(...a) { return collections.publishCollections(this, ...a); }
  publishPending(...a) { return collections.publishPending(this, ...a); }
  publishBlocked(...a) { return collections.publishBlocked(this, ...a); }
  recordOutbox(...a) { return collections.recordOutbox(this, ...a); }
  unrecordOutbox(...a) { return collections.unrecordOutbox(this, ...a); }
  recordOwn(...a) { return own.recordOwn(this, ...a); }
  backfillLiked() { return own.backfillLiked(this); }
  inboxesFor(...a) { return notes.inboxesFor(this, ...a); }
  noteToSelf(...a) { return notes.noteToSelf(this, ...a); }
  updateObject(...a) { return notes.updateObject(this, ...a); }
  unrecordOwn(...a) { return own.unrecordOwn(this, ...a); }
  publishOwn(...a) { return own.publishOwn(this, ...a); }
  ownSettled() { return own.ownSettled(this); }
  publishFeatured(...a) { return collections.publishFeatured(this, ...a); }

  // restore.mjs
  reconcileFollowers(...a) { return restore.reconcileFollowers(this, ...a); }
  reconcileOutbox(...a) { return restore.reconcileOutbox(this, ...a); }
  rebuildStatuses(...a) { return restore.rebuildStatuses(this, ...a); }
  healStatuses(...a) { return restore.healStatuses(this, ...a); }

  // notes.mjs
  ensureMediaContainer(...a) { return notes.ensureMediaContainer(this, ...a); }
  _containerExists(...a) { return notes.containerExists(this, ...a); }
  ensurePrivateContainer(...a) { return notes.ensurePrivateContainer(this, ...a); }
  privateReady(...a) { return notes.privateReady(this, ...a); }
  _mentionsFor(...a) { return notes.mentionsFor(this, ...a); }
  publishNote(...a) { return notes.publishNote(this, ...a); }
  authorizeQuote(...a) { return notes.authorizeQuote(this, ...a); }
  withdrawQuote(...a) { return notes.withdrawQuote(this, ...a); }
  grantQuote(...a) { return notes.grantQuote(this, ...a); }
  publishObject(...a) { return notes.publishObject(this, ...a); }
  updateNote(...a) { return notes.updateNote(this, ...a); }

  // questions.mjs
  publishQuestion(...a) { return questions.publishQuestion(this, ...a); }
  _pollActivity(...a) { return questions.pollActivity(this, ...a); }
  recordVote(...a) { return questions.recordVote(this, ...a); }
  _pollDirty(...a) { return questions.pollDirty(this, ...a); }
  republishPoll(...a) { return questions.republishPoll(this, ...a); }
  closeDuePolls(...a) { return questions.closeDuePolls(this, ...a); }
  stopPolls(...a) { return questions.stopPolls(this, ...a); }
}
