// owner.mjs — the record: what the owner's page reads about this identity,
// and the one write that edits it.

import fs from 'node:fs';
import path from 'node:path';
import { announceModeration } from '../../../core/social.mjs';
import { addRemoveActivity, publicHandle } from '../../../core/wire.mjs';
import { hashPassword } from '../../../client/masto/index.mjs';
import { identityHomes, rootOf, tildify, defaultProfile } from '../../home.mjs';
import { localFetch } from '../../../client/localapi.mjs';
import { AGENT_VERSION } from '../static.mjs';
import { secureOrigin } from '../origins.mjs';

// The identity itself. Changing any of these means a different actor at a
// different address, which is a new setup, not an edit.
const PERMANENT_CONFIG = ['handle', 'remotePod', 'issuer', 'root', 'kind'];
// Config the actor document carries, so a change is not real until it is
// republished.
const WIRE_CONFIG = ['name', 'summary', 'icon', 'image', 'fields', 'approveJoins', 'moderators'];

export async function get(p, ctx, req, res, url) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };

  if (req.method === 'GET' && p === '/status') return json(res, 200, agent.status());
  // The moderation queue: what listed moderators asked for over federation,
  // waiting for the operator to vouch (or not). See POST /modqueue.
  if (req.method === 'GET' && p === '/modqueue') {
    return json(res, 200, agent.store.getConfig()?.kind === 'group'
      ? agent.store.read('modqueue.json', []) : []);
  }
  // The inbox gateway (optional, opt-in). Its state, and the shadow-mode
  // measurement that says whether it is worth trusting. The HMAC secret is
  // never returned — only whether one is set.
  if (req.method === 'GET' && p === '/gateway') {
    const g = agent.store.getConfig()?.gateway || null;
    return json(res, 200, {
      configured: !!(g && g.url),
      url: g?.url || null, webId: g?.webId || null,
      frontActor: g?.frontActor || null,
      mode: g?.mode || 'off', hasSecret: !!g?.hmacSecret,
      stats: agent.store.read('gateway-stats.json', { verified: 0, unverified: 0, lastAt: null }),
    });
  }
  // The other identities on this machine, so the page can link to each one.
  // Their `agent.json` is the only file read — a port and a handle. A
  // sibling's credential and keys are never opened; anything else shown
  // here comes from that agent answering /status for itself.
  if (req.method === 'GET' && p === '/profiles') {
    const here = path.resolve(agent.home || '');
    // Which identity a plain command means: the last one started. A
    // different question from `current`, which is the page you are on.
    const wasLast = defaultProfile(rootOf(here));
    const rows = await Promise.all(identityHomes(rootOf(here)).map(async ({ name, dir }) => {
      // agent.json holds a port AND a handle — setup records both, exactly
      // so the named origin can be built before that agent has said a word.
      let rec = {};
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) || {}; } catch {}
      const port = rec.port || null;
      // A directory under profiles/ is not an identity until it holds a
      // credential or has run somewhere. A half-finished setup leaves one
      // behind, and listing it offers a page that cannot exist yet.
      if (!port && !fs.existsSync(path.join(dir, 'credential.json'))) return null;
      const current = path.resolve(dir) === here;
      const live = current ? agent.status() : port
        ? await localFetch(agent.home, port, '/status', { timeout: 1200 })
          .then(r => r.json()).catch(() => null)
        : null;
      // The handle is right here — spending it on the origin is the whole
      // point of having asked that agent who it is. A stopped one never
      // answers, so its recorded handle stands in: the link has to be named
      // before you get there, or starting it lands you on the shared origin.
      const handle = live?.handle || rec.handle || null;
      const origin = port
        ? secureOrigin(handle, port)
        : null;
      // The fediverse address, assembled from the two things /status has:
      // the handle, and the pod host its actor URL sits on.
      let address = null;
      if (live?.handle && live?.actor) {
        try {
          const front = live.actor.match(/\/u\/([^/]+)\/ap\/actor\/?$/)?.[1];
          address = `${front || live.handle}@${new URL(live.actor).host}`;
        } catch { /* not a URL yet */ }
      }
      return {
        name, port, current,
        admin: origin ? `${origin}/admin/` : null,
        app: origin ? `${origin}/` : null,
        handle,
        address,
        lastUsed: name === wasLast,
        kind: live?.kind || null,
        mode: live ? live.mode : null,
      };
    }));
    return json(res, 200, { identities: rows.filter(Boolean) });
  }
  if (req.method === 'GET' && p === '/blocks') return json(res, 200, agent.store.getBlocklist());
  if (req.method === 'GET' && p === '/log') return json(res, 200, { lines: agent.logLines(200) });
  if (req.method === 'GET' && p === '/deadletter') return json(res, 200, { items: agent.store.getDeadLetters() });

  if (req.method === 'GET' && p === '/config') {
    const cfg = agent.store.getConfig();
    if (!cfg) return json(res, 409, { error: 'agent not configured — set it up at /admin/setup/' });
    const urls = agent.urls || agent.publisher?.urls || null;
    const wfHost = urls ? new URL(urls.base).host : null;
    // A fronted identity's address is its name AT THE FRONT — the front
    // serves the actor under that name, whatever this pod calls it.
    const address = cfg.gateway?.frontActor
      ? `@${publicHandle(cfg)}@${new URL(cfg.gateway.frontActor).host}`
      : (wfHost ? `@${cfg.handle}@${wfHost}` : null);
    return json(res, 200, {
      // permanent
      handle: cfg.handle, remotePod: cfg.remotePod, issuer: cfg.issuer,
      root: cfg.root || null, kind: cfg.kind || 'person',
      actor: urls?.actor || null, webId: agent.readCredential?.()?.webId || null,
      // The opaque id the client addresses this actor by, so the record can
      // link straight at its profile there. Derived from the actor URL the
      // same way every other id is — computed here rather than in the page,
      // which has no business knowing how they are made.
      accountId: urls?.actor ? agent.store.idFor(urls.actor) : null,
      address,
      // editable
      name: cfg.name || null, summary: cfg.summary || null, icon: cfg.icon || null,
      image: cfg.image || null, fields: cfg.fields || [],
      approveJoins: !!cfg.approveJoins, review: !!cfg.review,
      aliases: cfg.aliases || [],
      autoAcceptFollows: !!cfg.autoAcceptFollows,
      // never the record itself
      hasUiPassword: !!cfg.uiPassword,
      quiescedAt: cfg.quiescedAt || null, movedTo: cfg.movedTo || null,
      // Per-machine, so it comes from the credential file, not pod config —
      // and it is a fact here, not a setting: moving it means moving data,
      // which is `fedipod state --to <url>`.
      privateRoot: agent.readCredential?.()?.privateRoot || null,
      mode: agent.status?.().mode || null, port, home: tildify(agent.home) || null,
      update: agent.updateInfo || null,
      // What this process is running, against what a restart would run:
      // the checkout can move while an agent stays up.
      version: AGENT_VERSION,
      versionOnDisk: versionOnDisk(),
      pendingUpgrade: agent.pendingUpgrade || [],
      // The connected Bluesky account, non-secret half. `connected` is the
      // credential's word, so a config entry orphaned by a deleted
      // atproto.json shows as disconnected rather than pretending.
      atproto: cfg.atproto
        ? { ...cfg.atproto, connected: !!agent.atproto?.connected() }
        : null,
      // Connected fediverse accounts, from the credentials themselves
      // rather than from config — a roster entry whose file was deleted
      // should stop being listed, not linger.
      fediAccounts: agent.fediaccts?.status() || [],
      origins: {
        loopback: publicOrigin
          || `https://localhost:${port}/`,
        named: publicOrigin
          ? null
          : allowed.label
            ? (true
              ? `https://${allowed.label}.localhost:${port}/`
              : `http://${allowed.label}.localhost:${port}/`)
            : null,
      },
    });
  }
  // How far the CSV import has gotten — polled by the CLI while it runs.
  if (req.method === 'GET' && p === '/import') {
    if (!agent.importer) return json(res, 409, { error: 'agent not connected yet' });
    return json(res, 200, agent.importer.progress());
  }
  // Group-only: who is here, and what the group has carried. A group cannot
  // force an unfollow, so muting — declining to carry — is its whole lever.
  if (req.method === 'GET' && p === '/members') {
    if (!isGroup()) return json(res, 404, { error: 'not a group' });
    const muted = agent.store.getMuted().actors;
    return json(res, 200, {
      members: agent.store.getContacts().followers
        .map(f => ({
          actor: f.actor,
          handle: agent.store.handleOf(f.actor),
          inbox: f.sharedInbox || f.inbox,
          muted: muted.includes(f.actor),
        })),
    });
  }
  if (req.method === 'GET' && p === '/announced') {
    if (!isGroup()) return json(res, 404, { error: 'not a group' });
    return json(res, 200, {
      announced: agent.store.getStatuses().filter(s => s.announcedAt)
        .map(s => ({ noteId: s.noteId, actor: s.actor, announcedAt: s.announcedAt })),
    });
  }
  if (req.method === 'GET' && p === '/requests') {
    // Not group-only any more: a person queues unverifiable follows here
    // too, and a queue with no way to read it is worse than no queue.
    return json(res, 200, {
      approveJoins: !!agent.store.getConfig()?.approveJoins,
      requests: agent.store.getRequests().map(r => ({ actor: r.actor, at: r.at })),
    });
  }
  if (req.method === 'GET' && p === '/pending') {
    if (!isGroup()) return json(res, 404, { error: 'not a group' });
    return json(res, 200, {
      review: !!agent.store.getConfig()?.review,
      pending: agent.store.getPending(),
    });
  }

  return false;
}

