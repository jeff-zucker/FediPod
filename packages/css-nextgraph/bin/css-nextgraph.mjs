#!/usr/bin/env node
// css-nextgraph.mjs — the hand-over: where a pod's wallet is and what opens it.
//
//   css-nextgraph wallet <pod-root-url> --dir <walletsDir>
//
// Prints the wallet file's path, its password (what the NextGraph app asks for
// after "Import a Wallet File"), and the twelve mnemonic words with the PIN
// (what the SDK opens it with).
// Nothing leaves the machine; the file itself is what the owner takes.
import fs from 'node:fs';
import path from 'node:path';

const [verb, root, ...rest] = process.argv.slice(2);
const dirFlag = rest.indexOf('--dir');
const dir = dirFlag >= 0 ? rest[dirFlag + 1] : undefined;
if (verb !== 'wallet' || !root || !dir) {
  console.error('usage: css-nextgraph wallet <pod-root-url> --dir <walletsDir>');
  process.exit(2);
}
const stem = root.replace(/^https?:\/\//u, '').replace(/\/+$/u, '').replace(/[^A-Za-z0-9.-]+/gu, '_') || 'root';
const file = path.join(dir, `${stem}.ngw`);
const recordPath = path.join(dir, `${stem}.json`);
if (!fs.existsSync(file) || !fs.existsSync(recordPath)) {
  console.error(`no wallet for ${root} under ${dir} (looked for ${stem}.ngw and ${stem}.json)`);
  process.exit(1);
}
const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
console.log(`wallet file: ${path.resolve(file)}`);
console.log(`user:        ${record.user}`);
console.log(`password:    ${record.password ?? '(none: made before passwords were recorded)'}`);
console.log(`mnemonic:    ${record.mnemonic.join(' ')}`);
console.log(`PIN:         ${record.pin.join('')}`);
