// setup.mjs — the first run and the process: setup driven from the page,
// a new actor in a new home, starting a stopped one, updating and
// restarting, moving the private half, and stopping this process.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isCrossSiteNavigation } from '../../../shared/guard.mjs';
import { identityHomes, rootOf, tildify, writeJsonAtomic } from '../../home.mjs';
import { copyPrivateHalf, isCurrent, CURRENT_LAYOUT } from '../../migrate.mjs';
import { insecureUrlReason } from '../../../shared/safefetch.mjs';
import { newRun, preflight, runSetup, setupInputError, hasCredential, credentialPath } from '../../setup.mjs';
import { portFree, freePortFrom } from '../../ports.mjs';
import { yieldDirectory } from '../../../gateway/directory.mjs';
import { localFetch } from '../../../client/localapi.mjs';
import { projectRoot, SETUP_PAGE } from '../static.mjs';
import { secureOrigin } from '../origins.mjs';

// The signup carry-over: gateway and identity parameters a signup page
// recorded for this install (written by the installer, consumed by the first
// setup run). Read fresh each time — the file is deleted once consumed.
function readFirstRun() {
  const file = process.env.AP_FIRST_RUN;
  if (!file) return null;
  try {
    const fr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return fr && typeof fr === 'object' ? fr : null;
  } catch { return null; }
}

// The same config shape the `gateway` CLI command writes.
function gatewayConfigFrom(fr) {
  if (!fr?.gateway || !fr?.secret) return null;
  const target = String(fr.gateway);
  return fr.fronted
    ? { url: target.replace(/ap\/actor$/, 'ap/inbox/'), frontActor: target,
      mode: 'shadow', hmacSecret: String(fr.secret) }
    : { url: target.replace(/\/?$/, '/'), mode: 'shadow', hmacSecret: String(fr.secret) };
}

export async function get(p, ctx, req, res, url) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };

  // ---- setup and configuration, for the pages under /admin/ ----
  // These answer for a group too: a group is set up in the browser like
  // anything else, and it has a display name to change.
  if (req.method === 'GET' && p === '/setup/state') {
    const home = agent.home || null;
    const held = home && hasCredential(home) ? agent.readCredential?.() : null;
    return json(res, 200, {
      hasCredential: !!(home && hasCredential(home)),
      configured: agent.configured(),
      // Not the same question: a crashed setup leaves a credential with no
      // actor behind it, and that is finishable without minting a second.
      resumable: !!(home && hasCredential(home)) && !agent.configured(),
      running: ctx.setup.run?.phase === 'running',
      phase: ctx.setup.run?.phase || 'idle',
      home,
      port,
      handle: agent.store.getConfig()?.handle || allowed.label || null,
      kind: agent.store.getConfig()?.kind || null,
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
      // Set in the environment, the password never needs to reach the page.
      passwordSupplied: !!process.env.AP_PASSWORD,
      identity: held ? { pod: held.remotePod, issuer: held.issuerOrigin, root: held.root || null } : null,
      defaults: { issuer: 'https://solidcommunity.net', port: 8030 },
      // What a signup page arranged for this install, so the form opens
      // pre-filled. The receipt secret stays out of it — the /setup run
      // reads that from the file itself.
      firstRun: (() => {
        if (agent.configured()) return null;
        const fr = readFirstRun();
        if (!fr?.handle) return null;
        let gatewayHost = null;
        try { gatewayHost = new URL(fr.gateway).host; } catch { /* no gateway named */ }
        return { pod: fr.pod || null, issuer: fr.issuer || null, handle: String(fr.handle),
          kind: fr.kind === 'group' ? 'group' : 'person', fronted: !!fr.fronted, gatewayHost };
      })(),
    });
  }
  if (req.method === 'GET' && p === '/setup/progress') {
    return json(res, 200, ctx.setup.run || { phase: 'idle', steps: [], error: null, result: null });
  }

  return false;
}

