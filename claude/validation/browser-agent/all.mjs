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

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const isRig = (f) => f.endsWith('.mjs') && f !== 'all.mjs'
  && /^\/\/\s+node claude\/validation\/browser-agent\//mu.test(fs.readFileSync(path.join(here, f), 'utf8'));
const wanted = process.argv.slice(2).map((n) => (n.endsWith('.mjs') ? n : `${n}.mjs`));
const rigs = fs.readdirSync(here).filter(isRig).filter((f) => !wanted.length || wanted.includes(f)).sort();
if (!rigs.length) { console.error('all.mjs: no rig matched'); process.exit(2); }

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
  if (!ok && process.env.RIG_DEBUG) console.log(out.split('\n').slice(-40).join('\n'));
}
console.log(broken ? `\n${broken} rig(s) FAILED` : '\nall rigs green');
process.exit(broken);
