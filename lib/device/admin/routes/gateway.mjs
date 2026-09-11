// gateway.mjs — the inbox gateway lifecycle: configure, mode, check, attach
// through a front, forget.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function post(p, body, ctx, req, res) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };
  switch (p) {
    // The inbox gateway lifecycle (opt-in). `configure` points at a
    // deployed gateway (and reveals the HMAC secret once, to paste into
    // its env); `mode` walks off→shadow→trust→locked and back, each step
    // reversible; `forget` clears it and restores the pod inbox.
    case '/gateway': {
      const cfg = { ...agent.store.getConfig() };
      const g = { ...(cfg.gateway || {}) };
      const inboxUrl = agent.publisher?.urls?.inbox;
      // Availability is a read: answered before the lease takeover below,
      // which every real gateway change does want.
      if (body.action === 'check') {
        const front = String(body.front || '').replace(/\/+$/, '');
        try { new URL(front); } catch { return json(res, 400, { error: 'front must be a gateway origin URL' }); }
        const chk = await fetch(`${front}/api/handle?handle=${encodeURIComponent(String(body.handle || '').toLowerCase())}`,
          { headers: { accept: 'application/json' } }).then((r) => r.json()).catch(() => null);
        if (!chk) return json(res, 502, { error: `${front} did not answer its handle check` });
        return json(res, 200, { available: !!chk.available, reason: chk.reason || null });
      }
      await agent.requestTakeover?.();
      const persist = async () => {
        cfg.gateway = g; agent.store.setConfig(cfg);
        if (agent.publisher) agent.publisher.config.gateway = g;
        await agent.store.flush();
      };
      // Fronting renames the actor's ids; the signing key is the same
      // identity's and moves with it, wherever the key record lives.
      const restampKeys = async (actorId) => {
        try {
          const kp = path.join(agent.home, 'keys.json');
          const rec = JSON.parse(fs.readFileSync(kp, 'utf8'));
          if (rec.mintedFor) { rec.mintedFor = actorId; fs.writeFileSync(kp, JSON.stringify(rec)); return; }
        } catch { /* not local — try pod state */ }
        const podRec = agent.store.read('keys.json', null);
        if (podRec?.mintedFor) { podRec.mintedFor = actorId; agent.store.write('keys.json', podRec); await agent.store.flush(); }
      };
      const podActorId = () => {
        const base = cfg.remotePod.endsWith('/') ? cfg.remotePod : `${cfg.remotePod}/`;
        const root = cfg.root ? (cfg.root.endsWith('/') ? cfg.root : `${cfg.root}/`) : 'activitypods-js/';
        return `${base}${root}ap/actor`;
      };
      // The reply first, the restart a beat later — same shape as /update.
      const selfRestart = (why) => setTimeout(() => {
        log(why);
        if (process.env.INVOCATION_ID) { process.exit(1); return; }   // systemd: Restart=on-failure respawns
        const child = spawn(process.execPath, process.argv.slice(1),
          { detached: true, stdio: 'ignore', env: process.env });
        child.unref();
        setTimeout(() => process.exit(0), 300);
      }, 200);
      if (body.action === 'configure') {
        if (!/^https:\/\/\S+$/.test(String(body.url || ''))) return json(res, 400, { error: 'gateway url must be https' });
        if (!/^https?:\/\/\S+$/.test(String(body.webId || ''))) return json(res, 400, { error: 'gateway webId must be a URL' });
        g.url = String(body.url); g.webId = String(body.webId);
        g.hmacSecret = g.hmacSecret || crypto.randomBytes(32).toString('base64');
        g.mode = g.mode || 'off';
        // The fronted actor URL, for a multi-user front that gives this
        // identity a @name@front handle: the agent then publishes and signs
        // under it. Optional; setting it on a published identity renames
        // every id (a Move), so it belongs at setup or a fresh identity.
        if ('frontActor' in body) {
          const fa = String(body.frontActor || '');
          if (fa && !/^https:\/\/\S+\/ap\/actor$/.test(fa)) {
            return json(res, 400, { error: 'frontActor must be an https …/ap/actor URL' });
          }
          g.frontActor = fa || undefined;
        }
        await persist();
        // The one time the secret is returned: the operator pastes it into
        // the gateway's deploy env. /gateway GET never reveals it again.
        return json(res, 200, { ok: true, mode: g.mode, url: g.url, webId: g.webId, hmacSecret: g.hmacSecret });
      }
      if (body.action === 'mode') {
        const target = body.mode;
        if (!['off', 'shadow', 'trust', 'locked'].includes(target)) {
          return json(res, 400, { error: 'mode must be off, shadow, trust or locked' });
        }
        if (target !== 'off' && !g.url) return json(res, 400, { error: 'point at a gateway first (action: configure)' });
        // Locking needs the door's own WebID to name in the ACL. Without it
        // the mode used to persist and the ACL be written for an undefined
        // agent, leaving config and pod disagreeing about who may write.
        if (target === 'locked' && !g.webId) {
          return json(res, 400, {
            error: 'locked needs the gateway\'s WebID — set it with action: configure, webId: <door-webid>',
          });
        }
        const prev = g.mode || 'off';
        // The ACL first: a lock that fails must not leave the mode recorded
        // as locked while the pod still accepts anyone's writes.
        if (target === 'locked') await agent.publisher?.lockInboxToGateway(g.webId);
        else if (prev === 'locked' && inboxUrl) await agent.remote.setAcl(inboxUrl, ['Append']);
        g.mode = target;
        await persist();
        // Advertisement flips only when crossing the off boundary (the actor
        // doc's inbox changes → publishProfile republishes, digest-gated).
        if ((prev === 'off') !== (target === 'off')) await agent.publisher?.publishProfile();
        else if (target !== 'off') await agent.publisher?.publishGatewayPolicy().catch(() => {});
        return json(res, 200, { ok: true, mode: g.mode });
      }
      // Attach through a multi-user front (fedipod.net and kin): the agent
      // proves the pod with its own credential — no browser, no password —
      // and the front answers with the door and the receipt secret.
      if (body.action === 'attach') {
        const front = String(body.front || '').replace(/\/+$/, '');
        let fu;
        try { fu = new URL(front); } catch { return json(res, 400, { error: 'front must be the gateway origin, like https://fedipod.net' }); }
        if (fu.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$|\.localhost$/.test(fu.hostname)) {
          return json(res, 400, { error: 'front must be https' });
        }
        if (agent.embedded) {
          return json(res, 400, { error: 'this identity runs inside its pod server and has no portable credential — attach from a standalone agent' });
        }
        const named = !!String(body.handle || '').trim();
        let handle = String(body.handle || cfg.handle || '').toLowerCase().trim();
        if (!handle) return json(res, 400, { error: 'a name at the gateway is required' });
        const fronted = body.fronted === true;
        // Availability first, for a clean answer before anything is created.
        const avail = async (h) => fetch(`${front}/api/handle?handle=${encodeURIComponent(h)}`,
          { headers: { accept: 'application/json' } }).then((r) => r.json()).catch(() => null);
        let chk = await avail(handle);
        if (!chk) return json(res, 502, { error: `${front} did not answer its handle check` });
        // An unnamed door name is plumbing nobody reads: walk to a free
        // variant instead of failing over a label the user never chose.
        if (!chk.available && !named) {
          for (let i = 2; i <= 9 && !chk.available; i++) {
            const cand = `${handle}${i}`;
            const c = await avail(cand);
            if (c?.available) { handle = cand; chk = c; }
          }
        }
        if (!chk.available) return json(res, 409, { error: chk.reason || `the name ${handle} is taken at ${front}` });
        const frontActor = `${front}/u/${handle}/ap/actor`;
        if (g.frontActor && (!fronted || g.frontActor !== frontActor)) {
          return json(res, 400, { error: `this identity already fronts through ${g.frontActor} — changing a published front renames every id; detach first if you mean it` });
        }
        const attach = await agent.remote.session.fetch(`${front}/api/attach`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ handle, podHome: agent.urls.home, kind: cfg.kind || 'person', fronted }),
        }).catch(() => null);
        if (!attach) return json(res, 502, { error: `${front} did not answer the attach` });
        const d = await attach.json().catch(() => ({}));
        if (attach.status !== 201) {
          return json(res, attach.status >= 400 && attach.status < 500 ? attach.status : 502,
            { error: d.error || `attach failed (HTTP ${attach.status})` });
        }
        g.url = String(d.doorInbox || `${front}/u/${handle}/ap/inbox/`);
        if (d.hmacSecret) g.hmacSecret = String(d.hmacSecret);
        if (fronted) g.frontActor = String(d.frontActor || frontActor);
        if (!g.mode || g.mode === 'off') g.mode = 'shadow';
        await persist();
        // Inbox-only applies live: the actor republishes advertising the
        // door. A front carries new ids, which are wired at startup — so a
        // fronted attach restarts this agent itself, the reply going out
        // first so it is not taken down with the process.
        if (!fronted) {
          await agent.publisher?.publishProfile();
          await agent.publisher?.publishGatewayPolicy?.().catch(() => {});
          return json(res, 200, { ok: true, mode: g.mode, url: g.url });
        }
        await restampKeys(g.frontActor);
        json(res, 200, { ok: true, mode: g.mode, url: g.url,
          frontActor: g.frontActor, address: d.address || null, restarting: true });
        selfRestart('restarting to publish under the front');
        return true;
      }
      if (body.action === 'forget') {
        const wasLocked = g.mode === 'locked';
        const wasFronted = !!g.frontActor;
        delete cfg.gateway; agent.store.setConfig(cfg);
        if (agent.publisher) agent.publisher.config.gateway = undefined;
        await agent.store.flush();
        if (wasLocked && inboxUrl) await agent.remote.setAcl(inboxUrl, ['Append']).catch(() => {});
        if (wasFronted) {
          // Going home renames every id back to the pod: key and process
          // follow, the same way attach came.
          await restampKeys(podActorId());
          json(res, 200, { ok: true, mode: 'off', forgotten: true, restarting: true });
          selfRestart('restarting under the pod\'s own ids');
          return true;
        }
        await agent.publisher?.publishProfile();   // re-advertise the pod inbox
        return json(res, 200, { ok: true, mode: 'off', forgotten: true });
      }
      return json(res, 400, { error: 'action must be configure, mode, check, attach or forget' });
    }
    default: return false;
  }
}
