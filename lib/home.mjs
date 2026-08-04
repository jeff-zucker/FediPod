// Where an install keeps its credential, signing keys, pidfile and log.
//
// The root was `~/.activitypod` before the 2026-07-30 rename to
// solid-activitypub. An install that already has one keeps using it: that
// directory holds the credential and the private key, and moving those is the
// owner's decision rather than an upgrade's side effect. `solid-activitypub home
// --to <dir>` is how you take the new name when you want it.
//
// Resolve ONCE and derive `profiles/` from the same answer. Deciding the two
// separately is how `--profile solo` ends up looking in a different tree from
// the default agent.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Write one of this home's files without a window in which it is half there.
//
// lib/storage.mjs goes to the trouble of tmp+rename for state documents that
// its own header calls rebuildable from the pod. The files here are the ones
// that are NOT: keys.json is the private key remote servers have cached, and
// credential.json holds a secret a Solid server mints once and will not mint
// again. A plain writeFileSync truncates first, so a crash, a power loss or a
// full disk between truncate and write leaves an empty or half-written file
// where the identity used to be.
//
// rename(2) is atomic on POSIX, so a reader — or a backup running at the wrong
// moment — sees either the old file or the new one. fsync before it, so the
// content is on the platter and not merely in the page cache when the rename
// lands. Windows has no atomic rename over an existing file; there the copy
// path is still better than a truncate, and this is a best effort by design.
export function writeFileAtomic(file, body, { mode = 0o600 } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// The same, for the JSON these files all happen to be.
export function writeJsonAtomic(file, obj, opts) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n', opts);
}

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


// For DISPLAY only: `~/.solid-activitypub` reads at a glance where
// `/home/jeff/.solid-activitypub` has to be parsed, and the home directory is
// the least interesting part of every path this prints. A `file:` URL is a path
// wearing a scheme, so it is shown as the path — which is also what you would
// type, since `state --to` takes either.
//
// Never used to build a path. `~` is the shell's, not the filesystem's, and
// anything that resolves one must expand it first.
export function tildify(p, homedir = os.homedir()) {
  if (!p) return p;
  let s = String(p);
  if (s.startsWith('file://')) { try { s = fileURLToPath(s); } catch { return s; } }
  if (s === homedir) return '~';
  return s.startsWith(homedir + path.sep) ? '~' + s.slice(homedir.length) : s;
}

// Using an identity is what makes it the default. Called when an agent starts
// for one — not on every read, or `--profile other status` would quietly move
// the machine's idea of "you" while only asking a question.
export function recordLastUsed(root, name) {
  if (!root || !name || readRoot(root).default === name) return;
  try { writeRoot(root, { default: name, at: new Date().toISOString() }); } catch { /* not fatal */ }
}
