// accounts.mjs — the account endpoints: the owner's credentials and profile
// editor, follow requests, markers, relationships, search and lookup, block
// and mute, follow and unfollow, an account and its lists and statuses, and
// the web-push subscription a client login holds.

import crypto from 'node:crypto';
import * as podMedia from '../../pod/media.mjs';
import * as social from '../../core/social.mjs';
import { readBody } from './body.mjs';
import { readMultipart } from './media.mjs';

export async function handle(api, ctx) {
  const { req, res, pathname, url, send } = ctx;   // eslint-disable-line no-unused-vars

  if (pathname === '/api/v1/accounts/verify_credentials') {
    const cfg0 = api.store.getConfig() || {};
    return send(200, {
      ...api.selfAccount(),
      // `source` is what the editor fills its inputs from: the raw text it
      // will send back, not the HTML the profile renders.
      source: {
        privacy: 'public', sensitive: false, language: 'en',
        note: cfg0.summary || '',
        fields: (cfg0.fields || []).map(f => ({ name: f.name, value: f.value })),
      },
    });
  }

  // The profile editor. Everything it can send is carried: the name and bio,
  // both pictures, and the extra fields. An avatar or header arrives as file
  // bytes, so it goes to the pod's media container first and the actor gets
  // the URL — the same path a posted attachment takes.
  if (pathname === '/api/v1/accounts/update_credentials') {
    if (req.method !== 'PATCH' && req.method !== 'POST') return send(405, { error: 'PATCH expected' });
    const ct = String(req.headers['content-type'] || '');
    // readBody already covers JSON and urlencoded; only the file case differs.
    let form = {}, files = {};
    if (ct.includes('multipart/form-data')) ({ fields: form, files } = await readMultipart(req));
    else form = await readBody(req);

    const cfg = { ...api.store.getConfig() };
    const putImage = async (f) => {
      const ext = (f.filename || '').includes('.')
        ? f.filename.split('.').pop().replace(/[^\w]/g, '') : 'bin';
      const slug = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      const url = api.urls.media + slug;
      await api.agent.publisher.ensureMediaContainer();
      await podMedia.write(api.agent.remote, url, f.data, f.contentType);
      return url;
    };

    if ('display_name' in form) cfg.name = String(form.display_name).trim() || cfg.handle;
    if ('note' in form) cfg.summary = String(form.note) || undefined;
    if ('locked' in form) cfg.approveJoins = form.locked === 'true' || form.locked === true;
    if (files.avatar?.data?.length) cfg.icon = await putImage(files.avatar);
    if (files.header?.data?.length) cfg.image = await putImage(files.header);

    // fields_attributes arrives as fields_attributes[0][name] etc. A row with
    // no name is how the editor says "delete this one", so it is dropped.
    const rows = [];
    for (const [k, v] of Object.entries(form)) {
      const m = /^fields_attributes\[(\d+)\]\[(name|value)\]$/.exec(k);
      if (!m) continue;
      (rows[Number(m[1])] ||= {})[m[2]] = String(v);
    }
    if (rows.length) cfg.fields = rows.filter(r => r && r.name?.trim())
      .map(r => ({ name: r.name.trim(), value: (r.value || '').trim() }));

    api.store.setConfig(cfg);
    Object.assign(api.agent.publisher.config, {
      name: cfg.name, summary: cfg.summary, icon: cfg.icon, image: cfg.image,
      fields: cfg.fields, approveJoins: !!cfg.approveJoins,
    });
    await api.store.flush();
    // publishProfile says whether the world can actually read the actor it
    // just wrote. Discarding that reported success for a save that left the
    // account undiscoverable — the one outcome the caller needed to hear.
    const published = await api.agent.publisher.publishProfile();
    const unreachable = published?.unreachable;
    if (unreachable?.length) {
      api.log(`profile saved but NOT publicly readable: ${unreachable.join(', ')}`);
    }
    api.log(`profile updated from a client: ${Object.keys(form).join(', ') || '(files only)'}`);
    return send(200, api.selfAccount());
  }

  // Follow requests. The queue, and the two answers to it, have existed since
  // groups did — `agent.store.getRequests()`, `admitRequest`, `refuseRequest`,
  // all driven from the record page — but the facade stubbed the list to `[]`
  // and offered no authorize/reject. So a locked account could see and answer
  // its requests in FediPod's own page and in NO Mastodon client: Phanpy,
  // Tuba and Whalebird all showed nothing waiting.
  if (pathname === '/api/v1/follow_requests' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 40, 80);
    return send(200, api.store.getRequests().slice(0, limit)
      .map((r) => api.account(r.actor)));
  }
  const mReq = /^\/api\/v1\/follow_requests\/([a-f0-9]+)\/(authorize|reject)$/.exec(pathname);
  if (mReq && req.method === 'POST') {
    // The client addresses an account by the id it was given for it, which is
    // this store's own hash of the actor URL — the same one every other
    // account route here uses.
    const actorUrl = api.store.urlFor(mReq[1]);
    if (!actorUrl) return send(404, { error: 'Record not found' });
    if (!api.store.getRequests().some((r) => r.actor === actorUrl)) {
      return send(404, { error: 'Record not found' });
    }
    try {
      if (mReq[2] === 'authorize') await social.admitRequest(api.agent, actorUrl);
      else await social.refuseRequest(api.agent, actorUrl);
    } catch (e) { return send(422, { error: e.message }); }
    await api.store.flush();
    return send(200, api.relationship(actorUrl));
  }

  if (pathname === '/api/v1/markers') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const markers = api.store.read('masto-markers.json', {});
      for (const [k, v] of Object.entries(body)) {
        const lastId = v?.last_read_id || v;
        if (typeof lastId === 'string') {
          markers[k] = { last_read_id: lastId, version: (markers[k]?.version || 0) + 1, updated_at: new Date().toISOString() };
        }
      }
      api.store.write('masto-markers.json', markers);
      return send(200, markers);
    }
    return send(200, api.store.read('masto-markers.json', {}));
  }

  if (pathname === '/api/v1/accounts/relationships') {
    const ids = [...url.searchParams.getAll('id[]'), ...url.searchParams.getAll('id')];
    const rels = ids.map(id => api.store.urlFor(id)).filter(Boolean).map(u => api.relationship(u));
    return send(200, rels);
  }

  if (pathname === '/api/v1/accounts/search') {
    return send(200, await api.accountSearch(url.searchParams.get('q')));
  }

  if (pathname === '/api/v1/accounts/lookup') {
    const acct = String(url.searchParams.get('acct') || '').replace(/^@/, '');
    const cfg = api.store.getConfig();
    if (acct === cfg?.handle || acct === `${cfg?.handle}@${api.host}`) {
      return send(200, api.selfAccount());
    }
    const hit = Object.entries(api.store.getActors()).find(([u, a]) => {
      try { return `${a.preferredUsername}@${new URL(u).host}` === acct; } catch { return false; }
    });
    return hit ? send(200, api.account(hit[0])) : send(404, { error: 'Record not found' });
  }

  // Block and mute, from where the trouble is seen. A block also unfollows —
  // intake refuses a blocked author already — and a mute is view-only: their
  // posts stay out of the timelines, nothing federates.
  const mRel = /^\/api\/v1\/accounts\/([a-f0-9]+)\/(block|unblock|mute|unmute)$/.exec(pathname);
  if (mRel && req.method === 'POST') {
    const actorUrl = api.store.urlFor(mRel[1]);
    if (!actorUrl) return send(404, { error: 'Record not found' });
    if (mRel[2] === 'block' || mRel[2] === 'unblock') {
      if (mRel[2] === 'block') await social.blockActor(api.agent, actorUrl);
      else await social.unblockActor(api.agent, actorUrl);
    } else {
      const m = api.store.getMuted();
      if (mRel[2] === 'mute' && !m.actors.includes(actorUrl)) m.actors.push(actorUrl);
      if (mRel[2] === 'unmute') m.actors = m.actors.filter(a => a !== actorUrl);
      api.store.setMuted(m);
    }
    return send(200, api.relationship(actorUrl));
  }

  const mFollow = /^\/api\/v1\/accounts\/([a-f0-9]+)\/(follow|unfollow)$/.exec(pathname);
  if (mFollow && req.method === 'POST') {
    const actorUrl = api.store.urlFor(mFollow[1]);
    if (!actorUrl) return send(404, { error: 'Record not found' });
    if (mFollow[2] === 'follow') await social.followActor(api.agent, actorUrl);
    else await social.unfollowActor(api.agent, actorUrl).catch(() => {});   // already-gone is fine
    return send(200, api.relationship(actorUrl));
  }

  const mAccount = /^\/api\/v1\/accounts\/([a-f0-9]+)$/.exec(pathname);
  if (mAccount && req.method === 'GET') {
    const actorUrl = api.store.urlFor(mAccount[1]);
    return actorUrl ? send(200, api.account(actorUrl)) : send(404, { error: 'Record not found' });
  }

  // Web push: one subscription per client login. The agent pushes payloads
  // to the browser's push service itself, so a closed client still hears.
  if (pathname === '/api/v1/push/subscription') {
    const token = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
    if (!token) return send(401, { error: 'The access token is invalid' });
    // A client that ignores the missing `vapid` and subscribes anyway must
    // not be told it worked — a stored subscription nothing ever pushes to is
    // the same silent nothing the toggle was.
    if (!api.webPush) return send(422, { error: 'this instance does not send web push' });
    if (req.method === 'GET') {
      const sub = api.push.get(token);
      return sub ? send(200, api.push.json(token, sub)) : send(404, { error: 'Record not found' });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const sub = api.push.set(token, {
        endpoint: body.subscription?.endpoint,
        keys: body.subscription?.keys,
        alerts: body.data?.alerts,
      });
      if (!sub) return send(422, { error: 'a https endpoint and p256dh/auth keys are required' });
      return send(200, api.push.json(token, sub));
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const sub = api.push.setAlerts(token, body.data?.alerts);
      return sub ? send(200, api.push.json(token, sub)) : send(404, { error: 'Record not found' });
    }
    if (req.method === 'DELETE') {
      api.push.drop(token);
      return send(200, {});
    }
  }

  if (/^\/api\/v1\/accounts\/[a-f0-9]+\/featured_tags$/.test(pathname)) return send(200, []);

  // The counts these back are rendered from the same two arrays (see
  // `account`), so a client that shows a number here can always open it.
  const mAccList = /^\/api\/v1\/accounts\/([a-f0-9]+)\/(following|followers)$/.exec(pathname);
  if (mAccList && req.method === 'GET') {
    const actorUrl = api.store.urlFor(mAccList[1]);
    if (!actorUrl) return send(404, { error: 'Record not found' });
    // Only our own lists are known. A remote actor's collections live on its
    // own server, and opening a profile is not worth a fetch of a stranger's
    // pod — an empty list, not an error, is what the API can honestly say.
    const mine = actorUrl === api.urls?.actor;
    const c = api.store.getContacts();
    // Reversed: the contact arrays append, and page()'s cursors read
    // newest-first — fed as stored, since_id answered with its complement.
    const recs = (!mine ? []
      : mAccList[2] === 'followers' ? c.followers
        : c.following.filter(f => f.accepted))   // pending is not following
      .slice().reverse();
    const { items, headers } = api.page(recs, url,
      { limit: 40, max: 80, idOf: (r) => api.store.idFor(r.actor) });
    return send(200, items.map(r => api.account(r.actor)), headers);
  }

  // Who among the people I follow also follows THEM — a graph we do not hold,
  // and the shape is an entry per requested account, not a bare list.
  if (pathname === '/api/v1/accounts/familiar_followers') {
    const ids = [...url.searchParams.getAll('id[]'), ...url.searchParams.getAll('id')];
    return send(200, ids.map(id => ({ id, accounts: [] })));
  }

  const mAccStatuses = /^\/api\/v1\/accounts\/([a-f0-9]+)\/statuses$/.exec(pathname);
  if (mAccStatuses) {
    const actorUrl = api.store.urlFor(mAccStatuses[1]);
    const all = api.store.getStatuses();
    const pinnedOnly = url.searchParams.get('pinned') === 'true';
    const { items, headers } = api.page(
      all.filter(s => s.actor === actorUrl && (!pinnedOnly || s.pinned)), url);
    return send(200, items.map(s => api.statusOrBoost(s, { all })), headers);
  }

  return false;
}
