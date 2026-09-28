// files.mjs — writing a file without a window in which it is half there, and
// showing a path the way a person types it.
//
// The files written this way are the ones nothing can rebuild: keys.json is
// the private key remote servers have cached, and credential.json holds a
// secret a Solid server mints once and will not mint again. A plain
// writeFileSync truncates first, so a crash, a power loss or a full disk
// between truncate and write leaves an empty or half-written file where the
// identity used to be.
//
// rename(2) is atomic on POSIX, so a reader — or a backup running at the wrong
// moment — sees either the old file or the new one. fsync before it, so the
// content is on the platter and not merely in the page cache when the rename
// lands. Windows has no atomic rename over an existing file; there the copy
// path is still better than a truncate, and this is a best effort by design.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// A path for display: the home directory becomes `~`, a `file:` URL is shown
// as the path it is. Never used to build a path — `~` is the shell's, not the
// filesystem's, and anything that resolves one must expand it first.
export function tildify(p, homedir = os.homedir()) {
  if (!p) return p;
  let s = String(p);
  if (s.startsWith('file://')) { try { s = fileURLToPath(s); } catch { return s; } }
  if (s === homedir) return '~';
  return s.startsWith(homedir + path.sep) ? '~' + s.slice(homedir.length) : s;
}
