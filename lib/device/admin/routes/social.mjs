// social.mjs — the owner acting on the social graph, and a group operator
// moderating: posting, the tag feed, follows, mutes, blocks, ejecting,
// retracting, review, joins, the moderation queue.

import { followHandle, followActor, unfollowActor, ejectFollower, retractAnnouncement, admitRequest, refuseRequest, applyModeration } from '../../../core/social.mjs';

export async function get(p, ctx, req, res, url) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };

  if (req.method === 'GET' && p === '/tagfeed') {
    return json(res, 200, agent.tagfeed
      ? { ...agent.tagfeed.config(), lastSweep: agent.tagfeed.lastSweep, lastAdded: agent.tagfeed.lastAdded }
      : { error: 'agent not configured' });
  }

  return false;
}

export async function post(p, body, ctx, req, res) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };
  switch (p) {
    case '/post': {
      if (!body.content) return json(res, 400, { error: 'content required' });
      const note = await agent.publisher.publishNote(body.content, { inReplyTo: body.inReplyTo });
      return json(res, 200, { ok: true, id: note.id });
    }
    case '/tagfeed': return json(res, 200, agent.tagfeed.setConfig(body));
    case '/archive': {
      // Whether drained mail's original bytes are kept in the private
      // half's inbox-archive/. Absent means on.
      const cfg = agent.store.getConfig();
      agent.store.setConfig({ ...cfg, archiveInbox: !!body.on });
      await agent.store.flush();
      return json(res, 200, { ok: true, archiveInbox: !!body.on });
    }
    case '/follow': {
      // By handle normally; by actor URL when there is no handle to resolve —
      // a pod on a path, or anything WebFinger cannot answer for. Pasting an
      // actor URL is a normal way to follow in Mastodon too.
      if (body.actor) { await followActor(agent, body.actor); return json(res, 200, { ok: true, actor: body.actor }); }
      if (!body.handle) return json(res, 400, { error: 'handle or actor required' });
      return json(res, 200, await followHandle(agent, body.handle));
    }
    case '/unfollow': return json(res, 200, await unfollowActor(agent, body.actor));
    case '/mute':
    case '/unmute': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      if (!body.actor) return json(res, 400, { error: 'actor required' });
      const m = agent.store.getMuted();
      m.actors = p === '/mute'
        ? [...new Set([...m.actors, body.actor])]
        : m.actors.filter(a => a !== body.actor);
      agent.store.setMuted(m);
      await agent.store.flush();
      return json(res, 200, { ok: true, actors: m.actors });
    }
    case '/eject': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      if (!body.actor) return json(res, 400, { error: 'actor required' });
      const r = await ejectFollower(agent, body.actor);
      await agent.store.flush();
      return json(res, 200, r);
    }
    case '/retract': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      if (!body.noteId) return json(res, 400, { error: 'noteId required' });
      const r = await retractAnnouncement(agent, body.noteId);
      await agent.store.flush();
      return json(res, 200, r);
    }
    case '/review': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      agent.store.setConfig({ ...agent.store.getConfig(), review: !!body.on });
      await agent.store.flush();
      return json(res, 200, { ok: true, review: !!body.on });
    }
    case '/describe': {
      const cfg = { ...agent.store.getConfig() };
      if ('summary' in body) cfg.summary = body.summary || undefined;
      if ('icon' in body) cfg.icon = body.icon || undefined;
      agent.store.setConfig(cfg);
      Object.assign(agent.publisher.config, { summary: cfg.summary, icon: cfg.icon });
      await agent.store.flush();
      await agent.publisher.publishProfile();      // the bio and avatar are on the wire
      return json(res, 200, { ok: true, summary: cfg.summary || null, icon: cfg.icon || null });
    }
    case '/joins': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      const cfg = { ...agent.store.getConfig(), approveJoins: !!body.approve };
      agent.store.setConfig(cfg);
      agent.publisher.config.approveJoins = !!body.approve;
      await agent.store.flush();
      // Unlike review, this one is visible to the fediverse: the actor
      // document carries manuallyApprovesFollowers, so nothing changes for
      // anyone until it is republished.
      await agent.publisher.publishProfile();
      return json(res, 200, { ok: true, approveJoins: !!body.approve });
    }
    case '/admit':
    case '/refuse': {
      // Kind-agnostic, like the queue they act on: admitting adds a
      // follower and Accepts, refusing Rejects. A person needs both.
      // `all` answers the whole queue — the shape a migration wave arrives
      // in — with one collections republish for the lot.
      if (p === '/admit' && body.all === true) {
        const waiting = agent.store.getRequests().map(r => r.actor);
        let admitted = 0;
        for (const actor of waiting) {
          try { await admitRequest(agent, actor, { publish: false }); admitted++; }
          catch (e) { log(`admit ${actor} failed: ${e.message}`); }
        }
        if (admitted) await agent.publisher.publishCollections({ followers: true, pending: true });
        await agent.store.flush();
        return json(res, 200, { ok: true, admitted, requests: agent.store.getRequests().length });
      }
      if (!body.actor) return json(res, 400, { error: 'actor required' });
      const r = p === '/admit' ? await admitRequest(agent, body.actor)
        : await refuseRequest(agent, body.actor);
      await agent.store.flush();
      return json(res, 200, { ...r, requests: agent.store.getRequests().length });
    }
    case '/approve':
    case '/decline': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      if (!body.noteId) return json(res, 400, { error: 'noteId required' });
      const held = agent.store.getPending().some(x => x.noteId === body.noteId);
      if (!held) return json(res, 404, { error: 'not held for review' });
      if (p === '/approve') await agent.intake.amplify(body.noteId, { approved: true });
      else agent.store.setPending(agent.store.getPending().filter(x => x.noteId !== body.noteId));
      await agent.store.flush();
      return json(res, 200, { ok: true, noteId: body.noteId, pending: agent.store.getPending().length });
    }
    // Answer one queued moderation ask: apply it (the operator vouching
    // for a delivery nothing else can vouch for) or dismiss it.
    case '/modqueue': {
      if (!isGroup()) return json(res, 404, { error: 'not a group' });
      const q = agent.store.read('modqueue.json', []);
      const entry = q.find(e => e.id === body.id);
      if (!entry) return json(res, 404, { error: 'no such queued action' });
      if (body.action !== 'apply' && body.action !== 'dismiss') {
        return json(res, 400, { error: 'action must be apply or dismiss' });
      }
      let applied = null;
      if (body.action === 'apply') applied = await applyModeration(agent, entry);
      agent.store.write('modqueue.json', q.filter(e => e.id !== entry.id));
      await agent.store.flush();
      return json(res, 200, {
        ok: true, action: body.action, type: entry.type, moderator: entry.moderator,
        ...(applied && typeof applied === 'object' ? { result: applied } : {}),
        remaining: agent.store.read('modqueue.json', []).length,
      });
    }
    // Symmetrical with /block, and open for the same reason: a block made
    // by mistake is worth undoing before federation is even configured.
    case '/unblock': {
      const b = agent.store.getBlocklist();
      const before = b.domains.length + b.actors.length;
      if (body.actor) b.actors = b.actors.filter(a => a !== body.actor);
      else if (body.domain) b.domains = b.domains.filter(d => d !== body.domain);
      else return json(res, 400, { error: 'domain or actor required' });
      agent.store.setBlocklist(b);
      // The published blocked collection (FEP-c648) follows, best-effort.
      Promise.resolve(agent.publisher?.publishCollections?.({ blocked: true })).catch(() => {});
      return json(res, 200, {
        ok: true, removed: before - (b.domains.length + b.actors.length),
        domains: b.domains, actors: b.actors,
      });
    }
    case '/block': {
      const b = agent.store.getBlocklist();
      if (body.actor) {
        if (!/^https?:\/\/\S+$/.test(body.actor)) return json(res, 400, { error: 'actor must be a URL' });
        if (!b.actors.includes(body.actor)) b.actors.push(body.actor);
      } else if (body.domain) {
        if (!b.domains.includes(body.domain)) b.domains.push(body.domain);
      } else {
        return json(res, 400, { error: 'domain or actor required' });
      }
      agent.store.setBlocklist(b);
      // The published blocked collection (FEP-c648) follows, best-effort.
      Promise.resolve(agent.publisher?.publishCollections?.({ blocked: true })).catch(() => {});
      return json(res, 200, { ok: true, domains: b.domains, actors: b.actors });
    }
    default: return false;
  }
}
