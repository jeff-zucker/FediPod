// state.mjs — where things live and moving them: state (this identity's
// private half, or every identity's), upgrade, profiles, home, export.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identityHomes, isLegacyRoot, CURRENT_ROOT, tildify, defaultProfile, profileHome, rootHoldsIdentity, recordLastUsed, writeJsonAtomic } from '../../home.mjs';
import { insecureUrlReason } from '../../../shared/safefetch.mjs';
import { localFetch } from '../../../client/localapi.mjs';
import { args, flag, has, PROFILE, AP_ROOT, HOME, PORT, requireHandle, requireIdentity, somethingOn, agentOn, isInside } from '../context.mjs';

export async function state() {
  if (has('all') || has('drop-remote')) return stateAll();
requireIdentity();
// Where the private half lives, and how to move it. Copy, verify, THEN
// repoint — a pointer moved on its own leaves the agent reading one
// container and writing another, which is the divergence this avoids.
// The old copy is left behind on purpose; delete it when you are satisfied.
const credPath = path.join(HOME, 'credential.json');
let cred;
try { cred = JSON.parse(fs.readFileSync(credPath, 'utf8')); }
catch { console.error(`no identity in ${HOME} — run setup first`); process.exit(2); }

const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const where = (c) => (c.privateRoot ? tildify(c.privateRoot) : `${apUrls(c.remotePod, c.root).home}(on the pod)`);

const to = flag('to');
if (!to) {
  console.log(`private data: ${where(cred)}`);
  console.log(`public face:  ${apUrls(cred.remotePod, cred.root).home}`);
  console.log('\nTo move it:  fedipod state --to ~/somewhere/private/');
  console.log('             fedipod state --to <container-url>');
  console.log('             fedipod state --to pod');
  process.exit(0);
}
if (await localFetch(HOME, PORT, `/status`).then(() => true).catch(() => false)) {
  console.error(`an agent is running on port ${PORT} — stop it first:  fedipod stop`);
  process.exit(1);
}
// A path or a URL. `state` prints the path form, so refusing it here would
// mean what the command shows you is not what it takes back — two chars before
// the colon, so a Windows drive letter is a path rather than a scheme.
let target = null;
if (to !== 'pod') {
  const asPath = !/^[a-z][a-z0-9+.-]+:/i.test(to);
  const raw = asPath
    ? pathToFileURL(path.resolve(to.replace(/^~(?=[/\\]|$)/, os.homedir()))).href
    : to;
  target = raw.endsWith('/') ? raw : raw + '/';
  try { new URL(target); } catch { console.error(`"${to}" is not a container URL or a path`); process.exit(2); }
}
if ((cred.privateRoot || null) === target) { console.log(`already there: ${where(cred)}`); process.exit(0); }
// Before anything is built or sent, not after. This check used to sit at the
// very bottom, past the copy — so `--to http://nas.local/private/`, a typo
// for https or a plaintext box on the LAN, wrote every state document
// (masto-tokens.json included) and every RDF note to that host in the clear,
// and only then said the address was refused. The messages around it, which
// say nothing was repointed and the old copy was left where it was, were
// true and read as "nothing happened".
if (/^https?:/i.test(target || '')) {
  const bad = insecureUrlReason(target, 'private-data address');
  if (bad) { console.error(bad); process.exit(2); }
}

const agent = new Agent({ home: HOME, log: (...a) => console.log('[state]', ...a) });
agent.urls = apUrls(cred.remotePod, cred.root);
// Only one of the two sides can be the pod, and moving between two local
// pods needs no credential at all — so do not spend a token grant on it.
if (!cred.privateRoot || !target) {
  const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
  agent.remote = new RemotePod(cred, { log: () => {}, home: HOME });
  // A pod that is not there is the ordinary case for an identity nobody has
  // run in a while, and it used to arrive as an unhandled rejection — 20
  // lines of undici internals ending in ECONNREFUSED, with the reason on the
  // last line. Say which pod and why, and stop.
  try { await agent.remote.warmup(); }
  catch (e) {
    const why = e?.cause?.code === 'ECONNREFUSED' ? 'nothing is listening there' : (e.message || String(e));
    console.error(`cannot reach the pod this identity keeps its private half on:`);
    console.error(`  ${cred.remotePod} — ${why}`);
    console.error('Nothing was copied and nothing was repointed. Start the pod and try again.');
    process.exit(1);
  }
}
const destCred = { ...cred, privateRoot: target };
const from = agent.privateUrls(cred);
const dest = agent.privateUrls(destCred);
console.log(`moving the private half\n  from ${from.state.replace(/ap-state\/$/, '')}\n  to   ${dest.state.replace(/ap-state\/$/, '')}\n`);

const { copyPrivateHalf } = await import(new URL('../../../../lib/device/migrate.mjs', import.meta.url));
let copied;
try {
  copied = await copyPrivateHalf({
    from: { state: agent.privateStorage(cred, 'state') },
    to: { state: agent.privateStorage(destCred, 'state') },
    log: (...a) => console.log('[state]', ...a),
  });
} catch (e) { console.error(e.message); process.exit(1); }
console.log(`copied ${copied.docs} state document(s)`);

// An empty source produces an empty destination, and every check above
// passes: nothing failed to land because nothing was sent. The command then
// repointed the credential and said it had moved your private data. Say what
// actually happened instead — an empty move is usually a wrong --from, and
// finding that out later means looking for a timeline that was never there.
if (copied.docs === 0 && copied.notes === 0) {
  console.log('\nNOTHING WAS COPIED — the source held no state documents and no notes.');
  console.log(`  from: ${where(cred)}`);
  console.log('The pointer is being moved anyway, which is right for a fresh identity');
  console.log('and wrong if you expected a timeline here. Check the source if so.\n');
}

if (target) cred.privateRoot = target; else delete cred.privateRoot;
// Stamp what this install now IS, so `upgrade` stops naming it and the agent
// stops saying it is behind. Moving back onto the pod un-stamps it, which is
// honest rather than punitive: that is the old shape, and it should read as
// the old shape whoever chose it.
{
  const { CURRENT_LAYOUT, isCurrent } = await import(new URL('../../../../lib/device/migrate.mjs', import.meta.url));
  if (isCurrent(cred)) cred.layout = CURRENT_LAYOUT; else delete cred.layout;
}
writeJsonAtomic(credPath, cred);
console.log(`\nprivate data now: ${where(cred)}`);
console.log('The old copy was left where it was — `state --drop-remote` removes it');
console.log('once you are satisfied, or delete it by hand.');
process.exit(0);
}

