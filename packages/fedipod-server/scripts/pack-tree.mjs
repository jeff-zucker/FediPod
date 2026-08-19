// pack-tree.mjs copy|clean — the published tarball must stand alone, so
// prepack copies the agent tree into the package (the handler loads lib/
// beside dist/ when it exists) and postpack removes the copies again: in a
// repo checkout the handler must reach the repo's own lib/, never a stale
// copy of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ITEMS = ['lib', 'vendor', 'web', 'run-agent.mjs'];
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(pkg, '../..');
const verb = process.argv[2];

if (verb === 'copy') {
  for (const item of ITEMS) {
    const to = path.join(pkg, item);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(repo, item), to, { recursive: true });
  }
  console.log(`pack-tree: copied ${ITEMS.join(', ')} into the package`);
} else if (verb === 'clean') {
  for (const item of ITEMS) fs.rmSync(path.join(pkg, item), { recursive: true, force: true });
  console.log('pack-tree: package copies removed');
} else {
  console.error('usage: node scripts/pack-tree.mjs copy|clean');
  process.exit(1);
}
