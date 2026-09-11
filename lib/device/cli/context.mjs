// context.mjs — what every command starts from: the arguments, which
// identity (HOME) and port (PORT) a command means, and the helpers that ask,
// probe and finish. HOME, PORT and DEFAULT_ISSUE are live bindings: useProfile()
// reassigns them and every command module sees the new value.

import fs from 'node:fs';
import { localFetch } from '../../../lib/client/localapi.mjs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apRoot, profilesDir, identityHomes, isLegacyRoot, CURRENT_ROOT, tildify, rootOf,
  readRoot, writeRoot, defaultProfile, profileHome, rootHoldsIdentity, ROOT_FILE,
  recordLastUsed, writeJsonAtomic } from '../../../lib/device/home.mjs';
import { insecureUrlReason } from '../../../lib/shared/safefetch.mjs';
import { portFree, freePortFrom } from '../../../lib/device/ports.mjs';

export const args = process.argv.slice(2);
export const cmd = args[0];
export const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
export const has = (name) => args.includes('--' + name);
// The port can also be given bare — `npm start 8081` reaches us as `up 8081`,
// because npm passes positionals through but eats `--port`. Bare form only for
// the start-style commands, where a lone number cannot mean anything else.
export const barePort = () => {
  if (!['up', 'start', 'run'].includes(cmd)) return null;
  for (let i = 1; i < args.length; i++) {
    if (/^\d+$/.test(args[i]) && !args[i - 1].startsWith('--')) return args[i];
  }
  return null;
};
export const portFlag = () => flag('port', null) || barePort();
// One identity per home, and EVERY identity is `<root>/profiles/<name>/`. There
// is no privileged unnamed one: `root.json` names which you get when you do not
// say, and that is a pointer you can change rather than a directory you have to
// move a private key out of. lib/home.mjs decides the root.
//
// An explicit --home / AP_HOME still wins and is taken literally: you named a
// directory, so that directory is the identity, root.json unread. That is what
// `rootOf` has always documented for a custom home.
export const PROFILE = flag('profile', process.env.AP_PROFILE || null);
export const AP_ROOT = apRoot();
export const PROFILES_DIR = profilesDir(AP_ROOT);

// `let`, because setup does not know which identity it is until it has asked for
// the handle — the home is named after it. Everything below reads HOME at call
// time, so reassigning it once, early, is enough; PORT is the exception and is
// recomputed with it.
export let DEFAULT_ISSUE = null;                      // set when the pointer is unusable
export let HOME = flag('home', process.env.AP_HOME || (() => {
  if (PROFILE) return profileHome(AP_ROOT, PROFILE);
  const d = defaultProfile(AP_ROOT);
  if (typeof d === 'string') return profileHome(AP_ROOT, d);
  DEFAULT_ISSUE = d?.missing
    ? `${ROOT_FILE} names "${d.missing}", which is not an identity here`
    : 'there is more than one identity here and none is the default';
  return profileHome(AP_ROOT, d?.missing || '');
})());

// The port chosen at setup is remembered, so `start`/`stop`/`status` need no
// flags afterwards. Precedence: --port (or a bare port number, `npm start
// 8081`) > AP_PORT > the recorded choice > 8030.
// The handle is remembered alongside it, for the named origin: the agent also
// answers at <handle>.localhost:<port>, and that has to work from the first
// request, before pod state has been read.
export function recordedAgent() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8')) || {}; }
  catch { return {}; }
}
export function recordedPort() { return Number(recordedAgent().port) || null; }
export function recordAgent(fields) {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const rec = { ...recordedAgent(), ...fields };
    writeJsonAtomic(path.join(HOME, 'agent.json'), rec, { mode: 0o644 });
  } catch { /* the flag still works, it just isn't remembered */ }
}
export let PORT = Number(portFlag() || process.env.AP_PORT || recordedPort() || 8030);

// Setup is the one command that cannot know its home in advance: the identity is
// named after the handle, and the handle is the first thing it asks. Everything
// that reads HOME does so at call time, so pointing it at the right directory as
// soon as the name exists is enough — PORT is recomputed because it was read
// from the old home's agent.json.
export function useProfile(name) {
  HOME = flag('home', process.env.AP_HOME || profileHome(AP_ROOT, name));
  PORT = Number(portFlag() || process.env.AP_PORT || recordedPort() || 8030);
  DEFAULT_ISSUE = null;
  return HOME;
}