export async function stateAll() {
// The root-wide half. `state --to` moves ONE identity, with the right AP_HOME
// set by hand; this runs over every identity under the root.
//
// Per identity, in its own process. HOME, PORT and the root are resolved at
// module load from the environment, so doing several in one process would
// mean re-deriving all of it — and a failure part way would be sharing state
// with the next one. A spawn per identity is a handful of processes for a
// one-shot migration, and each is exactly the command you could have typed.
const { execFile } = await import('node:child_process');
const { needsStateMove, pendingSteps } = await import(new URL('../../../../lib/device/migrate.mjs', import.meta.url));
const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));

const homes = identityHomes(AP_ROOT);
if (!homes.length) {
  console.log(`no identities under ${tildify(AP_ROOT)} — nothing to move`);
  process.exit(0);
}

// The same refusal `--to` and `home --restructure` make, for the same reason,
// and it has to cover ALL of them: a running agent holds its state
// write-through in memory, so a copy taken underneath one is overwritten by
// its next write.
// Only when something is actually going to be written. A dry run reads
// credential files and prints what it found, and refusing to do THAT while
// the agents are up defeats the whole point of leading with the inventory:
// you would have to stop everything to find out whether you needed to.
if (has('apply')) {
  const live = [];
  for (const { name, dir } of homes) {
    let port = null;
    try { port = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')).port; } catch { continue; }
    if (!port) continue;
    const why = await somethingOn(port);
    if (why) live.push(`${name} on ${port} (${why})`);
  }
  if (live.length) {
    console.error(`still answering: ${live.join(', ')}`);
    console.error('stop them first — a running agent would overwrite the copy with what it holds');
    process.exit(2);
  }
}

const rows = [];
for (const { name, dir } of homes) {
  let cred = null;
  try { cred = JSON.parse(fs.readFileSync(path.join(dir, 'credential.json'), 'utf8')); } catch { continue; }
  rows.push({ name, dir, cred, pending: pendingSteps(cred) });
}
if (!rows.length) { console.log('no identities with a credential yet'); process.exit(0); }

if (has('drop-remote')) {
  // Deliberately separate from the move, and second. While both copies exist
  // the move is reversible; this is the step that ends that, so it is never
  // something you get by accident.
  const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
  const { classifyRemoteState } = await import(new URL('../../../../lib/device/migrate.mjs', import.meta.url));
  const apply = has('apply');
  for (const { name, dir, cred } of rows) {
    if (needsStateMove(cred)) {
      console.log(`${name}: still on the pod — run \`state --all --apply\` first`);
      continue;
    }
    const urls = apUrls(cred.remotePod, cred.root);
    const remote = new RemotePod(cred, { log: () => {}, home: dir });
    try { await remote.warmup(); } catch (e) { console.error(`${name}: ${e.message}`); continue; }
    const children = (await remote.listContainer(urls.state)).map(c => c.url);
    const { drop, keep } = classifyRemoteState(children, urls.state);
    console.log(`${name}: ${drop.length} document(s) to remove, ${keep.length} kept`);
    for (const k of keep) console.log(`    keep ${k.name} — ${k.why}`);
    for (const d of drop) {
      if (!apply) { console.log(`    would remove ${d.name}`); continue; }
      try { await remote.delete(d.url); console.log(`    removed ${d.name}`); }
      catch (e) { console.error(`    ${d.name}: ${e.message}`); }
    }
  }
  if (!apply) console.log('\nThis was a dry run. Add --apply to remove them.');
  process.exit(0);
}

const apply = has('apply');
console.log(apply ? 'Moving the private half onto this machine.\n'
  : 'What a move would do. Nothing is written without --apply.\n');
let moved = 0;
for (const { name, dir, cred, pending } of rows) {
  const home = cred.privateRoot ? tildify(cred.privateRoot)
    : `${apUrls(cred.remotePod, cred.root).home} (ON THE POD)`;
  if (!pending.length) { console.log(`${name}: already current — ${home}`); continue; }
  const dest = pathToFileURL(path.join(dir, 'private')).href + '/';
  if (!apply) {
    console.log(`${name}: ${home}\n    → would move to ${tildify(dest)}`);
    continue;
  }
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [process.argv[1], 'state', '--to', dest],
      { env: { ...process.env, AP_HOME: dir, AP_PROFILE: '' } },
      (err, stdout, stderr) => resolve({ ok: !err, text: String(stdout) + String(stderr) }));
  });
  console.log(`${name}: ${out.ok ? 'moved' : 'FAILED'}`);
  for (const line of out.text.split('\n').filter(Boolean)) console.log(`    ${line}`);
  if (out.ok) moved++;
}
if (apply) {
  console.log(`\n${moved} identit(ies) moved. The pod still holds the old copy —`);
  console.log('`state --drop-remote` removes it once you are satisfied.');
} else {
  console.log('\nRe-run with --apply to do it.');
}
process.exit(0);
}

