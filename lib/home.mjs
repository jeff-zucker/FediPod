// Where an install keeps its credential, signing keys, pidfile and log.
//
// The root was `~/.activitypod` before the 2026-07-30 rename to
// solid-activitypub. An install that already has one keeps using it: that
// directory holds the credential and the private key, and moving those is the
// owner's decision rather than an upgrade's side effect. `activitypod home
// --to <dir>` is how you take the new name when you want it.
//
// Resolve ONCE and derive `profiles/` from the same answer. Deciding the two
// separately is how `--profile solo` ends up looking in a different tree from
// the default agent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CURRENT_ROOT = '.solid-activitypub';
export const LEGACY_ROOT = '.activitypod';

// Existing install wins over the new name; a fresh one gets the new name.
export function apRoot(homedir = os.homedir()) {
  const current = path.join(homedir, CURRENT_ROOT);
  if (fs.existsSync(current)) return current;
  const legacy = path.join(homedir, LEGACY_ROOT);
  return fs.existsSync(legacy) ? legacy : current;
}

export const isLegacyRoot = (root) => path.basename(root) === LEGACY_ROOT;

export const profilesDir = (root) => path.join(root, 'profiles');

// The root an arbitrary home belongs to. `<root>/profiles/<name>` is a profile;
// anything else is its own root — so a custom AP_HOME reports no neighbours,
// which is the truth rather than a special case.
export function rootOf(home) {
  const resolved = path.resolve(home);
  const parent = path.dirname(resolved);
  return path.basename(parent) === 'profiles' ? path.dirname(parent) : resolved;
}

// Every identity under a root: the default home, plus profiles/*. Callers read
// `agent.json` from these — a port and a handle. Nothing here, and nothing that
// uses it, opens a sibling's credential or keys.
export function identityHomes(root) {
  const homes = [{ name: '(default)', dir: root }];
  try {
    for (const name of fs.readdirSync(profilesDir(root)).sort()) {
      const dir = path.join(profilesDir(root), name);
      if (fs.statSync(dir).isDirectory()) homes.push({ name, dir });
    }
  } catch { /* no profiles yet */ }
  return homes;
}
