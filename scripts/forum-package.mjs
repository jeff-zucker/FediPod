// forum-package.mjs — the forum (fedipod-bb) that fedipod.net runs and
// serves, taken from the forum's own folder every time, not from a version
// FediPod pins: the checkout beside FediPod, or a clone of the forum's GitHub
// main where there is none (scripts/dependents.mjs). It is packed as npm would
// publish it and put in node_modules without touching FediPod's package list,
// so nothing FediPod records names a forum version. Staging the site, the
// bundle check and the app build each bring it first.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fetchDependent, root } from './dependents.mjs';

/** The forum from its folder, installed in node_modules. Returns its folder and version. */
export function bringForum({ log = console.log } = {}) {
  const dir = fetchDependent('fedipod-bb', { log });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-pack-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', dir, '--pack-destination', tmp, '--ignore-scripts', '--json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0];
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', path.join(tmp, packed.filename)],
      { cwd: root, stdio: 'ignore' });
    log(`forum: fedipod-bb ${packed.version} from ${path.relative(root, dir) || dir}`);
    return { dir, version: packed.version };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) bringForum();