export async function post(p, body, ctx, req, res) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };
  switch (p) {
    // ---- the record, edited from the page at /admin/ ----
    case '/config': {
      const fixed = PERMANENT_CONFIG.filter(k => k in body);
      if (fixed.length) {
        return json(res, 400, {
          error: `${fixed.join(', ')} cannot be changed — that is the identity itself, not a setting`,
        });
      }
      for (const k of ['approveJoins', 'review']) {
        if (k in body && !isGroup()) return json(res, 404, { error: 'not a group' });
      }
      // A user acting here outranks an idle active agent on another device:
      // claim the lease rather than write state that one will clobber.
      await agent.requestTakeover?.();
      // Merge, never replace: the UI password and anything else set later
      // must survive an edit that never mentions it.
      const cfg = { ...agent.store.getConfig() };
      if ('name' in body) {
        if (!body.name) return json(res, 400, { error: 'a display name is required' });
        cfg.name = String(body.name);
      }
      if ('summary' in body) cfg.summary = body.summary || undefined;
      if ('icon' in body) cfg.icon = body.icon || undefined;
      // The banner and the labelled rows, so a client and this page edit one
      // record rather than each other's leftovers.
      if ('image' in body) cfg.image = body.image || undefined;
      if ('fields' in body) {
        cfg.fields = (Array.isArray(body.fields) ? body.fields : [])
          .filter(f => f?.name?.trim())
          .map(f => ({ name: String(f.name).trim(), value: String(f.value ?? '').trim() }));
      }
      if ('approveJoins' in body) cfg.approveJoins = !!body.approveJoins;
      if ('review' in body) cfg.review = !!body.review;
      // A person's queue gate: on, and an inbound Follow is accepted on
      // arrival instead of waiting in the requests queue. Local behavior,
      // not on the wire — but intake reads the LIVE config, so it is
      // patched below whether or not anything republishes.
      if ('autoAcceptFollows' in body) cfg.autoAcceptFollows = !!body.autoAcceptFollows;
      // The moderator roster (FEP-1b12): actor IRIs whose federated
      // moderation asks are queued, published as attributedTo.
      let rosterDiff = null;
      if ('moderators' in body) {
        if (!isGroup()) return json(res, 404, { error: 'not a group' });
        const next = [...new Set((Array.isArray(body.moderators) ? body.moderators : [])
          .map(String).filter(m => /^https?:\/\/\S+$/.test(m)))];
        const prev = cfg.moderators || [];
        rosterDiff = {
          added: next.filter(m => !prev.includes(m)),
          removed: prev.filter(m => !next.includes(m)),
        };
        cfg.moderators = next;
      }
      if ('password' in body) {
        // '' clears it. The UI password is what turns the instant OAuth
        // redirect into a login form; switching that off is a real choice.
        if (body.password) cfg.uiPassword = hashPassword(body.password);
        else delete cfg.uiPassword;
      }
      const republish = WIRE_CONFIG.some(k => k in body);
      agent.store.setConfig(cfg);
      if ('autoAcceptFollows' in body && agent.publisher) {
        agent.publisher.config.autoAcceptFollows = cfg.autoAcceptFollows;
      }
      if (republish && agent.publisher) {
        Object.assign(agent.publisher.config, {
          name: cfg.name, summary: cfg.summary, icon: cfg.icon,
          image: cfg.image, fields: cfg.fields,
          approveJoins: !!cfg.approveJoins,
          moderators: cfg.moderators,
          aliases: cfg.aliases,
        });
      }
      await agent.store.flush();
      // Publishing is only half of it: publishProfile re-fetches the public
      // documents unauthenticated and reports the ones a stranger's server
      // could not read. Carrying that back is what lets this be the only
      // republish control there is.
      const pub = republish ? await agent.publisher.publishProfile() : null;
      // Roster changes are announced to the membership (FEP-1b12), so
      // their servers can mirror who moderates here.
      if (rosterDiff && agent.publisher) {
        const urls = agent.publisher.urls;
        for (const [type, list] of [['Add', rosterDiff.added], ['Remove', rosterDiff.removed]]) {
          for (const m of list) {
            await announceModeration(agent, addRemoveActivity({
              urls, type, object: m, target: urls.moderators, serial: Date.now(),
            })).catch(e => log(`moderation announce failed: ${e.message}`));
          }
        }
      }
      return json(res, 200, {
        ok: true, published: republish,
        ...(pub?.unreachable?.length ? { unreachable: pub.unreachable } : {}),
        config: {
          name: cfg.name || null, summary: cfg.summary || null, icon: cfg.icon || null,
      image: cfg.image || null, fields: cfg.fields || [],
          approveJoins: !!cfg.approveJoins, review: !!cfg.review,
          autoAcceptFollows: !!cfg.autoAcceptFollows,
          ...(isGroup() ? { moderators: cfg.moderators || [] } : {}),
          hasUiPassword: !!cfg.uiPassword,
        },
      });
    }
    default: return false;
  }
}
