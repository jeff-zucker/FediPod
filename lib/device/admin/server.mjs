// server.mjs — the DeviceAgent's listener: the https servers on both
// loopbacks, the pidfile, the directory door, and the retry when the port is
// held by that door.

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Authorities } from '../../shared/guard.mjs';
import { rootOf } from '../home.mjs';
import { portFree } from '../ports.mjs';
import { claimDirectory, yieldDirectory } from '../../gateway/directory.mjs';
import { ensureTrustedTls } from '../certs.mjs';
import { localVersion } from '../update.mjs';
import { projectRoot } from './static.mjs';
import { secureOrigin } from './origins.mjs';
import { buildAdminSurface } from './surface.mjs';

const require = createRequire(import.meta.url);
const { makeGate } = require(path.join(projectRoot, 'vendor/gate.cjs'));

export function startAdmin({ port, gateToken, agent, log = console.log, handle = null, tls = null,
  // Injectable, so a test can put a checkout ahead of the running process
  // without editing the package.json of the machine running the test.
  versionOnDisk = () => localVersion(projectRoot) }) {
  const gate = makeGate(gateToken);
  // Live, so the named origin appears the moment connect() reads the handle
  // out of pod state — including for the OAuth redirect check in MastoApi.
  // The https listener's port joins the authority set: same names, second port.
  const allowed = new Authorities(port, handle);
  agent.authorities = allowed;
  const { handler, streaming } = buildAdminSurface({ agent, gate, allowed, log, port, handle, versionOnDisk });

  // Loopback both ways: the canonical URL is https://localhost:<port>/, and
  // "localhost" resolves to ::1 on many systems before falling back to IPv4 —
  // answer on both so the same origin always works (one origin = one
  // browser storage = one login). There is one listener and it is https: the
  // port you name is the port you browse.
  // Every listener here is https, so a caller that did not bring a certificate
  // gets this install's own rather than an exception: throwing here killed the
  // signal handlers registered after the call, and the agent became unstoppable.
  if (!tls) {
    tls = ensureTrustedTls(path.join(rootOf(agent.home || os.tmpdir()), 'certs'),
      { log, names: allowed.label ? [`${allowed.label}.localhost`] : [] });
  }
  const tlsOpts = { key: tls.key, cert: tls.cert };
  const server = https.createServer(tlsOpts, handler);
  streaming.attach(server);
  const server6 = https.createServer(tlsOpts, handler);
  streaming.attach(server6);
  server6.on('error', () => { /* no IPv6 loopback on this system — IPv4 covers it */ });
  const onListen = () => {
    // Pidfile for `fedipod stop` — written only AFTER the listen
    // succeeds, so a port-race loser can never clobber the live agent's pid.
    try {
      if (agent.home) fs.writeFileSync(path.join(agent.home, 'agent.pid'), String(process.pid) + '\n');
    } catch { /* stop will report no pidfile */ }
    // The named origin when there is one: on a detached start this line is the
    // only record of where to browse, and sending you to the shared origin is
    // how two identities end up in one browser storage bucket.
    log(`FediPod on ${secureOrigin(allowed.label, port)}/ (UI + API)`
      + (tls.trust ? '' : ' (self-signed — your client may ask once to trust it)'));
    // Hold the well-known door: whoever answers on the directory port sends the
    // browser to its own record page, which lists every identity on this
    // machine. Only a configured agent qualifies — an unconfigured one's record
    // page is a setup form with no identity list.
    const door = claimDirectory({ port,
      origin: () => secureOrigin(allowed.label, port),
      log, eligible: () => agent.configured(), tls });
    // Closing the IPv4 listener has to take the IPv6 one and the door with it,
    // or a shutdown leaves a listening handle and the process never exits.
    server.on('close', () => { door.stop(); try { server6.close(); } catch { /* already down */ } });
  };
  let retriedDoor = false;
  server.on('error', async (e) => {
    if (e.code === 'EADDRINUSE') {
      // The directory door yields to a real owner of its port; anything else
      // holding it is a genuine conflict.
      if (!retriedDoor && await yieldDirectory(port, { portFree, home: agent.home })) {
        retriedDoor = true;
        server.listen(port, '127.0.0.1', onListen);
        if (!server6.listening) server6.listen(port, '::1');
        return;
      }
      log(`port ${port} is already in use by another server — set AP_PORT to a free port and retry`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(port, '127.0.0.1', onListen);
  server6.listen(port, '::1');

  return server;
}
