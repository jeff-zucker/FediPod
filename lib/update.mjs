// update.mjs — is a newer FediPod published, and the update itself.
//
// "Latest" is the version field of package.json on the repo's main branch —
// the same file a clone reads to know what it is running. The check is one
// GET of that file; nothing else leaves the machine, and AP_UPDATE_CHECK=0
// turns it off. The update is what re-running the installer does: fast-forward
// the checkout, reinstall dependencies, restart the agents.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LATEST_URL = 'https://raw.githubusercontent.com/jeff-zucker/FediPod/main/package.json';

export const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const localVersion = (root = repoRoot()) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
};

// a newer than b, for dotted numeric versions.
export const newerThan = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
};

export async function checkLatest({ current = localVersion(), fetchImpl = fetch } = {}) {
  if (process.env.AP_UPDATE_CHECK === '0') return null;
  try {
    const res = await fetchImpl(LATEST_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const latest = (await res.json()).version || null;
    if (!latest || !current) return null;
    return { current, latest, available: newerThan(latest, current), checkedAt: new Date().toISOString() };
  } catch { return null; }
}

// Fast-forward only: a checkout with local changes is somebody's work, and an
// update must refuse rather than eat it.
export function runUpdate({ root = repoRoot(), log = () => {} } = {}) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    return { ok: false, note: 'not a git checkout — update it the way it was installed' };
  }
  try {
    execFileSync('git', ['-C', root, 'pull', '--ff-only'], { stdio: 'pipe' });
  } catch (e) {
    return { ok: false, note: `git pull refused: ${String(e.stderr || e.message).slice(0, 300).trim()}` };
  }
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: 'pipe' });
  } catch (e) {
    return { ok: false, note: `npm install failed: ${String(e.stderr || e.message).slice(0, 300).trim()}` };
  }
  const version = localVersion(root);
  log(`updated the checkout to ${version}`);
  return { ok: true, note: `updated to ${version}`, version };
}

// New code runs only after a restart. Where systemd units exist they are all
// restarted by name; otherwise the caller re-execs its own process.
export function restartAgents({ log = () => {} } = {}) {
  try {
    const list = execFileSync('systemctl',
      ['--user', 'list-units', '--plain', '--no-legend', 'fedipod-*'], { stdio: 'pipe' })
      .toString().trim();
    if (list) {
      const child = spawn('systemctl', ['--user', 'restart', 'fedipod-*'], { detached: true, stdio: 'ignore' });
      child.unref();
      log('restarting the fedipod units');
      return 'units';
    }
  } catch { /* no systemd here */ }
  return 'self';
}
