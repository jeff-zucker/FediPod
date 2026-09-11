// statuses.mjs — a status and what a client does to one: compose (a note, a
// poll, a scheduled post, a reply through a connected account), source and
// history, read, edit and delete, context, who reacted, pin, bookmarks and
// favourites, scheduled posts, poll votes, favourite and boost.

import crypto from 'node:crypto';
import * as social from '../../core/social.mjs';
import { readBody, pollParams, htmlToText } from './body.mjs';
import {
  MAX_OPTIONS as POLL_MAX_OPTIONS, MAX_OPTION_CHARS as POLL_MAX_OPTION_CHARS,
  MIN_SECONDS as POLL_MIN_SECONDS, MAX_SECONDS as POLL_MAX_SECONDS,
} from '../../core/polls.mjs';

export async function handle(api, ctx) {
  const { req, res, pathname, url, send } = ctx;   // eslint-disable-line no-unused-vars

  if (pathname === '/api/v1/statuses' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.status) return send(422, { error: 'status text required' });
    const visibility = body.visibility || 'public';
    if (!['public', 'unlisted', 'private', 'direct'].includes(visibility)) {
      return send(422, { error: `unknown visibility "${visibility}"` });
    }
    const inReplyTo = body.in_reply_to_id ? api.store.urlFor(body.in_reply_to_id) : undefined;
    // A reply to a mirrored Bluesky post goes out as a native Bluesky reply
    // — the parent is not an AP object, so there is no AP note to make.
    const bskyParent = inReplyTo && api.store.getStatuses().find(x => x.noteId === inReplyTo && x.kind === 'bsky');
    if (bskyParent) return api.bskyReply(send, body, bskyParent, visibility);
    // A reply to a post a connected account brought us goes out from that
    // account, where the conversation already is.
    const acctParent = inReplyTo && api.store.getStatuses().find(x => x.noteId === inReplyTo && x.kind === 'acct');
    if (acctParent) return api.acctReply(send, body, acctParent, visibility);
    // Private and direct posts live in an owner-only pod container — and
    // only on a pod that provably enforces it.
    if (visibility === 'private' || visibility === 'direct') {
      const ready = await api.agent.publisher.privateReady();
      if (ready !== true) return send(422, { error: ready });
    }
    const spoilerText = String(body.spoiler_text || '').trim() || null;
    const mediaIds = [].concat(body.media_ids || body['media_ids[]'] || []).filter(Boolean);
    const media = api.store.getMedia();
    const attachments = mediaIds.map(id => media[id] && { id, ...media[id] }).filter(Boolean);

    const asking = pollParams(body);
    if (asking) {
      // Mastodon's own rules, stated here rather than discovered inside the
      // publisher, so a client gets the reason back on the request it made.
      if (attachments.length) return send(422, { error: 'a poll cannot carry media' });
      if (body.scheduled_at) return send(422, { error: 'a poll cannot be scheduled' });
      if (asking.options.length < 2) return send(422, { error: 'a poll needs at least two options' });
      if (asking.options.length > POLL_MAX_OPTIONS) {
        return send(422, { error: `a poll takes at most ${POLL_MAX_OPTIONS} options` });
      }
      if (asking.options.some(o => o.length > POLL_MAX_OPTION_CHARS)) {
        return send(422, { error: `a poll option is at most ${POLL_MAX_OPTION_CHARS} characters` });
      }
      if (new Set(asking.options).size !== asking.options.length) {
        return send(422, { error: 'a poll\u2019s options must differ from one another' });
      }
      const seconds = asking.expiresIn ?? POLL_MAX_SECONDS;
      if (!Number.isFinite(seconds) || seconds < POLL_MIN_SECONDS || seconds > POLL_MAX_SECONDS) {
        return send(422, {
          error: `a poll runs between ${POLL_MIN_SECONDS} and ${POLL_MAX_SECONDS} seconds`,
        });
      }
      try {
        const q = await api.agent.publisher.publishQuestion(body.status, {
          options: asking.options, multiple: asking.multiple,
          expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
          inReplyTo, visibility, spoilerText,
        });
        return send(200, api.status(api.store.getStatuses().find(x => x.noteId === q.id)));
      } catch (e) {
        return send(422, { error: e.message });
      }
    }

    if (body.scheduled_at) {
      // Nothing here publishes it when the time comes (see `scheduling` in the
      // constructor), so saying yes would be losing the post quietly.
      if (!api.scheduling) {
        return send(422, { error: 'this instance cannot schedule posts — it has no process '
          + 'running between now and then to publish one. Post it when you want it sent.' });
      }
      const at = Date.parse(body.scheduled_at);
      if (!Number.isFinite(at) || at < Date.now() + 60_000) {
        return send(422, { error: 'scheduled_at must be at least a minute from now' });
      }
      const sched = api.store.getScheduled();
      const entry = {
        id: crypto.randomBytes(8).toString('hex'), scheduledAt: new Date(at).toISOString(),
        params: { status: body.status, visibility, spoilerText, inReplyTo, attachments },
      };
      sched.push(entry);
      api.store.setScheduled(sched);
      return send(200, api.scheduledJson(entry));
    }
    const note = await api.agent.publisher.publishNote(body.status,
      { inReplyTo, attachments, visibility, spoilerText });
    const s = api.store.getStatuses().find(x => x.noteId === note.id);
    return send(200, api.status(s));
  }

  // The composer reads the raw text back before an edit.
  const mSource = /^\/api\/v1\/statuses\/([a-f0-9]+)\/source$/.exec(pathname);
  if (mSource && req.method === 'GET') {
    const noteUrl = api.store.urlFor(mSource[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s) return send(404, { error: 'Record not found' });
    return send(200, { id: mSource[1], text: s.text ?? htmlToText(s.content || ''), spoiler_text: s.spoiler || '' });
  }

  // One entry — the current version. Enough for the client's history view;
  // past versions are not kept.
  const mHistory = /^\/api\/v1\/statuses\/([a-f0-9]+)\/history$/.exec(pathname);
  if (mHistory && req.method === 'GET') {
    const noteUrl = api.store.urlFor(mHistory[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s) return send(404, { error: 'Record not found' });
    return send(200, [{
      content: s.content || '', spoiler_text: s.spoiler || '', sensitive: !!s.spoiler,
      created_at: s.editedAt || s.published, account: api.account(s.actor),
      media_attachments: (s.attachments || []).map(a => api.mediaJson(a)),
      emojis: [], poll: null,
    }]);
  }

  const mStatus = /^\/api\/v1\/statuses\/([a-f0-9]+)$/.exec(pathname);
  if (mStatus && req.method === 'GET') {
    const { s, wrapped } = api.lookup(mStatus[1]);
    if (!s) return send(404, { error: 'Record not found' });
    return send(200, wrapped ? api.statusOrBoost(s) : api.status(s));
  }
  if (mStatus && req.method === 'PUT') {
    const noteUrl = api.store.urlFor(mStatus[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s) return send(404, { error: 'Record not found' });
    if (s.actor !== api.urls.actor) return send(403, { error: 'not your status' });
    const body = await readBody(req);
    if (!body.status) return send(422, { error: 'status text required' });
    const mediaIds = [].concat(body.media_ids || body['media_ids[]'] || []).filter(Boolean);
    const media = api.store.getMedia();
    const attachments = mediaIds.length
      ? mediaIds.map(id => media[id] && { id, ...media[id] }).filter(Boolean)
      : null;                                   // null: keep what the post has
    const spoilerText = String(body.spoiler_text || '').trim() || null;
    const patched = await api.agent.publisher.updateNote(s,
      { content: body.status, spoilerText, attachments });
    return send(200, api.status(patched || s));
  }
  if (mStatus && req.method === 'DELETE') {
    const noteUrl = api.store.urlFor(mStatus[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s) return send(404, { error: 'Record not found' });
    // A post the owner wrote on a connected account is theirs to delete too.
    // It is deleted where it lives — an AP Delete of ours would address an
    // object that was never ours to speak for.
    const onAcct = s.actor !== api.urls.actor
      ? (api.agent.fediaccts?.list() || []).find(r => r.actorUrl && r.actorUrl === s.actor)
      : null;
    if (s.actor !== api.urls.actor && !onAcct) return send(403, { error: 'not your status' });
    const rendered = api.status(s);
    if (onAcct) {
      const held = (s.sourceAccts || []).find(v => v.acct === onAcct.id);
      if (!held?.remoteId) return send(422, { error: `we do not know where ${onAcct.handle} keeps that post` });
      try {
        await api.agent.fediaccts.api(onAcct.id,
          `/api/v1/statuses/${encodeURIComponent(held.remoteId)}`, { method: 'DELETE' });
      } catch (e) { return send(502, { error: e.message }); }
      api.store.removeStatus(s.noteId);
      return send(200, { ...rendered, text: s.content || '' });
    }
    // 502, because the refusal is the pod's: the client asked correctly and
    // the post is still up. Reporting 200 here is what let a deleted post
    // stay publicly readable with nothing to show for it.
    const gone = await social.deleteNote(api.agent, s);
    if (!gone.ok) return send(502, { error: gone.error });
    return send(200, { ...rendered, text: s.content || '' });
  }

  // Threads from the mirror's inReplyTo chains.
  const mContext = /^\/api\/v1\/statuses\/([a-f0-9]+)\/context$/.exec(pathname);
  if (mContext) {
    const noteUrl = api.lookup(mContext[1]).s?.noteId;
    const all = api.store.getStatuses();
    const byId = new Map(all.map(s => [s.noteId, s]));
    const ancestors = [];
    let cur = noteUrl && byId.get(noteUrl)?.inReplyTo;
    while (cur && byId.has(cur) && ancestors.length < 40) {
      const s = byId.get(cur);
      ancestors.unshift(s);
      cur = s.inReplyTo;
    }
    const descendants = [];
    const queue = noteUrl ? [noteUrl] : [];
    while (queue.length && descendants.length < 60) {
      const id = queue.shift();
      for (const s of all) if (s.inReplyTo === id) { descendants.push(s); queue.push(s.noteId); }
    }
    return send(200, {
      ancestors: ancestors.map(s => api.status(s, { all })),
      descendants: descendants.map(s => api.status(s, { all })),
    });
  }

  // Who reacted: only what our own store witnessed, so the lists are the
  // reactions we were notified of, not the whole fediverse's count.
  const mWho = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(reblogged_by|favourited_by)$/.exec(pathname);
  if (mWho && req.method === 'GET') {
    const noteUrl = api.store.urlFor(mWho[1]);
    if (!noteUrl) return send(404, { error: 'Record not found' });
    const type = mWho[2] === 'reblogged_by' ? 'reblog' : 'favourite';
    const actors = [...new Set(api.store.getNotifications()
      .filter(n => n.noteId === noteUrl && n.type === type).map(n => n.actor))];
    return send(200, actors.map(a => api.account(a)));
  }

  // Pinning republishes the featured collection, so a visitor's server
  // shows the pins too; the actor document names the collection.
  const mPin = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(pin|unpin)$/.exec(pathname);
  if (mPin && req.method === 'POST') {
    const noteUrl = api.store.urlFor(mPin[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s) return send(404, { error: 'Record not found' });
    if (s.actor !== api.urls.actor) return send(403, { error: 'not your status' });
    const updated = await social.pinStatus(api.agent, s, mPin[2] === 'pin');
    return send(200, api.status(updated));
  }

  if (pathname === '/api/v1/reports' && req.method === 'POST') {
    return send(422, {
      error: 'this is your own single-user server, so there is no moderation team to receive a report. Blocking the account is the action that takes effect here.',
    });
  }

  // Bookmarks are this machine's own list: nothing federates, nothing is
  // told, which is what a bookmark means everywhere.
  const mBookmark = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(bookmark|unbookmark)$/.exec(pathname);
  if (mBookmark && req.method === 'POST') {
    const noteUrl = api.store.urlFor(mBookmark[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s) return send(404, { error: 'Record not found' });
    const updated = api.store.updateStatus(s.noteId, { bookmarked: mBookmark[2] === 'bookmark' });
    return send(200, api.status(updated || s));
  }
  if (pathname === '/api/v1/bookmarks' || pathname === '/api/v1/favourites') {
    const key = pathname.endsWith('bookmarks') ? 'bookmarked' : 'favourited';
    const all = api.store.getStatuses();
    const items = all.filter(s => s[key])
      .sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
    const { items: page, headers } = api.page(items, url);
    return send(200, page.map(s => api.status(s, { all })), headers);
  }

  if (pathname === '/api/v1/scheduled_statuses' && req.method === 'GET') {
    return send(200, api.store.getScheduled().map(e => api.scheduledJson(e)));
  }
  const mSched = /^\/api\/v1\/scheduled_statuses\/([a-f0-9]+)$/.exec(pathname);
  if (mSched) {
    const sched = api.store.getScheduled();
    const e = sched.find(x => x.id === mSched[1]);
    if (!e) return send(404, { error: 'Record not found' });
    if (req.method === 'DELETE') {
      api.store.setScheduled(sched.filter(x => x.id !== mSched[1]));
      return send(200, {});
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const at = Date.parse(body.scheduled_at || '');
      if (!Number.isFinite(at)) return send(422, { error: 'scheduled_at required' });
      e.scheduledAt = new Date(at).toISOString();
      api.store.setScheduled(sched);
    }
    return send(200, api.scheduledJson(e));
  }

  const mPoll = /^\/api\/v1\/polls\/([a-f0-9]+)(\/votes)?$/.exec(pathname);
  if (mPoll) {
    const noteUrl = api.store.urlFor(mPoll[1]);
    const s = noteUrl && api.store.getStatuses().find(x => x.noteId === noteUrl);
    if (!s?.poll) return send(404, { error: 'Record not found' });
    if (mPoll[2] && req.method === 'POST') {
      const body = await readBody(req);
      const choices = [].concat(body.choices || body['choices[]'] || []).map(Number)
        .filter(Number.isInteger);
      if (!choices.length) return send(422, { error: 'choices required' });
      const r = await social.votePoll(api.agent, s, choices);
      if (!r.ok) return send(422, { error: r.error });
      return send(200, api.pollJson(api.store.getStatuses().find(x => x.noteId === noteUrl)));
    }
    return send(200, api.pollJson(s));
  }

  const mAction = /^\/api\/v1\/statuses\/([a-f0-9]+)\/(favourite|unfavourite|reblog|unreblog)$/.exec(pathname);
  if (mAction && req.method === 'POST') {
    // Acting on a carried row acts on the post itself, as Mastodon does.
    const { s } = api.lookup(mAction[1]);
    if (!s) return send(404, { error: 'Record not found' });
    // A mirrored Bluesky post is not an AP object — a Like or Announce has
    // nothing to address. The interaction goes to Bluesky instead, as the
    // native record every Bluesky app writes.
    if (s.kind === 'bsky') {
      const at = api.agent.atproto;
      if (!at?.connected()) return send(422, { error: 'this is a Bluesky post — no Bluesky account is connected to act from' });
      try {
        let patch = null;
        if (mAction[2] === 'favourite' && !s.favourited) {
          patch = { favourited: true, bskyLike: (await at.like(s.noteId, s.cid || null)).uri };
        } else if (mAction[2] === 'unfavourite' && s.favourited) {
          if (s.bskyLike) await at.deleteCrossPost(s.bskyLike);
          patch = { favourited: false, bskyLike: undefined };
        } else if (mAction[2] === 'reblog' && !s.reblogged) {
          patch = { reblogged: true, bskyRepost: (await at.repost(s.noteId, s.cid || null)).uri };
        } else if (mAction[2] === 'unreblog' && s.reblogged) {
          if (s.bskyRepost) await at.deleteCrossPost(s.bskyRepost);
          patch = { reblogged: false, bskyRepost: undefined };
        }
        return send(200, api.status(patch ? (api.store.updateStatus(s.noteId, patch) || s) : s));
      } catch (e) { return send(422, { error: e.message }); }
    }
    // A post that reached us through a connected account is not ours to
    // address as the pod actor. Our own posts and our own inbox's timeline
    // keep the AP path even when a connected account also saw them: where
    // the pod identity has standing, it is the one that acts.
    if (s.kind === 'acct') return api.acctAction(send, s, mAction[2]);
    const updated = await social[mAction[2]](api.agent, s);
    return send(200, api.status(updated || s));
  }

  return false;
}
