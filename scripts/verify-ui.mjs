// verify-ui.mjs — integrity check for the vendored client bundles.
//
// phanpy/dist is upstream's own build, unmodified; nothing else in the project
// would notice if a file in it changed. This records a SHA-256 per file and
// re-checks them, so tampering (or an accidental edit) is visible. The two
// things the agent needs done to the client happen when the files are served
// (lib/admin.mjs), which is what lets these hashes be compared against the
// ones upstream published.
//
//   node scripts/verify-ui.mjs           # verify against phanpy/SHA256SUMS
//   node scripts/verify-ui.mjs --write   # (re)record after a client upgrade

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'phanpy/dist');
const sumsFile = path.join(root, 'phanpy/SHA256SUMS');

function walk(d, base = d, out = []) {
  for (const name of fs.readdirSync(d).sort()) {
    const p = path.join(d, name);
    if (fs.statSync(p).isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

const current = new Map(walk(dir).map(rel => [
  rel, crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex'),
]));

if (process.argv.includes('--write')) {
  const body = [...current].map(([rel, hash]) => `${hash}  ${rel}`).join('\n') + '\n';
  fs.writeFileSync(sumsFile, body);
  console.log(`recorded ${current.size} file hashes → ${path.relative(root, sumsFile)}`);
  process.exit(0);
}

let recorded;
try {
  recorded = new Map(fs.readFileSync(sumsFile, 'utf8').trim().split('\n')
    .map(l => { const [h, ...r] = l.split(/\s+/); return [r.join(' '), h]; }));
} catch {
  console.error(`no ${path.relative(root, sumsFile)} — run with --write to record`);
  process.exit(2);
}

const problems = [];
for (const [rel, hash] of current) {
  if (!recorded.has(rel)) problems.push(`ADDED    ${rel}`);
  else if (recorded.get(rel) !== hash) problems.push(`CHANGED  ${rel}`);
}
for (const rel of recorded.keys()) if (!current.has(rel)) problems.push(`REMOVED  ${rel}`);

if (problems.length) {
  console.error(`vendored UI does not match ${path.relative(root, sumsFile)}:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`vendored UI verified: ${current.size} files match`);
