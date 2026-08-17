// guard.mjs — the browser-facing firewall. A loopback HTTP server is
// reachable by any web page the user visits, and DNS rebinding lets such a
// page keep its own origin while its requests land here — so binding to
// loopback is NOT an access control. Two header checks close that door:
//
//   Host   must name a loopback authority we expect (or an operator-declared
//          host) — a rebound `evil.example` fails here.
//   Origin when present, must be one of those same authorities — a
//          cross-origin fetch/WebSocket fails here even without rebinding.
//
// AP_ALLOWED_HOSTS (comma-separated host[:port]) extends the set for
// deliberate exposure (tailnet name, reverse-proxy domain).
//
// An agent also answers at <handle>.localhost, so each identity on a machine
// gets an origin of its own — one browser storage jar per actor, instead of
// every agent sharing localhost:<port> and asking which instance you meant.
// `.localhost` is reserved by RFC 6761 and cannot be delegated in public DNS,
// so it is not the rebinding hole this file exists to close; the label comes
// from config, never from a request header, and matching stays exact-string.

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

// A handle earns a named origin only when it is already a clean DNS label.
// Nothing is rewritten: a mangled name would be a different origin from the
// one we printed, and the user would land on a 403 with no way to see why.
export function hostLabel(handle) {
  const s = String(handle || '').toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

// The authorities that are this machine, and only this machine.
//
// The port-less form is a DIFFERENT origin: `http://localhost` means port 80
// and `https://localhost` means 443. Emitting it whatever port we are on put
// every other local server's pages inside our own origin set — a page served
// from 127.0.0.1:80 sends `Origin: http://localhost`, which passed the Origin
// check, and a form POST needs no preflight to reach a write route. So the
// bare form is emitted only when it really is this server's own authority.
export function loopbackAuthorities(port, labels = []) {
  const out = [];
  const bare = Number(port) === 80 || Number(port) === 443;
  for (const name of LOOPBACK_NAMES) {
    out.push(`${name}:${port}`);
    if (bare) out.push(name);
  }
  for (const l of labels) {
    const label = hostLabel(l);
    if (!label) continue;
    out.push(`${label}.localhost:${port}`);
    if (bare) out.push(`${label}.localhost`);
  }
  return out;
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Where the connection came FROM, as opposed to which authority it asked for.
// Both listeners bind loopback, so today this is true of everything that
// arrives — including a request relayed by a same-host reverse proxy, which is
// exactly why it is not what keeps an exposed agent safe (see exposureProblem).
// It is here so that binding to another address later cannot silently turn the
// local-only routes into public ones.
export function isLoopbackSocket(req) {
  const a = req?.socket?.remoteAddress;
  if (!a) return false;
  return LOOPBACK_ADDRESSES.has(a) || a.startsWith('127.');
}

// AP_ALLOWED_HOSTS is the documented way to put the agent on a tailnet name or
// behind a reverse proxy. Doing so removes every transport signal that told the
// operator apart from everyone else: the listeners bind loopback, so exposure
// means something on this machine is relaying, and a stock
// `proxy_pass http://127.0.0.1:<port>;` rewrites Host to a loopback authority
// and connects from loopback. Every caller then looks local, which is what the
// local-only routes and the password-less authorize path were trusting.
//
// A secret is all that is left, and AP_GATE_TOKEN is the one every route
// checks — a uiPassword guards the OAuth login and nothing else. Returns a
// reason string when the agent must not start, or null.
export function exposureProblem({ allowedHosts, gateToken } = {}) {
  const exposed = String(allowedHosts || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!exposed.length || gateToken) return null;
  return `AP_ALLOWED_HOSTS names ${exposed.join(', ')}, but AP_GATE_TOKEN is not set.\n`
    + 'An exposed agent cannot tell your requests from anyone else\'s — a reverse proxy\n'
    + 'rewrites Host to a loopback authority and connects from loopback, so every caller\n'
    + 'looks like this machine. Without a shared secret that means the admin API, the\n'
    + 'setup routes and the OAuth mint answer whoever reaches the address.\n\n'
    + 'Either set AP_GATE_TOKEN to a secret (send it as the x-dk-token header, or visit\n'
    + '?dk-token=<secret> once to be given the cookie), or unset AP_ALLOWED_HOSTS.';
}

export function allowedAuthorities(port, labels = []) {
  const extra = String(process.env.AP_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set([...loopbackAuthorities(port, labels), ...extra]);
}

// The set has to stay live. startAdmin runs before connect, so an unconfigured
// agent has no handle yet — and MastoApi consults this same object to decide
// whether an OAuth redirect_uri is one of ours, so a snapshot taken at listen
// time would reject the named origin for the life of the process.
export class Authorities {
  constructor(port, handle = null, extraPorts = []) {
    this.port = port;
    // The https listener's port: same machine, same names, second authority.
    this.extraPorts = extraPorts.filter(Boolean);
    this.label = null;
    this.set = null;
    this.local = null;
    this.rebuild();
    this.setHandle(handle);
  }

  rebuild() {
    const labels = this.labels();
    this.set = allowedAuthorities(this.port, labels);
    this.local = new Set(loopbackAuthorities(this.port, labels));
    for (const p of this.extraPorts) {
      for (const a of loopbackAuthorities(p, labels)) { this.set.add(a); this.local.add(a); }
    }
  }

  // Returns true when the named origin actually changed.
  setHandle(handle) {
    const label = hostLabel(handle);
    if (label === this.label) return false;
    this.label = label;
    this.rebuild();
    return true;
  }

  labels() { return this.label ? [this.label] : []; }

  has(authority) { return this.set.has(authority); }

  // Machine-local, ignoring AP_ALLOWED_HOSTS: an agent deliberately exposed
  // under a tailnet name answers the fediverse there, but must not offer
  // account creation or config editing over it.
  isLocal(host) { return this.local.has(String(host || '').toLowerCase()); }

  // The Host header says which authority the client asked for; the socket says
  // where it came from. A local-only route wants both to agree. Neither
  // survives a same-host proxy on its own — exposureProblem is what covers
  // that case — but requiring both costs nothing and closes the plain forgery.
  isLocalRequest(req) {
    return isLoopbackSocket(req) && this.isLocal(req?.headers?.host);
  }
}

const authorityOf = (originHeader) => {
  try { return new URL(originHeader).host.toLowerCase(); } catch { return null; }
};

// Returns null when the request is acceptable, else a reason string.
export function checkRequest(req, allowed) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host || !allowed.has(host)) return `unexpected Host "${host || '(none)'}"`;
  const origin = req.headers.origin;
  // 'null' is what a sandboxed/file: page sends — never trusted here.
  if (origin && origin !== 'null') {
    const oh = authorityOf(origin);
    if (!oh || !allowed.has(oh)) return `cross-origin request from "${origin}"`;
  } else if (origin === 'null') {
    return 'opaque origin';
  }
  return null;
}

// Same-site navigations and typed URLs only — blocks a visited page from
// driving a top-level navigation into an endpoint that mints credentials.
// Absent header (older browsers, curl) is allowed: Host/Origin still apply.
export function isCrossSiteNavigation(req) {
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site';
}
