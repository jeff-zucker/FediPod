#!/usr/bin/env node
// activitypod.mjs — CLI for the standalone pod-stored ActivityPub actor.
//
//   activitypod setup --new-account --email you@example.org --handle you
//     Asks for the identity provider, the pod name (which becomes the
//     domain half of your address) and your display name, showing the
//     address you are about to create before creating it. Any of them can
//     be given as flags instead: --issuer, --pod-name, --name (and --home,
//     --keys pod, --root).
//     Creates a brand-new account + pod on the CSS server, mints the
//     credential, provisions the pod, publishes the actor, STARTS the agent
//     and opens the browser. One command from nothing to federating.
//
//   activitypod setup --pod https://you.solidcommunity.net/ \
//       --issuer https://solidcommunity.net --email you@example.org --handle you
//     Same, against an account + pod you already have.
//
//     The password is prompted (or AP_PASSWORD) — used once to create the
//     account and/or mint a revocable CSS client-credential, never stored.
//     Keys live in AP_HOME by default (the pod host cannot read them);
//     --keys pod stores them in pod state instead, so several devices can
//     sign as the same actor without copying files.
//
//   activitypod start     start the agent (UI + API on http://localhost:8030/)
//                         --name "Your Name" sets the display name other
//                         servers show, and republishes the actor
//                         ('run' is kept as an alias)
//   activitypod stop      stop the running agent (graceful: flush + lease release)
//   activitypod status    show the running agent's status
//   activitypod passwd    set/change the UI password (REQUIRED before any
//                         non-loopback exposure — it turns the instant
//                         OAuth redirect into a real login form)
//   activitypod tokens    list client tokens; --revoke <prefix> / --revoke-all
//   activitypod revoke-credential --email you@example.org
//                         kill this machine's pod credential server-side and
//                         delete it locally (the answer to a suspected leak)
//   activitypod install-service    start at boot + restart on crash
//                                  (systemd --user on Linux, launchd on mac)
//   activitypod uninstall-service  remove that registration

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes('--' + name);
// One identity per home. --profile <name> is the ergonomic form of picking one:
// ~/.activitypod for the first, ~/.activitypod/profiles/<name>/ for the rest.
// An explicit --home / AP_HOME still wins, so existing installs are untouched.
const PROFILE = flag('profile', process.env.AP_PROFILE || null);
const PROFILES_DIR = path.join(os.homedir(), '.activitypod', 'profiles');
const HOME = flag('home', process.env.AP_HOME
  || (PROFILE ? path.join(PROFILES_DIR, PROFILE) : path.join(os.homedir(), '.activitypod')));

// The port chosen at setup is remembered, so `start`/`stop`/`status` need no
// flags afterwards. Precedence: --port > AP_PORT > the recorded choice > 8030.
function recordedPort() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(HOME, 'agent.json'), 'utf8')).port) || null; }
  catch { return null; }
}
function recordPort(port) {
  try {
    fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(HOME, 'agent.json'), JSON.stringify({ port }, null, 2) + '\n');
  } catch { /* the flag still works, it just isn't remembered */ }
}
const PORT = Number(flag('port', process.env.AP_PORT || recordedPort() || 8030));

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

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
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

