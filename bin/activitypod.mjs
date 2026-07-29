#!/usr/bin/env node
// activitypod.mjs — CLI for the standalone pod-stored ActivityPub actor.
//
//   activitypod setup --new-account --email you@example.org --handle you \
//       [--issuer https://solidcommunity.net] [--name "You"] [--home DIR]
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
//     --keys local keeps the signing key in AP_HOME instead of pod state
//     (the pod host cannot read it; the key file must then travel with the
//     credential if you move machines).
//
//   activitypod run       start the agent (UI + API on http://localhost:8030/)
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
const HOME = flag('home', process.env.AP_HOME || path.join(os.homedir(), '.activitypod'));
const PORT = Number(flag('port', process.env.AP_PORT || 8030));

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (c) => { if (String(c) !== '\n' && String(c) !== '\r') readline.moveCursor(process.stdout, -1, 0), process.stdout.write('*'); };
    process.stdin.on('data', onData);
    rl.question(prompt, (answer) => { process.stdin.off('data', onData); rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort — the URL is printed anyway */ }
}

if (cmd === 'setup') {
  const issuer = flag('issuer', 'https://solidcommunity.net');
  const email = flag('email');
  const handle = flag('handle');
  const name = flag('name');
  const root = flag('root');
  let pod = flag('pod');
  if (!email || !handle || (!pod && !has('new-account'))) {
    console.error('need --email and --handle, plus either --pod <url> or --new-account');
    process.exit(2);
  }
  const password = process.env.AP_PASSWORD || await askHidden(`password for ${email} at ${issuer}: `);

  if (has('new-account')) {
    const { createAccountWithPod } = await import(new URL('../lib/account.mjs', import.meta.url));
    const made = await createAccountWithPod({ issuer, email, password, podName: flag('pod-name', handle) });
    pod = made.pod;
    console.log(`account + pod created: ${pod}`);
  }

  const { mintCredential } = await import(new URL('../lib/remote.mjs', import.meta.url));
  const credential = await mintCredential({ origin: issuer, email, password, name: 'activitypod-js' });
  const rec = {
    ...credential,
    remotePod: pod.endsWith('/') ? pod : pod + '/',
    ...(root ? { root } : {}),
    ...(flag('keys') === 'local' ? { keysLocal: true } : {}),
  };
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(HOME, 'credential.json'), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  console.log(`credential minted and saved to ${path.join(HOME, 'credential.json')}`);

  const { Agent } = await import(new URL('../run-agent.mjs', import.meta.url));
  const agent = new Agent({ home: HOME, log: (...a) => console.log('[setup]', ...a) });
  await agent.bootstrap({ handle, name, root });
  await agent.connect();
  await agent.publisher.publishProfile();
  await agent.store.flush();
  console.log(`actor published: @${handle}@${new URL(rec.remotePod).host}`);

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
  console.log(`agent running — opening ${url} (log in with instance localhost:${PORT})`);
  openBrowser(url);
} else if (cmd === 'run') {
  const { startAgent } = await import(new URL('../run-agent.mjs', import.meta.url));
  await startAgent({ home: HOME, port: PORT });
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
    console.error(`no pidfile at ${pidFile} — if an agent is running anyway, stop it with:`);
    console.error(`  pkill -f 'activitypod.mjs run'   (or: systemctl --user stop activitypod for a service install)`);
    process.exit(1);
  }
  try { process.kill(pid, 'SIGTERM'); } catch { console.log('agent was not running (stale pidfile)'); fs.rmSync(pidFile, { force: true }); process.exit(0); }
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
RestartSec=10

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
</dict></plist>
`);
      sh('launchctl', ['load', plist]);
      console.log('installed and loaded (starts at login)');
    }
  } else {
    console.log('Windows: create a Scheduled Task running:');
    console.log(`  ${process.execPath} ${runAgentPath}`);
    console.log(`with AP_HOME=${HOME} AP_PORT=${PORT}, trigger "At log on".`);
  }
} else if (cmd === 'status') {
  try {
    const res = await fetch(`http://localhost:${PORT}/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else {
  console.log('usage: activitypod <setup|run|status> [--flags]  (see file header)');
  process.exit(cmd ? 2 : 0);
}
