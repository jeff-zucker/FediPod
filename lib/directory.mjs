// directory.mjs — the well-known door. Whichever running agent holds port
// 8030 answers there with a redirect to its own record page, so opening
// https://localhost:9030/ (or the plain listener on 8030) always reaches a
// page that lists every identity on this machine, whatever ports they
// actually run on. Loopback only. Held only by a CONFIGURED agent: an
// unconfigured one's record page is a setup form with no identity list,
// which strands whoever the door sends there.
//
// The door is held politely: it identifies itself at GET /__directory, and a
// real owner of the port — an identity that recorded 8030 as its own — asks it
// to step aside with POST /__directory/yield before binding. The holder frees
// the port at once and stays off it for a minute. AP_DIRECTORY=0 disables the
// whole mechanism (the test suite sets it, so throwaway agents do not fight
// over a real machine's door).
import http from 'node:http';
import https from 'node:https';

export const DIRECTORY_PORT = 8030;
// The advertised door: the same claim, behind the machine's certificate.
export const DIRECTORY_HTTPS_PORT = 9030;

// Answer for a running agent. No-op when this agent already IS the door, or
// when the mechanism is switched off. `eligible` is asked before every claim
// attempt — the 15 s retry means an agent that configures later takes the
// door soon after, and one that never does never holds it.
export function claimDirectory({ port, origin, log = () => {}, eligible = () => true, tls = null }) {
  if (process.env.AP_DIRECTORY === '0' || port === DIRECTORY_PORT) {
    return { stop: () => {} };
  }
  const servers = [];
  let held = false;
  let pausedUntil = 0;
  const handler = (req, res) => {
    const p = req.url || '/';
    if (p === '/__directory') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ directory: true, agent: origin() }) + '\n');
      return;
    }
    if (req.method === 'POST' && p === '/__directory/yield') {
      pausedUntil = Date.now() + 60_000;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}\n');
      release();
      log(`directory: yielded port ${DIRECTORY_PORT}`);
      return;
    }
    res.writeHead(302, { location: origin().replace(/\/$/, '') + p });
    res.end();
  };
  const release = () => {
    for (const s of servers.splice(0)) { try { s.close(); } catch { /* already down */ } }
    held = false;
  };
  const tryClaim = () => {
    if (held || !eligible() || Date.now() < pausedUntil) return;
    // Loopback both ways, like the agent's own listener: "localhost" resolves
    // to ::1 first on many systems. IPv4 is the one that decides `held`.
    const s4 = http.createServer(handler);
    s4.on('error', () => { /* someone else holds the door — retry later */ });
    s4.listen(DIRECTORY_PORT, '127.0.0.1', () => {
      held = true;
      servers.push(s4);
      const s6 = http.createServer(handler);
      s6.on('error', () => { /* no IPv6 loopback here — IPv4 covers it */ });
      s6.listen(DIRECTORY_PORT, '::1', () => servers.push(s6));
      // The advertised door rides with the plain one: same claim, same
      // release, behind the machine's certificate.
      if (tls) {
        const tlsOpts = { key: tls.key, cert: tls.cert };
        const t4 = https.createServer(tlsOpts, handler);
        t4.on('error', () => { /* the https door is optional; 8030 still answers */ });
        t4.listen(DIRECTORY_HTTPS_PORT, '127.0.0.1', () => servers.push(t4));
        const t6 = https.createServer(tlsOpts, handler);
        t6.on('error', () => { /* no IPv6 loopback here — IPv4 covers it */ });
        t6.listen(DIRECTORY_HTTPS_PORT, '::1', () => servers.push(t6));
        log(`directory: https://localhost:${DIRECTORY_HTTPS_PORT}/ now reaches ${origin()}`);
      } else {
        log(`directory: http://localhost:${DIRECTORY_PORT}/ now reaches ${origin()}`);
      }
    });
  };
  tryClaim();
  const timer = setInterval(tryClaim, 15_000);
  timer.unref();
  return { stop: () => { clearInterval(timer); release(); } };
}

// Free `port` if what holds it is the directory door. Returns true when the
// port is free afterwards. Quick and quiet on every other kind of holder.
export async function yieldDirectory(port, { portFree } = {}) {
  const probe = await fetch(`http://localhost:${port}/__directory`, { signal: AbortSignal.timeout(1000) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!probe?.directory) return false;
  await fetch(`http://localhost:${port}/__directory/yield`, { method: 'POST', signal: AbortSignal.timeout(1000) })
    .catch(() => {});
  if (!portFree) return true;
  for (let i = 0; i < 10; i++) {
    if (await portFree(port)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
