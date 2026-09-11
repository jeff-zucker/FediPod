// origins.mjs — the addresses an identity answers on, as a browser must be
// sent to them.

import { allowedAuthorities, hostLabel } from '../../shared/guard.mjs';

// The origin a browser should be sent to for an identity. A browser keys
// storage per ORIGIN, so linking every identity at localhost:<port> files them
// all in one bucket — which is how a client ends up holding one actor's login
// and showing it on another's page. Named whenever the handle is a legal host
// label; bare loopback when it is not, because a mangled name would be an
// origin the other agent's own guard refuses.
export function namedOrigin(handle, port) {
  const label = hostLabel(handle);
  return `http://${label ? label + '.' : ''}localhost:${port}`;
}

// The https origin for an identity, on the one port it was given.
// This is the advertised default — what gets printed, opened and linked; the
// http listener stays served beside it for anything that needs cleartext.
export function secureOrigin(handle, httpsPort) {
  const label = hostLabel(handle);
  return `https://${label ? label + '.' : ''}localhost:${httpsPort}`;
}

export function wsOrigins(port, labels = []) {
  const out = new Set();
  for (const a of allowedAuthorities(port, labels)) {
    // No IPv6 at all. Bare `::1` cannot carry a port, and Chrome rejects the
    // bracketed form inside a CSP source expression — one invalid source makes
    // it drop the whole directive, which is worse than not listing the socket.
    if (a.startsWith('::') || a.startsWith('[')) continue;
    out.add(`wss://${/:\d+$/.test(a) ? a : `${a}:${port}`}`);
  }
  return [...out];
}