export async function upgrade() {
// One runner, every identity. The point is that being behind is a thing you
// can ASK about rather than something you find out from a pod bill.
const { pendingSteps, layoutOf, CURRENT_LAYOUT, isCurrent } =
  await import(new URL('../../../../lib/device/migrate.mjs', import.meta.url));
const homes = identityHomes(AP_ROOT);
const behind = [];
for (const { name, dir } of homes) {
  let cred = null;
  try { cred = JSON.parse(fs.readFileSync(path.join(dir, 'credential.json'), 'utf8')); } catch { continue; }
  const pending = pendingSteps(cred);
  console.log(`${name}: layout ${layoutOf(cred)} of ${CURRENT_LAYOUT}${pending.length ? '' : ' — current'}`);
  for (const s of pending) console.log(`    ${s.id}: ${s.what}\n      (${s.why})`);
  // Nothing to do and never stamped: an install that was already in the right
  // shape. Record it, so `upgrade` stops asking and the agent stops warning.
  if (isCurrent(cred) && layoutOf(cred) < CURRENT_LAYOUT) {
    writeJsonAtomic(path.join(dir, 'credential.json'), { ...cred, layout: CURRENT_LAYOUT });
    console.log('    stamped as current');
  }
  if (pending.length) behind.push(name);
}
if (!homes.length) console.log(`no identities under ${tildify(AP_ROOT)}`);
else if (behind.length) {
  console.log(`\n${behind.length} identit(ies) behind: ${behind.join(', ')}`);
  console.log('The only step is the state move. See what it would do:');
  console.log(`  ${path.basename(process.argv[1])} state --all`);
  console.log('then re-run it with --apply.');
} else if (homes.length) console.log('\nEverything here is at the current layout.');
process.exit(0);
}

