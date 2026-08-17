// One User-Agent for everything this agent sends. An operator reading an access
// log should be able to tell what we are and where to raise a complaint;
// solidcommunity.net's 2026-07-29 report had to infer us from client-credential
// names because every request identified itself only as "node".
//
// vendor/idp-grant.cjs builds the same string from package.json — it is
// CommonJS and cannot import this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Best-effort: a bundled deploy (the Netlify functions) rewrites this file's
// location and the relative path with it. A User-Agent must never be the
// reason anything fails to start.
let version = '0';
try {
  ({ version } = JSON.parse(fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')));
} catch {
  try {
    ({ version } = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'package.json'), 'utf8')));
  } catch { /* keep '0' */ }
}

// Renamed 2026-07-31, once solidcommunity.net was back up and both actors there
// were retired: the name in their logs no longer has to match the name in here.
export const USER_AGENT = `fedipod/${version} (+https://github.com/jeff-zucker/FediPod)`;
