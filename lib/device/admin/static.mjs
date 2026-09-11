// static.mjs — what the agent serves off disk: the vendored client with its
// own service worker taken out, any client dist dropped into ui/, and the
// agent's own pages; the headers every response carries; and the two
// constants every module here shares, where the checkout is and what
// version it is.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wsOrigins } from './origins.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const PHANPY_DIR = path.join(projectRoot, 'phanpy/dist');
// The vendored client is upstream's build, byte for byte, so the integrity
// check can say so. The two things it needs changed happen on the way out
// instead of in the files.
//
// vite-plugin-pwa injects this registration into every page it builds. The
// worker it installs answers navigations from a precache and replays the
// headers stored at install time, so a CSP change can never reach a browser
// that already has one.
const SW_REGISTER = /<script id="vite-plugin-pwa:inline-sw">[\s\S]*?<\/script>/i;
// Removing it stops new installs. This replaces the worker itself, so the ones
// already out there clean up: browsers re-fetch sw.js on navigation and
// install what they find. No fetch handler on purpose — a worker without one
// never intercepts a request, so pages go straight to the network while it
// runs.
const SW_KILL = `self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      try { await client.navigate(client.url); } catch { /* tab will refresh on its own */ }
    }
  })());
});
`;
// Null rather than the original when the tag is gone: an upstream change that
// silently no-opped here would put the worker back, which is the whole thing
// this exists to prevent.
function stripSwRegistration(html) {
  return SW_REGISTER.test(html) ? html.replace(SW_REGISTER, '') : null;
}
const UI_DIR = path.join(projectRoot, 'ui');       // extra client dists: ui/<name>/ → /<name>/
// Our own pages, kept out of ui/ for two reasons: a client dist dropped in
// there under the same name would shadow them, and a group serves these and
// nothing else — so the prefix has to be one nobody is invited to write into.
// One surface, /admin/, with setup as its first section: /admin/setup/ is the
// first run, /admin/ is the record, and there is room for the rest.
const WEB_DIR = path.join(projectRoot, 'web');
const WEB_MOUNTS = ['admin'];
export const webMount = (pathname) => {
  const seg = decodeURIComponent(pathname).replace(/^\/+/, '').split('/')[0];
  return WEB_MOUNTS.includes(seg) ? seg : null;
};
export const SETUP_PAGE = '/admin/setup/';

export const AGENT_VERSION = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.woff2': 'font/woff2',
};

// Sent on every response: nosniff and no-referrer everywhere, and for HTML a
// CSP that keeps SCRIPTS to our own origin while still allowing the remote
// avatars, media and instance calls a fediverse client must make. It is not an
// exfiltration boundary — connect-src has to allow https: for the client to
// work at all — it is a code-execution one.
// Phanpy's index.html carries an inline bootstrap script. Rather than
// opening the policy with 'unsafe-inline', hash the inline scripts we
// actually ship and allow exactly those.
let inlineHashes = null;
function inlineScriptHashes() {
  if (inlineHashes) return inlineHashes;
  inlineHashes = [];
  try {
    // The page as it is SERVED, not as it sits on disk: hashing the
    // registration script we strip would allow a script nobody gets.
    const raw = fs.readFileSync(path.join(PHANPY_DIR, 'index.html'), 'utf8');
    const html = stripSwRegistration(raw) ?? raw;
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const digest = crypto.createHash('sha256').update(m[1], 'utf8').digest('base64');
      inlineHashes.push(`'sha256-${digest}'`);
    }
  } catch { /* no inline scripts to allow */ }
  return inlineHashes;
}

