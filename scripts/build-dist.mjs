// build-dist.mjs — produce a self-contained, run-anywhere tarball:
// code + vendored auth helpers + Phanpy UI + pruned production deps.
// The only thing a user needs besides the tarball is Node ≥ 20.
//
//   node scripts/build-dist.mjs        → dist/solid-activitypub-<version>.tar.gz
//
// Unpack-and-go:  tar xzf solid-activitypub-*.tar.gz && cd solid-activitypub
//                 bin/activitypod.mjs setup --new-account --email … --handle …

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'dist', 'stage', 'solid-activitypub');
const out = path.join(root, 'dist', `solid-activitypub-${pkg.version}.tar.gz`);

fs.rmSync(path.join(root, 'dist', 'stage'), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const item of ['bin', 'lib', 'vendor', 'phanpy', 'ui', 'run-agent.mjs', 'package.json', 'package-lock.json', 'README.md']) {
  fs.cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
}

console.log('installing production deps into the stage…');
execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });

fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('tar', ['czf', out, '-C', path.dirname(stage), 'solid-activitypub']);
fs.rmSync(path.join(root, 'dist', 'stage'), { recursive: true, force: true });

const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`built ${out} (${mb} MB)`);
