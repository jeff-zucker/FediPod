// empty-retired-pod.mjs — take the agent's own tree out of a pod whose actor
// has been retired, and leave the Tombstone standing.
//
// CSS has no delete-pod and no delete-account handler — checked against the
// shipped 7.1.9, where the only Delete* in the whole account API is
// DeleteClientCredentialsHandler. So "delete the pod in the dashboard" is not
// something anyone but the server operator can do. What an owner CAN do is
// empty it, and the end state is arguably better: the actor keeps answering
// with its Tombstone — a permanent "this is gone" — while none of the data is
// left behind. Deleting the pod outright would replace that with a 404, which
// servers treat as transient and retry.
//
//   node claude/migration-scripts/empty-retired-pod.mjs --home <dir> [--root ''] [--go]
//
// DRY RUN unless given --go. The dry run is a measurement: how many resources,
// how many bytes, how old, and the size distribution — everything the
// container listing already carries, at no extra cost.
//
// ---- efficient ----
// One request per resource, and no more. A container listing carries
// ldp:contains, dc:modified and posix:size in a single response, so nothing is
// fetched to find out how big or how old it is, and nothing is read before
// being deleted — the whole tree is going, so its contents do not matter.
// Requests are issued one at a time: RemotePod's session already holds itself
// to AP_MAX_REQUESTS_PER_MIN (60) per pod and defers to stay under, so
// sequential calls pace themselves. Firing them in parallel would only make
// them queue past AP_SLOT_WAIT_MAX_MS and fail.
//
// ---- least destructive ----
//   · Scoped to the agent's own container, computed once, re-checked against
//     every child of every listing. Never the pod root — an earlier version
//     walked from `urls.home`, which for dk's flat layout IS the pod root, so
//     it enumerated /profile/ and /settings/ too. Deleting /profile/card takes
//     out the WebID the credential authenticates as, and everything after that
//     is a 401.
//   · Refuses unless the actor is already a Tombstone, so it cannot take a
//     live identity apart from underneath itself.
//   · Keeps the actor document. Auxiliaries (.acl, .meta) are never listed by
//     ldp:contains and are never deleted directly — CSS removes them with
//     their resource, and deleting an .acl on its own is how you lock yourself
//     out mid-run.
//   · Deletes leaves before their containers, and re-lists only what failed.
//   · Stops on a run of auth failures instead of grinding through a thousand
//     of them.
//   · Writes a manifest of everything it deleted, next to the credential.
//   · Re-runnable: it re-walks, so it resumes wherever it stopped.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as $rdf from 'rdflib';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { RemotePod } = await import(path.join(repo, 'lib/remote.mjs'));
const wire = await import(path.join(repo, 'lib/wire.mjs'));

const LDP = $rdf.Namespace('http://www.w3.org/ns/ldp#');
const DC = $rdf.Namespace('http://purl.org/dc/terms/');
const POSIX = $rdf.Namespace('http://www.w3.org/ns/posix/stat#');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const GO = args.includes('--go');
const GAP_MS = Number(flag('gap', 0));      // the session's own 60/min already paces us
const HOME = (flag('home') || '').replace(/^~/, os.homedir());
if (!HOME) { console.error('need --home <dir>'); process.exit(2); }
const ROOT = flag('root', undefined);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} kB`);

const readJson = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, name), 'utf8')); }
  catch { return null; }
};

// Two layouts: standalone keeps credential.json beside the state; dk nests the
// whole thing inside config.json, which also carries remotePod.
const standalone = readJson('credential.json');
const dkConfig = readJson('config.json');
const credential = standalone || (dkConfig?.credential ? { ...dkConfig.credential } : null);
const remotePod = standalone?.remotePod || dkConfig?.remotePod;
if (!credential || !remotePod) {
  console.error(`no credential in ${HOME} — expected credential.json, or config.json with .credential`);
  process.exit(2);
}
const root = ROOT !== undefined ? ROOT : (standalone?.root ?? dkConfig?.root);
const urls = wire.apUrls(remotePod, root);
const podBase = urls.base;

// SCOPE: the agent's own container and nothing above it. We have no idea what
// else a pod is used for.
//   standalone (root 'activitypods-js/')  → <pod>/activitypods-js/
//   dk         (root '')                  → <pod>/ap/
const SCOPE = urls.home === podBase ? urls.home + 'ap/' : urls.home;
if (!SCOPE.startsWith(podBase) || SCOPE.length <= podBase.length) {
  console.error(`refusing: scope ${SCOPE} is the pod root. Nothing outside the agent's own container is this script's business.`);
  process.exit(2);
}
const KEEP = new Set([urls.actor]);
const inScope = (u) => u.startsWith(SCOPE) && !KEEP.has(u);

console.log(`pod:   ${remotePod}`);
console.log(`scope: ${SCOPE}`);
console.log(`keep:  ${urls.actor}  (the Tombstone)\n`);

const remote = new RemotePod(credential, { log: (...a) => console.log('[pod]', ...a), home: HOME });
await remote.warmup();

const actor = await remote.getJson(urls.actor).catch(() => null);
if (actor?.type !== 'Tombstone') {
  console.error(`refusing: ${urls.actor} is ${actor?.type || 'unreadable'}, not a Tombstone.`);
  console.error(`retire it first:  node claude/migration-scripts/retire-scn-actor.mjs --home ${HOME}`);
  process.exit(2);
}
console.log(`actor is a Tombstone (deleted ${actor.deleted}) — safe to empty\n`);

// One request per container, and it carries everything: what is inside, how
// big each thing is, and when it last changed.
async function listing(url) {
  const res = await remote.fetch(url, { headers: { accept: 'text/turtle' } });
  if (res.status === 404) return [];
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const g = $rdf.graph();
  $rdf.parse(await res.text(), g, url, 'text/turtle');
  const here = $rdf.sym(url);
  return g.each(here, LDP('contains'), null, here).map((child) => ({
    url: child.value,
    container: child.value.endsWith('/'),
    size: Number(g.any(child, POSIX('size'), null, here)?.value || 0),
    modified: g.any(child, DC('modified'), null, here)?.value || null,
  }));
}

// Depth-first: a container cannot go until its children have.
async function walk(container, depth = 0, out = []) {
  if (depth > 12) { console.log(`  ${container} — too deep, skipped`); return out; }
  let children;
  try { children = await listing(container); }
  catch (e) { console.log(`  ${container} — unlistable (${e.message}), skipped`); return out; }
  for (const c of children) {
    if (!inScope(c.url)) { console.log(`  ${c.url} — outside the scope, skipped`); continue; }
    if (c.container) await walk(c.url, depth + 1, out);
    out.push({ ...c, depth });
  }
  return out;
}

const targets = await walk(SCOPE);
if (!targets.length) {
  console.log('nothing left under the scope — already empty.');
  process.exit(0);
}

// ---- the measurement ----
const docs = targets.filter(t => !t.container);
const bytes = docs.reduce((n, t) => n + t.size, 0);
const dates = docs.map(t => t.modified).filter(Boolean).sort();
const byContainer = new Map();
for (const t of docs) {
  const parent = t.url.slice(0, t.url.lastIndexOf('/') + 1);
  const e = byContainer.get(parent) || { n: 0, bytes: 0 };
  e.n++; e.bytes += t.size;
  byContainer.set(parent, e);
}
const BUCKETS = [[0, 512], [512, 1024], [1024, 4096], [4096, 16384], [16384, Infinity]];
const label = (lo, hi) => (hi === Infinity ? `>${kb(lo)}` : `${kb(lo)}–${kb(hi)}`);

console.log(`${targets.length} resource(s): ${docs.length} document(s) + ${targets.length - docs.length} container(s), ${kb(bytes)}`);
if (dates.length) console.log(`oldest ${dates[0]}   newest ${dates[dates.length - 1]}`);
console.log('\nby container:');
for (const [c, e] of [...byContainer].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(e.n).padStart(6)}  ${kb(e.bytes).padStart(9)}  ${c}`);
}
console.log('\nby size — small documents are control activities (Follow, Undo,');
console.log('Accept, Delete); large ones carry content:');
for (const [lo, hi] of BUCKETS) {
  const n = docs.filter(t => t.size >= lo && t.size < hi).length;
  if (n) console.log(`  ${String(n).padStart(6)}  ${label(lo, hi)}`);
}