// A handle becomes a directory name, so it is checked before it is one. Same
// rule the admin API applies before creating an actor (admin.mjs) — without it
// a handle containing a slash or `..` climbs out of profiles/.
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
export function requireHandle(handle) {
  if (HANDLE_RE.test(handle)) return handle;
  console.error(`"${handle}" cannot be a handle: letters, digits, hyphens and underscores,`);
  console.error('starting with a letter or digit, at most 31 characters.');
  process.exit(2);
}

// Commands that act on an identity need one decided. Says which of the three
// ways it failed, because "no identity" and "which identity" are different
// problems with different fixes.
export function requireIdentity() {
  // An explicit AP_HOME / --home is an explicit identity directory. Nothing
  // about the machine's root applies to it — including whether that root has
  // been restructured, which is somebody else's install's problem.
  if (process.env.AP_HOME || flag('home')) return;
  if (rootHoldsIdentity(AP_ROOT)) {
    console.error(`${tildify(AP_ROOT)} still keeps an identity at its top level.`);
    console.error('Every identity lives in profiles/<name>/ now. Move this one down with:\n');
    console.error(`  ${process.argv[1]} home --restructure\n`);
    process.exit(2);
  }
  if (!DEFAULT_ISSUE) return;
  const homes = identityHomes(AP_ROOT).filter(h => fs.existsSync(path.join(h.dir, 'credential.json')));
  console.error(DEFAULT_ISSUE + '.');
  if (homes.length) {
    console.error(`\n  ${process.argv[1]} --profile <name> start\n`);
    console.error('Whichever you start is remembered, so plain commands mean that one afterwards.');
    console.error(`here: ${homes.map(h => h.name).join(', ')}`);
  } else {
    console.error(`\nThere are no identities yet — ${process.argv[1]} setup`);
  }
  process.exit(2);
}

export function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (c) => { if (String(c) !== '\n' && String(c) !== '\r') readline.moveCursor(process.stdout, -1, 0), process.stdout.write('*'); };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => { process.stdin.off('data', onData); rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

// Plain prompt with a default: Enter accepts it. Non-interactive runs
// (scripts, CI) take the default silently, so flags remain sufficient.
let sharedRl = null;                     // one interface: a new one per
export function ask(prompt, dflt = '') {        // question would drop buffered input
  if (!process.stdin.isTTY) return Promise.resolve(dflt);
  sharedRl ||= readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    sharedRl.question(dflt ? `${prompt} [${dflt}]: ` : `${prompt}: `, (answer) => {
      resolve(String(answer).trim() || dflt);
    });
  });
}
export function endAsking() { sharedRl?.close(); sharedRl = null; }

// "Occupied" means "cannot be bound", not "does not answer HTTP": something
// holding a port without speaking HTTP reads as free to a GET, and then the
// agent dies on EADDRINUSE.

// The first port from `first` upward that binds. Walking always ends in one,
// so this is a step rather than a condition.

// Is anything at all on this port? For the operations that MOVE data, "it did
// not answer as one of ours" is not the same as "nothing is there": an agent
// started with AP_GATE_TOKEN answers 401 to an un-tokened /status, so agentOn
// reads a perfectly live agent as stopped — and a sweep that trusted it would
// copy the state out from under one, which the next write then overwrites.
// Bind to find out, and fail closed.
export async function somethingOn(port) {
  const mine = await agentOn(port);
  if (mine) return 'running';
  return (await portFree(port)) ? null : 'something is on the port and did not answer as ours';
}

// Whatever is on the port — is it one of ours?
export async function agentOn(port) {
  try {
    const res = await localFetch(HOME, port, `/status`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return typeof body?.configured === 'boolean' ? body : null;
  } catch { return null; }
}

export const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export function openBrowser(url) {
  try {
    const win = process.platform === 'win32';
    const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, win ? ['/c', 'start', '', url] : [url], { detached: true, stdio: 'ignore' });
    // A box with no opener at all (a server, a bare container) emits this
    // asynchronously, where the try/catch cannot reach it — and an unhandled
    // 'error' event on a child process ends the agent.
    child.on('error', () => {});
    child.unref();
  } catch { /* best-effort — the URL is printed anyway */ }
}

