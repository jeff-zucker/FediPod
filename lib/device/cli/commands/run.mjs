// run.mjs — starting and stopping: up, start, stop, status, https.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { identityHomes, rootOf, profileHome, recordLastUsed } from '../../home.mjs';
import { portFree, freePortFrom } from '../../ports.mjs';
import { localFetch } from '../../../client/localapi.mjs';
import { flag, has, portFlag, PROFILE, AP_ROOT, DEFAULT_ISSUE, HOME, PORT, recordedAgent, recordedPort, recordAgent, useProfile, requireHandle, requireIdentity, ask, endAsking, agentOn, openBrowser } from '../context.mjs';

export async function up() {
// A signup page may have arranged an identity already: the installer records
// its parameters in first-run.json beside this script's package, and the
// carry-over outranks the last-used identity — whether this machine is fresh
// or already full of accounts, `npm start` right after the installer brings
// up the identity the signup arranged, beside any that exist. An explicitly
// named profile or home still means exactly what it says.
const firstRunFile = process.env.AP_FIRST_RUN
  || new URL('../../../../first-run.json', import.meta.url).pathname;
const explicitHome = !!(PROFILE || flag('home', null) || process.env.AP_HOME);
let firstRun = null;
if (!explicitHome) {
  try { firstRun = JSON.parse(fs.readFileSync(firstRunFile, 'utf8')); } catch { /* none */ }
}
if (firstRun?.handle) {
  const carried = String(firstRun.handle);
  requireHandle(carried);
  if (fs.existsSync(path.join(profileHome(AP_ROOT, carried), 'credential.json'))) {
    console.error(`the signup carried the name "${carried}", but an identity with that name already exists here.`);
    console.error('To attach the existing identity instead, use the signup page\'s Manage → Attach —');
    console.error(`then remove ${firstRunFile} and run this again.`);
    process.exit(2);
  }
  useProfile(carried);
  process.env.AP_FIRST_RUN = firstRunFile;
} else if (DEFAULT_ISSUE && !identityHomes(AP_ROOT).some(h => fs.existsSync(path.join(h.dir, 'credential.json')))) {
  // A fresh machine has no identity, and an identity is named after its
  // handle, so there is no home to start in until that is asked. One
  // question, the same one `setup` opens with — `npm start` stays the
  // single command it was.
  if (!process.stdin.isTTY) {
    console.error('no identities yet — fedipod setup');
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
const { hostLabel } = await import(new URL('../../../../lib/shared/guard.mjs', import.meta.url));

let port = preferred;
let already = null;
if (!await portFree(preferred)) {
  already = await agentOn(preferred);
  // Ours already — nothing to start. The directory door yields to a real
  // owner of its port. Anything else is simply not this port; walking on is
  // what "occupied" has always meant here.
  if (!already) {
    const { yieldDirectory } = await import(new URL('../../../../lib/gateway/directory.mjs', import.meta.url));
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
// One listener, one scheme: the port the agent was given is the port you
// browse, over https.
const originNow = () => `https://${label ? label + '.' : ''}localhost:${port}`;

if (already) {
  console.log(`already running on port ${port}`);
} else {
  // The handle too, not just the port: the agent seeds its allowed hosts
  // from agent.json, and without it the named origin this command is about
  // to open would be refused on the very first run.
  recordAgent(recordedAgent().handle ? { port } : { port, handle: path.basename(HOME) });
  const child = spawn(process.execPath, [new URL('../../../../run-agent.mjs', import.meta.url).pathname], {
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
// The client pinned to this actor, not the bare root — root serves vendored
// Phanpy with no account bound, which reads as the wrong app entirely.
const url = configured ? `${originNow()}/admin/client/` : `${originNow()}/admin/setup/`;
console.log(`\n  ${url}\n`);
console.log(configured ? 'stop it with:  fedipod stop'
  : 'setup continues in the browser. Stop it with:  fedipod stop');
if (!has('no-open')) openBrowser(url);
process.exit(0);
}

export async function start() {
requireIdentity();
// Starting one is what makes it the default — so `--profile group start`
// today is what a plain command means tomorrow. Recorded before the agent
// comes up, because a start that fails still expressed the intent.
if (rootOf(HOME) === AP_ROOT) recordLastUsed(AP_ROOT, path.basename(HOME));
// This flag is read only by setup; it silently did nothing here, while the
// key guard's own error message told people to use it.
if (has('rotate-key')) {
  console.error('start does not rotate keys — use:  fedipod rotate-key');
  process.exit(2);
}
if (portFlag()) recordAgent({ port: PORT });   // `start --port N` (or bare N) moves it for good

// Something already on the port? Offer to take it over rather than dying
// with "address in use" and leaving the user to hunt the process down.
const answering = await localFetch(HOME, PORT, `/status`)
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

  await localFetch(HOME, PORT, `/shutdown`, { method: 'POST' }).catch(() => {});
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  const freed = await (async () => {                 // give it a few seconds
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 300));
      const still = await localFetch(HOME, PORT, `/status`).then(() => true).catch(() => false);
      if (!still) return true;
    }
    return false;
  })();
  if (!freed && pid) { try { process.kill(pid, 'SIGKILL'); } catch {} await new Promise(r => setTimeout(r, 500)); }
  const clear = await localFetch(HOME, PORT, `/status`).then(() => false).catch(() => true);
  if (!clear) {
    console.error(`could not stop whatever is on port ${PORT}. Find it with:  ss -tlnp | grep :${PORT}`);
    process.exit(1);
  }
  console.log('previous agent stopped');
}

const { startAgent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const startHandle = recordedAgent().handle || null;
await startAgent({
  home: HOME, port: PORT, name: flag('name') || null,
  takeover: has('takeover'),      // claim a lease whose holder is gone
  handle: startHandle,            // the named origin, before pod state is read
});
{
  const { hostLabel } = await import(new URL('../../../../lib/shared/guard.mjs', import.meta.url));
  const label = hostLabel(startHandle);
  const named = label ? `https://${label}.localhost:${PORT}/` : null;
  const plain = `https://localhost:${PORT}/`;
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
}

export async function stop() {
requireIdentity();
const pidFile = path.join(HOME, 'agent.pid');
let pid = null;
try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch {}
if (!pid) {
  // The agent may still be listening even with no pidfile — an older
  // build, a deleted file, or one started detached from any terminal
  // (where Ctrl-C can never reach it). Ask it to stop over the API.
  const asked = await localFetch(HOME, PORT, `/shutdown`, { method: 'POST' })
    .then(r => r.ok).catch(() => false);
  if (asked) { console.log(`agent on port ${PORT} asked to stop`); process.exit(0); }
  console.error(`no agent found: no pidfile at ${pidFile}, nothing answering on port ${PORT}.`);
  console.error('If it is on another port, add --port N; a service install stops with:');
  console.error('  systemctl --user stop fedipod-<name>');
  process.exit(1);
}
try { process.kill(pid, 'SIGTERM'); } catch {
  // Stale pidfile, but something may still hold the port.
  const asked = await localFetch(HOME, PORT, `/shutdown`, { method: 'POST' })
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
}

export async function status() {
requireIdentity();
try {
  const res = await localFetch(HOME, PORT, `/status`);
  console.log(JSON.stringify(await res.json(), null, 2));
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}

export async function https() {
// Agents serve https beside http with a certificate minted on this machine
// (never packaged — a shipped key would be one key for every install).
// Plain: self-signed, a client may ask once. --trust: a local CA signs it,
// and the CA certificate is what a trust store accepts — for clients that
// refuse self-signed outright.
const { ensureLocalTls, enableTrust, certPaths } = await import(new URL('../../../../lib/device/certs.mjs', import.meta.url));
const certDir = path.join(rootOf(HOME), 'certs');   // same resolution the agent uses
if (has('trust')) {
  const t = enableTrust(certDir, { log: console.log });   // mints, signs, installs in NSS
  console.log(`CA certificate: ${t.caCertPath}`);
  if (process.platform === 'linux') {
    console.log('for the system store, run:');
    console.log(`  sudo cp ${t.caCertPath} /usr/local/share/ca-certificates/fedipod-local-ca.crt && sudo update-ca-certificates`);
  } else if (process.platform === 'darwin') {
    console.log('to trust it system-wide, run:');
    console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${t.caCertPath}`);
  } else if (process.platform === 'win32') {
    console.log('to trust it, run:');
    console.log(`  certutil -addstore -user Root "${t.caCertPath}"`);
  }
  console.log('restart your agents to serve the CA-signed certificate');
} else {
  const tls = ensureLocalTls(certDir, { log: console.log });
  const paths2 = certPaths(certDir);
  console.log(`certificate: ${paths2.cert}`);
  console.log(`  ${tls.trust ? 'signed by the local CA' : 'self-signed'}, ${tls.expiresInDays} days left`);
  console.log('agents serve https on the port they were given — e.g. https://localhost:8030');
  console.log('strict clients: `fedipod https --trust` mints a local CA your trust store can accept');
}
}