export async function profiles() {
// Local files only, plus a quick liveness probe: nothing here needs the pod.
const homes = identityHomes(AP_ROOT);

const rows = [];
for (const { name, dir } of homes) {
  let pod = null, port = null;
  try { pod = JSON.parse(fs.readFileSync(path.join(dir, 'credential.json'), 'utf8')).remotePod; } catch {}
  try { port = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')).port; } catch {}
  if (!pod && !port) continue;                       // not an identity, just a directory
  let live = null;
  if (port) {
    live = await localFetch(HOME, port, `/status`, { signal: AbortSignal.timeout(1500) })
      .then(r => r.json()).catch(() => null);
  }
  // The kind lives in pod state, so it is only knowable from the live probe —
  // a stopped identity honestly shows nothing rather than a guess.
  rows.push({ name, pod: pod ? new URL(pod).host : '(no credential)', port: port || '—',
    kind: live?.kind === 'group' ? 'group' : live ? 'person' : '—',
    state: live ? `${live.mode}${live.podRequests ? ` · ${live.podRequests.perMinuteNow}/min` : ''}` : 'not running' });
}

// Which one answers with no --profile. A property of the ROOT, not of any
// identity — which is the whole point of it being a pointer.
const theDefault = (() => { const d = defaultProfile(AP_ROOT); return typeof d === 'string' ? d : null; })();
if (!rows.length) console.log('no identities yet — fedipod setup');
else {
  const w = (k, min) => Math.max(min, ...rows.map(r => String(r[k]).length));
  const [wn, wp, wo, wk] = [w('name', 7), w('pod', 3), w('port', 4), w('kind', 4)];
  console.log(`${'PROFILE'.padEnd(wn)}  ${'POD'.padEnd(wp)}  ${'PORT'.padEnd(wo)}  ${'KIND'.padEnd(wk)}  STATE`);
  for (const r of rows) {
    console.log(`${r.name.padEnd(wn)}  ${String(r.pod).padEnd(wp)}  ${String(r.port).padEnd(wo)}`
      + `  ${String(r.kind).padEnd(wk)}  ${r.state}${r.name === theDefault ? '  (default)' : ''}`);
  }
}
console.log(`\nIdentities under a custom AP_HOME are not listed — only ${AP_ROOT}`
  + ' and its profiles/*.');
process.exit(0);
}

export async function home() {
  if (has('restructure')) return homeRestructure();
// The root holds the credential and the signing keys of every identity on
// this machine, so taking the post-rename name is a command you run, never
// something an upgrade does behind you. Resolution is in lib/home.mjs.
const to = flag('to');
const overridden = !!(process.env.AP_HOME || flag('home'));

if (!to) {
  console.log(`\nroot:      ${tildify(AP_ROOT)}${isLegacyRoot(AP_ROOT) ? '   (the name from before the rename)' : ''}`);
  console.log(`this home: ${tildify(HOME)}`);
  const d = defaultProfile(AP_ROOT);
  for (const { name, dir } of identityHomes(AP_ROOT)) {
    if (fs.existsSync(path.join(dir, 'credential.json'))) {
      console.log(`  · ${name}${name === d ? '   (default)' : ''}`);
    }
  }
  if (rootHoldsIdentity(AP_ROOT)) {
    console.log('\nThis root still keeps an identity at its top level, from before every');
    console.log('identity moved under profiles/. Move it down with:\n');
    console.log(`  ${process.argv[1]} home --restructure\n`);
  }
  if (overridden) {
    console.log('\nAP_HOME / --home is set, so this run is not using the root above.');
  } else if (isLegacyRoot(AP_ROOT)) {
    console.log('\nTake the current name with:\n');
    console.log(`  ${process.argv[1]} home --to ${path.join(os.homedir(), CURRENT_ROOT)}\n`);
    console.log('That moves the whole root — the default identity and every profile — and');
    console.log('refuses while any of them is answering.');
  }
  process.exit(0);
}

if (overridden) {
  console.error('AP_HOME / --home is set. That is an explicit directory, not the root this');
  console.error('command moves — unset it and run again, or move the directory yourself.');
  process.exit(2);
}
const target = path.resolve(to.replace(/^~(?=[/\\]|$)/, os.homedir()));
if (target === AP_ROOT) { console.log(`already there: ${AP_ROOT}`); process.exit(0); }
if (!fs.existsSync(AP_ROOT)) { console.error(`nothing to move — ${AP_ROOT} does not exist`); process.exit(2); }
if (fs.existsSync(target) && fs.readdirSync(target).length) {
  console.error(`${target} exists and is not empty — refusing to merge two roots`);
  process.exit(2);
}

// A running agent holds its pidfile and log by path; moving out from under it
// strands both and leaves `stop` with nothing to find.
const live = [];
for (const { name, dir } of identityHomes(AP_ROOT)) {
  let port = null;
  try { port = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')).port; } catch { continue; }
  if (port && await agentOn(port)) live.push(`${name} on ${port}`);
}
if (live.length) {
  console.error(`still answering: ${live.join(', ')}`);
  console.error('stop them first — a move would strand the pidfile and log they hold');
  process.exit(2);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
try {
  fs.renameSync(AP_ROOT, target);
} catch (e) {
  if (e.code !== 'EXDEV') throw e;                  // a different filesystem
  fs.cpSync(AP_ROOT, target, { recursive: true, preserveTimestamps: true });
  fs.rmSync(AP_ROOT, { recursive: true, force: true });
}
console.log(`moved ${AP_ROOT} → ${target}`);

// privateRoot is recorded as an absolute path. One that pointed inside the
// root we just moved now points at nothing, and an agent finding an empty
// store reports itself unconfigured rather than saying why.
for (const { name, dir } of identityHomes(target)) {
  const credPath = path.join(dir, 'credential.json');
  let cred;
  try { cred = JSON.parse(fs.readFileSync(credPath, 'utf8')); } catch { continue; }
  if (!cred.privateRoot || /^https?:/i.test(cred.privateRoot)) continue;   // a pod, not a directory
  const was = cred.privateRoot.startsWith('file:')
    ? fileURLToPath(cred.privateRoot) : path.resolve(cred.privateRoot);
  if (!isInside(AP_ROOT, was)) continue;                                   // somewhere else entirely
  const now = path.join(target, path.relative(AP_ROOT, was));
  cred.privateRoot = pathToFileURL(now).href + '/';
  writeJsonAtomic(credPath, cred);
  console.log(`  · ${name}: private data now ${cred.privateRoot}`);
}

console.log('\nIf you installed the service, its unit has the old path baked in as');
console.log('Environment=AP_HOME — re-run install-service to update it.');
process.exit(0);
}

export async function homeRestructure() {
// One-time: move the identity that lives AT the root down into
// profiles/<name>/, so every identity is a named folder and none of them
// contains the others. Its own files only — profiles/ stays where it is.
if (process.env.AP_HOME || flag('home')) {
  console.error('AP_HOME / --home is set. That is an explicit identity directory, not the');
  console.error('root this restructures — unset it and run again.');
  process.exit(2);
}
if (!rootHoldsIdentity(AP_ROOT)) {
  console.log(`nothing to move — ${tildify(AP_ROOT)} keeps no identity at its top level`);
  const d = defaultProfile(AP_ROOT);
  if (typeof d === 'string') console.log(`default identity: ${d}`);
  process.exit(0);
}
// Its name is its handle, which agent.json records and pod state confirms.
// Falling back to the credential's pod host keeps a half-set-up root movable.
let name = null;
try { name = JSON.parse(fs.readFileSync(path.join(AP_ROOT, 'agent.json'), 'utf8')).handle || null; } catch {}
if (!name) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(AP_ROOT, 'private/ap-state/config.json'), 'utf8'));
    name = cfg.handle || null;
  } catch {}
}
name = flag('name', name);
if (!name) {
  console.error('cannot tell what this identity is called — no handle in agent.json or pod state.');
  console.error(`Name it:  ${process.argv[1]} home --restructure --name <name>`);
  process.exit(2);
}
requireHandle(name);
const dest = profileHome(AP_ROOT, name);
if (fs.existsSync(dest) && fs.readdirSync(dest).length) {
  console.error(`${tildify(dest)} exists and is not empty — refusing to merge two identities`);
  console.error(`Give the moved one another name:  ${process.argv[1]} home --restructure --name <name>`);
  process.exit(2);
}

