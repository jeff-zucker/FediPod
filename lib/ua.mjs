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

const { version } = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));

// Renamed 2026-07-31, once solidcommunity.net was back up and both actors there
// were retired: the name in their logs no longer has to match the name in here.
export const USER_AGENT = `solid-activitypub/${version} (+https://github.com/jeff-zucker/solid-activitypub)`;
