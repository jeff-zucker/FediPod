// empty-retired-pod.mjs — take everything out of a pod whose actor has been
// retired, and leave the Tombstone standing.
//
// CSS has no delete-pod and no delete-account handler — checked against the
// shipped 7.1.9: `dist/identity/interaction/` has CreateAccountHandler,
// CreatePodHandler and UpdateOwnerHandler, and the only Delete* in the whole
// account API is DeleteClientCredentialsHandler. So "delete the pod in the
// dashboard" is not a thing anyone can do; only the server operator can.
//
// What you CAN do is own it and empty it. The end state is arguably better than
// deletion: the actor document keeps answering with its Tombstone — a permanent
// "this is gone" — while none of your data is left behind. Deleting the pod
// outright would replace that with a 404, which servers treat as a transient
// failure and retry.
//
//   node claude/migration-scripts/empty-retired-pod.mjs --home <dir> [--root ''] [--go]
//
// DRY RUN unless given --go: it walks the containers and prints every URL it
// would delete, and deletes nothing.
//
// Refuses to run unless the actor already IS a Tombstone — retire first
// (retire-scn-actor.mjs), or you would be emptying a live actor's pod.
//
// It never deletes:
//   · the actor document          (the Tombstone is the point)
//   · .well-known/*               (webfinger keeps resolving to the Tombstone)
//   · anything outside the pod's own container tree
//
// Run this BEFORE revoking the pod's credential — afterwards there is no way in.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { RemotePod } = await import(path.join(repo, 'lib/remote.mjs'));
const { storageFor } = await import(path.join(repo, 'lib/storage.mjs'));
const wire = await import(path.join(repo, 'lib/wire.mjs'));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const GO = args.includes('--go');
const HOME = (flag('home') || '').replace(/^~/, os.homedir());
if (!HOME) { console.error('need --home <dir>'); process.exit(2); }
const ROOT = flag('root', undefined);

const read = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, name), 'utf8')); }
  catch { return null; }
};
const standalone = read('credential.json');
const dkConfig = read('config.json');
const credential = standalone || (dkConfig?.credential ? { ...dkConfig.credential } : null);
const remotePod = standalone?.remotePod || dkConfig?.remotePod;
if (!credential || !remotePod) {
  console.error(`no credential in ${HOME} — expected credential.json, or config.json with .credential`);
  process.exit(2);
}
const root = ROOT !== undefined ? ROOT : (standalone?.root ?? dkConfig?.root);
const urls = wire.apUrls(remotePod, root);

console.log(`pod:   ${remotePod}`);
console.log(`actor: ${urls.actor}\n`);

const remote = new RemotePod(credential, { log: (...a) => console.log('[pod]', ...a), home: HOME });
await remote.warmup();

// The guard: emptying a pod whose actor is still live would take a working
// identity apart from underneath itself.
const actor = await remote.getJson(urls.actor).catch(() => null);
if (actor?.type !== 'Tombstone') {
  console.error(`refusing: ${urls.actor} is ${actor?.type || 'unreadable'}, not a Tombstone.`);
  console.error('Retire it first:  node claude/migration-scripts/retire-scn-actor.mjs --home ' + HOME);
  process.exit(2);
}
console.log(`actor is a Tombstone (deleted ${actor.deleted}) — safe to empty\n`);

const KEEP = new Set([urls.actor]);
const podBase = urls.base;
const store = storageFor(podBase, (u, i) => remote.fetch(u, i));

// Depth-first: a container cannot go until its children have.
async function walk(container, depth = 0) {
  if (depth > 12) { console.log(`  ${container} — too deep, skipped`); return []; }
  let names = [];
  try { ({ names } = await store.list(container.slice(podBase.length))); }
  catch (e) { console.log(`  ${container} — unlistable (${e.message}), skipped`); return []; }
  const out = [];
  for (const name of names) {
    const child = container + name;
    if (child.startsWith(podBase + '.well-known')) continue;   // webfinger stays
    if (KEEP.has(child)) continue;
    if (name.endsWith('/')) out.push(...await walk(child, depth + 1));
    out.push(child);
  }
  return out;
}

const targets = await walk(urls.home);
console.log(`${targets.length} resource(s) under ${urls.home}:`);
for (const t of targets) console.log(`  ${t}`);
console.log(`\nkeeping: ${urls.actor}`);
console.log(`keeping: ${podBase}.well-known/* (webfinger still resolves to the Tombstone)`);

if (!GO) {
  console.log('\n--- DRY RUN, nothing deleted. Re-run with --go to do it. ---');
  process.exit(0);
}

let gone = 0;
let failed = 0;
for (const t of targets) {
  const ok = await store.remove(t.slice(podBase.length));
  if (ok) { gone++; } else { failed++; console.log(`  FAILED ${t}`); }
}
console.log(`\ndeleted ${gone}${failed ? `, ${failed} failed` : ''}`);
console.log('The Tombstone is still there. Revoke the pod credential now — after that,');
console.log('nothing can write to this pod again.');
