#!/usr/bin/env node
// fedipod.mjs — CLI for the standalone pod-stored ActivityPub actor.
//
//   npm start   (= fedipod up)
//     The one command. Finds a port that BINDS — starting from the recorded
//     one, or 8030 — puts the agent behind it detached (logging to
//     AP_HOME/agent.log, stoppable by pidfile), and opens the browser where
//     there is something to do: /admin/setup/ when there is no identity yet,
//     the client when there is. Already running? It says so and opens that.
//     --no-open leaves the browser alone; --port names a starting port.
//
//   fedipod setup
//     Asks two things at the terminal — the handle, which is permanent and
//     names the agent's own origin, and the port — then starts serving and
//     opens http://<handle>.localhost:<port>/, where the rest is asked:
//     new account or a pod you already have, identity provider, email, pod
//     name, display name, person or group, bio, avatar, passwords. Nothing
//     is created until you say so there, and the address you are about to
//     take is shown before you do.
//
//   fedipod setup --new-account --email you@example.org --handle you
//   fedipod setup --pod https://you.solidcommunity.net/ \
//       --issuer https://solidcommunity.net --email you@example.org --handle you
//     Any identity flag (--new-account, --pod, --issuer, --email, --name,
//     --pod-name, --group, --summary, --icon, --root, --keys) keeps setup
//     entirely on the command line, as does a non-TTY stdin. --cli forces it.
//
//     The password is prompted (or AP_PASSWORD) — used once to create the
//     account and/or mint a revocable CSS client-credential, never stored.
//     Keys live in AP_HOME by default (the pod host cannot read them);
//     --keys pod stores them in pod state instead, so several devices can
//     sign as the same actor without copying files.
//
//   fedipod start     start the agent (UI + API on http://localhost:8030/
//                         and http://<handle>.localhost:8030/ — one origin per
//                         identity, so two agents stop sharing one login).
//                         Prints both URLs; --open also opens a browser.
//                         --name "Your Name" sets the display name other
//                         servers show, and republishes the actor
//                         ('run' is kept as an alias)
//   fedipod stop      stop the running agent (graceful: flush + lease release)
//   fedipod status    show the running agent's status
//   fedipod state     where the private half lives — your timeline, contacts,
//                         blocklist and notifications. `--to <container-url>`
//                         moves it to a pod on this machine, `--to pod` moves it
//                         back. Copies and verifies before repointing; the old
//                         copy is left behind. Stop the agent first.
//   fedipod rebuild   put back the posts a restored or replaced machine no
//                         longer knows about, from what the pod still serves.
//                         Adds only — a post this machine already has keeps its
//                         local facts. `--from-notes` also walks ap/notes/,
//                         which finds more and can bring back a post whose
//                         deletion the pod refused. The agent must be running.
//   (the default identity) is whichever one you last STARTED. Every identity is
//                         profiles/<name>/, and the root records the last one
//                         used, so `--profile x start` today is what plain
//                         `start` gives you tomorrow. Nothing to configure.
//   fedipod home      which directory every identity on this machine lives
//                         in. `--to <dir>` moves the whole root, rewrites any
//                         privateRoot that pointed inside it, and refuses while
//                         an agent is answering. `--restructure` is the one-time
//                         move for a root from before every identity lived in
//                         profiles/: it takes the identity at the top level down
//                         into profiles/<its handle>/. Installs made before the
//                         2026-07-30 rename keep ~/.activitypod until they run
//                         `--to`; new ones get ~/.fedipod.
//   fedipod passwd    set/change the UI password (REQUIRED before any
//                         non-loopback exposure — it turns the instant
//                         OAuth redirect into a real login form)
//   fedipod tokens    list client tokens; --revoke <prefix> / --revoke-all
//   fedipod revoke-credential --email you@example.org
//                         kill this machine's pod credential server-side and
//                         delete it locally (the answer to a suspected leak)
//   fedipod install-service    start at boot + restart on crash
//                                  (systemd --user on Linux, launchd on mac)
//   fedipod uninstall-service  remove that registration

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apRoot, profilesDir, identityHomes, isLegacyRoot, CURRENT_ROOT, tildify, rootOf,
  readRoot, writeRoot, defaultProfile, profileHome, rootHoldsIdentity, ROOT_FILE,
  recordLastUsed, writeJsonAtomic } from '../lib/home.mjs';
import { insecureUrlReason } from '../lib/safefetch.mjs';
import { portFree, freePortFrom } from '../lib/ports.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes('--' + name);
// The port can also be given bare — `npm start 8081` reaches us as `up 8081`,
// because npm passes positionals through but eats `--port`. Bare form only for
// the start-style commands, where a lone number cannot mean anything else.
const barePort = () => {
  if (!['up', 'start', 'run'].includes(cmd)) return null;
  for (let i = 1; i < args.length; i++) {
    if (/^\d+$/.test(args[i]) && !args[i - 1].startsWith('--')) return args[i];
  }
  return null;
};
const portFlag = () => flag('port', null) || barePort();
// One identity per home, and EVERY identity is `<root>/profiles/<name>/`. There
// is no privileged unnamed one: `root.json` names which you get when you do not
// say, and that is a pointer you can change rather than a directory you have to
// move a private key out of. lib/home.mjs decides the root.
//
// An explicit --home / AP_HOME still wins and is taken literally: you named a
// directory, so that directory is the identity, root.json unread. That is what
// `rootOf` has always documented for a custom home.
const PROFILE = flag('profile', process.env.AP_PROFILE || null);
const AP_ROOT = apRoot();
const PROFILES_DIR = profilesDir(AP_ROOT);

