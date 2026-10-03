// dependents.mjs — the packages built on fedipod, each in a repository of its
// own, and where this machine keeps each one. A checkout beside FediPod
// (../fedipod-bb and so on) is used as it stands, edits and all; failing that,
// a shallow clone of its main branch under .dependents/, which is what CI and
// anyone else's clone get.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `fedipod`: whether its tests import fedipod, and so run against this checkout.
// `sizes`: its source folder, held to FediPod's size limit.
export const DEPENDENTS = {
  'fedipod-server': {
    repo: 'https://github.com/jeff-zucker/fedipod-server.git', fedipod: true, sizes: 'src',
    tests: [['npm', 'test'], ['npm', 'run', 'test:e2e'], ['npm', 'run', 'test:e2e:suffix']],
  },
  'fedipod-bb': {
    repo: 'https://github.com/jeff-zucker/fedipod-bb.git', fedipod: true, sizes: 'src',
    tests: [['npm', 'test']],
  },
  'fediverse-session': {
    repo: 'https://github.com/jeff-zucker/fediverse-session.git', fedipod: false,
    tests: [['npm', 'test']],
  },
};

const nameOf = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name; } catch { return null; }
};

/** The folder holding this dependent: the checkout beside FediPod, else .dependents/<name>. */
export function dependentDir(name) {
  const beside = path.resolve(root, '..', name);
  return nameOf(beside) === name ? beside : path.join(root, '.dependents', name);
}

/** The dependent's folder, cloned from its repository first when there is none. */
export function fetchDependent(name, { log = console.log } = {}) {
  const dir = dependentDir(name);
  if (nameOf(dir) === name) return dir;
  log(`dependents: cloning ${DEPENDENTS[name].repo} into ${path.relative(root, dir)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--depth', '1', DEPENDENTS[name].repo, dir], { stdio: 'inherit' });
  return dir;
}

/** Its packages installed, when it has any and they are not there yet. */
export function installDependent(dir, { log = console.log } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const wants = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  if (!wants || fs.existsSync(path.join(dir, 'node_modules'))) return;
  const lock = fs.existsSync(path.join(dir, 'package-lock.json'));
  log(`dependents: npm ${lock ? 'ci' : 'install'} in ${dir}`);
  execFileSync('npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
}

/** Its `fedipod` pointed at this checkout, replacing whatever npm put there. */
export function linkFedipod(dir) {
  const link = path.join(dir, 'node_modules', 'fedipod');
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  if (real(link) === real(root)) return;
  fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(root, link, 'dir');
}

/** The dependent made ready to run against this checkout. */
export function readyDependent(name, opts = {}) {
  const dir = fetchDependent(name, opts);
  installDependent(dir, opts);
  if (DEPENDENTS[name].fedipod) linkFedipod(dir);
  return dir;
}
