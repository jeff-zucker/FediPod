#!/usr/bin/env node
// check-sizes.mjs — no runtime source file over 1,000 lines. The split of
// 2026-09-11 made every module readable one part at a time; this keeps it so.
// Run by `npm test`. Exits 1 naming the offenders.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 1000;
const ROOTS = ['lib', 'bin', 'web/app', 'web/front', 'web/admin', 'netlify/functions', 'packages/fedipod-server/src', 'packages/css-nextgraph/src'];
const FILES = ['run-agent.mjs'];
const SKIP = /\/(dist|site|node_modules|vendor|client|shims)\//u;
const EXT = /\.(mjs|js|ts)$/u;

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.test(p + '/')) walk(p, out); }
    else if (EXT.test(e.name) && !SKIP.test(p)) out.push(p);
  }
  return out;
};
const files = [...FILES.map(f => path.join(root, f)), ...ROOTS.flatMap(r => (fs.existsSync(path.join(root, r)) ? walk(path.join(root, r)) : []))];
const over = files
  .map(f => ({ f: path.relative(root, f), n: fs.readFileSync(f, 'utf8').split('\n').length }))
  .filter(x => x.n > LIMIT)
  .sort((a, b) => b.n - a.n);
if (over.length) {
  console.error(`check-sizes: ${over.length} runtime file(s) over ${LIMIT} lines:`);
  for (const x of over) console.error(`  ${String(x.n).padStart(6)}  ${x.f}`);
  process.exit(1);
}
console.log(`check-sizes: ${files.length} runtime files, none over ${LIMIT} lines`);
