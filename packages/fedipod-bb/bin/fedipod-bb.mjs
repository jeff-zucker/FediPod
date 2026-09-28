#!/usr/bin/env node
// fedipod-bb.mjs — run a forum from this machine.
//
//   fedipod-bb credential --home DIR --email you@example.org --pod https://forum.example/ [--issuer URL]
//     Mint the forum's pod credential at the pod's server (the password is
//     asked at the terminal) and save it as DIR/credential.json.
//   fedipod-bb init --home DIR --handle forum --name "The Forum" \
//       [--moderator-webid https://you.example/profile/card#me] \
//       --category gardening:Gardening --category compost:Compost [--moderator <actor>]
//     Writes the forum's config and containers to the pod; publishes nothing yet.
//   fedipod-bb start --home DIR
//     Host the forum from here. Publishes every actor on first start, then
//     drains the forum's inbox, places posts in topics and carries them.
//     Several moderators may run this on their own machines; one acts, the
//     others watch and take over when it stops.
//   fedipod-bb status --home DIR
//     What the forum's state says, without hosting.
//   fedipod-bb attach --home DIR --front https://fedipod.net
//     Take addresses at a Gateway: @<handle>@<front> for the forum and one
//     per category. Deliveries arrive verified at the front and are written
//     into the forum's inbox; every actor is republished with its front ids
//     on the next start.
//   fedipod-bb keep --home DIR --front https://fedipod.net
//     Let that Gateway run the forum when nothing else does: the pod's rules
//     name its keeper from here on, and it places posts as they land. `unkeep`
//     takes the name out again.

import fs from 'node:fs';
import path from 'node:path';
import { ForumAgent } from '../src/forum-agent.mjs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const flags = (name) => args.flatMap((a, i) => (a === '--' + name && args[i + 1] ? [args[i + 1]] : []));
const home = flag('home') || process.env.FEDIPOD_BB_HOME;
if (!home) { console.error('--home DIR is required'); process.exit(2); }

const logFile = path.join(home, 'forum.log');
const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log('[bb]', ...a);
  try { fs.appendFileSync(logFile, line + '\n'); } catch { /* logging never throws */ }
};

// --reply-policy open|review, checked here so a typo does not quietly become
// the strictest reading of it.
const replyPolicy = () => {
  const said = String(flag('reply-policy') || '').toLowerCase();
  if (said !== 'open' && said !== 'review') {
    console.error('--reply-policy takes open or review');
    process.exit(2);
  }
  return said;
};

if (cmd === 'credential') {
  const email = flag('email');
  const pod = flag('pod');
  if (!email || !pod) { console.error('--email and --pod are required'); process.exit(2); }
  const { mintForumCredential } = await import('../src/credential.mjs');
  try {
    const file = await mintForumCredential({ email, pod, home, issuer: flag('issuer'), root: flag('root') || 'fedipod-bb/' });
    console.log(`credential minted and saved to ${file}`);
  } catch (e) { console.error(e.message); process.exit(1); }
} else if (cmd === 'init') {
  const handle = flag('handle');
  if (!handle) { console.error('--handle is required'); process.exit(2); }
  const categories = flags('category').map(c => {
    const [slug, name] = c.split(':');
    return { slug, name: name || slug };
  });
  const agent = new ForumAgent({ home, log });
  const cfg = await agent.init({
    handle, name: flag('name') || handle, categories, moderators: flags('moderator'),
    // A moderator's WebID, so the pod itself can let them read the queue;
    // their actor id is what the wire uses and cannot be granted access.
    moderatorWebIds: flags('moderator-webid'),
    // A members-only category, and who may read it: --members-only <slug>
    // and --member <slug>:<webid>. Only a WebID can be named; a follower
    // from Mastodon has none, and serving them is the Server build's job.
    membersOnly: flags('members-only'),
    memberWebIds: flags('member').reduce((m, v) => {
      const at = v.indexOf(':');
      if (at < 1) return m;
      const slug = v.slice(0, at);
      (m[slug] ||= []).push(v.slice(at + 1));
      return m;
    }, {}),
    approveJoins: args.includes('--approve-joins'), review: args.includes('--review'),
    // What becomes of a post from somebody who has not joined: `open` takes
    // the post as the joining, `review` holds it for a moderator. A private
    // category holds it whatever this says.
    ...(flag('reply-policy') ? { replyPolicy: replyPolicy() } : {}),
  });
  console.log(JSON.stringify(cfg, null, 2));
} else if (cmd === 'start') {
  const { runForum } = await import('../src/run.mjs');
  const agent = await runForum({ home, log });
  if (!agent) process.exit(1);
} else if (cmd === 'attach') {
  const front = flag('front');
  if (!front) { console.error('--front <https://gateway-origin> is required'); process.exit(2); }
  const agent = new ForumAgent({ home, log });
  if (!await agent.connect({ act: false })) { console.error('nothing to attach — run init first'); process.exit(1); }
  const r = await agent.attach({ front });
  console.log(`attached at ${r.front}: ${r.handles.map(h => '@' + h).join(', ')} — start the forum to publish its new addresses`);
  process.exit(0);
} else if (cmd === 'keep' || cmd === 'unkeep') {
  const front = flag('front');
  if (!front) { console.error('--front <https://gateway-origin> is required'); process.exit(2); }
  const agent = new ForumAgent({ home, log });
  if (!await agent.connect({ act: false })) { console.error('nothing to keep — run init first'); process.exit(1); }
  const r = await agent.keep({ front, on: cmd === 'keep' });
  console.log(cmd === 'keep'
    ? `${front} keeps this forum (${r.handles.map(h => '@' + h).join(', ')}) as ${r.keeper}`
    : `${front} no longer keeps this forum`);
  process.exit(0);
} else if (cmd === 'status') {
  const agent = new ForumAgent({ home, log: () => {} });
  const up = await agent.connect({ act: false });
  console.log(JSON.stringify(up ? agent.status() : { mode: 'unconfigured' }, null, 2));
  process.exit(0);
} else {
  console.log('usage: fedipod-bb <credential|init|start|status|attach|keep|unkeep> --home DIR [--email E --pod URL | --handle H --name N --category slug:Name … --reply-policy open|review | --front URL]');
  process.exit(2);
}
