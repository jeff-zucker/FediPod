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
//
//   activitypod run       start the agent (UI + API on http://127.0.0.1:8030/)
//   activitypod status    show the running agent's status
//   activitypod passwd    set/change the UI password (REQUIRED before any
//                         non-loopback exposure — it turns the instant
//                         OAuth redirect into a real login form)

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
  const rec = { ...credential, remotePod: pod.endsWith('/') ? pod : pod + '/', ...(root ? { root } : {}) };
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
  process.on('SIGINT', () => { agent.store.flush().finally(() => process.exit(0)); });
  process.on('SIGTERM', () => { agent.store.flush().finally(() => process.exit(0)); });
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`agent running — opening ${url} (log in with instance 127.0.0.1:${PORT})`);
  openBrowser(url);
} else if (cmd === 'run') {
  const { startAgent } = await import(new URL('../run-agent.mjs', import.meta.url));
  await startAgent({ home: HOME, port: PORT });
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
} else if (cmd === 'status') {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message})`);
    process.exit(1);
  }
} else {
  console.log('usage: activitypod <setup|run|status> [--flags]  (see file header)');
  process.exit(cmd ? 2 : 0);
}