export function securityHeaders(auth, isHtml) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // SAMEORIGIN, not DENY: /admin/client/ frames the bundled client so a bar
    // of ours can sit above it. Only pages on this agent's own origins may —
    // the same set the Host/Origin firewall already trusts.
    'x-frame-options': 'SAMEORIGIN',
  };
  if (isHtml) {
    h['content-security-policy'] = [
      "default-src 'self'",
      `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes().join(' ')}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data: blob:",
      "media-src 'self' https: data: blob:",
      "font-src 'self' data:",
      // Every authority the Host/Origin firewall accepts, so browsing an agent
      // at its own name (solo.localhost:8041, a tailnet host) keeps streaming.
      // Pinning this to localhost blocked the socket with no visible error.
      //
      // `https:` is still here and the comment above no longer claims otherwise:
      // a fediverse client fetches remote instances by design — link previews,
      // an actor's own server, media — so there is no narrower set that leaves
      // it working. The XSS story is `script-src 'self'` plus hashes; treat
      // connect-src as availability, not containment.
      `connect-src 'self' https: ${(typeof auth.wsAuthorities === 'function'
        ? auth.wsAuthorities()
        : wsOrigins(auth.port, auth.labels())).join(' ')}`,
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
  }
  return h;
}

export function sendJson(res, status, obj, auth) {
  res.writeHead(status, { 'content-type': 'application/json', ...securityHeaders(auth, false) });
  res.end(JSON.stringify(obj) + '\n');
}

// Static UI serving, path-jailed. Phanpy owns the root; any other client
// dist dropped into ui/<name>/ is served at /<name>/. Hash-routed apps:
// '/' (and directories) get their index.html; anything unknown 404s.
export function serveStatic(res, pathname, auth) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let baseDir = PHANPY_DIR;
  const uiName = rel.split('/')[0];
  // The mount name is joined to UI_DIR, so it must be CONTAINED by it — the
  // same resolve-then-check sendFile does below, for the same reason.
  //
  // Decoding happens before the split, so a `%2f` in the first segment becomes
  // a real separator afterwards and `..` arrives here as a mount name. It
  // exists, and it is a directory, so baseDir was silently re-based to the
  // project root — and sendFile's jail then enforced containment against THAT,
  // dutifully approving `/..%2fpackage.json`, `/..%2f.git/config` and every
  // source file under it for anyone who could reach the port.
  // Resolved through symlinks, not just lexically: sendFile's own jail has
  // always used realpath, and a lexical check here would still admit a mount
  // that is a link pointing out of ui/.
  let mount = '';
  try {
    if (uiName) {
      const cand = path.resolve(UI_DIR, uiName);
      if (cand.startsWith(UI_DIR + path.sep) && fs.statSync(cand).isDirectory()) {
        const real = fs.realpathSync(cand);
        if (real.startsWith(fs.realpathSync(UI_DIR) + path.sep)) mount = cand;
      }
    }
  } catch { /* no such mount; fall through to the default base */ }
  if (mount) {
    baseDir = mount;
    rel = rel.slice(uiName.length).replace(/^\/+/, '');
  }
  return sendFile(res, baseDir, rel, auth);
}

// '/admin/setup' names a directory, so it needs the slash the browser will
// resolve relative URLs against. Returns the corrected path, or null.
export function webDirRedirect(pathname) {
  if (pathname.endsWith('/')) return null;
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR + path.sep)) return null;      // not ours to stat
  try {
    if (fs.statSync(full).isDirectory()) return pathname + '/';
  } catch { /* not a directory here */ }
  return null;
}

// web/<mount>/ → /<mount>/. Same jail, different mount rule.
export function serveWeb(res, pathname, mount, auth) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '').slice(mount.length).replace(/^\/+/, '');
  return sendFile(res, path.join(WEB_DIR, mount), rel, auth);
}

export function sendFile(res, baseDir, rel, auth) {
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep) && file !== path.join(baseDir, 'index.html')) {
    res.writeHead(403); res.end(); return true;
  }
  let target = file;
  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    // Resolve symlinks before reading: a link inside a UI dir must not be a
    // way out of the jail.
    const real = fs.realpathSync(target);
    const realBase = fs.realpathSync(baseDir);
    if (!real.startsWith(realBase + path.sep) && real !== path.join(realBase, 'index.html')) {
      res.writeHead(403); res.end(); return true;
    }
    const ext = path.extname(real);
    let body = fs.readFileSync(real);
    // The vendored client, adjusted on the way out rather than in the files.
    if (real.startsWith(fs.realpathSync(PHANPY_DIR))) {
      if (path.basename(real) === 'sw.js') {
        body = Buffer.from(SW_KILL);
      } else if (ext === '.html') {
        const stripped = stripSwRegistration(body.toString('utf8'));
        if (stripped === null) {
          console.error(`refusing to serve ${path.basename(real)}: no service-worker `
            + 'registration to remove — the vendored client changed shape');
          res.writeHead(500, { 'content-type': 'text/plain', ...securityHeaders(auth, false) });
          res.end('the bundled client changed shape; refusing to serve it\n');
          return true;
        }
        body = Buffer.from(stripped);
      }
    }
    // Our own pages are read straight off disk and change whenever the project
    // does. With no cache headers a browser is free to reuse them without
    // asking, so an edited page keeps rendering the old one and looks like the
    // edit never landed. The vendored client dists have hashed filenames and
    // are left alone.
    const ours = real.startsWith(fs.realpathSync(WEB_DIR) + path.sep);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      ...(ours ? { 'cache-control': 'no-store' } : {}),
      ...securityHeaders(auth, ext === '.html'),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain', ...securityHeaders(auth, false) });
    res.end('not found\n');
  }
  return true;
}
