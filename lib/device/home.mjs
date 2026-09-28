// Where an install keeps its credential, signing keys, pidfile and log.
//
// The root was `~/.activitypod`, then `~/.solid-activitypub`, before the
// rename to fedipod. An install that already has one keeps using it: that
// directory holds the credential and the private key, and moving those is the
// owner's decision rather than an upgrade's side effect. `fedipod home
// --to <dir>` is how you take the new name when you want it.
//
// Resolve ONCE and derive `profiles/` from the same answer. Deciding the two
// separately is how `--profile solo` ends up looking in a different tree from
// the default agent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../shared/files.mjs';

export { writeFileAtomic, writeJsonAtomic, tildify } from '../shared/files.mjs';

export const CURRENT_ROOT = '.fedipod';
export const LEGACY_ROOTS = ['.solid-activitypub', '.activitypod'];  // most recent first

// Existing install wins over the new name; a fresh one gets the new name.
export function apRoot(homedir = os.homedir()) {
  const current = path.join(homedir, CURRENT_ROOT);
  if (fs.existsSync(current)) return current;
  for (const name of LEGACY_ROOTS) {
    const legacy = path.join(homedir, name);
    if (fs.existsSync(legacy)) return legacy;
  }
  return current;
}

export const isLegacyRoot = (root) => LEGACY_ROOTS.includes(path.basename(root));

export const profilesDir = (root) => path.join(root, 'profiles');

// The root an arbitrary home belongs to. `<root>/profiles/<name>` is a profile;
// anything else is its own root — so a custom AP_HOME reports no neighbours,
// which is the truth rather than a special case.
export function rootOf(home) {
  const resolved = path.resolve(home);
  const parent = path.dirname(resolved);
  return path.basename(parent) === 'profiles' ? path.dirname(parent) : resolved;
}

// Every identity under a root — all of them under `profiles/`, none of them the
// root itself. Callers read `agent.json` from these — a port and a handle.
// Nothing here, and nothing that uses it, opens a sibling's credential or keys.
//
// The root used to BE one of these, and had no name, so this function invented
// `(default)` for it at display time. That was the tell: a thing you have to
// name when you show it does not have an identity, it has a position. It also
// meant one identity's home contained all the others — back it up and you
// backed up everyone; delete it and you deleted everyone.
export function identityHomes(root) {
  const homes = [];
  try {
    for (const name of fs.readdirSync(profilesDir(root)).sort()) {
      const dir = path.join(profilesDir(root), name);
      if (fs.statSync(dir).isDirectory()) homes.push({ name, dir });
    }
  } catch { /* no identities yet */ }
  return homes;
}

// The root's own record. Today it holds one thing: which identity was last
// started, which is what a plain command means afterwards. Nobody sets it —
// using an identity IS setting it, so there is no default to configure and no
// way for the configured answer to drift from the one you actually work in.
export const ROOT_FILE = 'root.json';

export function readRoot(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, ROOT_FILE), 'utf8')) || {}; }
  catch { return {}; }
}

export function writeRoot(root, fields) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rec = { ...readRoot(root), ...fields };
  writeJsonAtomic(path.join(root, ROOT_FILE), rec);
  return rec;
}

// Which identity you get with no `--profile`: the last one started. Failing
// that, one identity is unambiguous and needs no ceremony. Two, neither ever
// started, is a genuine question — and the answer is to ask rather than pick,
// because picking silently would be picking someone's fediverse account.
export function defaultProfile(root) {
  const named = readRoot(root).default;
  // Only a home holding a credential counts. A setup that was abandoned leaves a
  // directory behind, and letting that become the default would answer "which
  // identity" with one that does not exist yet.
  const real = identityHomes(root).filter(h => fs.existsSync(path.join(h.dir, 'credential.json')));
  if (named && real.some(h => h.name === named)) return named;
  if (named) return { missing: named };
  return real.length === 1 ? real[0].name : null;
}

export const profileHome = (root, name) => path.join(profilesDir(root), name);

// A root from before every identity moved under profiles/. Its presence is what
// every command checks to tell you to migrate, rather than quietly doing it —
// this directory holds a private key.
export const rootHoldsIdentity = (root) => fs.existsSync(path.join(root, 'credential.json'));


// Using an identity is what makes it the default. Called when an agent starts
// for one — not on every read, or `--profile other status` would quietly move
// the machine's idea of "you" while only asking a question.
export function recordLastUsed(root, name) {
  if (!root || !name || readRoot(root).default === name) return;
  try { writeRoot(root, { default: name, at: new Date().toISOString() }); } catch { /* not fatal */ }
}