export async function post(p, body, ctx, req, res) {   // eslint-disable-line no-unused-vars
  const { agent, log, allowed, embedded, port, publicOrigin, versionOnDisk, isGroup } = ctx;   // eslint-disable-line no-unused-vars
  const json = (res, status, obj) => { ctx.json(res, status, obj); return true; };
  switch (p) {
    // Stop an agent whose pidfile is gone and which no terminal owns
    // (backgrounded, orphaned by a closed shell). It used to sit ABOVE both
    // the configured() gate and the isLocal one, so it was the only
    // state-changing route that needed neither — reachable from any host
    // AP_ALLOWED_HOSTS named, on an agent that had never been set up.
    case '/shutdown': {
      json(res, 200, { ok: true, stopping: process.pid });
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
      return true;
    }
    // ---- setup, driven by the page at /admin/setup/ ----
    case '/setup/check': return json(res, 200, preflight(body));
    // Discard a credential that never finished setup, so the account and
    // pod can be entered again. The credential a CSS server mints is shown
    // once, so a setup that stops after the mint (a wrong pod answers 401
    // to the first write) leaves the form in "finish" mode with no way to
    // re-enter what was wrong. This removes it locally and reopens the full
    // form. It does NOT revoke server-side — that needs the account
    // password (`fedipod revoke-credential`); the old credential is left on
    // the account, revocable from its dashboard.
    case '/setup/reset': {
      if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
      // A working identity is never swapped out this way — that is a
      // teardown (`fedipod retire`), not a half-finished setup.
      if (agent.configured()) {
        return json(res, 409, { error: 'this home holds a working identity — retire it, do not reset' });
      }
      if (ctx.setup.run?.phase === 'running') {
        return json(res, 409, { error: 'setup is running — let it finish or stop it first', phase: 'running' });
      }
      const home = agent.home;
      if (!home) return json(res, 500, { error: 'this agent has no AP_HOME to reset' });
      const removed = hasCredential(home);
      if (removed) fs.rmSync(credentialPath(home), { force: true });
      // Drop the pod handle too, so configured() cannot flicker true off a
      // stale in-memory session while the fresh form is filled in.
      agent.remote = null;
      ctx.setup.run = null;
      return json(res, 200, { ok: true, removed });
    }
    case '/setup': {
      // A visited page must not be able to navigate this into existence.
      if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
      if (agent.configured()) {
        return json(res, 409, {
          error: 'this home already holds an identity',
          pod: agent.store.getConfig()?.remotePod || null,
        });
      }
      if (ctx.setup.run?.phase === 'running') {
        return json(res, 409, { error: 'setup is already running', phase: 'running' });
      }
      const home = agent.home;
      if (!home) return json(res, 500, { error: 'this agent has no AP_HOME to set up' });
      // A crashed setup left a credential with no actor behind it. That is
      // finishable, and must NOT mint a second credential — the first is
      // unrecoverable and would be orphaned.
      const resuming = hasCredential(home);
      const answers = { ...body, password: body.password || process.env.AP_PASSWORD || '' };
      // The signup carry-over: attach to the gateway the signup arranged,
      // set before the first publish so the actor never advertises the pod
      // inbox first. The secret comes from the installer's file, never the
      // page.
      const gatewayCfg = gatewayConfigFrom(readFirstRun());
      if (gatewayCfg) answers.gateway = gatewayCfg;
      const bad = setupInputError(answers, resuming);
      if (bad) return json(res, 400, { error: bad });
      if (!resuming) {
        const pre = preflight(answers);
        if (!pre.ok) return json(res, 400, { ...pre, error: pre.error || pre.refusal });
      }
      // Widen the allowlist now, not at the end: the page offers to move to
      // the named origin, which has to answer before it is offered.
      allowed.setHandle(answers.handle);
      ctx.setup.run = newRun();
      // Deliberately not awaited. The credential a CSS server mints is
      // shown once, so what a run depends on is the file it writes, never
      // a connection a closed tab can take with it.
      runSetup({ home, agent, answers, run: ctx.setup.run, log })
        .then((r) => {
          // The carried secret is consumed; a finished setup deletes it.
          if (r?.phase === 'done' && process.env.AP_FIRST_RUN) {
            try { fs.unlinkSync(process.env.AP_FIRST_RUN); } catch { /* already gone */ }
          }
        })
        .catch(e => { ctx.setup.run.phase = 'error'; ctx.setup.run.error = e.message; });
      return json(res, 202, { ok: true, running: true, resuming });
    }
    // One identity per home, so a new actor means a new home, a free port
    // and a process there — then its own setup, run with the answers this
    // page collected. The reply is the address of the new actor's page,
    // which is where the progress of that setup is reported.
    case '/new-actor': {
      if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
      const handle = String(body.handle || '').trim().toLowerCase();
      // The name first, and before anything is created: it is what becomes
      // a directory, and "mode must be new or existing" is a poor answer to
      // a handle that could climb out of profiles/.
      // Named after the handle rather than generated, so `profiles` and
      // `--profile <name>` stay legible a year from now.
      if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(handle)) {
        return json(res, 400, { error: 'a handle is letters, digits, hyphens and underscores' });
      }
      const dir = path.join(rootOf(path.resolve(agent.home || '')), 'profiles', handle);
      if (fs.existsSync(path.join(dir, 'credential.json'))) {
        return json(res, 409, { error: `${handle} already exists — it is in the list above` });
      }
      // Then everything else setup needs, so a missing password is refused
      // here rather than after a process has been started for it.
      const bad = setupInputError({ ...body, handle });
      if (bad) return json(res, 400, { error: bad });
      const newPort = await freePortFrom(port + 1);
      if (!newPort) return json(res, 503, { error: 'no free port in the next 50' });
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const child = spawn(process.execPath, [path.join(projectRoot, 'run-agent.mjs')], {
        detached: true, stdio: 'ignore',
        env: { ...process.env, AP_HOME: dir, AP_PORT: String(newPort), AP_PROFILE: '' },
      });
      child.unref();
      // Answer only once it is listening: handing back a URL that is not
      // up yet shows a connection error instead of the setup form.
      let listening = false;
      for (let i = 0; i < 60 && !listening; i++) {
        await new Promise(r => setTimeout(r, 250));
        listening = await localFetch(agent.home, newPort, '/status', { timeout: 1000 })
          .then(r => r.ok).catch(() => false);
      }
      if (!listening) return json(res, 504, { error: `started it on ${newPort} but it never answered` });

      // Its own /setup owns the work — minting the credential, provisioning
      // the pod, publishing. It answers 202 and runs in the background, so
      // the page that opens next is the one reporting progress.
      const started = await localFetch(agent.home, newPort, '/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, handle }),
      }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }))
        .catch(e => ({ status: 0, json: { error: e.message } }));
      if (started.status !== 202) {
        return json(res, started.status || 502, {
          error: started.json?.error || `the new agent refused setup (HTTP ${started.status})`,
          port: newPort, url: `${secureOrigin(handle, newPort)}${SETUP_PAGE}`,
        });
      }
      return json(res, 200,
        { ok: true, handle, port: newPort,
          url: `${secureOrigin(handle, newPort)}${SETUP_PAGE}` });
    }
    // Start an actor that is not running, so its page can be visited. The
    // same spawn as /new-actor, minus the making: this one has a home
    // already. Its recorded port is preferred so its address stays what it
    // was, but a port something else has taken is walked past, not fought.
    case '/start-actor': {
      if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
      const name = String(body.name || '');
      const found = identityHomes(rootOf(path.resolve(agent.home || ''))).find(h => h.name === name);
      if (!found) return json(res, 404, { error: `no identity called ${name}` });

      let want = null;
      try { want = JSON.parse(fs.readFileSync(path.join(found.dir, 'agent.json'), 'utf8')).port || null; } catch {}
      if (want) {
        // Its own handle, not the profile directory's name: usually the
        // same, but a renamed profile makes them differ and the origin has
        // to be one that agent's own guard will accept.
        const live = await localFetch(agent.home, want, '/status', { timeout: 1000 })
          .then(r => (r.ok ? r.json() : null)).catch(() => null);
        if (live) {
          return json(res, 200, {
            ok: true, name, port: want, already: true,
            url: `${secureOrigin(live.handle || name, want)}/`,
          });
        }
      }
      // The port is not the only evidence it is running. An agent from
      // before agent.json was written at startup has a live pidfile and no
      // recorded port, and spawning past that gives one home two agents —
      // which is exactly how this machine ended up with two on profiles/jeff.
      let held = null;
      try { held = Number(fs.readFileSync(path.join(found.dir, 'agent.pid'), 'utf8').trim()) || null; } catch {}
      if (held) {
        let alive = false;
        try { process.kill(held, 0); alive = true; } catch { /* gone */ }
        if (alive) {
          return json(res, 409, {
            error: `${name} is already running as pid ${held}, on a port it never recorded. `
              + `Stop it first:  kill ${held}`,
          });
        }
      }
      // A recorded port held by the directory door is still this
      // identity's port — the door steps aside for its owner.
      if (want && !await portFree(want)) await yieldDirectory(want, { portFree });
      const on = (want && await portFree(want)) ? want : await freePortFrom(port + 1);
      if (!on) return json(res, 503, { error: 'no free port in the next 50' });

      const started = spawn(process.execPath, [path.join(projectRoot, 'run-agent.mjs')], {
        detached: true, stdio: 'ignore',
        env: { ...process.env, AP_HOME: found.dir, AP_PORT: String(on), AP_PROFILE: '' },
      });
      started.unref();
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 250));
        const up = await localFetch(agent.home, on, '/status', { timeout: 1000 })
          .then(r => (r.ok ? r.json() : null)).catch(() => null);
        if (up) {
          return json(res, 200, { ok: true, name, port: on,
            url: `${secureOrigin(up.handle || name, on)}/` });
        }
      }
      return json(res, 504, { error: `started ${name} on ${on} but it never answered` });
    }
    // Pull the latest published FediPod and restart the agents. What the
    // installer does on a re-run, offered where the version line is.
    case '/update': {
      if (isCrossSiteNavigation(req)) return json(res, 403, { error: 'cross-site request' });
      const { runUpdate, restartAgents, repoRoot } = await import('../../update.mjs');
      const r = runUpdate({ log });
      if (!r.ok) return json(res, 409, { error: r.note });
      json(res, 200, { ok: true, note: r.note, restarting: true });
      // The response first, the restart a beat later — a self-restart must
      // not take the answer down with it.
      setTimeout(() => {
        if (restartAgents({ log }) === 'self') {
          const child = spawn(process.execPath, [path.join(repoRoot(), 'run-agent.mjs')],
            { detached: true, stdio: 'ignore', env: process.env });
          child.unref();
          setTimeout(() => process.exit(0), 300);
        }
      }, 200);
      return true;
    }
    // Move the private half — every state document and the RDF tree — while
    // the agent runs: quiesce this process's writers, flush, copy, verify,
    // repoint the credential, then reconnect on the new location. The old
    // copy is left where it was, exactly as the CLI move leaves it.
    case '/state-move': {
      const cred = agent.readCredential?.();
      if (!cred) return json(res, 409, { error: 'no credential — run setup first' });
      const to = String(body.to || '').trim();
      if (!to) return json(res, 400, { error: 'say where it should go' });
      let target = null;
      if (to !== 'pod') {
        // A path or a URL — two chars before the colon, so a Windows drive
        // letter reads as a path rather than a scheme.
        const asPath = !/^[a-z][a-z0-9+.-]+:/i.test(to);
        const raw = asPath
          ? pathToFileURL(path.resolve(to.replace(/^~(?=[/\\]|$)/, os.homedir()))).href
          : to;
        target = raw.endsWith('/') ? raw : raw + '/';
        try { new URL(target); } catch { return json(res, 400, { error: `"${to}" is not a container URL or a path` }); }
        if (/^https?:/i.test(target)) {
          const bad = insecureUrlReason(target, 'private-data address');
          if (bad) return json(res, 400, { error: bad });
        }
      }
      const whereState = (c) => (c.privateRoot ? tildify(c.privateRoot) : 'on the pod');
      if ((cred.privateRoot || null) === target) {
        return json(res, 200, { ok: true, docs: 0, notes: 0, unchanged: true, now: whereState(cred) });
      }
      await agent.requestTakeover?.();
      agent.intake?.stop(); agent.deliverer?.stop(); agent.tagfeed?.stop(); agent.importer?.stop();
      try {
        await agent.store.flush();
        const destCred = { ...cred, privateRoot: target };
        const copied = await copyPrivateHalf({
          from: { state: agent.privateStorage(cred, 'state') },
          to: { state: agent.privateStorage(destCred, 'state') },
          log,
        });
        if (target) cred.privateRoot = target; else delete cred.privateRoot;
        if (isCurrent(cred)) cred.layout = CURRENT_LAYOUT; else delete cred.layout;
        writeJsonAtomic(path.join(agent.home, 'credential.json'), cred);
        // connect() rebuilds everything that pointed at the old location —
        // store, publisher, intake — and restarts them.
        agent.store.attach(agent.privateStorage(cred, 'state'));
        agent.stateLoaded = false;
        await agent.connect();
        return json(res, 200, { ok: true, ...copied, now: whereState(cred) });
      } catch (e) {
        // The credential is only repointed after a verified copy, so on any
        // failure reconnect puts the agent back to work where it was.
        agent.stateLoaded = false;
        await agent.connect().catch(() => {});
        return json(res, 502, { error: e.message });
      }
    }
    default: return false;
  }
}
