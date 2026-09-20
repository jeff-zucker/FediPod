// forum-intake.mjs — the forum's inbox, drained by one loop and handed out by
// address. Every mechanism of a drain — listing, reading, receipts, dead
// letters, the commit-before-delete rule — is the Intake's; only handle()
// differs.

import { Intake } from '../../../lib/core/intake/index.mjs';
import * as podInbox from '../../../lib/pod/inbox.mjs';
import * as settings from './settings.mjs';

const idOf = (v) => (typeof v === 'string' ? v : v?.id);

// A vote, as Lemmy federates one: a Like for up, a Dislike for down, and the
// Undo of either to take it back. Both are ordinary ActivityStreams. Anything
// else is not a vote.
export function voteIn(activity) {
  const t = activity?.type;
  const inner = activity?.object && typeof activity.object === 'object' ? activity.object : null;
  if (t === 'Like') return { post: idOf(activity.object), actor: idOf(activity.actor), way: 'up' };
  if (t === 'Dislike') return { post: idOf(activity.object), actor: idOf(activity.actor), way: 'down' };
  if (t === 'Undo' && (inner?.type === 'Like' || inner?.type === 'Dislike')) {
    return { post: idOf(inner.object), actor: idOf(activity.actor), way: 'none' };
  }
  return null;
}

export class ForumIntake extends Intake {
  constructor(opts, forum) {
    super(opts);
    this.forum = forum;
  }

  async handle(activity, receipt = null) {
    const vote = voteIn(activity);
    if (vote) {
      const done = await this.forum.countVote(vote);
      if (done) return undefined;
    }
    const cats = this.forum.route(activity);
    if (cats.length) {
      const results = [];
      for (const cat of cats) results.push(await cat.intake.handle(activity, receipt));
      // Accepted by any category is accepted; refused by all is the first reason.
      return results.every(r => r) ? results[0] : undefined;
    }
    if (settings.isSettingsAsk(this.forum, activity)) {
      const who = idOf(activity?.actor);
      if (!(this.forum.config.moderators || []).includes(who)) return 'only a moderator may change this forum';
      this.queueModeration(activity, who, { trusted: false });
      return undefined;
    }
    if (this.forum.namesSite(activity)) return super.handle(activity, receipt);
    return 'names no category of this forum';
  }

  // Every category's state has to be on the pod before an item leaves the
  // inbox, not only the forum's own.
  async _persisted() {
    let ok = await this.store.commit();
    for (const cat of this.forum.categories) ok = (await cat.store.commit()) && ok;
    return ok;
  }

  // Categories carry (FEP-1b12); the forum's own inbox forwards nothing.
  async _maybeForward() {}

  // A receipt beside an item was signed by the door it came through, and each
  // category's door has its own secret: the receipt is ours if any of them
  // verifies it.
  async _readReceipt(itemUrl) {
    const secrets = [this.config.gateway?.hmacSecret, ...this.forum.categories.map(c => c.config.gateway?.hmacSecret)]
      .filter(Boolean);
    if (!secrets.length) return null;
    try {
      const { readCapped } = await import('../../../lib/shared/safefetch.mjs');
      const { verifyReceipt } = await import('../../../lib/gateway/httpsig.mjs');
      const receipt = await podInbox.readDeliveryReceipt(this.remote, itemUrl, { maxBytes: 64 * 1024, readCapped });
      if (!receipt) return null;
      return secrets.some(s => verifyReceipt(receipt, s)) ? receipt : null;
    } catch { return null; }
  }

  gatewaySecret() {
    return this.config.gateway?.hmacSecret || this.forum.categories.find(c => c.config.gateway?.hmacSecret)?.config.gateway.hmacSecret || null;
  }

  // The forum owner's own post, taken at an outbox door: written by the
  // category it addresses.
  async ownerPostFrom(activity, raw, receipt) {
    const [cat] = this.forum.route(activity);
    if (!cat) return 'an owner post names no category';
    const r = await cat.c2s.dispatch(activity, { raw, slug: receipt?.slug || null });
    return r.status < 300 ? undefined : `owner post refused (${r.status}: ${r.body?.error || ''})`;
  }
}
