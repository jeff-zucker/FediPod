// run-agent.mjs — fedipod: a standalone single-actor ActivityPub
// agent. The remote pod is a RELAY: it serves the public wire face
// (/fedipod/ap/) and buffers inbound mail in a public-append inbox
// while this process is off, and it keeps one private document, the lease,
// because a lock only one machine can reach coordinates nothing.
//
// Everything else private is on THIS machine — the RDF truth and the
// operational state, in a directory beside the credential and the signing key.
// So a machine holding only the credential file does NOT resume the actor: it
// resumes the identity with an empty timeline, contacts, blocklist and
// notifications, and `fedipod rebuild` recovers the posts the pod still
// carries. `privateRoot` absent in credential.json is the pre-2026-08-03
// layout and still means both trees are on the pod; `fedipod upgrade`
// says so and `state --all` moves them.
//
//   node run-agent.mjs                      # or: bin/fedipod.mjs run
//
// Env: AP_HOME (credential dir + local log, default ~/.fedipod, or
//      ~/.activitypod on an install that predates the rename — see lib/device/home.mjs),
//      AP_PORT (UI/API/admin, default 8030),
//      AP_GATE_TOKEN (optional loopback gate; absent → open, loopback-only).
//
// Until `bin/fedipod.mjs setup` has minted a credential the agent idles:
// UI + admin up, no federation.


import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Agent } from './lib/core/agent.mjs';
import { apRoot, rootOf } from './lib/device/home.mjs';
import { writeJsonAtomic } from './lib/shared/files.mjs';
import { ensureTrustedTls } from './lib/device/certs.mjs';
import { startAdmin } from './lib/device/admin/index.mjs';
import { exposureProblem, hostLabel } from './lib/shared/guard.mjs';
import { pendingSteps } from './lib/device/migrate.mjs';

// The class is imported from here by the callers that always did.
export { Agent };

// Two megabytes is a few weeks of an ordinary agent's chatter, and small
// enough that reading the whole thing is still reasonable.
const LOG_MAX_BYTES = 2 * 1024 * 1024;

