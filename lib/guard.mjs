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

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

export function allowedAuthorities(port) {
  const extra = String(process.env.AP_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const base = [];
  for (const name of LOOPBACK_NAMES) base.push(`${name}:${port}`, name);
  return new Set([...base, ...extra]);
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
