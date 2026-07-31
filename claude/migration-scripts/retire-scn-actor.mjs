// retire-scn-actor.mjs — retire an actor that its own agent cannot retire.
//
// `activitypod retire` needs the standalone layout: a credential.json in
// AP_HOME and the agent's state in ap-state/ ON the pod. Neither scn identity
// has that — dk's ap-agent keeps its credential nested inside a local
// config.json and its state in plain files, and the activitypods-js pod's
// credential was overwritten before the guard existed. So this does exactly
// what publisher.retireActor() does, with the same library code, driven by
// whatever credential and key you point it at:
//
//   1. POST a Delete{actor} to every follower inbox — the signal that makes a
//      well-behaved server drop the account AND the posts it cached.
//   2. PUT a Tombstone where the actor document was, publicly readable, so
//      anything that dereferences it afterwards gets an answer rather than a
//      404 it will retry.
//
// Deleting the pod without this leaves a ghost: mastodon.social keeps the
// account and its statuses, and nothing ever tells it otherwise. Retire FIRST,
// then delete the pod (claude/plans/live-test.md, tear-down order).
//
// Usage, from the repo root:
//
//   node claude/migration-scripts/retire-scn-actor.mjs --home <dir> [--root ''] [--go]
//
// Without --go it is a DRY RUN: it reads everything, resolves the follower
// inboxes and prints exactly what it would send, and sends nothing.
//
//   # dk's agent (credential nested in config.json, flat /ap/ layout)
//   node claude/migration-scripts/retire-scn-actor.mjs --home ~/.config/data-kitchen/ap --root ''
//
//   # a standalone home (credential.json, activitypods-js/ layout)
//   node claude/migration-scripts/retire-scn-actor.mjs --home ~/.activitypod-scn
//
// Your credential and signing key are read by THIS script at run time and go
// nowhere else.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { RemotePod } = await import(path.join(repo, 'lib/remote.mjs'));
const { Deliverer } = await import(path.join(repo, 'lib/deliver.mjs'));
const { PodStore } = await import(path.join(repo, 'lib/store.mjs'));
const wire = await import(path.join(repo, 'lib/wire.mjs'));

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const GO = args.includes('--go');
const HOME = (flag('home') || '').replace(/^~/, os.homedir());
if (!HOME) { console.error('need --home <dir>'); process.exit(2); }
const ROOT = flag('root', undefined);          // '' for dk's flat /ap/ layout

const read = (name) => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, name), 'utf8')); }
  catch { return null; }
};

// Two layouts. Standalone: credential.json beside the state. dk: the whole
// thing nested inside config.json, which also carries remotePod.
const standalone = read('credential.json');
const dkConfig = read('config.json');
const credential = standalone || (dkConfig?.credential ? { ...dkConfig.credential } : null);
const remotePod = standalone?.remotePod || dkConfig?.remotePod;
const kind = dkConfig?.kind || 'person';
if (!credential || !remotePod) {
  console.error(`no credential in ${HOME} — expected credential.json or config.json with .credential`);
  process.exit(2);
}
const root = ROOT !== undefined ? ROOT : (standalone?.root ?? dkConfig?.root);
const urls = wire.apUrls(remotePod, root);

console.log(`home:      ${HOME}`);
console.log(`pod:       ${remotePod}`);
console.log(`actor:     ${urls.actor}`);
console.log(`followers: ${urls.followers}\n`);

const remote = new RemotePod(credential, { log: (...a) => console.log('[pod]', ...a), home: HOME });
await remote.warmup();

// Read the follower list the way the agent does. Authenticated, so it works
// even where the collection is not publicly readable.
const localContacts = read('contacts.json');
let followers = localContacts?.followers || [];
if (!followers.length) {
  const doc = await remote.getJson(urls.followers).catch(() => null);
  followers = (doc?.orderedItems || []).map(actor => ({ actor }));
  // A follower record from the collection has no inbox; dereference for it.
  for (const f of followers) {
    const a = await remote.getJson(f.actor).catch(() => null);
    f.inbox = a?.inbox;
    f.sharedInbox = a?.endpoints?.sharedInbox;
  }
}
const inboxes = [...new Set(followers.map(f => f.sharedInbox || f.inbox).filter(Boolean))];
console.log(`followers: ${followers.length} → ${inboxes.length} inbox(es)`);
for (const i of inboxes) console.log(`  ${i}`);

const deletedAt = new Date().toISOString();
const activity = wire.deleteActorActivity(urls, Date.parse(deletedAt));
const tombstone = wire.tombstoneDoc(urls, deletedAt, kind);

if (!GO) {
  console.log('\n--- DRY RUN, nothing sent. Re-run with --go to do it. ---');
  console.log('\nDelete to each inbox above:\n' + JSON.stringify(activity, null, 2));
  console.log(`\nTombstone PUT to ${urls.actor}:\n` + JSON.stringify(tombstone, null, 2));
  process.exit(0);
}

// Signing key: local by default, in pod state when the identity used --keys pod.
const keys = read('keys.json');
if (!keys?.rsa?.privatePem) {
  console.error(`no signing key in ${HOME}/keys.json — a Delete nobody can verify is a Delete nobody acts on`);
  process.exit(2);
}
const store = new PodStore({ log: () => {} });          // memory only: nothing is written back
const deliverer = new Deliverer({
  store, keyId: urls.actor + '#main-key', rsaPrivate: keys.rsa.privatePem,
  log: (...a) => console.log('[deliver]', ...a), passive: true,
});

await deliverer.deliverToAll(inboxes, activity);
console.log(`Delete sent to ${inboxes.length} inbox(es)`);

await remote.putJson(urls.actor, tombstone);
await remote.setAcl(urls.actor, ['Read']);              // a Tombstone must stay fetchable
console.log(`Tombstone published at ${urls.actor}`);
console.log('\nGive it a few minutes, check the actor URL, THEN delete the pod.');