export async function startAgent({
  home = process.env.AP_HOME || apRoot(),
  port = Number(process.env.AP_PORT) || 8030,
  gateToken = process.env.AP_GATE_TOKEN || '',
  name = null,
  takeover = false,
  handle = null,
} = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // A home can hold a FORUM rather than a person or a group; its credential
  // says so. A forum is run by its own package (`fedipod-bb start`), and
  // running this agent over its home would publish a person where a forum
  // lives.
  try {
    const cred = JSON.parse(fs.readFileSync(path.join(home, 'credential.json'), 'utf8'));
    if (String(cred.root || '').replace(/\/$/u, '') === 'fedipod-bb') {
      console.error(`${home} holds a forum — run it with: fedipod-bb start --home ${home}`);
      process.exit(2);
    }
  } catch { /* no credential yet, or not a forum */ }
  // connect() sets this from pod state a moment later, but the browser may
  // already be opening — seed it from what setup recorded so the named origin
  // works from the first request.
  // agent.json is how everything else finds this agent afterwards — `profiles`,
  // `stop`, the Actors list. The CLI used to be the only thing that wrote it, so
  // an agent spawned any other way (the admin page starts them now) ran
  // invisibly on a port nobody could look up. Merge, so `handle` survives.
  const agentJson = path.join(home, 'agent.json');
  let recorded = {};
  try { recorded = JSON.parse(fs.readFileSync(agentJson, 'utf8')) || {}; } catch { /* first run */ }
  if (!handle) handle = recorded.handle || null;
  if (recorded.port !== port) {
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      writeJsonAtomic(agentJson, { ...recorded, port }, { mode: 0o644 });
    } catch { /* the agent still runs; it is just harder to find */ }
  }
  const logFile = path.join(home, 'agent.log');
  const agent = new Agent({ home, log: () => {}, upgradeCheck: pendingSteps });
  // The port on every line. Agents sharing a home share agent.log, and without
  // it there is no way to tell which one wrote what — a viewer's startup reads
  // as the active one's work.
  const log = (...a) => {
    const line = `${new Date().toISOString()} :${port} ${a.join(' ')}`;
    console.log(`[ap:${port}]`, ...a);
    agent.logRing.push(line);
    if (agent.logRing.length > 500) agent.logRing.shift();
    try {
      // Rotated, because nothing else was ever going to. This file is appended
      // to on every drain, every delivery and every lease event, for the life
      // of an agent that is meant to run for months — on a phone under Termux
      // especially, an unbounded log is the thing that fills the disk. One
      // previous generation is kept; a crash investigation rarely wants two.
      if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
    } catch { /* no log yet, or a rename we cannot do — appending still works */ }
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* logging must never throw */ }
  };
  agent.log = log;
  agent.store.log = log;
  // Before the socket, not after: an agent that must not be reachable at that
  // address must never have answered there. This used to be a warning said at
  // connect time, which is both too late (the server has been listening for
  // seconds) and too narrow (it only ever described the OAuth login).
  const exposure = exposureProblem({ allowedHosts: process.env.AP_ALLOWED_HOSTS, gateToken });
  if (exposure) {
    log(`refusing to start:\n${exposure}`);
    process.exit(2);
  }
  // https and nothing else, on the one port this agent was given: a
  // per-machine certificate (never packaged — see lib/certs.mjs), covering
  // every identity on this root. A certificate problem stops the start rather
  // than quietly serving the UI and the API in the clear.
  let tls = null;
  try {
    tls = ensureTrustedTls(path.join(rootOf(agent.home), 'certs'),
      { log, names: hostLabel(handle) ? [`${hostLabel(handle)}.localhost`] : [] });
  } catch (e) {
    log(`refusing to start: certificate setup failed (${e.message})`);
    log('the agent serves https only — fix the certificate, or run `fedipod https --trust`');
    process.exit(2);
  }
  startAdmin({ port, gateToken, agent, log, handle, tls });

  // Is a newer FediPod published? Once at boot and daily after; the answer
  // rides /status and the record page offers the update.
  const updateTick = async () => {
    const { checkLatest } = await import('./lib/device/update.mjs');
    const u = await checkLatest();
    if (u) {
      agent.updateInfo = u;
      if (u.available) log(`FediPod ${u.latest} is available (running ${u.current}) — update from the record page or \`fedipod update\``);
    }
  };
  void updateTick();
  setInterval(updateTick, 24 * 3600e3).unref?.();

  // The pod (or its issuer) can be briefly unreachable — a 504 from the
  // token endpoint, or no network yet at boot under install-service. Keep
  // retrying with backoff instead of sitting unconfigured until someone
  // notices; the UI stays up throughout.
  const connectWithRetry = async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const up = await agent.connect({ name });
        if (up) {
          // A lease whose holder is gone but not expired would otherwise leave
          // us read-only for the whole TTL.
          if (takeover && agent.viewer) await agent.takeOver();
          return;
        }
        log('unconfigured — run `bin/fedipod.mjs setup` to begin');
        return;                                    // no credential: retrying won't help
      } catch (e) {
        // Caps at an hour, not ten minutes: a pod that has refused for an hour
        // is not going to be helped by asking six times more per hour, and an
        // agent left running for days should not be a fixture in its logs.
        // Jittered so restarts of several agents do not line up.
        const base = Math.min(30 * 2 ** (attempt - 1), 3600);
        const wait = Math.round(base * (0.8 + Math.random() * 0.4));
        log(`connect failed (attempt ${attempt}): ${e.message} — retrying in ${wait}s`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
    }
  };
  connectWithRetry();
  const shutdown = () => {
    setTimeout(() => process.exit(0), 1500).unref();   // never hang a stop on a slow pod
    try { fs.rmSync(path.join(home, 'agent.pid'), { force: true }); } catch {}
    Promise.allSettled([
      agent.store.flush(),
      agent.viewer ? Promise.resolve() : agent.lease?.release(),
    ]).finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return agent;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startAgent();
}
