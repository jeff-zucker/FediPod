#!/usr/bin/env node
// pin-solid-oidc.mjs — vendor a pinned copy of the browser Solid-OIDC client
// for the front pages (run.html, admin.html).
//
// Downloads the exact npm tarball, verifies its sha512 against the pin below,
// extracts the worker-free CORE build (SessionCore — no SharedWorker, right for
// these one-shot sign-in pages), strips the trailing sourceMappingURL, prepends
// a provenance banner, and writes web/front/solid-oidc-client.js.
//
// Re-pin: bump VERSION + INTEGRITY (from `npm view @uvdsl/solid-oidc-client-browser@<v> dist.integrity`)
// and re-run. The output filename stays unversioned so routes/tests don't churn.

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const NAME = '@uvdsl/solid-oidc-client-browser';
const VERSION = '0.2.3';
const INTEGRITY = 'sha512-WzVlxv46EUSoqm7ovsWJRZq8KEI/CdpA9O1fXoiP8bihs2cNxPnet3YcqvIYWYMsTrf0zsR031l5s/BzQ9MEgA==';
const TARBALL = `https://registry.npmjs.org/@uvdsl/solid-oidc-client-browser/-/solid-oidc-client-browser-${VERSION}.tgz`;
const ENTRY = 'package/dist/esm/core/index.min.js';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = resolve(here, '..', 'web', 'front', 'solid-oidc-client.js');

function verifyIntegrity(buf, integrity) {
  const [alg, expected] = integrity.split('-', 2);
  const actual = createHash(alg).update(buf).digest('base64');
  if (actual !== expected) {
    throw new Error(`integrity mismatch: expected ${alg}-${expected}, got ${alg}-${actual}`);
  }
}

// Minimal ustar tar reader — enough to pull one file out of the npm tarball.
function readTarEntry(tar, wanted) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', off + 124, off + 136).replace(/\0.*$/, '').trim() || '0', 8);
    const start = off + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

const res = await fetch(TARBALL);
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
const gz = Buffer.from(await res.arrayBuffer());
verifyIntegrity(gz, INTEGRITY);

const tar = gunzipSync(gz);
const entry = readTarEntry(tar, ENTRY);
if (!entry) throw new Error(`entry not found in tarball: ${ENTRY}`);

let code = entry.toString('utf8').replace(/\n?\/\/# sourceMappingURL=.*$/m, '');
const banner =
  `// ${NAME}@${VERSION} — vendored worker-free Solid-OIDC client (core build).\n` +
  `// tarball ${INTEGRITY}\n` +
  `// license MIT — https://github.com/uvdsl/solid-oidc-client-browser\n` +
  `// Regenerate with: node scripts/pin-solid-oidc.mjs\n`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, banner + code + '\n');
console.log(`[pin-solid-oidc] wrote ${outFile} (${(code.length / 1024).toFixed(1)} KB)`);