// `let`, because setup does not know which identity it is until it has asked for
// the handle — the home is named after it. Everything below reads HOME at call
// time, so reassigning it once, early, is enough; PORT is the exception and is
// recomputed with it.
let DEFAULT_ISSUE = null;                      // set when the pointer is unusable
let HOME = flag('home', process.env.AP_HOME || (() => {
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
function recordedAgent() {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8')) || {}; }
  catch { return {}; }
}
function recordedPort() { return Number(recordedAgent().port) || null; }
function recordAgent(fields) {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    const rec = { ...recordedAgent(), ...fields };
    writeJsonAtomic(path.join(HOME, 'agent.json'), rec, { mode: 0o644 });
  } catch { /* the flag still works, it just isn't remembered */ }
}
let PORT = Number(portFlag() || process.env.AP_PORT || recordedPort() || 8030);

// Setup is the one command that cannot know its home in advance: the identity is
// named after the handle, and the handle is the first thing it asks. Everything
// that reads HOME does so at call time, so pointing it at the right directory as
// soon as the name exists is enough — PORT is recomputed because it was read
// from the old home's agent.json.
function useProfile(name) {
  HOME = flag('home', process.env.AP_HOME || profileHome(AP_ROOT, name));
  PORT = Number(portFlag() || process.env.AP_PORT || recordedPort() || 8030);
  DEFAULT_ISSUE = null;
  return HOME;
}

// A handle becomes a directory name, so it is checked before it is one. Same
// rule the admin API applies before creating an actor (admin.mjs) — without it
// a handle containing a slash or `..` climbs out of profiles/.
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
function requireHandle(handle) {
  if (HANDLE_RE.test(handle)) return handle;
  console.error(`"${handle}" cannot be a handle: letters, digits, hyphens and underscores,`);
  console.error('starting with a letter or digit, at most 31 characters.');
  process.exit(2);
}

// Commands that act on an identity need one decided. Says which of the three
// ways it failed, because "no identity" and "which identity" are different
// problems with different fixes.
function requireIdentity() {
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

function askHidden(prompt) {
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
function ask(prompt, dflt = '') {        // question would drop buffered input
  if (!process.stdin.isTTY) return Promise.resolve(dflt);
  sharedRl ||= readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    sharedRl.question(dflt ? `${prompt} [${dflt}]: ` : `${prompt}: `, (answer) => {
      resolve(String(answer).trim() || dflt);
    });
  });
}
function endAsking() { sharedRl?.close(); sharedRl = null; }

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
async function somethingOn(port) {
  const mine = await agentOn(port);
  if (mine) return 'running';
  return (await portFree(port)) ? null : 'something is on the port and did not answer as ours';
}

// Whatever is on the port — is it one of ours?
async function agentOn(port) {
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return typeof body?.configured === 'boolean' ? body : null;
  } catch { return null; }
}

const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function openBrowser(url) {
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
async function finish(agent, code = 0) {
  await agent.lease?.release().catch(() => {});
  await agent.store?.flush?.().catch(() => {});
  process.exit(code);
}

// Anything that decides the identity. Given even one of these, setup stays on
// the command line exactly as it always did — scripts, CI and the tarball's
// unpack-and-go line depend on that. At a terminal with none of them, setup
// asks the two things it needs to open a browser and asks the rest there.
const IDENTITY_FLAGS = ['new-account', 'pod', 'issuer', 'email', 'name', 'pod-name',
  'group', 'approve-joins', 'summary', 'icon', 'root', 'keys', 'rotate-key'];

// Refuse before anything is asked, let alone typed: setup used to overwrite
// credential.json in place, and a minted credential is only shown once — so
// the identity it belonged to could not be recovered afterwards.
function refuseExistingIdentity() {
  const credPath = path.join(HOME, 'credential.json');
  if (!fs.existsSync(credPath) || has('force')) return;
  let held = '(unreadable)';
  try { held = JSON.parse(fs.readFileSync(credPath, 'utf8')).remotePod; } catch {}
  console.error(`${HOME} already holds an identity: ${held}`);
  console.error('For another identity:  bin/fedipod.mjs setup --profile <name>');
  console.error('To list what exists:   bin/fedipod.mjs profiles');
  console.error('To replace this one:   add --force (the old credential is lost)');
  console.error('');
  console.error('If a setup died half-way, do NOT re-run it — the credential it already');
  console.error('minted cannot be minted twice. Run `bin/fedipod.mjs start` and');
  console.error('finish at /admin/setup/ in the browser.');
  process.exit(2);
}

// Ask the handle (permanent, and it names the origin) and the port, start
// serving, and hand over to the page at /admin/setup/. Nothing is created here: the
// agent's own POST /setup does all of it, so a closed tab cannot lose a
// credential that only exists in an HTTP response.
async function runBrowserSetup() {
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

  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const { startAdmin } = await import(new URL('../lib/admin.mjs', import.meta.url));
  const { hostLabel } = await import(new URL('../lib/guard.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[ap]', ...a) });
  startAdmin({
    port, handle, agent,
    gateToken: process.env.AP_GATE_TOKEN || '',
    log: (...a) => console.log('[ap]', ...a),
  });
  const shutdown = () => {
    setTimeout(() => process.exit(0), 5000).unref();
    try { fs.rmSync(path.join(HOME, 'agent.pid'), { force: true }); } catch {}
    Promise.allSettled([agent.store.flush(), agent.lease?.release()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const label = hostLabel(handle);
  const named = label ? `http://${label}.localhost:${port}/` : null;
  const plain = `http://localhost:${port}/`;
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

// `npm start`. One command that does the obvious thing: find a port that
// binds, put the agent behind it, and open the browser where there is
// something to do — the setup form when there is no identity yet, the client
// when there is. Detached, because you asked for an agent, not a terminal
// that is now busy: it logs to AP_HOME/agent.log and `stop` finds it by pidfile.
if (cmd === 'up') {
  // A fresh machine has no identity, and an identity is named after its handle,
  // so there is no home to start in until that is asked. One question, the same
  // one `setup` opens with — `npm start` stays the single command it was.
  if (DEFAULT_ISSUE && !identityHomes(AP_ROOT).some(h => fs.existsSync(path.join(h.dir, 'credential.json')))) {
    if (!process.stdin.isTTY) {
      console.error('no identities yet — bin/fedipod.mjs setup');
      process.exit(2);
    }
    const first = await ask('handle (the name in your address; permanent)');
    endAsking();
    if (!first) { console.error('a handle is required'); process.exit(2); }
    requireHandle(first);
    useProfile(first);
  } else {
    requireIdentity();
  }
  if (rootOf(HOME) === AP_ROOT) recordLastUsed(AP_ROOT, path.basename(HOME));
  const preferred = Number(portFlag() || process.env.AP_PORT || recordedPort() || 8030);
  const configured = fs.existsSync(path.join(HOME, 'credential.json'));
  const { hostLabel } = await import(new URL('../lib/guard.mjs', import.meta.url));

  let port = preferred;
  let already = null;
  if (!await portFree(preferred)) {
    already = await agentOn(preferred);
    // Ours already — nothing to start. The directory door yields to a real
    // owner of its port. Anything else is simply not this port; walking on is
    // what "occupied" has always meant here.
    if (!already) {
      const { yieldDirectory } = await import(new URL('../lib/directory.mjs', import.meta.url));
      if (!await yieldDirectory(preferred, { portFree })) {
        port = await freePortFrom(preferred + 1);
        // The shared helper returns null; the message is this command's to write.
        if (port == null) throw new Error(`no free port between ${preferred + 1} and ${preferred + 51}`);
      }
    }
  }

  // Both branches take the named origin: setup at the shared one would file the
  // first login under localhost:<port>, and the identity is stuck with it.
  // The profile name is the handle — that is what naming identities after them
  // bought — so the named origin works on the very first run, before anything
  // has been recorded.
  const label = hostLabel(recordedAgent().handle || path.basename(HOME));
  const origin = `http://${label ? label + '.' : ''}localhost:${port}`;
  // The client pinned to this actor, not the bare root — root serves vendored
  // Phanpy with no account bound, which reads as the wrong app entirely.
  const url = configured ? `${origin}/admin/client/` : `${origin}/admin/setup/`;

  if (already) {
    console.log(`already running on port ${port} — ${url}`);
  } else {
    recordAgent({ port });
    const child = spawn(process.execPath, [new URL('../run-agent.mjs', import.meta.url).pathname], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, AP_HOME: HOME, AP_PORT: String(port) },
    });
    child.on('error', (e) => { console.error(`could not start the agent: ${e.message}`); process.exit(1); });
    child.unref();
    // Wait for it to answer before pointing a browser at it, or the first
    // load races the listen and shows a connection error.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise(r => setTimeout(r, 250));
      up = !!await agentOn(port);
    }
    if (!up) {
      console.error(`the agent did not come up on port ${port} — see ${path.join(HOME, 'agent.log')}`);
      process.exit(1);
    }
    console.log(`agent running on port ${port} (pid in ${path.join(HOME, 'agent.pid')})`);
    if (port !== preferred) console.log(`port ${preferred} was taken, so it moved to ${port}`);
  }
  console.log(`\n  ${url}\n`);
  console.log(configured ? 'stop it with:  bin/fedipod.mjs stop'
    : 'setup continues in the browser. Stop it with:  bin/fedipod.mjs stop');
  if (!has('no-open')) openBrowser(url);
  process.exit(0);
} else if (cmd === 'setup' && PROFILE && (useProfile(PROFILE), refuseExistingIdentity(), false)) {
  // Unreachable: --profile names the home before anything is asked, so the
  // collision is knowable now. refuseExistingIdentity exits when it finds one;
  // when it does not, this falls through to the real branches below.
} else if (cmd === 'setup' && process.stdin.isTTY && !has('cli')
    && !IDENTITY_FLAGS.some(f => args.includes('--' + f))) {
  // No refusal yet: which identity this would overwrite is not knowable until
  // the handle is asked, because the handle is what names the home.
  await runBrowserSetup();
} else if (cmd === 'setup') {
  const root = flag('root');
  const kind = has('group') ? 'group' : 'person';
  const approveJoins = has('group') && has('approve-joins');
  const summary = flag('summary');
  const icon = flag('icon');
  let pod = flag('pod');
  const interactive = process.stdin.isTTY;

  // Everything that shapes your identity is asked for here, with defaults,
  // because these are decisions — the pod name becomes half of your
  // permanent address, and nobody should discover that after the fact.
  // Flags skip the matching question, so scripted setup is unchanged.
  let newAccount = has('new-account');
  if (!newAccount && !pod) {
    if (!interactive) {
      console.error('need --email and --handle, plus either --pod <url> or --new-account');
      process.exit(2);
    }
    const have = await ask('do you already have a Solid pod? (y/n)', 'n');
    if (/^y/i.test(have)) {
      // Either tuck the fediverse account into the pod they already have,
      // or make a fresh pod on the same Solid account for it.
      const where = await ask('store your fediverse account in that pod, or in a new pod? (existing/new)', 'existing');
      if (/^n/i.test(where)) newAccount = true;
      else pod = await ask('your pod address (e.g. https://you.solidcommunity.net/)');
    } else {
      newAccount = true;
    }
  }
  if (!newAccount && !pod) { console.error('no pod given'); process.exit(2); }

  const issuer = flag('issuer') || await ask('Solid identity provider', 'https://solidcommunity.net');
  // Before the password is asked for, let alone sent. The issuer is where it
  // goes and the pod is where the credential it buys is used, so an http:
  // address off this machine puts both in clear. Loopback is exempt: it never
  // reaches a network interface, and a pod on this machine is an ordinary way
  // to run this.
  for (const [url, what] of [[issuer, 'identity provider address'], [pod, 'pod address']]) {
    const bad = insecureUrlReason(url, what);
    if (bad) { console.error(bad); process.exit(2); }
  }
  const email = flag('email') || await ask(`account email at ${new URL(issuer).host}`);
  const handle = flag('handle') || await ask('handle (the name in your address; permanent)');
  if (!email || !handle) {
    console.error('an email and a handle are required');
    process.exit(2);
  }
  // Before anything irreversible: the account creation and the mint are both
  // one-way, and a credential is shown once. A home that cannot be decided has
  // to be refused here, not after there is something to lose.
  requireHandle(handle);
  useProfile(PROFILE || handle);
  refuseExistingIdentity();
  const podName = newAccount
    ? (flag('pod-name') || await ask('pod name (this becomes the domain of your address)', handle))
    : null;
  const name = flag('name') || await ask('display name (shown above your address)', handle);

  // A handle resolves through <host>/.well-known/webfinger, so it only works
  // when the pod owns the root of its host. Whether a NEW pod gets its own
  // subdomain is the server's call, so promise nothing here we cannot keep.
  const { webfingerHost } = await import(new URL('../lib/wire.mjs', import.meta.url));
  const issuerHost = new URL(issuer).host;
  const wfHost = newAccount ? null : webfingerHost(pod);
  // A person warned about an unresolvable handle is the one who suffers, so a
  // warning is their call to accept. Nobody could ever find this group, and the
  // people it would fail are not the operator reading the warning.
  if (kind === 'group' && !newAccount && !wfHost) {
    console.error(`${pod} is a path on ${new URL(pod).host}, not the root of its own host.`);
    console.error('WebFinger is answered only at a host root, so nobody could find this group.');
    console.error('Give the group a pod of its own:  bin/fedipod.mjs setup --group --new-account');
    process.exit(2);
  }
  console.log(kind === 'group' ? '\nThe group will be:\n' : '\nYou will be:\n');
  console.log(`  ${name}`);
  if (wfHost) {
    console.log(`  @${handle}@${wfHost}\n`);
  } else if (newAccount) {
    console.log(`  @${handle}@${podName}.${issuerHost}\n`);
    console.log(`— provided ${issuerHost} gives each pod its own subdomain. Some servers put`);
    console.log(`pods at ${issuerHost}/${podName}/ instead, and a pod sharing a host cannot`);
    console.log('answer WebFinger for an address. Setup checks which you got and says so');
    console.log('before publishing anything.\n');
  } else {
    console.log(`  @${handle}@${new URL(pod).host}   —   WILL NOT RESOLVE\n`);
    console.log(`This pod is ${pod} — a path on ${new URL(pod).host}, not the root of its own`);
    console.log('host. WebFinger is answered only at a host root, which this pod cannot');
    console.log('write to, so other servers will not find you. Posting and reading still');
    console.log('work; being discovered does not.\n');
  }
  console.log('The display name can be changed later; the handle and pod cannot.');
  const go = await ask(newAccount
    ? (kind === 'group' ? 'create pod and group? (y/n)' : 'create pod and fediverse account? (y/n)')
    : (kind === 'group' ? 'create group on this pod? (y/n)' : 'create fediverse account on this pod? (y/n)'), 'y');
  if (!/^y/i.test(go)) { console.log('nothing was created'); process.exit(0); }
  endAsking();                           // hand the tty to the password prompt

  const password = process.env.AP_PASSWORD || await askHidden(`password for ${email} at ${issuer}: `);

  if (newAccount) {
    const { createAccountWithPod } = await import(new URL('../lib/account.mjs', import.meta.url));
    const made = await createAccountWithPod({ issuer, email, password, podName });
    pod = made.pod;
    console.log(`account + pod created: ${pod}`);
    if (!webfingerHost(pod)) {
      console.log(`\n${issuerHost} created the pod at a path rather than on its own subdomain,`);
      console.log(`so @${handle}@\u2026 cannot be discovered by other fediverse servers.`);
      const cont = kind === 'group' ? 'n' : (interactive ? await ask('continue anyway? (y/n)', 'n') : 'y');
      endAsking();
      if (!/^y/i.test(cont)) {
        console.log('stopping \u2014 the pod exists, but no actor was published');
        process.exit(0);
      }
    }
  }

  const { mintCredential } = await import(new URL('../lib/remote.mjs', import.meta.url));
  // New credentials only: one already registered keeps the name it was minted
  // under, so existing pods stay as they are unless they are set up again.
  const credential = await mintCredential({ origin: issuer, email, password, name: 'fedipod' });
  const rec = {
    ...credential,
    remotePod: pod.endsWith('/') ? pod : pod + '/',
    // The private half goes on THIS machine, exactly as the browser setup does
    // (lib/setup.mjs). Omitting it here meant the two paths produced different
    // installs from the same answers: the CLI put the timeline, contacts,
    // blocklist and notifications on the pod — the layout the relay design
    // exists to avoid, and the one that makes receiving a post cost pod writes.
    // It also made provisioning write a tree it did not need, which is where a
    // slow server showed it up.
    privateRoot: flag('private-root')
      || pathToFileURL(path.join(HOME, 'private')).href + '/',
    ...(root ? { root } : {}),
    ...(flag('keys') === 'pod' ? { keysMode: 'pod' } : {}),
    ...(has('rotate-key') ? { rotateKeyOnce: true } : {}),
    // What shape this install is. Both setup paths stamp it, so `upgrade` can
    // tell an old install from a new one rather than inferring it.
    layout: (await import(new URL('../lib/migrate.mjs', import.meta.url))).CURRENT_LAYOUT,
  };
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeJsonAtomic(path.join(HOME, 'credential.json'), rec);
  // The one you just made is the one you are using.
  if (rootOf(HOME) === AP_ROOT) recordLastUsed(AP_ROOT, path.basename(HOME));
  recordAgent({ port: PORT, handle });   // later commands need no --port
  console.log(`credential minted and saved to ${path.join(HOME, 'credential.json')}`);

  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[setup]', ...a) });
  await agent.bootstrap({ handle, name, root, kind, approveJoins, summary, icon });
  await agent.connect({ repair: false });   // publishProfile below is the publish
  await agent.publisher.publishProfile();
  await agent.store.flush();
  const finalHost = webfingerHost(rec.remotePod);
  const what = kind === 'group' ? 'group' : 'actor';
  console.log(finalHost
    ? `${what} published: @${handle}@${finalHost}`
    : `${what} published, but not reachable as a handle \u2014 ${rec.remotePod} is not a host root`);

  // Straight into serving — setup ends with a working client in the browser.
  const { startAdmin } = await import(new URL('../lib/admin.mjs', import.meta.url));
  const { hostLabel } = await import(new URL('../lib/guard.mjs', import.meta.url));
  startAdmin({ port: PORT, handle, gateToken: process.env.AP_GATE_TOKEN || '', agent, log: (...a) => console.log('[ap]', ...a) });
  const shutdown = () => {
    setTimeout(() => process.exit(0), 5000).unref();   // never hang a stop on a slow pod
    try { fs.rmSync(path.join(HOME, 'agent.pid'), { force: true }); } catch {}
    Promise.allSettled([agent.store.flush(), agent.lease?.release()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The named origin, and the instance to log the client into is that same
  // origin. Opening the shared one and then telling you to log in there is how
  // two identities end up sharing a browser storage bucket, and a client on the
  // shared origin shows whichever account it happens to hold.
  const label = hostLabel(handle);
  const authority = `${label ? label + '.' : ''}localhost:${PORT}`;
  const url = `http://${authority}/`;
  if (kind === 'group') {
    console.log(`group running on ${url} — see \`fedipod members\``);
  } else {
    console.log(`agent running — opening ${url} (log in with instance ${authority})`);
    openBrowser(url);
  }
} else if (cmd === 'start' || cmd === 'run') {   // 'run' kept as an alias
  requireIdentity();
  // Starting one is what makes it the default — so `--profile group start`
  // today is what a plain command means tomorrow. Recorded before the agent
  // comes up, because a start that fails still expressed the intent.
  if (rootOf(HOME) === AP_ROOT) recordLastUsed(AP_ROOT, path.basename(HOME));
  // This flag is read only by setup; it silently did nothing here, while the
  // key guard's own error message told people to use it.
  if (has('rotate-key')) {
    console.error('start does not rotate keys — use:  bin/fedipod.mjs rotate-key');
    process.exit(2);
  }
  if (portFlag()) recordAgent({ port: PORT });   // `start --port N` (or bare N) moves it for good

  // Something already on the port? Offer to take it over rather than dying
  // with "address in use" and leaving the user to hunt the process down.
  const answering = await fetch(`http://localhost:${PORT}/status`)
    .then(r => r.status).catch(() => null);
  if (answering !== null) {
    const pidFile = path.join(HOME, 'agent.pid');
    let pid = null;
    try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch {}
    const who = pid ? `pid ${pid}` : 'started elsewhere';
    if (!has('replace') && !process.stdin.isTTY) {
      console.error(`an agent is already running on port ${PORT} (${who}).`);
      console.error('Stop it with `fedipod stop`, or start this one with --replace.');
      process.exit(1);
    }
    const ans = has('replace')
      ? 'y'
      : await ask(`an agent is already running on port ${PORT} (${who}) — stop it and start this one? (y/n)`, 'y');
    endAsking();
    if (!/^y/i.test(ans)) { console.log('left the running agent alone'); process.exit(0); }

    await fetch(`http://localhost:${PORT}/shutdown`, { method: 'POST' }).catch(() => {});
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    const freed = await (async () => {                 // give it a few seconds
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 300));
        const still = await fetch(`http://localhost:${PORT}/status`).then(() => true).catch(() => false);
        if (!still) return true;
      }
      return false;
    })();
    if (!freed && pid) { try { process.kill(pid, 'SIGKILL'); } catch {} await new Promise(r => setTimeout(r, 500)); }
    const clear = await fetch(`http://localhost:${PORT}/status`).then(() => false).catch(() => true);
    if (!clear) {
      console.error(`could not stop whatever is on port ${PORT}. Find it with:  ss -tlnp | grep :${PORT}`);
      process.exit(1);
    }
    console.log('previous agent stopped');
  }

  const { startAgent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const startHandle = recordedAgent().handle || null;
  await startAgent({
    home: HOME, port: PORT, name: flag('name') || null,
    takeover: has('takeover'),      // claim a lease whose holder is gone
    handle: startHandle,            // the named origin, before pod state is read
  });
  {
    const { hostLabel } = await import(new URL('../lib/guard.mjs', import.meta.url));
    const label = hostLabel(startHandle);
    const named = label ? `http://${label}.localhost:${PORT}/` : null;
    const plain = `http://localhost:${PORT}/`;
    // One origin per identity is the point of the named form: a browser keeps
    // its storage per origin, so two agents stop sharing one Phanpy login.
    if (named) {
      const pad = Math.max(named.length, plain.length);
      console.log(`\n  ${named.padEnd(pad)}   <- browse it here`);
      console.log(`  ${plain.padEnd(pad)}   <- the same agent, if that name will not resolve\n`);
    } else {
      console.log(`\n  ${plain}\n`);
    }
    // Printed, not opened. `start` is run by supervisors and on every restart;
    // a window arriving unasked over whatever you were doing is not a feature.
    // `setup` opens one because that is the whole point of `setup`.
    if (has('open')) openBrowser(named || plain);
  }
} else if (cmd === 'state' && (has('all') || has('drop-remote'))) {
  // The root-wide half. `state --to` moves ONE identity, with the right AP_HOME
  // set by hand; this runs over every identity under the root.
  //
  // Per identity, in its own process. HOME, PORT and the root are resolved at
  // module load from the environment, so doing several in one process would
  // mean re-deriving all of it — and a failure part way would be sharing state
  // with the next one. A spawn per identity is a handful of processes for a
  // one-shot migration, and each is exactly the command you could have typed.
  const { execFile } = await import('node:child_process');
  const { needsStateMove, pendingSteps } = await import(new URL('../lib/migrate.mjs', import.meta.url));
  const { apUrls } = await import(new URL('../lib/wire.mjs', import.meta.url));

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
    const { RemotePod } = await import(new URL('../lib/remote.mjs', import.meta.url));
    const { classifyRemoteState } = await import(new URL('../lib/migrate.mjs', import.meta.url));
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
} else if (cmd === 'upgrade') {
  // One runner, every identity. The point is that being behind is a thing you
  // can ASK about rather than something you find out from a pod bill.
  const { pendingSteps, layoutOf, CURRENT_LAYOUT, isCurrent } =
    await import(new URL('../lib/migrate.mjs', import.meta.url));
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
} else if (cmd === 'state') {
  requireIdentity();
  // Where the private half lives, and how to move it. Copy, verify, THEN
  // repoint — a pointer moved on its own leaves the agent reading one
  // container and writing another, which is the divergence this avoids.
  // The old copy is left behind on purpose; delete it when you are satisfied.
  const credPath = path.join(HOME, 'credential.json');
  let cred;
  try { cred = JSON.parse(fs.readFileSync(credPath, 'utf8')); }
  catch { console.error(`no identity in ${HOME} — run setup first`); process.exit(2); }

  const { apUrls } = await import(new URL('../lib/wire.mjs', import.meta.url));
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const where = (c) => (c.privateRoot ? tildify(c.privateRoot) : `${apUrls(c.remotePod, c.root).home}(on the pod)`);

  const to = flag('to');
  if (!to) {
    console.log(`private data: ${where(cred)}`);
    console.log(`public face:  ${apUrls(cred.remotePod, cred.root).home}`);
    console.log('\nTo move it:  bin/fedipod.mjs state --to ~/somewhere/private/');
    console.log('             bin/fedipod.mjs state --to <container-url>');
    console.log('             bin/fedipod.mjs state --to pod');
    process.exit(0);
  }
  if (await fetch(`http://localhost:${PORT}/status`).then(() => true).catch(() => false)) {
    console.error(`an agent is running on port ${PORT} — stop it first:  bin/fedipod.mjs stop`);
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
    const { RemotePod } = await import(new URL('../lib/remote.mjs', import.meta.url));
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

  const { copyPrivateHalf } = await import(new URL('../lib/migrate.mjs', import.meta.url));
  let copied;
  try {
    copied = await copyPrivateHalf({
      from: { state: agent.privateStorage(cred, 'state'), fediverse: agent.privateStorage(cred, 'fediverse') },
      to: { state: agent.privateStorage(destCred, 'state'), fediverse: agent.privateStorage(destCred, 'fediverse') },
      log: (...a) => console.log('[state]', ...a),
    });
  } catch (e) { console.error(e.message); process.exit(1); }
  console.log(`copied ${copied.docs} state document(s)`);
  console.log(`copied ${copied.notes} note(s)`);

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
    const { CURRENT_LAYOUT, isCurrent } = await import(new URL('../lib/migrate.mjs', import.meta.url));
    if (isCurrent(cred)) cred.layout = CURRENT_LAYOUT; else delete cred.layout;
  }
  writeJsonAtomic(credPath, cred);
  console.log(`\nprivate data now: ${where(cred)}`);
  console.log('The old copy was left where it was — `state --drop-remote` removes it');
  console.log('once you are satisfied, or delete it by hand.');
  process.exit(0);
} else if (cmd === 'rotate-key') {
  requireIdentity();
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[rotate-key]', ...a) });
  // A home whose keys.json is gone or truncated cannot connect() at all:
  // resolveKeys refuses to mint over a key the actor already publishes, which
  // is the right default — minting silently would invalidate every signature
  // the other device can still make. It did leave the advice that refusal
  // prints ("run fedipod rotate-key") a dead end, though, because this
  // command connects first and meets the same refusal. --force arms the
  // one-shot rotation in the credential so the connect can get past it.
  const forced = has('force');
  const rotateCredPath = path.join(HOME, 'credential.json');
  if (forced) {
    const cred = JSON.parse(fs.readFileSync(rotateCredPath, 'utf8'));
    writeJsonAtomic(rotateCredPath, { ...cred, rotateKeyOnce: true });
    console.log('--force: the replacement key is minted as the agent connects\n');
  }
  // Read-only until you say yes: connecting for real acquires the lease and
  // starts the whole active agent — a destructive inbox drain, a channel
  // subscription, ACL probes and a tag-feed sweep — before the prompt.
  if (!await agent.connect({ act: false })) {
    console.error('nothing to rotate — no configured agent in this AP_HOME');
    process.exit(2);
  }
  const cfg = agent.store.getConfig();
  console.log(`\nRotating the signing key for @${cfg.handle}@${new URL(cfg.remotePod).host}\n`);
  console.log('  · a new keypair replaces the one in this home');
  console.log('  · the actor document is republished so other servers learn it');
  console.log('  · ANY OTHER DEVICE holding the old key stops being able to sign\n');
  const ans = has('yes') ? 'y' : await ask('rotate now? (y/n)', 'n');
  endAsking();
  if (!/^y/i.test(ans)) { console.log('key unchanged'); process.exit(0); }
  await agent.connect();                          // now it may act
  if (forced) {
    // connect() has already minted it; all that is left is telling the
    // fediverse. Calling rotateKey here would mint a second one for nothing.
    await agent.publisher.publishProfile();
    console.log('rotated and republished');
  } else {
    const r = await agent.rotateKey();
    console.log(r.changed ? 'rotated and republished' : 'no change — the key was already fresh');
  }
  await finish(agent);
} else if (cmd === 'profiles') {
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
      live = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(1500) })
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
  if (!rows.length) console.log('no identities yet — bin/fedipod.mjs setup');
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
} else if (cmd === 'home' && has('restructure')) {
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
} else if (cmd === 'home') {
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
} else if (cmd === 'park' || cmd === 'revive') {
  // Park is quiesce plus a snapshot of the follow graph, because unfollowing is
  // what stops the traffic and also what destroys the record needed to come back.
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log(`[${cmd}]`, ...a) });
  // Read-only until you say yes: connecting for real acquires the lease and
  // starts the whole active agent — a destructive inbox drain, a channel
  // subscription, ACL probes and a tag-feed sweep — before the prompt.
  if (!await agent.connect({ act: false })) {
    console.error(`nothing to ${cmd} — no configured, un-retired agent in this AP_HOME`);
    process.exit(2);
  }
  const cfg = agent.store.getConfig();
  const host = new URL(cfg.remotePod).host;

  if (cmd === 'park') {
    const contacts = agent.store.getContacts();
    console.log(`\nParking @${cfg.handle}@${host}\n`);
    console.log(`  · ${contacts.following.length} account(s) unfollowed, and remembered so revive can undo it`);
    console.log('  · the inbox is closed: deliveries are refused outright, not stored');
    console.log(`  · ${contacts.followers.length} follower(s) keep following you — nothing is told you left`);
    console.log('  · the handle keeps resolving; posts and RDF stay where they are');
    console.log('  · a parked agent that gets started will not drain or poll\n');
    console.log('Quietest state short of retiring. Undo with:  fedipod revive\n');
    const ans = has('yes') ? 'y' : await ask('park this actor? (y/n)', 'n');
    endAsking();
    if (!/^y/i.test(ans)) { console.log('nothing changed'); process.exit(0); }
    await agent.connect();                        // now it may act
    const r = await agent.park();
    console.log(`parked: unfollowed ${r.unfollowed}/${r.following}, ${r.snapshot} remembered, inbox closed`);
  } else {
    const parked = agent.store.read('parked.json', null);
    console.log(`\nReviving @${cfg.handle}@${host}${parked ? ` (parked ${parked.parkedAt})` : ''}\n`);
    console.log(`  · the inbox re-opens`);
    console.log(`  · ${parked?.following?.length || 0} Follow(s) are re-sent — each needs the far side to accept\n`);
    const ans = has('yes') ? 'y' : await ask('revive this actor? (y/n)', 'y');
    endAsking();
    if (!/^y/i.test(ans)) { console.log('nothing changed'); process.exit(0); }
    await agent.connect();                        // now it may act
    const r = await agent.revive();
    console.log(`revived: inbox open, ${r.refollowed}/${r.of} follow(s) re-sent`);
  }
  await finish(agent);
} else if (cmd === 'retire') {
  // Without this an abandoned pod accepts fediverse deliveries forever into a
  // container nobody will ever drain, and no remote server can tell.
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const { resolveHandle } = await import(new URL('../lib/social.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[retire]', ...a) });
  // Read-only until you say yes: connecting for real acquires the lease and
  // starts the whole active agent — a destructive inbox drain, a channel
  // subscription, ACL probes and a tag-feed sweep — before the prompt.
  if (!await agent.connect({ act: false })) {
    console.error('nothing to retire — no configured, un-retired agent in this AP_HOME');
    process.exit(2);
  }
  const cfg = agent.store.getConfig();
  const host = new URL(cfg.remotePod).host;
  const contacts = agent.store.getContacts();
  const followers = contacts.followers.length;
  const following = contacts.following.length;
  const moveTo = flag('move-to');
  const keep = has('keep-handle') || !!moveTo;

  console.log(`\n${keep ? 'Standing down' : 'Retiring'} @${cfg.handle}@${host}\n`);
  if (moveTo) {
    console.log(`  · a Move goes to ${followers} follower inbox(es); their servers migrate them to ${moveTo}`);
    console.log(`  · the actor advertises movedTo, so the old handle resolves as a redirect`);
  } else if (keep) {
    console.log('  · the handle keeps resolving — webfinger, host-meta and the actor stay published');
  } else {
    console.log(`  · a Delete goes to ${followers} follower inbox(es), telling those servers to drop the account`);
    console.log('  · the actor document is replaced with a Tombstone');
    console.log('  · this agent will refuse to start again for this pod');
  }
  if (keep) {
    console.log(`  · ${following} account(s) get unfollowed — that is what stops posts arriving`);
    console.log('  · the inbox is closed, so anything else is refused rather than stored forever');
  }
  // revive() opens the inbox first and only then replays parked.json, which a
  // stand-down never wrote — so it is the right undo here, minus the re-follows.
  console.log(keep
    ? '\nReversible: fedipod revive re-opens the inbox. Standing down keeps no snapshot\n'
      + 'of the follow graph, unlike park, so following people again is on you.\n'
    : '\nYour posts and RDF stay on the pod; the identity does not come back.\n');

  const ans = has('yes') ? 'y' : await ask(
    keep ? 'stand this actor down? (y/n)' : 'retire this actor? this cannot be undone (y/n)', 'n');
  endAsking();
  if (!/^y/i.test(ans)) { console.log('nothing changed'); process.exit(0); }
  await agent.connect();                          // now it may act

  if (moveTo) {
    // Accept either a full actor URL or @user@host.
    const target = /^https?:\/\//.test(moveTo) ? moveTo : await resolveHandle(agent, moveTo);
    const r = await agent.moveTo(target);
    console.log(`moved to ${r.target}: Move delivered to ${r.inboxes} inbox(es), unfollowed ${r.unfollowed}/${r.following}`);
  } else if (keep) {
    const r = await agent.park();                 // same thing, and revivable
    console.log(`stood down ${r.quiescedAt}: unfollowed ${r.unfollowed}/${r.following}, inbox closed`);
    console.log('undo with:  fedipod revive');
  } else {
    const r = await agent.publisher.retireActor();
    console.log(`retired ${r.deletedAt}: Delete delivered to ${r.inboxes} inbox(es)`);
  }
  await finish(agent);
} else if (cmd === 'revoke-credential') {
  // The credential file cannot be protected from anything running as you —
  // so the answer to a suspected leak is to kill it server-side, fast.
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const { revokeCredentialViaAccount } = await import(new URL('../lib/remote.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: () => {} });
  const cred = agent.readCredential();
  if (!cred) { console.error('no credential to revoke'); process.exit(2); }
  const email = flag('email');
  if (!email) { console.error('need --email <account email> (the account password is prompted)'); process.exit(2); }
  const password = process.env.AP_PASSWORD || await askHidden(`password for ${email} at ${cred.issuerOrigin}: `);
  const ok = await revokeCredentialViaAccount({
    origin: cred.issuerOrigin, email, password, resource: cred.resource,
  }).catch(e => { console.error(`revoke failed: ${e.message}`); return false; });
  if (ok) {
    fs.rmSync(path.join(HOME, 'credential.json'), { force: true });
    console.log('credential revoked server-side and deleted locally — run setup again to reconnect');
  } else {
    console.error('server did not confirm revocation — revoke it from the account dashboard');
    console.error(`(credential resource: ${cred.resource || 'unknown — dashboard only'})`);
    process.exit(1);
  }
} else if (cmd === 'tokens') {
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const { RemotePod } = await import(new URL('../lib/remote.mjs', import.meta.url));
  const { apUrls } = await import(new URL('../lib/wire.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: () => {} });
  const cred = agent.readCredential();
  if (!cred) { console.error('no credential — run setup first'); process.exit(2); }
  agent.remote = new RemotePod(cred);
  await agent.remote.warmup();
  agent.urls = apUrls(cred.remotePod, cred.root);
  agent.store.attach(agent.privateStorage(cred, 'state'));   // honours privateRoot
  await agent.store.load();
  const recs = agent.store.read('masto-tokens.json', [])
    .map(r => (typeof r === 'string' ? { token: r, createdAt: null } : r));
  if (has('revoke-all')) {
    agent.store.write('masto-tokens.json', []);
    await agent.store.flush();
    console.log(`revoked ${recs.length} token(s) — every logged-in client must log in again`);
  } else if (flag('revoke')) {
    const prefix = flag('revoke');
    const kept = recs.filter(r => !r.token.startsWith(prefix));
    agent.store.write('masto-tokens.json', kept);
    await agent.store.flush();
    console.log(`revoked ${recs.length - kept.length} token(s) matching "${prefix}"`);
  } else {
    if (!recs.length) console.log('no client tokens issued');
    for (const r of recs) {
      const age = r.createdAt ? `${Math.round((Date.now() - r.createdAt) / 86400000)}d old` : 'undated';
      console.log(`${r.token.slice(0, 8)}…  ${age}`);
    }
    console.log('\nrevoke with: fedipod tokens --revoke <prefix>   (or --revoke-all)');
  }
} else if (cmd === 'stop') {
  requireIdentity();
  const pidFile = path.join(HOME, 'agent.pid');
  let pid = null;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
  if (!pid) {
    // The agent may still be listening even with no pidfile — an older
    // build, a deleted file, or one started detached from any terminal
    // (where Ctrl-C can never reach it). Ask it to stop over the API.
    const asked = await fetch(`http://localhost:${PORT}/shutdown`, { method: 'POST' })
      .then(r => r.ok).catch(() => false);
    if (asked) { console.log(`agent on port ${PORT} asked to stop`); process.exit(0); }
    console.error(`no agent found: no pidfile at ${pidFile}, nothing answering on port ${PORT}.`);
    console.error('If it is on another port, add --port N; a service install stops with:');
    console.error('  systemctl --user stop fedipod-<name>');
    process.exit(1);
  }
  try { process.kill(pid, 'SIGTERM'); } catch {
    // Stale pidfile, but something may still hold the port.
    const asked = await fetch(`http://localhost:${PORT}/shutdown`, { method: 'POST' })
      .then(r => r.ok).catch(() => false);
    fs.rmSync(pidFile, { force: true });
    console.log(asked ? `agent on port ${PORT} asked to stop (pidfile was stale)` : 'agent was not running (stale pidfile)');
    process.exit(0);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000) {
    await new Promise(r => setTimeout(r, 300));
    try { process.kill(pid, 0); } catch { console.log('agent stopped'); process.exit(0); }
  }
  console.error('agent did not exit within 10s — kill it with: kill -9 ' + pid);
  process.exit(1);
} else if (cmd === 'passwd') {
  requireIdentity();
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const { hashPassword } = await import(new URL('../lib/mastoapi.mjs', import.meta.url));
  const { RemotePod } = await import(new URL('../lib/remote.mjs', import.meta.url));
  const { apUrls } = await import(new URL('../lib/wire.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: () => {} });
  const cred = agent.readCredential();
  if (!cred) { console.error('no credential — run setup first'); process.exit(2); }
  const pw = await askHidden('new UI password: ');
  if (!pw) { console.error('empty password — aborted'); process.exit(2); }
  agent.remote = new RemotePod(cred);
  await agent.remote.warmup();
  agent.urls = apUrls(cred.remotePod, cred.root);
  agent.store.attach(agent.privateStorage(cred, 'state'));   // honours privateRoot
  await agent.store.load();
  const config = agent.store.getConfig();
  if (!config) { console.error('pod state empty — run setup first'); process.exit(2); }
  agent.store.setConfig({ ...config, uiPassword: hashPassword(pw) });
  await agent.store.flush();
  console.log('UI password set — /oauth/authorize now shows a login form (restart a running agent to pick it up)');
} else if (cmd === 'install-service' || cmd === 'uninstall-service') {
  const { execFileSync } = await import('node:child_process');
  const runAgentPath = new URL('../run-agent.mjs', import.meta.url).pathname;
  const sh = (file, a) => { try { execFileSync(file, a, { stdio: 'pipe' }); return true; } catch { return false; } };
  // Every identity with a credential gets a service of its own: a stopped
  // actor's pod goes on collecting deliveries, so "installed" means ALL of
  // them start at boot, each on its recorded port.
  const identities = [];
  for (const { name, dir } of identityHomes(AP_ROOT)) {
    if (!fs.existsSync(path.join(dir, 'credential.json'))) continue;
    let rec = {};
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8')) || {}; } catch { /* no record yet */ }
    if (!Number(rec.port)) {
      console.log(`${name}: no recorded port — start it once (\`up --profile ${name}\`), then re-run install-service`);
      continue;
    }
    identities.push({ name, dir, port: Number(rec.port), handle: rec.handle || name });
  }
  if (cmd === 'install-service' && !identities.length) {
    console.error('no identities with a credential and a recorded port — nothing to install');
    process.exit(2);
  }
  // Graceful handover: an identity already running outside the service is
  // stopped through its own /shutdown so the unit can take the port.
  const handOver = async ({ name, port }) => {
    if (!await agentOn(port)) return;
    await fetch(`http://localhost:${port}/shutdown`, { method: 'POST' }).catch(() => {});
    for (let i = 0; i < 20 && !await portFree(port); i++) await new Promise(r => setTimeout(r, 250));
    console.log(`${name}: was running detached — stopped for the service to take over`);
  };

  if (process.platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config/systemd/user');
    const unitOf = (name) => `fedipod-${name}.service`;
    // Old shapes are cleared on both paths: units under the pre-rename names
    // (activitypod, solid-activitypub), single-identity units, and any
    // per-identity unit for an identity that no longer exists here.
    const dropOld = () => {
      const keep = new Set(cmd === 'install-service' ? identities.map(i => unitOf(i.name)) : []);
      let units = [];
      try { units = fs.readdirSync(unitDir).filter(u => /^(activitypod|solid-activitypub|fedipod)(-.+)?\.service$/.test(u)); } catch { /* no unit dir */ }
      for (const u of units) {
        if (keep.has(u)) continue;
        sh('systemctl', ['--user', 'disable', '--now', u]);
        fs.rmSync(path.join(unitDir, u), { force: true });
        console.log(`removed ${u}`);
      }
    };
    if (cmd === 'uninstall-service') {
      dropOld();
      sh('systemctl', ['--user', 'daemon-reload']);
      console.log('service(s) removed');
    } else {
      fs.mkdirSync(unitDir, { recursive: true });
      dropOld();
      for (const id of identities) {
        fs.writeFileSync(path.join(unitDir, unitOf(id.name)), `[Unit]
Description=FediPod agent — ${id.handle}
After=network-online.target

[Service]
ExecStart=${process.execPath} ${runAgentPath}
Environment=AP_HOME=${id.dir}
Environment=AP_PORT=${id.port}
Restart=on-failure
RestartSec=30
# A crash loop must not become a request loop against the pod.
StartLimitIntervalSec=600
StartLimitBurst=5

[Install]
WantedBy=default.target
`);
      }
      sh('systemctl', ['--user', 'daemon-reload']);
      sh('loginctl', ['enable-linger', os.userInfo().username]);   // keep running while logged out
      for (const id of identities) {
        sh('systemctl', ['--user', 'enable', unitOf(id.name)]);
        await handOver(id);
        if (await portFree(id.port)) {
          sh('systemctl', ['--user', 'start', unitOf(id.name)]);
          console.log(`${id.handle}: installed, enabled and started on port ${id.port}`);
        } else {
          console.log(`${id.handle}: installed + enabled (starts at next boot). Port ${id.port} is held by something that is not ours — free it, then: systemctl --user start ${unitOf(id.name)}`);
        }
      }
      console.log('logs: journalctl --user -u fedipod-<name> -f');
    }
  } else if (process.platform === 'darwin') {
    const agents = path.join(os.homedir(), 'Library/LaunchAgents');
    const plistOf = (name) => path.join(agents, `net.fedipod.${name}.agent.plist`);
    // Old shapes are cleared on both paths: plists under the pre-rename names
    // (net.activitypod, net.solid-activitypub), single-identity plists, and any
    // per-identity plist for an identity that no longer exists here.
    const dropOld = () => {
      const keep = new Set(cmd === 'install-service' ? identities.map(i => plistOf(i.name)) : []);
      let plists = [];
      try {
        plists = fs.readdirSync(agents)
          .filter(f => /^net\.(activitypod|solid-activitypub|fedipod)(\..+)?\.agent\.plist$/.test(f))
          .map(f => path.join(agents, f));
      } catch { /* no LaunchAgents dir */ }
      for (const p of plists) {
        if (keep.has(p)) continue;
        sh('launchctl', ['unload', p]);
        fs.rmSync(p, { force: true });
        console.log(`removed ${path.basename(p)}`);
      }
    };
    if (cmd === 'uninstall-service') {
      dropOld();
      console.log('service(s) removed');
    } else {
      fs.mkdirSync(agents, { recursive: true });
      dropOld();
      for (const id of identities) {
        const plist = plistOf(id.name);
        sh('launchctl', ['unload', plist]);      // replacing our own older copy
        fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>net.fedipod.${id.name}.agent</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${runAgentPath}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AP_HOME</key><string>${id.dir}</string>
    <key>AP_PORT</key><string>${id.port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`);
        await handOver(id);
        sh('launchctl', ['load', plist]);
        console.log(`${id.handle}: installed and loaded (starts at login)`);
      }
    }
  } else if (process.platform === 'win32') {
    // schtasks is scriptable, but this path is UNTESTED here (no Windows
    // machine); the equivalent command is printed either way so a failure
    // is actionable rather than mysterious.
    const taskOf = (name) => `fedipod-${name}`;
    // Pre-rename names, single-identity and per-identity, cleared on both paths.
    const dropOld = () => {
      sh('schtasks', ['/delete', '/tn', 'activitypod', '/f']);
      sh('schtasks', ['/delete', '/tn', 'solid-activitypub', '/f']);
      for (const id of identities) sh('schtasks', ['/delete', '/tn', `solid-activitypub-${id.name}`, '/f']);
    };
    if (cmd === 'uninstall-service') {
      dropOld();
      for (const id of identities) sh('schtasks', ['/delete', '/tn', taskOf(id.name), '/f']);
      console.log('scheduled task(s) removed');
    } else {
      dropOld();
      for (const id of identities) {
        const tr = `"${process.execPath}" "${runAgentPath}"`;
        const made = sh('schtasks', ['/create', '/tn', taskOf(id.name), '/tr', tr, '/sc', 'onlogon', '/rl', 'limited', '/f']);
        if (made) {
          console.log(`${id.handle}: scheduled task created — starts at log on (untested on Windows; please report)`);
          console.log(`  set AP_HOME=${id.dir} and AP_PORT=${id.port} in the task's environment`);
        } else {
          console.log(`${id.handle}: could not create the task automatically. Run this in an elevated prompt:`);
          console.log(`  schtasks /create /tn ${taskOf(id.name)} /tr ${tr} /sc onlogon /rl limited /f`);
          console.log(`  with AP_HOME=${id.dir} AP_PORT=${id.port}.`);
        }
      }
    }
  } else if (process.platform === 'android' || process.env.PREFIX?.includes('com.termux')) {
    // Android has no user service manager: running at boot needs the
    // separate termux-boot app, supervision needs the termux-services
    // package. Neither can be installed from here, so print the recipe.
    // The agent is designed for this: whatever Android kills, the pod
    // buffered, and the next start catches up.
    if (cmd === 'uninstall-service') {
      console.log('Termux: remove ~/.termux/boot/fedipod.sh (solid-activitypub.sh or activitypod.sh on an older install, and `sv-disable` the matching service if you used termux-services).');
    } else {
      const boot = path.join(os.homedir(), '.termux/boot');
      console.log('Android/Termux has no service manager. To start at boot:');
      console.log('  1. install the Termux:Boot app (F-Droid), open it once');
      console.log(`  2. mkdir -p ${boot} && cat > ${boot}/fedipod.sh <<'EOF'`);
      console.log('#!/data/data/com.termux/files/usr/bin/sh');
      console.log('termux-wake-lock');
      for (const id of identities) console.log(`AP_HOME=${id.dir} AP_PORT=${id.port} ${process.execPath} ${runAgentPath} &`);
      console.log('EOF');
      console.log(`  3. chmod +x ${boot}/fedipod.sh`);
      console.log('\nWithout Termux:Boot, run `termux-wake-lock` then `fedipod run` —');
      console.log('anything Android kills is buffered on the pod and catches up next start.');
    }
  } else {
    console.log(`no service integration for platform "${process.platform}". Run each yourself with:`);
    for (const id of identities) console.log(`  AP_HOME=${id.dir} AP_PORT=${id.port} ${process.execPath} ${runAgentPath}`);
  }
} else if (cmd === 'describe') {
  // The bio and the avatar. Both live in the actor document, so this republishes.
  if (!flag('summary') && !flag('icon')) {
    console.error('usage: fedipod describe --summary "what this is" --icon <url>');
    process.exit(2);
  }
  const payload = {};
  if (flag('summary') !== undefined) payload.summary = flag('summary');
  if (flag('icon') !== undefined) payload.icon = flag('icon');
  try {
    const res = await fetch(`http://localhost:${PORT}/describe`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    console.log(`described and republished — summary: ${body.summary ? '"' + body.summary + '"' : '(none)'}, icon: ${body.icon || '(none)'}`);
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else if (cmd === 'rebuild') {
  requireIdentity();
  // Served by the running agent because it needs the lease: it writes the
  // statuses store, and two agents writing it is the thing the lease prevents.
  try {
    const res = await fetch(`http://localhost:${PORT}/rebuild`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromNotes: has('from-notes') }),
    });
    const body = await res.json();
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    if (body.why) { console.error(body.why); process.exit(1); }
    console.log(`the pod indexed ${body.indexed} post(s); recovered ${body.recovered}`
      + `${body.reblogs ? `, and marked ${body.reblogs} of them boosted` : ''}`
      + `${body.rdf ? ` (${body.rdf} written back to the RDF)` : ''}`);
    if (body.dropped) console.log(`${body.dropped} fell past the 1000-status cap`);
    if (!body.landed) { console.error('the state write did NOT land — nothing is saved'); process.exit(1); }
    if (!body.recovered && !has('from-notes')) {
      console.log('Nothing was missing. `--from-notes` looks past the outbox, at every note the pod still holds.');
    }
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else if (cmd === 'status') {
  requireIdentity();
  try {
    const res = await fetch(`http://localhost:${PORT}/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else if (['members', 'announced', 'pending', 'requests', 'mute', 'unmute', 'eject',
  'retract', 'approve', 'decline', 'review', 'joins', 'admit', 'refuse'].includes(cmd)) {
  // Group operator commands, served by the running agent's admin API.
  const GETS = ['members', 'announced', 'pending', 'requests'];
  const BY_ACTOR = ['mute', 'unmute', 'eject', 'admit', 'refuse'];
  const TOGGLES = { review: ['on', 'off'], joins: ['open', 'approve'] };
  const post = !GETS.includes(cmd);
  const arg = post ? (flag('actor') || flag('note') || args[1]) : null;
  if (post && !TOGGLES[cmd] && !arg) {
    console.error(`usage: fedipod ${cmd} <${BY_ACTOR.includes(cmd) ? 'actor' : 'note'}-url>`);
    process.exit(2);
  }
  if (TOGGLES[cmd] && !TOGGLES[cmd].includes(arg)) {
    console.error(`usage: fedipod ${cmd} <${TOGGLES[cmd].join('|')}>`);
    process.exit(2);
  }
  const payload = cmd === 'review' ? { on: arg === 'on' }
    : cmd === 'joins' ? { approve: arg === 'approve' }
    : BY_ACTOR.includes(cmd) ? { actor: arg } : { noteId: arg };
  let body;
  try {
    const res = await fetch(`http://localhost:${PORT}/${cmd}`, post
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
      : undefined);
    body = await res.json();
    if (res.status === 404 && body.error === 'not a group') {
      console.error(`the agent on :${PORT} is not a group — these commands only apply to one`);
      process.exit(2);
    }
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
  if (cmd === 'members') {
    if (!body.members.length) console.log('no members yet — nobody has followed this group');
    for (const m of body.members) console.log(`${m.muted ? 'muted ' : '      '}${m.actor}`);
    console.log('\nstop carrying someone: fedipod mute <actor-url>   (undo: unmute)');
    console.log('remove them entirely:  fedipod eject <actor-url>');
  } else if (cmd === 'announced') {
    if (!body.announced.length) console.log('nothing carried yet');
    for (const a of body.announced) console.log(`${a.announcedAt}  ${a.actor}  ${a.noteId}`);
    console.log('\nunsay one: fedipod retract <note-url>');
  } else if (cmd === 'pending') {
    console.log(`review is ${body.review ? 'ON' : 'off'}`);
    if (!body.pending.length) console.log('nothing held');
    for (const q of body.pending) console.log(`${q.at}  ${q.actor}  ${q.noteId}`);
    if (body.pending.length) console.log('\nfedipod approve <note-url>   (or decline)');
  } else if (cmd === 'requests') {
    console.log(`joins ${body.approveJoins ? 'need approval' : 'are open — anyone can join'}`);
    if (!body.requests.length) console.log('nobody waiting');
    for (const q of body.requests) console.log(`${q.at}  ${q.actor}`);
    if (body.requests.length) console.log('\nfedipod admit <actor-url>   (or refuse)');
  } else if (cmd === 'joins') {
    console.log(body.approveJoins
      ? 'joins now need approval — the actor advertises manuallyApprovesFollowers and was republished'
      : 'joins are now open — anyone who follows is admitted at once');
  } else if (cmd === 'admit' || cmd === 'refuse') {
    console.log(`${cmd === 'admit' ? 'admitted' : 'refused'} ${arg} — ${body.requests} still waiting`);
  } else if (cmd === 'mute' || cmd === 'unmute') {
    console.log(`${cmd}d ${arg} — ${body.actors.length} muted member(s)`);
  } else if (cmd === 'eject') {
    console.log(`ejected ${arg}${body.told ? ' — their server was told' : ' (no inbox on record; not told)'}`);
    console.log('they are muted too, so a re-follow rejoins but nothing of theirs is carried');
  } else if (cmd === 'retract') {
    console.log(`retracted ${arg} — Undo sent to ${body.inboxes} inbox(es)`);
  } else if (cmd === 'review') {
    console.log(`review is now ${body.review ? 'ON — nothing is carried until approved' : 'off'}`);
  } else {
    console.log(`${cmd}d ${arg} — ${body.pending} still held`);
  }
} else if (cmd === 'bsky') {
  // Bluesky account commands, served by the running agent's admin API.
  const sub = args[1];
  let out;
  try {
    if (sub === 'connect') {
      const identifier = flag('handle') || args[2];
      const appPassword = flag('app-password') || args[3];
      if (!identifier || !appPassword) {
        console.error('usage: fedipod bsky connect <handle> <app-password> [--service https://bsky.social]');
        process.exit(2);
      }
      const res = await fetch(`http://localhost:${PORT}/atproto/connect`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier, appPassword, service: flag('service') }),
      });
      out = await res.json();
      if (res.status >= 400) { console.error(out.error || `HTTP ${res.status}`); process.exit(1); }
      console.log(`connected: @${out.handle} on ${out.service}`);
      console.log('public posts will cross-post; turn off: fedipod bsky crosspost off');
    } else if (sub === 'disconnect') {
      const res = await fetch(`http://localhost:${PORT}/atproto/disconnect`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      out = await res.json();
      if (res.status >= 400) { console.error(out.error || `HTTP ${res.status}`); process.exit(1); }
      console.log('disconnected — the local credential is gone');
    } else if (sub === 'crosspost') {
      if (!['on', 'off'].includes(args[2])) {
        console.error('usage: fedipod bsky crosspost <on|off>');
        process.exit(2);
      }
      const res = await fetch(`http://localhost:${PORT}/atproto`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crossPost: args[2] === 'on' }),
      });
      out = await res.json();
      if (res.status >= 400) { console.error(out.error || `HTTP ${res.status}`); process.exit(1); }
      console.log(`cross-posting is ${out.atproto.crossPost ? 'on' : 'off'}`);
    } else {
      const res = await fetch(`http://localhost:${PORT}/status`);
      out = await res.json();
      const a = out.atproto;
      if (!a?.connected) console.log('no bluesky account connected — fedipod bsky connect <handle> <app-password>');
      else console.log(`@${a.handle} (${a.did}) on ${a.service}${a.lastError ? `\nlast error: ${a.lastError}` : ''}`);
    }
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else {
  console.log('usage: fedipod <setup|start|stop|status|state|upgrade|rebuild|home|passwd'
    + '|tokens|revoke-credential|install-service> [--flags]');
  console.log('  state: --to <path|url|pod>   move THIS identity\'s private half');
  console.log('         --all [--apply]       move every identity\'s onto this machine');
  console.log('         --drop-remote [--apply]  remove the pod\'s copy afterwards');
  console.log('  upgrade: what every identity here is behind on, and stamp the ones that are not');
  console.log('  bsky: connect <handle> <app-password> | disconnect | crosspost <on|off> | status');
  console.log('  group: members | eject <actor> | mute <actor> | unmute <actor>');
  console.log('         joins <open|approve> | requests | admit <actor> | refuse <actor>');
  console.log('         announced | retract <note> | review <on|off> | pending | approve <note> | decline <note>');
  process.exit(cmd ? 2 : 0);
}