// A one-shot command holds the lease only for its own duration: exiting without
// releasing it leaves the next `start` as a read-only viewer until the lease
// expires, which is 5 minutes of doing nothing.
export async function finish(agent, code = 0) {
  await agent.lease?.release().catch(() => {});
  await agent.store?.flush?.().catch(() => {});
  process.exit(code);
}

// Anything that decides the identity. Given even one of these, setup stays on
// the command line exactly as it always did — scripts, CI and the tarball's
// unpack-and-go line depend on that. At a terminal with none of them, setup
// asks the two things it needs to open a browser and asks the rest there.
export const IDENTITY_FLAGS = ['new-account', 'pod', 'issuer', 'email', 'name', 'pod-name',
  'group', 'approve-joins', 'summary', 'icon', 'root', 'keys', 'rotate-key'];

// Refuse before anything is asked, let alone typed: setup used to overwrite
// credential.json in place, and a minted credential is only shown once — so
// the identity it belonged to could not be recovered afterwards.
export function refuseExistingIdentity() {
  const credPath = path.join(HOME, 'credential.json');
  if (!fs.existsSync(credPath) || has('force')) return;
  let held = '(unreadable)';
  try { held = JSON.parse(fs.readFileSync(credPath, 'utf8')).remotePod; } catch {}
  console.error(`${HOME} already holds an identity: ${held}`);
  console.error('For another identity:  fedipod setup --profile <name>');
  console.error('To list what exists:   fedipod profiles');
  console.error('To replace this one:   add --force (the old credential is lost)');
  console.error('');
  console.error('If a setup died half-way, do NOT re-run it — the credential it already');
  console.error('minted cannot be minted twice. Run `fedipod start` and');
  console.error('finish at /admin/setup/ in the browser.');
  process.exit(2);
}

// Ask the handle (permanent, and it names the origin) and the port, start
// serving, and hand over to the page at /admin/setup/. Nothing is created here: the
// agent's own POST /setup does all of it, so a closed tab cannot lose a
// credential that only exists in an HTTP response.
export async function runBrowserSetup() {
  const handle = flag('handle') || await ask('handle (the name in your address; permanent)');
  if (!handle) { console.error('a handle is required'); process.exit(2); }
  // The handle names the home, so nothing can be decided before it — including
  // which identity would be overwritten, and which port was remembered.
  requireHandle(handle);
  useProfile(PROFILE || handle);
  refuseExistingIdentity();
  const port = portFlag() ? PORT : (Number(await ask('port', String(PORT))) || PORT);
  endAsking();

  // Recorded before the server starts, so `stop`/`status` work while the
  // browser flow is still open — it used to be written only after the mint.
  recordAgent({ port, handle });

  const { Agent } = await import(new URL('../../../run-agent.mjs', import.meta.url));
  const { startAdmin } = await import(new URL('../../../lib/device/admin/index.mjs', import.meta.url));
  const { hostLabel } = await import(new URL('../../../lib/shared/guard.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[ap]', ...a) });
  startAdmin({
    port, handle, agent,
    gateToken: process.env.AP_GATE_TOKEN || '',
    log: (...a) => console.log('[ap]', ...a),
  });
  const shutdown = () => {
    setTimeout(() => process.exit(0), 1500).unref();
    try { fs.rmSync(path.join(HOME, 'agent.pid'), { force: true }); } catch {}
    Promise.allSettled([agent.store.flush(), agent.lease?.release()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const label = hostLabel(handle);
  const named = label ? `https://${label}.localhost:${port}/` : null;
  const plain = `https://localhost:${port}/`;
  const pad = Math.max(named?.length || 0, plain.length);
  console.log('');
  if (named) {
    console.log(`  ${named.padEnd(pad)}   <- opening this`);
    console.log(`  ${plain.padEnd(pad)}   <- the same agent, if your browser cannot find that name`);
  } else {
    console.log(`  ${plain}`);
  }
  console.log('\nsetup continues in the browser — Ctrl-C to stop\n');
  openBrowser(named || plain);
}
