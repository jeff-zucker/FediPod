#!/usr/bin/env node
// clear-pod-private-copy.mjs — after `activitypod state --to <local>`, remove the
// copy left behind on the pod.
//
// `state --to` copies and never deletes: a move that destroys the source before
// you have looked at the destination is not a move. So the private half stays on
// the pod until someone says otherwise, and getting it off the pod is usually the
// whole reason for moving it. This is that second step.
//
// TWO THINGS IT MUST NOT DELETE, and both are why this is a script rather than a
// flag on the command:
//
//   ap-state/lease.json — pinned to the REMOTE pod on purpose (run-agent builds
//     the Lease from urls.state, never from privateRoot). Exactly one agent may
//     act on a pod because inbox drains are destructive reads; a lease in a
//     directory only this machine can see coordinates nothing.
//   ap-state/.keep      — the container marker.
//
// Everything else under ap-state/ goes, and the whole fediverse/ tree with it.
// NOTHING outside those two prefixes is touched — not the actor, the inbox, the
// outbox, the notes, the followers or webfinger, which are the public face other
// servers read, and not whatever else the pod is used for.
//
//   node claude/migration-scripts/clear-pod-private-copy.mjs            # dry run
//   node claude/migration-scripts/clear-pod-private-copy.mjs --go
//   node claude/migration-scripts/clear-pod-private-copy.mjs --home ~/.activitypod/profiles/solo

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const GO = args.includes('--go');
const HOME = flag('home', process.env.AP_HOME || path.join(process.env.HOME, '.activitypod'));

const KEEP = new Set(['lease.json', '.keep']);

const cred = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'credential.json'), 'utf8')); }
  catch { console.error(`no credential in ${HOME}`); process.exit(2); }
})();

if (!cred.privateRoot) {
  console.error('privateRoot is not set — this identity still keeps its private half ON the pod.');
  console.error('There is nothing here that is a leftover copy. Run `activitypod state --to <url>` first.');
  process.exit(2);
}

const { apUrls } = await import(new URL('../../lib/wire.mjs', import.meta.url));
const { RemotePod } = await import(new URL('../../lib/remote.mjs', import.meta.url));
const { Agent } = await import(new URL('../../run-agent.mjs', import.meta.url));

const urls = apUrls(cred.remotePod, cred.root);
const remote = new RemotePod(cred, { log: () => {}, home: HOME });
await remote.warmup();

// The jail. Every URL is checked against these before a DELETE is issued, so a
// listing that returns something unexpected cannot make this reach further.
const PREFIXES = [urls.state, urls.home + 'fediverse/'];
const inScope = (u) => PREFIXES.some(p => u.startsWith(p));

// Depth-first: children before the container that holds them.
async function tree(container) {
  const out = [];
  for (const child of await remote.listContainer(container).catch(() => [])) {
    if (!inScope(child.url)) { console.error(`REFUSED, out of scope: ${child.url}`); continue; }
    if (child.url.endsWith('/')) out.push(...await tree(child.url), child.url);
    else out.push(child.url);
  }
  return out;
}

const local = cred.privateRoot.replace(/^file:\/\//, '');
const doomed = [];
for (const u of await tree(urls.state)) {
  if (KEEP.has(u.split('/').pop())) continue;
  doomed.push(u);
}
doomed.push(...await tree(urls.home + 'fediverse/'));
doomed.push(urls.home + 'fediverse/');

// A copy is only a leftover if the copy still exists. Anything with no local
// counterpart is NOT deleted — it would be the only one there is.
const orphans = [];
for (const u of doomed) {
  if (u.endsWith('/')) continue;
  // A container marker is not data and never has a local counterpart — the
  // filesystem store has no need of one. Counting it as an orphan would refuse
  // every run for the one file whose loss costs nothing.
  if (u.endsWith('/.keep')) continue;
  const rel = u.startsWith(urls.state)
    ? 'ap-state/' + u.slice(urls.state.length)
    : 'fediverse/' + u.slice((urls.home + 'fediverse/').length);
  if (!fs.existsSync(path.join(local, rel))) orphans.push(rel);
}

console.log(`pod   : ${urls.home}`);
console.log(`local : ${cred.privateRoot}`);
console.log(`kept on the pod: ${[...KEEP].join(', ')}\n`);
for (const u of doomed) console.log(`  delete  ${u.slice(urls.home.length)}`);
console.log(`\n${doomed.length} to delete.`);

if (orphans.length) {
  console.error(`\nREFUSING: ${orphans.length} document(s) on the pod have no local copy:`);
  for (const o of orphans) console.error(`  ${o}`);
  console.error('Deleting those would remove the only copy. Re-run `state --to` first.');
  process.exit(1);
}
if (!GO) { console.log('\nDry run. Add --go to delete.'); process.exit(0); }

let gone = 0;
const failed = [];
for (const u of doomed) {
  if (!inScope(u)) { failed.push([u, 'out of scope']); continue; }
  const ok = await remote.delete(u).catch(e => e.message);
  if (ok === true) { gone++; } else { failed.push([u, ok]); }
}
console.log(`\ndeleted ${gone}/${doomed.length}`);
for (const [u, why] of failed) console.error(`  left behind: ${u.slice(urls.home.length)} (${why})`);
process.exit(failed.length ? 1 : 0);
