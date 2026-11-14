// forum-package.mjs — the forum (fedipod-bb) that fedipod.net runs and
// serves, taken from the forum's own folder every time, not from a version
// FediPod pins: the checkout beside FediPod, or a clone of the forum's GitHub
// main where there is none (scripts/dependents.mjs). It is packed as npm would
// publish it and put in node_modules without touching FediPod's package list,
// so nothing FediPod records names a forum version. Staging the site, the
// bundle check and the app build each bring it first.
//
// The forum runs on FediPod, and here that is this folder: packed the same
// way and installed beside the forum, so the forum's `fedipod` is the code
// being deployed and not the one the registry has.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fetchDependent, root } from './dependents.mjs';

/** The forum from its folder, and this folder for it to run on, installed in node_modules. Returns the forum's folder and version. */
export function bringForum({ log = console.log } = {}) {
  const dir = fetchDependent('fedipod-bb', { log });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-pack-'));
  try {
    const pack = (from) => JSON.parse(execFileSync('npm', ['pack', from, '--pack-destination', tmp, '--ignore-scripts', '--json'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))[0];
    const forum = pack(dir);
    const self = pack(root);
    execFileSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts',
      path.join(tmp, forum.filename), path.join(tmp, self.filename)], { cwd: root, stdio: 'ignore' });
    log(`forum: fedipod-bb ${forum.version} from ${path.relative(root, dir) || dir}, on fedipod ${self.version} from this folder`);
    return { dir, version: forum.version };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * The files under lib/ that the forum's `fedipod` and this folder do not
 * have the same. Empty when the forum runs on this folder's code.
 */
export function forumCoreDiffers() {
  const theirs = path.join(path.dirname(createRequire(path.join(root, 'node_modules/fedipod-bb/package.json')).resolve('fedipod/package.json')), 'lib');
  const ours = path.join(root, 'lib');
  const files = (base) => fs.readdirSync(base, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.relative(base, path.join(e.parentPath, e.name)));
  const same = (rel) => {
    try { return fs.readFileSync(path.join(ours, rel)).equals(fs.readFileSync(path.join(theirs, rel))); } catch { return false; }
  };
  return [...new Set([...files(ours), ...files(theirs)])].filter((rel) => !same(rel)).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) bringForum();
