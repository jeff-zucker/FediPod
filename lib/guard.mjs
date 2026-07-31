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
export function loopbackAuthorities(port, labels = []) {
  const out = [];
  for (const name of LOOPBACK_NAMES) out.push(`${name}:${port}`, name);
  for (const l of labels) {
    const label = hostLabel(l);
    if (label) out.push(`${label}.localhost:${port}`, `${label}.localhost`);
  }
  return out;
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
  constructor(port, handle = null) {
    this.port = port;
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
