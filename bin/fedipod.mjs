#!/usr/bin/env node
// fedipod.mjs — CLI for the standalone pod-stored ActivityPub actor.
//
//   fedipod start
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
//   fedipod start     start the agent (UI + API on https://localhost:8030/
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


import { cmd } from '../lib/device/cli/context.mjs';
import * as run from '../lib/device/cli/commands/run.mjs';
import * as setup from '../lib/device/cli/commands/setup.mjs';
import * as state from '../lib/device/cli/commands/state.mjs';
import * as service from '../lib/device/cli/commands/service.mjs';
import * as account from '../lib/device/cli/commands/account.mjs';

const COMMANDS = new Map([
  ['up', run.up], ['start', run.start], ['run', run.start], ['stop', run.stop], ['status', run.status],
  ['https', run.https],
  ['setup', setup.setup], ['rotate-key', setup.rotateKey], ['revoke-credential', setup.revokeCredential],
  ['tokens', setup.tokens], ['passwd', setup.passwd], ['keys', setup.keys],
  ['state', state.state], ['upgrade', state.upgrade], ['profiles', state.profiles], ['home', state.home],
  ['export', state.exportCollectionsCmd],
  ['update', service.update], ['install-service', service.service], ['uninstall-service', service.service],
  ['park', account.parkRevive], ['revive', account.parkRevive], ['retire', account.retire],
  ['gateway', account.gateway], ['front', account.gateway], ['describe', account.describe],
  ['alias', account.alias], ['import', account.importCmd], ['rebuild', account.rebuild],
  ['archive', account.archive], ['bsky', account.bsky],
  ...['members', 'announced', 'pending', 'requests', 'mute', 'unmute', 'eject', 'retract', 'approve', 'decline',
    'review', 'joins', 'admit', 'refuse', 'modqueue'].map((c) => [c, account.group]),
]);

const command = COMMANDS.get(cmd);
if (command) {
  await command();
} else {
console.log('usage: fedipod <setup|start|stop|status|state|upgrade|rebuild|home|passwd'
  + '|tokens|revoke-credential|install-service|archive|alias|import|keys|front> [--flags]');
console.log('  keys: where the signing key lives; --to pod|local moves it (pod = multi-device signing)');
console.log('  https: the local certificate agents serve TLS with; --trust mints a local CA for strict clients');
console.log('  gateway: attach to a gateway; --inbox-only keeps your identity and moves only the inbox;');
console.log('           --detach returns delivery to your pod (\'front\' still works as an alias)');
console.log('  alias: --add <@you@old.server|url> | --remove <url> [--yes]   migration aliases (alsoKnownAs)');
console.log('  import: <csv-file…> from the old account\'s export (follows, blocks, mutes, lists,');
console.log('          domain blocks); no files = progress; --clear drops the record');
console.log('  state: --to <path|url|pod>   move THIS identity\'s private half');
console.log('         --all [--apply]       move every identity\'s onto this machine');
console.log('         --drop-remote [--apply]  remove the pod\'s copy afterwards');
console.log('  upgrade: what every identity here is behind on, and stamp the ones that are not');
console.log('  bsky: connect <handle> <app-password> | disconnect | crosspost <on|off> | status');
console.log('  group: members | eject <actor> | mute <actor> | unmute <actor>');
console.log('         joins <open|approve> | requests | admit <actor> | refuse <actor>');
console.log('         announced | retract <note> | review <on|off> | pending | approve <note> | decline <note>');
console.log('         modqueue | modqueue --apply <id> | modqueue --dismiss <id>');
process.exit(cmd ? 2 : 0);
}
