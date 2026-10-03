#!/usr/bin/env node
// test-dependents.mjs — every package built on fedipod, tested against this
// checkout: the Server, the forum and the session library, each from the
// folder dependents.mjs finds it in. Run by `npm test` before the browser rigs,
// which boot their scratch pod server from the Server's folder. A dependent
// that cannot be fetched, installed or run fails the whole run; none is ever
// skipped. Exits 1, the failures named in its last lines.
//
//   node scripts/test-dependents.mjs [name ...]
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { DEPENDENTS, readyDependent, root } from './dependents.mjs';

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(DEPENDENTS);
const failed = [];
for (const name of names) {
  const spec = DEPENDENTS[name];
  if (!spec) { failed.push(`${name}: not a dependent`); continue; }
  let dir;
  try { dir = readyDependent(name); }
  catch (e) { failed.push(`${name}: could not be made ready (${e.message})`); continue; }
  console.log(`\n== ${name} (${dir}) against this checkout`);
  for (const cmd of spec.tests) {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) failed.push(`${name}: \`${cmd.join(' ')}\` failed (exit ${r.status ?? r.signal})`);
  }
  if (spec.sizes) {
    try { execFileSync(process.execPath, [path.join(root, 'scripts/check-sizes.mjs'), path.join(dir, spec.sizes)], { stdio: 'inherit' }); }
    catch { failed.push(`${name}: a source file is over the size limit`); }
  }
}
if (failed.length) {
  console.error(`\ntest-dependents: ${failed.length} FAILED`);
  for (const f of failed) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`\ntest-dependents: ${names.join(', ')} pass against this checkout`);
