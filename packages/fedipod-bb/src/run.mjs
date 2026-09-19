// run.mjs — running a forum on this machine, however it was started: by
// `fedipod-bb start`, or by the agent runner when the home it was pointed at
// turns out to hold a forum rather than a person. One loop, so a forum in a
// profile behaves exactly like one started by hand.

import fs from 'node:fs';
import { ForumAgent } from './forum-agent.mjs';
import { startConsole, DEFAULT_CONSOLE_PORT } from './console.mjs';

export async function runForum({ home, port = DEFAULT_CONSOLE_PORT, console: wantConsole = true,
  log = (...a) => console.log('[bb]', ...a) } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // The last of what it said, for the console to show: a forum runs unattended
  // and the question is always what it has been doing.
  const said = [];
  const keep = (line) => { said.push(line); if (said.length > 200) said.shift(); };
  const agent = new ForumAgent({ home, log: (...a) => { keep(`${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`); log(...a); } });

  let up = false;
  for (let attempt = 1; !up; attempt++) {
    try {
      up = await agent.connect();
      if (!up) { log('nothing to host — run init first'); return null; }
    } catch (e) {
      // The attempt that just died may have taken the lease on its way in.
      // Give it back, or the next attempt finds the forum held by a process
      // that is this one, and waits five minutes to be told it may act. The
      // release is a pod write too, and a pod that refused the start is
      // usually still refusing: try it until it takes.
      for (let i = 0; i < 4; i++) {
        try { await agent.lease?.release(); break; } catch { await new Promise(r => { setTimeout(r, 8000); }); }
      }
      const wait = Math.min(15 * attempt, 120);
      log(`start failed (${e.message}) — trying again in ${wait}s`);
      await new Promise(r => { setTimeout(r, wait * 1000); });
    }
  }

  let window_ = null;
  if (wantConsole) {
    try { window_ = startConsole({ agent, home, port, log, lines: () => said.slice(-60) }); }
    catch (e) { log(`console: not started (${e.message})`); }
  }
  // Every timer in the agent is unreferenced (the DeviceAgent's web server is
  // what holds that process open); here nothing else would, and the host
  // exited quietly once the push socket went idle. This holds it.
  const hold = setInterval(() => {}, 1 << 30);
  const shutdown = () => {
    clearInterval(hold);
    window_?.stop();
    agent.stop().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return agent;
}

// Whether a home holds a forum rather than a person or a group. The credential
// names the root its documents live under, and a forum's is its own.
export function isForumHome(home) {
  try {
    const cred = JSON.parse(fs.readFileSync(`${home.replace(/\/$/u, '')}/credential.json`, 'utf8'));
    return typeof cred.root === 'string' && cred.root.replace(/\/$/u, '') === 'fedipod-bb';
  } catch { return false; }
}