if (!GO) {
  console.log('\n--- DRY RUN, nothing deleted. Re-run with --go. ---');
  console.log(`at one request each and 60/min, expect about ${Math.ceil(targets.length / 60)} minute(s).`);
  process.exit(0);
}

// ---- the deletion ----
// Leaves before containers: `targets` is already in that order, because walk()
// pushes a container only after everything inside it.
const manifest = path.join(HOME, `emptied-${new URL(podBase).host}-${actor.deleted.slice(0, 10)}.log`);
const log = fs.createWriteStream(manifest, { flags: 'a' });
console.log(`\nrecording what goes to ${manifest}\n`);

let gone = 0;
let authFails = 0;
let remaining = targets;

for (let pass = 1; pass <= 4 && remaining.length; pass++) {
  console.log(`pass ${pass}: ${remaining.length} to go`);
  const failed = [];
  for (const t of remaining) {
    // RemotePod THROWS while it is inside a Retry-After cooldown, so one 429
    // would otherwise turn every remaining delete into a failure.
    while (remote.pausedUntil > Date.now()) {
      const secs = Math.ceil((remote.pausedUntil - Date.now()) / 1000);
      console.log(`  pod asked for ${secs}s of quiet — waiting`);
      await sleep(Math.min(secs, 30) * 1000 + 500);
    }
    let why = null;
    try {
      const res = await remote.fetch(t.url, { method: 'DELETE' });
      if (res.status >= 400 && res.status !== 404) why = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) authFails++;
    } catch (e) { why = e.message; }

    if (!why) { gone++; authFails = 0; log.write(`${t.url}\n`); }
    else { failed.push(t); console.log(`  ${why}\t${t.url}`); }

    // A run of these means the credential stopped working — grinding through
    // a thousand more will not fix it and is rude to the pod.
    if (authFails >= 10) {
      console.error('\n10 auth failures in a row — stopping. The credential is not being accepted.');
      console.error('Check that the pod\'s WebID document still exists and the credential is not revoked.');
      log.end();
      process.exit(1);
    }
    if (GAP_MS) await sleep(GAP_MS);
  }
  if (failed.length === remaining.length) {
    console.log('\nno progress this pass — stopping rather than pushing.');
    remaining = failed;
    break;
  }
  remaining = failed;      // only what failed is retried, and only it is re-tried
}
log.end();

console.log(`\ndeleted ${gone}${remaining.length ? `, ${remaining.length} left` : ''}`);
if (remaining.length) {
  console.log('\nstill there:');
  for (const t of remaining.slice(0, 40)) console.log(`  ${t.url}`);
  if (remaining.length > 40) console.log(`  … and ${remaining.length - 40} more`);
  console.log('\nre-run to try again — it re-walks, so it resumes where it stopped.');
  process.exit(1);
}
console.log(`the Tombstone at ${urls.actor} is untouched.`);
console.log('revoke the pod credential now — after that, nothing can write here again.');
