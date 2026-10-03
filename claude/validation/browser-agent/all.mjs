// all.mjs — every browser rig in this folder, one after another, as part of
// `npm test`. Each rig boots its own scratch server and headless Chrome on
// ports of its own, and some rigs share ports, so they never run side by side.
// A rig is any file here whose header names how to run it; helpers have none.
// One line per rig with its PASS and FAIL counts; the exit code is the number
// of rigs that did not pass, so a broken rig fails the suite instead of
// waiting for someone to run it by hand.
//
//   node claude/validation/browser-agent/all.mjs            # every rig
//   node claude/validation/browser-agent/all.mjs run sw-run # named rigs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readyDependent } from '../../../scripts/dependents.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const isRig = (f) => f.endsWith('.mjs') && f !== 'all.mjs'
  && /^\/\/\s+node claude\/validation\/browser-agent\//mu.test(fs.readFileSync(path.join(here, f), 'utf8'));
const wanted = process.argv.slice(2).map((n) => (n.endsWith('.mjs') ? n : `${n}.mjs`));
const rigs = fs.readdirSync(here).filter(isRig).filter((f) => !wanted.length || wanted.includes(f)).sort();
if (!rigs.length) { console.error('all.mjs: no rig matched'); process.exit(2); }

// What every rig needs, named up front so a runner without them says so.
try { console.log(`chrome: ${spawnSync('google-chrome', ['--version'], { encoding: 'utf8' }).stdout.trim() || 'not found'}`); }
catch { console.log('chrome: google-chrome not found on PATH'); }
// The scratch server is the CSS the Server's folder installs, and it scans the
// Server as a component module when it starts, which needs the Server built;
// without that it never answers and every rig waits three minutes to say so.
const serverDir = readyDependent('fedipod-server');
if (!fs.existsSync(path.join(serverDir, 'dist/components/context.jsonld'))) {
  spawnSync('npm', ['run', 'build'], { cwd: serverDir, stdio: 'inherit' });
}
const cssBin = path.join(serverDir, 'node_modules/.bin/community-solid-server');
console.log(`scratch server: ${fs.existsSync(cssBin) ? cssBin : `MISSING — npm ci in ${serverDir}`}`);
const serverBuilt = fs.existsSync(path.join(serverDir, 'dist/components/context.jsonld'));
console.log(`server package built: ${serverBuilt ? 'yes' : `NO — npm run build in ${serverDir} failed`}`);
if (!fs.existsSync(cssBin) || !serverBuilt) { console.log('\nFAIL  the rigs cannot run here (see above)'); process.exit(1); }

let broken = 0;
for (const rig of rigs) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(here, rig)], { cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const pass = (out.match(/^PASS\b/gmu) || []).length;
  const fail = (out.match(/^FAIL\b/gmu) || []).length;
  const ok = r.status === 0 && fail === 0 && pass > 0;
  if (!ok) broken++;
  const why = r.signal ? ` (${r.signal})` : r.status !== 0 && fail === 0 ? ` — ${(out.match(/ERROR.*|Error:.*/u) || ['exited ' + r.status])[0].slice(0, 160)}` : '';
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${rig}: ${pass} pass, ${fail} fail, ${Math.round((Date.now() - started) / 1000)}s${why}`);
  // A failed rig shows its last lines: a runner has no other way to say why.
  if (!ok) console.log(out.split('\n').filter((l) => l.trim()).slice(process.env.RIG_DEBUG ? -60 : -25).map((l) => '    ' + l).join('\n'));
  // A machine where the scratch server does not start fails every rig the
  // same way; one such failure is the finding, the rest is three minutes each.
  if (!ok && /scratch (server|CSS) (never answered|did not come up)/u.test(out)) {
    const left = rigs.length - rigs.indexOf(rig) - 1;
    if (left > 0) { console.log(`FAIL  the scratch server does not start on this machine; ${left} rig(s) not run`); broken += left; }
    break;
  }
}
console.log(broken ? `\n${broken} rig(s) FAILED` : '\nall rigs green');
process.exit(broken);