// A running agent holds its pidfile and log by path. Same refusal `--to` makes.
const live = [];
for (const { name: n, dir } of [{ name, dir: AP_ROOT }, ...identityHomes(AP_ROOT)]) {
  let port = null;
  try { port = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')).port; } catch { continue; }
  if (!port) continue;
  // somethingOn, not agentOn: a gated agent answers 401 to an un-tokened
  // /status, and this moves its private key out from under it.
  const why = await somethingOn(port);
  if (why) live.push(`${n} on ${port} (${why})`);
}
if (live.length) {
  console.error(`still answering: ${live.join(', ')}`);
  console.error('stop them first — a move would strand the pidfile and log they hold');
  process.exit(2);
}

// Its own files, named explicitly. Everything else at the root — profiles/,
// and root.json once it exists — belongs to the root and stays.
const MOVE = ['credential.json', 'keys.json', 'agent.json', 'agent.log', 'token.json',
  'backoff.json', 'private'];
fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
const moved = [];
for (const f of MOVE) {
  const from = path.join(AP_ROOT, f);
  if (!fs.existsSync(from)) continue;
  fs.renameSync(from, path.join(dest, f));
  moved.push(f);
}
// A pidfile names a process that was told to stop. Carrying it forward would
// point `stop` at a pid nobody owns.
fs.rmSync(path.join(AP_ROOT, 'agent.pid'), { force: true });
console.log(`moved ${moved.length} item(s) → ${tildify(dest)}`);
console.log(`  ${moved.join(', ')}`);

// privateRoot is an absolute path; one that pointed at the root's private/
// now points at nothing, and an agent finding an empty store reports itself
// unconfigured rather than saying why.
const credPath = path.join(dest, 'credential.json');
try {
  const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  if (cred.privateRoot && !/^https?:/i.test(cred.privateRoot)) {
    const was = cred.privateRoot.startsWith('file:')
      ? fileURLToPath(cred.privateRoot) : path.resolve(cred.privateRoot);
    if (isInside(AP_ROOT, was) && !isInside(dest, was)) {
      cred.privateRoot = pathToFileURL(path.join(dest, path.relative(AP_ROOT, was))).href + '/';
      writeJsonAtomic(credPath, cred);
      console.log(`  private data now ${tildify(cred.privateRoot)}`);
    }
  }
} catch { /* no credential to repoint */ }

recordLastUsed(AP_ROOT, name);
console.log(`\n${name} is what a plain command means now. Start another with`);
console.log(`\`${path.basename(process.argv[1])} --profile <name> start\` and that becomes the one instead.`);
process.exit(0);
}

