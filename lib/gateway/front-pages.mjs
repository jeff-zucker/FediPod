// front-pages.mjs — the front's pages and the files they load, read from
// beside this package: the opt-in page, the roster, the notices page, the
// new-account page, each page's own script, the sign-in library and the
// installer. A file that is not there comes back null, and the route it
// feeds answers 404.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/front');
const SCRIPTS = ['new-account.js', 'run.js', 'admin.js', 'notices.js'];

const readOrNull = (name) => {
  try { return fs.readFileSync(path.join(FRONT_DIR, name), 'utf8'); } catch { return null; }
};

/** The pages routeFront serves, in the shape its options take them. */
export function frontPages() {
  const pageScripts = {};
  for (const name of SCRIPTS) pageScripts[name] = readOrNull(name);
  return {
    signupPage: readOrNull('new-account.html'),
    runPage: readOrNull('run.html'),
    adminPage: readOrNull('admin.html'),
    noticesPage: readOrNull('notices.html'),
    authBundle: readOrNull('solid-oidc-client.js'),
    pageScripts,
    installScript: readOrNull('install.sh'),
  };
}
