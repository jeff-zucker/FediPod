// localapi.mjs — talking to an agent on this machine.
//
// The agent serves https and nothing else, on the one port it was given. Its
// certificate is signed by this install's own certificate authority, which no
// public trust store knows about, so a plain fetch() would refuse it. Every
// caller here is on loopback reaching a listener this install started, so the
// answer is to trust that one authority — never to skip verification.
//
// Returns a small fetch-shaped result ({ status, ok, text(), json() }) so call
// sites read the way they did when this was cleartext http.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { rootOf, apRoot } from './home.mjs';
import { certPaths } from './certs.mjs';

/**
 * The authorities worth offering for a loopback call: this install's, and the
 * machine's default install's. The well-known door on 8030 is held by
 * whichever agent got there first, which may belong to a different root than
 * the one this command is acting in — so both are candidates. An empty list
 * means no certificate has been minted anywhere, and the call will fail the
 * way any unreachable agent does.
 */
export function localCa(home) {
  const read = (root) => {
    try { return fs.readFileSync(certPaths(path.join(root, 'certs')).caCert); } catch { return null; }
  };
  // This install's own authority decides, and alone: every install names its
  // authority the same thing, so offering two lets the verifier match by name
  // and then fail on the signature. Only an install with no authority of its
  // own falls back to the machine's default — that is the case of a command
  // run outside any install reaching the well-known door.
  const mine = home ? read(rootOf(home)) : null;
  if (mine) return [mine];
  try { const fallback = read(apRoot()); if (fallback) return [fallback]; } catch { /* no home dir */ }
  return null;
}

/**
 * One request to an agent on this machine. `home` names any identity under the
 * install, which is how the CA is found; `port` is the agent's own port.
 */
export async function localFetch(home, port, pathname, opts = {}) {
  const res = await once(home, port, pathname, opts);
  // The well-known door answers with a redirect to whichever agent holds it,
  // so a probe that lands there has to follow it the way fetch() would.
  if (opts.redirect === 'manual' || res.status < 300 || res.status >= 400) return res;
  const to = res.headers?.location;
  if (!to) return res;
  const target = new URL(to, `https://localhost:${port}`);
  return once(home, Number(target.port) || 443, target.pathname + target.search, opts);
}

function once(home, port, pathname, { method = 'GET', headers = {}, body, timeout = 0 } = {}) {
  const ca = localCa(home);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'localhost', port, path: pathname, method,
      // One-shot calls: a kept-alive socket holds the agent's listener open, so
      // a shutdown asked for over this channel would never finish.
      headers: { connection: 'close', ...headers },
      ...(ca ? { ca } : {}),
      // The certificate carries localhost and *.localhost; on some systems
      // "localhost" resolves to ::1 first, which the name check still covers.
      servername: 'localhost',
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: res.headers,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timed out')));
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });
}