if (cmd === 'setup') {
  // Refuse before anything is asked, let alone typed: setup used to overwrite
  // credential.json in place, and a minted credential is only shown once — so
  // the identity it belonged to could not be recovered afterwards.
  const credPath = path.join(HOME, 'credential.json');
  if (fs.existsSync(credPath) && !has('force')) {
    let held = '(unreadable)';
    try { held = JSON.parse(fs.readFileSync(credPath, 'utf8')).remotePod; } catch {}
    console.error(`${HOME} already holds an identity: ${held}`);
    console.error('For another identity:  bin/activitypod.mjs setup --profile <name>');
    console.error('To list what exists:   bin/activitypod.mjs profiles');
    console.error('To replace this one:   add --force (the old credential is lost)');
    process.exit(2);
  }
  const root = flag('root');
  const kind = has('group') ? 'group' : 'person';
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
  const email = flag('email') || await ask(`account email at ${new URL(issuer).host}`);
  const handle = flag('handle') || await ask('handle (the name in your address; permanent)');
  if (!email || !handle) {
    console.error('an email and a handle are required');
    process.exit(2);
  }
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
    console.error('Give the group a pod of its own:  bin/activitypod.mjs setup --group --new-account');
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
  const credential = await mintCredential({ origin: issuer, email, password, name: 'activitypod-js' });
  const rec = {
    ...credential,
    remotePod: pod.endsWith('/') ? pod : pod + '/',
    ...(root ? { root } : {}),
    ...(flag('keys') === 'pod' ? { keysMode: 'pod' } : {}),
    ...(has('rotate-key') ? { rotateKeyOnce: true } : {}),
  };
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(HOME, 'credential.json'), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  recordPort(PORT);                      // later commands need no --port
  console.log(`credential minted and saved to ${path.join(HOME, 'credential.json')}`);

  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[setup]', ...a) });
  await agent.bootstrap({ handle, name, root, kind });
  await agent.connect();
  await agent.publisher.publishProfile();
  await agent.store.flush();
  const finalHost = webfingerHost(rec.remotePod);
  const what = kind === 'group' ? 'group' : 'actor';
  console.log(finalHost
    ? `${what} published: @${handle}@${finalHost}`
    : `${what} published, but not reachable as a handle \u2014 ${rec.remotePod} is not a host root`);

  // Straight into serving — setup ends with a working client in the browser.
  const { startAdmin } = await import(new URL('../lib/admin.mjs', import.meta.url));
  startAdmin({ port: PORT, gateToken: process.env.AP_GATE_TOKEN || '', agent, log: (...a) => console.log('[ap]', ...a) });
  const shutdown = () => {
    setTimeout(() => process.exit(0), 5000).unref();   // never hang a stop on a slow pod
    try { fs.rmSync(path.join(HOME, 'agent.pid'), { force: true }); } catch {}
    Promise.allSettled([agent.store.flush(), agent.lease?.release()]).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const url = `http://localhost:${PORT}/`;
  if (kind === 'group') {
    // A group has no human reading a timeline, so it serves no client.
    console.log(`group running on ${url} — no client UI; see \`activitypod members\``);
  } else {
    console.log(`agent running — opening ${url} (log in with instance localhost:${PORT})`);
    openBrowser(url);
  }
} else if (cmd === 'start' || cmd === 'run') {   // 'run' kept as an alias
  // This flag is read only by setup; it silently did nothing here, while the
  // key guard's own error message told people to use it.
  if (has('rotate-key')) {
    console.error('start does not rotate keys — use:  bin/activitypod.mjs rotate-key');
    process.exit(2);
  }
  if (flag('port')) recordPort(PORT);      // `start --port N` once moves it for good

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
      console.error('Stop it with `activitypod stop`, or start this one with --replace.');
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
  await startAgent({
    home: HOME, port: PORT, name: flag('name') || null,
    takeover: has('takeover'),      // claim a lease whose holder is gone
  });
} else if (cmd === 'rotate-key') {
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[rotate-key]', ...a) });
  if (!await agent.connect()) {
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
  const r = await agent.rotateKey();
  console.log(r.changed ? 'rotated and republished' : 'no change — the key was already fresh');
  await finish(agent);
} else if (cmd === 'profiles') {
  // Local files only, plus a quick liveness probe: nothing here needs the pod.
  const homes = [{ name: '(default)', dir: path.join(os.homedir(), '.activitypod') }];
  try {
    for (const name of fs.readdirSync(PROFILES_DIR).sort()) {
      const dir = path.join(PROFILES_DIR, name);
      if (fs.statSync(dir).isDirectory()) homes.push({ name, dir });
    }
  } catch { /* no profiles yet */ }

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

  if (!rows.length) console.log('no identities yet — bin/activitypod.mjs setup');
  else {
    const w = (k, min) => Math.max(min, ...rows.map(r => String(r[k]).length));
    const [wn, wp, wo, wk] = [w('name', 7), w('pod', 3), w('port', 4), w('kind', 4)];
    console.log(`${'PROFILE'.padEnd(wn)}  ${'POD'.padEnd(wp)}  ${'PORT'.padEnd(wo)}  ${'KIND'.padEnd(wk)}  STATE`);
    for (const r of rows) {
      console.log(`${r.name.padEnd(wn)}  ${String(r.pod).padEnd(wp)}  ${String(r.port).padEnd(wo)}`
        + `  ${String(r.kind).padEnd(wk)}  ${r.state}`);
    }
  }
  console.log('\nIdentities under a custom AP_HOME are not listed — only ~/.activitypod'
    + ' and ~/.activitypod/profiles/*.');
  process.exit(0);
} else if (cmd === 'park' || cmd === 'revive') {
  // Park is quiesce plus a snapshot of the follow graph, because unfollowing is
  // what stops the traffic and also what destroys the record needed to come back.
  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log(`[${cmd}]`, ...a) });
  if (!await agent.connect()) {
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
    console.log('Quietest state short of retiring. Undo with:  activitypod revive\n');
    const ans = has('yes') ? 'y' : await ask('park this actor? (y/n)', 'n');
    endAsking();
    if (!/^y/i.test(ans)) { console.log('nothing changed'); process.exit(0); }
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
  if (!await agent.connect()) {
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
  console.log(keep
    ? '\nReversible: follow people again and re-open the inbox with publish-profile.\n'
    : '\nYour posts and RDF stay on the pod; the identity does not come back.\n');

  const ans = has('yes') ? 'y' : await ask(
    keep ? 'stand this actor down? (y/n)' : 'retire this actor? this cannot be undone (y/n)', 'n');
  endAsking();
  if (!/^y/i.test(ans)) { console.log('nothing changed'); process.exit(0); }

  if (moveTo) {
    // Accept either a full actor URL or @user@host.
    const target = /^https?:\/\//.test(moveTo) ? moveTo : await resolveHandle(agent, moveTo);
    const r = await agent.moveTo(target);
    console.log(`moved to ${r.target}: Move delivered to ${r.inboxes} inbox(es), unfollowed ${r.unfollowed}/${r.following}`);
  } else if (keep) {
    const r = await agent.park();                 // same thing, and revivable
    console.log(`stood down ${r.quiescedAt}: unfollowed ${r.unfollowed}/${r.following}, inbox closed`);
    console.log('undo with:  activitypod revive');
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
  agent.store.attach(apUrls(cred.remotePod, cred.root).state, (u, i) => agent.remote.fetch(u, i));
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
    console.log('\nrevoke with: activitypod tokens --revoke <prefix>   (or --revoke-all)');
  }
} else if (cmd === 'stop') {
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
    console.error('  systemctl --user stop activitypod');
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
  const urls = apUrls(cred.remotePod, cred.root);
  agent.store.attach(urls.state, (u, i) => agent.remote.fetch(u, i));
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
  if (process.platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config/systemd/user');
    const unit = path.join(unitDir, 'activitypod.service');
    if (cmd === 'uninstall-service') {
      sh('systemctl', ['--user', 'disable', '--now', 'activitypod.service']);
      fs.rmSync(unit, { force: true });
      sh('systemctl', ['--user', 'daemon-reload']);
      console.log('service removed');
    } else {
      fs.mkdirSync(unitDir, { recursive: true });
      fs.writeFileSync(unit, `[Unit]
Description=activitypod-js agent (pod-stored ActivityPub actor)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${runAgentPath}
Environment=AP_HOME=${HOME}
Environment=AP_PORT=${PORT}
Restart=on-failure
RestartSec=30
# A crash loop must not become a request loop against the pod.
StartLimitIntervalSec=600
StartLimitBurst=5

[Install]
WantedBy=default.target
`);
      sh('systemctl', ['--user', 'daemon-reload']);
      sh('systemctl', ['--user', 'enable', 'activitypod.service']);
      sh('loginctl', ['enable-linger', os.userInfo().username]);   // keep running while logged out
      const portBusy = await fetch(`http://localhost:${PORT}/status`).then(() => true).catch(() => false);
      if (portBusy) {
        console.log(`installed + enabled (starts at next boot). Port ${PORT} is in use right now — stop that agent, then: systemctl --user start activitypod`);
      } else {
        sh('systemctl', ['--user', 'start', 'activitypod.service']);
        console.log('installed, enabled and started');
      }
      console.log('logs: journalctl --user -u activitypod -f');
    }
  } else if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library/LaunchAgents/net.activitypod.agent.plist');
    if (cmd === 'uninstall-service') {
      sh('launchctl', ['unload', plist]);
      fs.rmSync(plist, { force: true });
      console.log('service removed');
    } else {
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>net.activitypod.agent</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${runAgentPath}</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>AP_HOME</key><string>${HOME}</string>
    <key>AP_PORT</key><string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`);
      sh('launchctl', ['load', plist]);
      console.log('installed and loaded (starts at login)');
    }
  } else if (process.platform === 'win32') {
    // schtasks is scriptable, but this path is UNTESTED here (no Windows
    // machine); the equivalent command is printed either way so a failure
    // is actionable rather than mysterious.
    const task = 'activitypod';
    const tr = `"${process.execPath}" "${runAgentPath}"`;
    if (cmd === 'uninstall-service') {
      const gone = sh('schtasks', ['/delete', '/tn', task, '/f']);
      console.log(gone ? 'scheduled task removed' : `could not remove it — run: schtasks /delete /tn ${task} /f`);
    } else {
      const made = sh('schtasks', ['/create', '/tn', task, '/tr', tr, '/sc', 'onlogon', '/rl', 'limited', '/f']);
      if (made) {
        console.log('scheduled task created — starts at log on (untested on Windows; please report)');
        console.log(`set AP_HOME=${HOME} and AP_PORT=${PORT} in the task's environment if they are not your defaults`);
      } else {
        console.log('could not create the task automatically. Run this in an elevated prompt:');
        console.log(`  schtasks /create /tn ${task} /tr ${tr} /sc onlogon /rl limited /f`);
        console.log(`with AP_HOME=${HOME} AP_PORT=${PORT}.`);
      }
    }
  } else if (process.platform === 'android' || process.env.PREFIX?.includes('com.termux')) {
    // Android has no user service manager: running at boot needs the
    // separate termux-boot app, supervision needs the termux-services
    // package. Neither can be installed from here, so print the recipe.
    // The agent is designed for this: whatever Android kills, the pod
    // buffered, and the next start catches up.
    if (cmd === 'uninstall-service') {
      console.log('Termux: remove ~/.termux/boot/activitypod.sh (and `sv-disable activitypod` if you used termux-services).');
    } else {
      const boot = path.join(os.homedir(), '.termux/boot');
      console.log('Android/Termux has no service manager. To start at boot:');
      console.log('  1. install the Termux:Boot app (F-Droid), open it once');
      console.log(`  2. mkdir -p ${boot} && cat > ${boot}/activitypod.sh <<'EOF'`);
      console.log('#!/data/data/com.termux/files/usr/bin/sh');
      console.log('termux-wake-lock');
      console.log(`AP_HOME=${HOME} AP_PORT=${PORT} ${process.execPath} ${runAgentPath} &`);
      console.log('EOF');
      console.log(`  3. chmod +x ${boot}/activitypod.sh`);
      console.log('\nWithout Termux:Boot, run `termux-wake-lock` then `activitypod run` —');
      console.log('anything Android kills is buffered on the pod and catches up next start.');
    }
  } else {
    console.log(`no service integration for platform "${process.platform}". Run it yourself with:`);
    console.log(`  AP_HOME=${HOME} AP_PORT=${PORT} ${process.execPath} ${runAgentPath}`);
  }
} else if (cmd === 'status') {
  try {
    const res = await fetch(`http://localhost:${PORT}/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else if (['members', 'announced', 'pending', 'mute', 'unmute', 'eject', 'retract',
  'approve', 'decline', 'review'].includes(cmd)) {
  // Group operator commands, served by the running agent's admin API.
  const GETS = ['members', 'announced', 'pending'];
  const BY_ACTOR = ['mute', 'unmute', 'eject'];
  const BY_NOTE = ['retract', 'approve', 'decline'];
  const post = !GETS.includes(cmd);
  const arg = post ? (flag('actor') || flag('note') || args[1]) : null;
  if (post && cmd !== 'review' && !arg) {
    console.error(`usage: activitypod ${cmd} <${BY_ACTOR.includes(cmd) ? 'actor' : 'note'}-url>`);
    process.exit(2);
  }
  if (cmd === 'review' && !['on', 'off'].includes(arg)) {
    console.error('usage: activitypod review <on|off>');
    process.exit(2);
  }
  const payload = cmd === 'review' ? { on: arg === 'on' }
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
    console.log('\nstop carrying someone: activitypod mute <actor-url>   (undo: unmute)');
    console.log('remove them entirely:  activitypod eject <actor-url>');
  } else if (cmd === 'announced') {
    if (!body.announced.length) console.log('nothing carried yet');
    for (const a of body.announced) console.log(`${a.announcedAt}  ${a.actor}  ${a.noteId}`);
    console.log('\nunsay one: activitypod retract <note-url>');
  } else if (cmd === 'pending') {
    console.log(`review is ${body.review ? 'ON' : 'off'}`);
    if (!body.pending.length) console.log('nothing held');
    for (const q of body.pending) console.log(`${q.at}  ${q.actor}  ${q.noteId}`);
    if (body.pending.length) console.log('\nactivitypod approve <note-url>   (or decline)');
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
} else {
  console.log('usage: activitypod <setup|start|stop|status|passwd|tokens|revoke-credential|install-service'
    + '> [--flags]');
  console.log('  group: members | eject <actor> | mute <actor> | unmute <actor>');
  console.log('         announced | retract <note> | review <on|off> | pending | approve <note> | decline <note>');
  process.exit(cmd ? 2 : 0);
}
