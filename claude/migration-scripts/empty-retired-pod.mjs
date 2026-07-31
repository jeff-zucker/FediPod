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
//   node claude/migration-scripts/empty-retired-pod.mjs --home <dir> [--root ''] [--go] [--gap 1000]
//
// DRY RUN unless given --go: it walks the containers and prints every URL it
// would delete, and deletes nothing.
//
// It goes slowly on purpose — one delete a second by default (`--gap`), because
// the agent holds itself to 60 requests a minute per pod and a bulk delete is
// the easiest way to repeat the 2026-07-29 incident. It waits out a
// `Retry-After` rather than failing everything behind it, retries across
// several passes (a container will not go while anything is left inside it),
// prints the actual status for every failure, and is safe to re-run: it
// re-walks, so it resumes where it stopped.
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

// SCOPE: the agent's own container, and nothing above it. We have no idea what
// else a pod is used for.
//
// The first version of this script walked `urls.home`, which for dk's flat
// layout (--root '') IS the pod root — so it enumerated /profile/, /settings/
// and everything else. Deleting /profile/card takes out the WebID the
// credential authenticates as, and every request after that is a 401. That is
// how it failed.
//
//   standalone (root 'activitypods-js/')  → <pod>/activitypods-js/
//   dk         (root '')                  → <pod>/ap/
const SCOPE = urls.home === podBase ? urls.home + 'ap/' : urls.home;
if (SCOPE === podBase || !SCOPE.startsWith(podBase) || SCOPE.length <= podBase.length) {
  console.error(`refusing: computed scope ${SCOPE} is the pod root. Nothing outside the agent's own container is this script's business.`);
  process.exit(2);
}
const inScope = (u) => u.startsWith(SCOPE) && !KEEP.has(u);
console.log(`scope: ${SCOPE}  (nothing outside this is touched)\n`);

// Depth-first: a container cannot go until its children have.
async function walk(container, depth = 0) {
  if (depth > 12) { console.log(`  ${container} — too deep, skipped`); return []; }
  let names = [];
  try { ({ names } = await store.list(container.slice(podBase.length))); }
  catch (e) { console.log(`  ${container} — unlistable (${e.message}), skipped`); return []; }
  const out = [];
  for (const name of names) {
    const child = container + name;
    // Checked per child, not just at the top: a container listing is remote
    // input, and a `..` or an absolute URL in it must not carry us out.
    if (!inScope(child)) { console.log(`  ${child} — outside ${SCOPE}, skipped`); continue; }
    if (name.endsWith('/')) out.push(...await walk(child, depth + 1));
    out.push(child);
  }
  return out;
}

const targets = await walk(SCOPE);
console.log(`${targets.length} resource(s) under ${SCOPE}:`);
for (const t of targets) console.log(`  ${t}`);
console.log(`\nkeeping: ${urls.actor}`);
console.log(`keeping: everything outside ${SCOPE} — the profile, the settings,`);
console.log(`         .well-known/ (webfinger still resolves to the Tombstone),`);
console.log('         and whatever else this pod is used for.');

if (!GO) {
  console.log('\n--- DRY RUN, nothing deleted. Re-run with --go to do it. ---');
  process.exit(0);
}

// Deliberately slow. The agent holds itself to 60 requests a minute per pod
// (AP_MAX_REQUESTS_PER_MIN) because blowing through that is what the 2026-07-29
// incident was about, and a bulk delete is the easiest way to do it again.
const GAP_MS = Number(flag('gap', 1000));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// RemotePod THROWS while it is in a Retry-After cooldown, so one 429 from the
// pod turns every remaining delete into a failure. Wait the window out instead.
async function settle() {
  while (remote.pausedUntil > Date.now()) {
    const secs = Math.ceil((remote.pausedUntil - Date.now()) / 1000);
    console.log(`  pod asked for ${secs}s of quiet — waiting`);
    await sleep(Math.min(secs, 30) * 1000 + 500);
  }
}

async function del(url) {
  await settle();
  try {
    const res = await remote.fetch(url, { method: 'DELETE' });
    if (res.status < 400 || res.status === 404) return { ok: true };
    return { ok: false, why: `HTTP ${res.status}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

// Several passes: a container will not go while anything is left inside it, so
// a child that failed once takes its parent down with it. Retrying until no
// further progress sorts out both ordering and anything transient.
let remaining = targets;
let gone = 0;
for (let pass = 1; pass <= 5 && remaining.length; pass++) {
  console.log(`\npass ${pass}: ${remaining.length} to go`);
  const failed = [];
  for (const t of remaining) {
    const r = await del(t);
    if (r.ok) { gone++; } else { failed.push(t); console.log(`  ${r.why}\t${t}`); }
    await sleep(GAP_MS);
  }
  if (failed.length === remaining.length) {
    console.log('\nno progress this pass — stopping rather than hammering the pod.');
    remaining = failed;
    break;
  }
  remaining = failed;
}

console.log(`\ndeleted ${gone}${remaining.length ? `, ${remaining.length} left` : ''}`);
if (remaining.length) {
  console.log('\nStill there:');
  for (const t of remaining) console.log(`  ${t}`);
  console.log('\nRe-run to try again — it re-walks, so it picks up where it left off.');
  process.exit(1);
}
console.log('The Tombstone is still there. Revoke the pod credential now — after that,');
console.log('nothing can write to this pod again.');
