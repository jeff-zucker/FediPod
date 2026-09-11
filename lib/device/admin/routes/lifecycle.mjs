// lifecycle.mjs — what happens to the identity over time: draining and
// pruning the inbox, rebuilding posts, republishing, parking and reviving,
// rotating the key, moving, aliases, importing, retiring.

import { resolveHandle } from '../../../core/social.mjs';
import { webfingerHost } from '../../../core/wire.mjs';
import { normalizeImport, IMPORT_KINDS } from '../../../connections/import.mjs';

export async function post(p, body, ctx, req, res) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };
  switch (p) {
    // Both of these DELETE from the pod's inbox, which is the one thing the
    // lease exists to keep to a single agent. A viewer must claim it first
    // and give up if it cannot — the facade has refused viewer writes since
    // multi-device landed, and these two were simply missed.
    case '/drain': {
      if (!await agent.requestTakeover?.()) {
        return json(res, 503, { error: 'another agent is active for this pod — it is doing the draining' });
      }
      await agent.intake.drain();
      return json(res, 200, agent.status());
    }
    // The owner's answer to "your inbox is very full". Never automatic:
    // discarding someone's mail is their call, not the agent's.
    case '/inbox/prune': {
      if (!body.before) return json(res, 400, { error: 'before (a date) required' });
      if (!await agent.requestTakeover?.()) {
        return json(res, 503, { error: 'another agent is active for this pod — discard from that one' });
      }
      return json(res, 200, await agent.intake.prune({
        before: body.before,
        ...(body.keepConcerning ? { keepConcerning: true } : {}),
      }));
    }
    // Put back the posts a lost or restored machine no longer knows about,
    // from what the pod still serves. It writes the statuses store, which is
    // the lease's business, so it refuses the same way the drain does.
    case '/rebuild': {
      if (!await agent.requestTakeover?.()) {
        return json(res, 503, { error: 'another agent is active for this pod — rebuild from that one' });
      }
      return json(res, 200, await agent.publisher.rebuildStatuses({ fromNotes: !!body.fromNotes }));
    }
    case '/publish-profile': {
      // The explicit "republish now" control. Asking for it IS the reason.
      const r = await agent.publisher.publishProfile({ force: true });
      return json(res, 200, { ok: true, ...(r?.unreachable?.length ? { unreachable: r.unreachable } : {}) });
    }
    // ---- lifecycle: what the CLI calls park | revive | rotate-key | retire ----
    // Each claims the lease first, for the same reason /config does: someone
    // acting on this page outranks an idle active agent on another device.
    // Asking first is the page's job — see the warnings in its markup.
    case '/park': {
      await agent.requestTakeover?.();
      return json(res, 200, { ok: true, ...await agent.park() });
    }
    case '/revive': {
      await agent.requestTakeover?.();
      return json(res, 200, { ok: true, ...await agent.revive() });
    }
    case '/rotate-key': {
      await agent.requestTakeover?.();
      const r = await agent.rotateKey();
      return json(res, 200, { ok: true, changed: !!r?.changed });
    }
    // Hand the identity on. Federated and effectively one-way: the Move
    // tells every follower's server to migrate them, and the actor is left
    // advertising movedTo so the old handle redirects. Same typed-handle
    // interlock as retire — a stray click cannot produce it.
    case '/move': {
      if (!body.target) return json(res, 400, { error: 'target required' });
      if (!body.confirm || body.confirm !== agent.store.getConfig()?.handle) {
        return json(res, 400, { error: 'type the handle to confirm' });
      }
      await agent.requestTakeover?.();
      // A handle is not an actor URI, and the Move's target has to be one or
      // the far side has nothing to migrate anyone to. The CLI resolves it
      // the same way; doing it here rather than in the page keeps the one
      // WebFinger lookup on the side that already knows how.
      let target = String(body.target).trim();
      if (!/^https?:\/\//.test(target)) {
        const doc = await resolveHandle(agent, target);
        if (!doc?.id) return json(res, 400, { error: `could not resolve ${target}` });
        target = doc.id;
      }
      return json(res, 200, { ok: true, ...await agent.moveTo(target) });
    }
    // The inbound half of a migration: list an old account elsewhere in
    // this actor's alsoKnownAs, which is what the old server checks for
    // before it will send a Move here. Whatever is entered is resolved to
    // the account's canonical id — the check on the far side is an exact
    // string match, so a pasted profile URL stored as typed would fail it.
    case '/alias': {
      const urls = agent.publisher?.urls;
      if (!urls) return json(res, 409, { error: 'agent not connected yet' });
      if (!body.add && !body.remove) return json(res, 400, { error: 'add or remove required' });
      await agent.requestTakeover?.();
      const cfg = { ...agent.store.getConfig() };
      const aliases = [...(cfg.aliases || [])];
      if (body.add) {
        // A Move target nobody can resolve is a landing pad nobody lands on.
        if (!webfingerHost(urls.base) && !cfg.gateway?.frontActor) {
          return json(res, 400, {
            error: 'this pod is a path on a shared host, so WebFinger cannot answer for it '
              + '— other servers could never resolve this account as a Move target',
          });
        }
        const input = String(body.add).trim().replace(/^@/, '');
        let doc = /^https?:\/\//.test(input)
          ? await agent.intake.fetchAP(input).catch(() => null)
          : await resolveHandle(agent, input).catch(() => null);
        // A URL may answer with any id it likes; before that id is stored
        // it must vouch for itself — the intake's verify-by-deref.
        if (doc?.id && /^https?:\/\//.test(input) && doc.id !== input) {
          const own = await agent.intake.fetchAP(doc.id).catch(() => null);
          doc = own?.id === doc.id ? own : null;
        }
        if (!doc?.id) {
          return json(res, 400, { error: `could not fetch the old account (${input}) — it must exist and answer` });
        }
        if (doc.id === urls.actor) return json(res, 400, { error: 'that is this account' });
        if (!aliases.includes(doc.id)) aliases.push(doc.id);
      } else {
        const target = String(body.remove).trim();
        if (!aliases.includes(target)) return json(res, 404, { error: 'no such alias' });
        // Follower servers process a Move on their own retry schedules,
        // over days — an alias removed early strands the late ones.
        if (!body.confirm) {
          return json(res, 409, {
            error: 'servers still retrying the Move check this alias and would strand '
              + 'their followers — send confirm: true to remove it anyway',
          });
        }
        aliases.splice(aliases.indexOf(target), 1);
      }
      cfg.aliases = aliases;
      agent.store.setConfig(cfg);
      agent.publisher.config.aliases = aliases;
      await agent.store.flush();
      const pub = await agent.publisher.publishProfile();
      return json(res, 200, {
        ok: true, aliases,
        ...(pub?.unreachable?.length ? { unreachable: pub.unreachable } : {}),
      });
    }
    // Stage a CSV export from the old account. Rows are applied by the
    // agent's paced worker, not in this request — big lists take a while,
    // and GET /import is the window onto how far it has gotten.
    case '/import': {
      if (!agent.importer) return json(res, 409, { error: 'agent not connected yet' });
      // Unlike the one-shot routes, staging arms a worker that keeps
      // writing for minutes — a device that could not take the lease must
      // not run one alongside the device that holds it.
      const took = await agent.requestTakeover?.();
      if (took === false) {
        return json(res, 503, { error: 'another device is active for this pod — import from there' });
      }
      if (body.clear === true) {
        agent.importer.clear();
        return json(res, 200, { ok: true, cleared: true });
      }
      if (!IMPORT_KINDS.includes(body.kind)) {
        return json(res, 400, { error: `kind must be one of: ${IMPORT_KINDS.join(', ')}` });
      }
      if (typeof body.text !== 'string' || !body.text.trim()) {
        return json(res, 400, { error: 'text required — the CSV file contents' });
      }
      const { values, invalid } = normalizeImport(body.kind, body.text);
      const r = agent.importer.stage(body.kind, values);
      await agent.store.flush();
      return json(res, 200, {
        ok: true, kind: body.kind, ...r,
        invalid: invalid.length,
        ...(invalid.length ? { invalidSample: invalid.slice(0, 5) } : {}),
      });
    }
    case '/retire': {
      // Irreversible and federated: a Delete leaves for every follower and
      // the actor becomes a Tombstone. The typed handle is the interlock —
      // a stray click cannot produce it, and nor can anything that never
      // read the record.
      if (!body.confirm || body.confirm !== agent.store.getConfig()?.handle) {
        return json(res, 400, { error: 'type the handle to confirm' });
      }
      await agent.requestTakeover?.();
      return json(res, 200, { ok: true, ...await agent.publisher.retireActor() });
    }
    default: return false;
  }
}
