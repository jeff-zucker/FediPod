// service.mjs — the machine's service manager and the update: update,
// install-service, uninstall-service.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { identityHomes } from '../../home.mjs';
import { portFree } from '../../ports.mjs';
import { localFetch } from '../../../client/localapi.mjs';
import { cmd, has, AP_ROOT, HOME, agentOn } from '../context.mjs';

export async function update() {
// Pull the latest published FediPod into this checkout and restart the
// agents — what re-running the installer does, as one command.
const { checkLatest, runUpdate, restartAgents } = await import(new URL('../../../../lib/device/update.mjs', import.meta.url));
const u = await checkLatest();
if (u && !u.available) console.log(`already current: ${u.current}`);
const r = runUpdate({ log: console.log });
if (!r.ok) { console.error(r.note); process.exit(1); }
console.log(r.note);
if (restartAgents({ log: console.log }) === 'self') {
  console.log('no managed agents found — restart any running agent to serve the new version');
}
process.exit(0);
}

export async function service() {
const { execFileSync } = await import('node:child_process');
const runAgentPath = new URL('../../../../run-agent.mjs', import.meta.url).pathname;
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
  await localFetch(HOME, port, `/shutdown`, { method: 'POST' }).catch(() => {});
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
}
