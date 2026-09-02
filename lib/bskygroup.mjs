// bskygroup.mjs — Bluesky members of a group, bridged-first. A bridged Bluesky
// account (one that follows @ap.brid.gy) is a plain AP actor and takes the
// existing FEP-1b12 paths untouched. This module covers the rest: knowing who
// is bridged, nudging who isn't, and the degraded Bluesky-only membership —
// follow-as-join, mention-as-submission, repost as the group's carry.

import { profileUrl } from './bskyfeed.mjs';
import { bskyText } from './atproto.mjs';

const BRIDGE_ACTOR = (did) => `https://bsky.brid.gy/ap/${did}`;
const AP_ACCEPT = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

export class BskyGroup {
  constructor({ store, atproto, intake, publisher, log = console.log, fetcher = null }) {
    Object.assign(this, { store, atproto, intake, publisher, log });
    this.fetcher = fetcher;   // tests inject; default rides safefetch lazily
  }

  // A DID is bridged when Bridgy Fed serves an AP actor for it. Cached on
  // whatever record the caller keeps, so one join costs one probe.
  async isBridged(did) {
    try {
      const { safeFetch } = await import('./safefetch.mjs');
      const doFetch = this.fetcher || ((u, i) => safeFetch(u, i));
      const res = await doFetch(BRIDGE_ACTOR(did), { headers: { accept: AP_ACCEPT } });
      return res.status < 400;
    } catch { return false; }
  }

  // ONE reply ever: tell an unbridged joiner how to reach the fediverse side.
  async nudge({ did, handle }) {
    const text = `@${handle} welcome! Follow @ap.brid.gy and your posts will reach `
      + 'the Fediverse side of this group too.';
    const start = 0;
    const rec = this.atproto.read();
    await this.atproto.xrpc('com.atproto.repo.createRecord', {
      body: {
        repo: rec.did, collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post', text,
          facets: [{
            index: { byteStart: start, byteEnd: start + 1 + handle.length },
            features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
          }],
          createdAt: new Date().toISOString(),
        },
      },
    });
  }

  // A native follow of the group's Bluesky account. Bridged accounts are left
  // to join through the bridge; unbridged ones become Bluesky-only members,
  // through the same approval queue as everyone else.
  async onFollow(author) {
    const actor = profileUrl(author.did);
    const contacts = this.store.getContacts();
    if (contacts.followers.some(f => f.actor === actor)) return;
    if (this.store.getRequests().some(r => r.actor === actor)) return;
    if (this.store.isBlocked(actor)) return;
    if (await this.isBridged(author.did)) {
      this.log(`bluesky follow from bridged @${author.handle} — their join arrives over AP`);
      return;
    }
    const member = { actor, bsky: { did: author.did, handle: author.handle } };
    if (this.store.getConfig()?.approveJoins) {
      const reqs = this.store.getRequests();
      reqs.unshift({ ...member, at: new Date().toISOString() });
      this.store.setRequests(reqs);
      this.log(`bluesky join request held: @${author.handle}`);
      return;
    }
    contacts.followers.push(member);
    this.store.setContacts(contacts);
    this.store.addNotification({ type: 'follow', actor, bsky: true });
    await this.nudgeOnce(member);
    this.log(`bluesky member joined: @${author.handle}`);
  }

  async nudgeOnce(member) {
    if (member.nudgedAt) return;
    try {
      await this.nudge(member.bsky);
      member.nudgedAt = new Date().toISOString();
      const contacts = this.store.getContacts();
      const rec = contacts.followers.find(f => f.actor === member.actor);
      if (rec) { rec.nudgedAt = member.nudgedAt; this.store.setContacts(contacts); }
    } catch (e) { this.log(`bluesky nudge failed for @${member.bsky?.handle}: ${e.message}`); }
  }

  // A mention of the group's handle is a submission — same rules as an AP
  // member addressing the group. amplify() applies the member, mute, and
  // review checks; its bsky branch calls carry() below.
  async onMention(n) {
    const actor = profileUrl(n.author.did);
    const isMember = this.store.getContacts().followers.some(f => f.actor === actor);
    if (!isMember) { this.log(`bluesky mention from non-member @${n.author.handle} — ignored`); return; }
    await this.intake.amplify(n.uri, {});
  }

  // The group's carry of a member's Bluesky post: a native repost. AP
  // followers get it only when the author is bridged — the group never
  // fabricates an AP object for someone else's words.
  async carry(s) {
    const rec = this.atproto.read();
    const out = await this.atproto.xrpc('com.atproto.repo.createRecord', {
      body: {
        repo: rec.did, collection: 'app.bsky.feed.repost',
        record: {
          $type: 'app.bsky.feed.repost',
          subject: { uri: s.noteId, cid: s.cid },
          createdAt: new Date().toISOString(),
        },
      },
    });
    this.store.updateStatus(s.noteId, { announcedAt: new Date().toISOString(), repostUri: out.uri });
    this.store.setPending(this.store.getPending().filter(p => p.noteId !== s.noteId));
    this.log(`bluesky repost: ${s.noteId}`);
    return { ok: true, noteId: s.noteId, repost: out.uri };
  }

  // Unsay a repost.
  async retract(s) {
    if (!s.repostUri) throw new Error('that post was never carried');
    await this.atproto.deleteCrossPost(s.repostUri);
    this.store.updateStatus(s.noteId, {
      announcedAt: undefined, repostUri: undefined, retractedAt: new Date().toISOString(),
    });
    return { ok: true, noteId: s.noteId, inboxes: 0 };
  }

  // An AP member's post the group just Announced, shown natively to the
  // group's Bluesky followers: the group account posts the conversion with
  // attribution and the link back.
  async mirrorCarry(s) {
    if (!this.store.getConfig()?.atproto?.crossPost) return;
    const handle = this.store.handleOf?.(s.actor) || s.actor;
    const plain = String(s.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const body = bskyText(`via ${handle}: ${plain}`, s.noteId);
    const rec = this.atproto.read();
    await this.atproto.xrpc('com.atproto.repo.createRecord', {
      body: {
        repo: rec.did, collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post', text: body.text,
          ...(body.facets.length ? { facets: body.facets } : {}),
          createdAt: new Date().toISOString(),
        },
      },
    });
  }

  // Ejection's Bluesky half: the DID is blocked so the departure sticks.
  async blockDid(did) {
    const rec = this.atproto.read();
    await this.atproto.xrpc('com.atproto.repo.createRecord', {
      body: {
        repo: rec.did, collection: 'app.bsky.graph.block',
        record: { $type: 'app.bsky.graph.block', subject: did, createdAt: new Date().toISOString() },
      },
    });
  }
}