export async function exportCollectionsCmd() {
// The account's collections as paged Turtle AS2 collections,
// produced on demand: outbox and followers from the pod, inbox from the
// local archive. See lib/export-collections.mjs.
requireIdentity();
const format = flag('format') || args[1];
const to = flag('to');
if (format !== 'as-collections' || !to) {
  console.error('usage: fedipod export --format as-collections --to <directory-or-container-url>');
  process.exit(2);
}
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const { exportCollections, DIR_BASE } = await import(new URL('../../../../lib/device/export-collections.mjs', import.meta.url));
const { storageFor } = await import(new URL('../../../../lib/core/storage.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: () => {} });
const cred = agent.readCredential();
if (!cred) { console.error('no credential — run setup first'); process.exit(2); }
agent.remote = new RemotePod(cred);
await agent.remote.warmup();
agent.urls = apUrls(cred.remotePod, cred.root);
agent.store.attach(agent.privateStorage(cred, 'state'));
await agent.store.load();
const { Publisher } = await import(new URL('../../../../lib/core/publisher/index.mjs', import.meta.url));
const outboxItems = (await Publisher.prototype.readPublishedOutbox.call(
  { remote: agent.remote, urls: agent.urls })) || [];
// Only real AP actors, like the published followers collection.
const contacts = agent.store.getContacts();
const followers = contacts.followers.filter(f => !f.bsky).map(f => f.actor);
const archive = agent.privateStorage(cred, 'archive');
const inboxEntries = [];
const months = (await archive.list('').catch(() => ({ names: [] }))).names || [];
for (const m of months.filter(n => n.endsWith('/'))) {
  const files = (await archive.list(m).catch(() => ({ names: [] }))).names || [];
  for (const f of files) {
    const r = await archive.read(m + f);
    if (!r.ok) continue;
    try { inboxEntries.push(JSON.parse(r.body)); } catch { /* not an archive record */ }
  }
}
const isUrl = /^https?:/i.test(to);
const storage = storageFor(to, (u, i) => agent.remote.fetch(u, i));
const base = isUrl ? (to.endsWith('/') ? to : to + '/') : DIR_BASE;
try {
  const out = await exportCollections({
    outboxItems, followers, inboxEntries, storage, base, log: console.log,
    resolve: (u) => agent.remote.getJson(u),
  });
  console.log(`outbox: ${out.outbox.items} item(s) in ${out.outbox.pages} page(s); `
    + `followers: ${out.followers.items}; inbox: ${out.inbox.items} archived item(s) in ${out.inbox.pages} page(s)`);
  console.log(`${out.written} Turtle document(s) written to ${to}`);
} catch (e) {
  console.error(`export failed: ${e.message}`);
  process.exit(1);
}
}
