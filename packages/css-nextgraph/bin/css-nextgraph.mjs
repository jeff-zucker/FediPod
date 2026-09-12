#!/usr/bin/env node
// css-nextgraph.mjs — the two things a host does by hand.
//
//   css-nextgraph key
//     Prints a new master key. Every pod's wallet record is sealed under it,
//     so the wallets directory alone opens nothing. Keep a copy somewhere
//     that is not this server: without it the pods cannot be opened again.
//
//   css-nextgraph wallet <pod-root-url> --dir <walletsDir> [--key <masterKey>]
//     The hand-over: the wallet file's path, its password (what the NextGraph
//     app asks for after "Import a Wallet File"), and the twelve mnemonic
//     words with the PIN (what the SDK opens it with). A sealed record needs
//     the master key, from --key or CSS_NEXTGRAPH_KEY.
//
// Nothing leaves the machine; the file itself is what the owner takes.
import fs from 'node:fs';
import path from 'node:path';
import { isSealed, newKey, parseKey, unseal, KEY_ENV } from '../dist/masterkey.js';

const [verb, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : undefined;
};

if (verb === 'key') {
  console.log(newKey());
  process.exit(0);
}

const root = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
const dir = flag('dir');
if (verb !== 'wallet' || !root || !dir) {
  console.error('usage: css-nextgraph wallet <pod-root-url> --dir <walletsDir> [--key <masterKey>]');
  console.error('       css-nextgraph key');
  process.exit(2);
}

const stem = root.replace(/^https?:\/\//u, '').replace(/\/+$/u, '').replace(/[^A-Za-z0-9.-]+/gu, '_') || 'root';
const file = path.join(dir, `${stem}.ngw`);
const recordPath = path.join(dir, `${stem}.json`);
if (!fs.existsSync(file) || !fs.existsSync(recordPath)) {
  console.error(`no wallet for ${root} under ${dir} (looked for ${stem}.ngw and ${stem}.json)`);
  process.exit(1);
}

const onDisk = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
let record = onDisk;
if (isSealed(onDisk.sealed)) {
  const supplied = flag('key') ?? process.env[KEY_ENV];
  if (!supplied) {
    console.error(`the record for ${root} is sealed under this server's master key — pass it with --key or in ${KEY_ENV}`);
    process.exit(1);
  }
  try {
    record = { ...unseal(parseKey(supplied), onDisk.sealed), user: onDisk.user };
  } catch {
    console.error('that key does not open this record');
    process.exit(1);
  }
}

console.log(`wallet file: ${path.resolve(file)}`);
console.log(`user:        ${record.user}`);
console.log(`password:    ${record.password ?? '(none: made before passwords were recorded)'}`);
console.log(`mnemonic:    ${record.mnemonic.join(' ')}`);
console.log(`PIN:         ${record.pin.join('')}`);
