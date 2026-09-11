// account.mjs — the account over its life, through the running agent's
// admin API: park, revive, retire, gateway, describe, alias, import, rebuild,
// the group operator's verbs, archive, bsky.

import fs from 'node:fs';
import path from 'node:path';
import { localFetch } from '../../../client/localapi.mjs';
import { args, cmd, flag, has, HOME, PORT, requireIdentity, ask, endAsking, finish } from '../context.mjs';

export async function parkRevive() {
// Park is quiesce plus a snapshot of the follow graph, because unfollowing is
// what stops the traffic and also what destroys the record needed to come back.
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
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
}

export async function retire() {
// Without this an abandoned pod accepts fediverse deliveries forever into a
// container nobody will ever drain, and no remote server can tell.
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { resolveHandle } = await import(new URL('../../../../lib/core/social.mjs', import.meta.url));
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
}

export async function gateway() {
// Attach this identity to a gateway ('front' kept as an alias). Shapes:
//   fedipod gateway --attach <origin> [--name N] [--fronted]  ask the gateway
//     itself: the agent proves the pod with its own credential and stores
//     the door + secret the gateway answers with.
//   fedipod gateway <.../ap/inbox/> --secret S --inbox-only   paste-in form:
//     identity stays on the pod; only the advertised inbox moves to the
//     gateway's door. Leaving is one republish with the pod inbox.
//   fedipod gateway <.../ap/actor> --secret S                 fronted identity
//   fedipod gateway --detach                                  back to the pod inbox
requireIdentity();
if (has('attach')) {
  const front = flag('attach');
  if (!/^https?:\/\/\S+$/.test(String(front || ''))) {
    console.error('usage: fedipod gateway --attach <https://gateway-origin> [--name yourname] [--fronted]');
    process.exit(2);
  }
  try {
    const res = await localFetch(HOME, PORT, `/gateway`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'attach', front,
        ...(flag('name') ? { handle: flag('name') } : {}),
        ...(has('fronted') ? { fronted: true } : {}) }),
    });
    const body = await res.json();
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    if (body.frontActor) {
      console.log(`attached — this identity now publishes as ${body.address || body.frontActor}`);
      console.log('The agent is restarting itself to publish under the front.');
    } else {
      console.log(`attached — your mail now arrives through ${body.url}, filtered; your name has not moved.`);
      console.log('Starting in shadow: the door filters, and the agent measures how much');
      console.log('verifies before it believes any receipt. Move to trust when you are ready.');
    }
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message}) — start it, then attach`);
    process.exit(1);
  }
  process.exit(0);
}
if (has('detach')) {
  try {
    const res = await localFetch(HOME, PORT, `/gateway`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'forget' }),
    });
    const body = await res.json();
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    console.log('detached — the actor was republished advertising your pod\'s own inbox');
  } catch (e) {
    console.error(`agent not reachable on :${PORT} (${e.message}) — start it, then detach`);
    process.exit(1);
  }
  process.exit(0);
}
const target = args[1];
const secret = flag('secret');
const inboxOnly = has('inbox-only');
const okActor = /^https:\/\/\S+\/ap\/actor$/.test(String(target || ''));
const okInbox = /^https:\/\/\S+\/ap\/inbox\/?$/.test(String(target || ''));
if (inboxOnly ? !okInbox : !okActor) {
  console.error(inboxOnly
    ? 'usage: fedipod gateway <https://host/u/<name>/ap/inbox/> --secret <hmac> --inbox-only'
    : 'usage: fedipod gateway <https://host/u/<name>/ap/actor> --secret <hmac> [--inbox-only]');
  console.error('  (the URL and secret come from the gateway\'s signup page)');
  process.exit(2);
}
const { Agent } = await import(new URL('../../../../run-agent.mjs', import.meta.url));
const { RemotePod } = await import(new URL('../../../../lib/device/remote.mjs', import.meta.url));
const { apUrls } = await import(new URL('../../../../lib/core/wire.mjs', import.meta.url));
const agent = new Agent({ home: HOME, log: () => {} });
const cred = agent.readCredential();
if (!cred) { console.error('no credential — run setup first'); process.exit(2); }
agent.remote = new RemotePod(cred);
await agent.remote.warmup();
agent.urls = apUrls(cred.remotePod, cred.root);
agent.store.attach(agent.privateStorage(cred, 'state'));
await agent.store.load();
const config = agent.store.getConfig();
if (!config) { console.error('pod state empty — run setup first'); process.exit(2); }
if (config.gateway?.frontActor && (inboxOnly || config.gateway.frontActor !== target)) {
  console.error(`this identity already fronts through ${config.gateway.frontActor}.`);
  console.error('Changing a published front renames every id — that is a move, not an edit. Detach first if you mean it.');
  process.exit(2);
}
const gateway = inboxOnly
  ? { ...(config.gateway || {}), url: target.replace(/\/?$/, '/'), mode: 'shadow',
      ...(secret ? { hmacSecret: secret } : {}) }
  : { ...(config.gateway || {}), url: target.replace(/ap\/actor$/, 'ap/inbox/'),
      frontActor: target, mode: 'shadow', ...(secret ? { hmacSecret: secret } : {}) };
agent.store.setConfig({ ...config, gateway });
await agent.store.flush();
if (inboxOnly) {
  console.log('attached to the shared filter — your identity stays on your pod;');
  console.log(`the actor will advertise ${gateway.url} as its inbox.`);
  console.log('Starting in shadow: the door filters, and the agent measures how much');
  console.log('verifies before it believes any receipt. Move to trust when you are ready.');
} else {
  console.log(`attached to the front — this identity now publishes as ${target}`);
}
console.log('Restart the agent (or `fedipod up`) to republish the actor.');
if (!secret) console.log('No --secret given: pass the front\'s receipt secret to trust its verification.');
}

export async function describe() {
// The bio and the avatar. Both live in the actor document, so this republishes.
if (!flag('summary') && !flag('icon')) {
  console.error('usage: fedipod describe --summary "what this is" --icon <url>');
  process.exit(2);
}
const payload = {};
if (flag('summary') !== undefined) payload.summary = flag('summary');
if (flag('icon') !== undefined) payload.icon = flag('icon');
try {
  const res = await localFetch(HOME, PORT, `/describe`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
  console.log(`described and republished — summary: ${body.summary ? '"' + body.summary + '"' : '(none)'}, icon: ${body.icon || '(none)'}`);
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}

export async function alias() {
// The migration landing pad: old accounts listed in alsoKnownAs, which their
// servers check before sending a Move here. Served by the running agent
// because adding one resolves the old account and republishes the actor.
requireIdentity();
try {
  if (flag('add')) {
    const res = await localFetch(HOME, PORT, `/alias`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ add: flag('add') }),
    });
    const body = await res.json();
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    console.log('alias added and the actor republished — aliases now:');
    for (const a of body.aliases) console.log(`  ${a}`);
    console.log('on the old server, Account → Move to a different account will now accept this one');
  } else if (flag('remove')) {
    const res = await localFetch(HOME, PORT, `/alias`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remove: flag('remove'), ...(has('yes') ? { confirm: true } : {}) }),
    });
    const body = await res.json();
    if (res.status === 409) { console.error(body.error); console.error('add --yes to remove it anyway'); process.exit(1); }
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    console.log(body.aliases.length ? 'removed — aliases now:' : 'removed — no aliases left');
    for (const a of body.aliases) console.log(`  ${a}`);
  } else {
    const res = await localFetch(HOME, PORT, `/config`);
    const body = await res.json();
    if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
    const aliases = body.aliases || [];
    if (!aliases.length) console.log('no aliases — fedipod alias --add @you@old.server');
    for (const a of aliases) console.log(a);
  }
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}

export async function importCmd() {
// The CSV exports the old account's server hands its leaver, staged with the
// running agent and applied by its paced worker. File names tell the kinds —
// the names Mastodon's export uses, which the rest of the family copies.
requireIdentity();
const NOVAL = new Set(['--clear', '--status']);
const files = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) { if (!NOVAL.has(a)) i++; continue; }
  files.push(a);
}
const jpost = (body) => localFetch(HOME, PORT, `/import`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const jget = () => localFetch(HOME, PORT, `/import`)
  .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
const showProgress = (p) => {
  const parts = Object.entries(p.byKind || {}).map(([k, c]) =>
    `${k} ${c.done}/${c.done + c.pending + c.failed}${c.failed ? ` (${c.failed} failed)` : ''}`);
  console.log(parts.join(', ') || 'nothing staged');
};
const kindOf = (file) => {
  const b = path.basename(file).toLowerCase();
  if (b.includes('following')) return 'follow';
  if (b.includes('domain')) return 'domain';
  if (b.includes('block')) return 'block';
  if (b.includes('mute')) return 'mute';
  if (b.includes('list')) return 'list';
  if (b.includes('bookmark')) return 'bookmark';
  return null;
};
try {
  if (has('clear')) {
    const r = await jpost({ clear: true });
    if (r.status >= 400) { console.error(r.json?.error || `HTTP ${r.status}`); process.exit(1); }
    console.log('import record cleared');
  } else if (!files.length) {
    const r = await jget();
    if (r.status >= 400) { console.error(r.json?.error || `HTTP ${r.status}`); process.exit(1); }
    if (!r.json.rows) {
      console.log('nothing imported yet — usage: fedipod import <csv-file…> [--kind follow|block|mute|list|domain]');
    } else {
      showProgress(r.json);
      for (const f of r.json.failures || []) console.log(`  failed ${f.kind} ${f.value}: ${f.reason}`);
    }
  } else {
    for (const file of files) {
      const kind = flag('kind') || kindOf(file);
      if (kind === 'bookmark') { console.log(`${file}: bookmarks are not imported — skipped`); continue; }
      if (!['follow', 'block', 'mute', 'list', 'domain'].includes(kind)) {
        console.error(`${file}: cannot tell what this is from its name — pass --kind follow|block|mute|list|domain`);
        process.exit(2);
      }
      let text;
      try { text = fs.readFileSync(file, 'utf8'); }
      catch (e) { console.error(`${file}: ${e.message}`); process.exit(2); }
      // Stay under the agent's request cap, splitting on line boundaries —
      // but never inside a quoted field, where a newline is field content:
      // a boundary is only taken while the quotes seen so far are balanced.
      const chunks = [];
      let chunk = [], size = 0, quotes = 0;
      for (const line of text.split('\n')) {
        if (size + line.length > 800_000 && chunk.length && quotes % 2 === 0) {
          chunks.push(chunk.join('\n')); chunk = []; size = 0;
        }
        chunk.push(line);
        size += line.length + 1;
        quotes += (line.match(/"/g) || []).length;
      }
      if (chunk.length) chunks.push(chunk.join('\n'));
      let staged = 0, duplicate = 0, already = 0, invalid = 0;
      for (const c of chunks) {
        const r = await jpost({ kind, text: c });
        if (r.status >= 400) { console.error(`${file}: ${r.json?.error || `HTTP ${r.status}`}`); process.exit(1); }
        staged += r.json.staged; duplicate += r.json.duplicate;
        already += r.json.already; invalid += r.json.invalid;
      }
      console.log(`${file}: staged ${staged} ${kind} row(s)`
        + (already ? `, ${already} already applied` : '')
        + (duplicate ? `, ${duplicate} already staged` : '')
        + (invalid ? `, ${invalid} unreadable` : ''));
    }
    // Watch it run. The worker paces itself, so a big list takes a while;
    // ctrl-c leaves it running and `fedipod import` shows where it is.
    let last = '';
    for (;;) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await jget();
      if (r.status >= 400) break;
      const p = r.json;
      const line = `applied ${p.done} of ${p.rows}${p.failed ? ` (${p.failed} failed)` : ''}`;
      if (line !== last) { console.log(line); last = line; }
      if (!p.pending) {
        for (const f of (p.failures || []).slice(0, 20)) console.log(`  failed ${f.kind} ${f.value}: ${f.reason}`);
        if ((p.failures || []).length > 20) {
          console.log(`  … and ${p.failures.length - 20} more — \`fedipod import\` lists them`);
        }
        break;
      }
    }
  }
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}

export async function rebuild() {
requireIdentity();
// Served by the running agent because it needs the lease: it writes the
// statuses store, and two agents writing it is the thing the lease prevents.
try {
  const res = await localFetch(HOME, PORT, `/rebuild`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromNotes: has('from-notes') }),
  });
  const body = await res.json();
  if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
  if (body.why) { console.error(body.why); process.exit(1); }
  console.log(`the pod indexed ${body.indexed} post(s); recovered ${body.recovered}`
    + `${body.reblogs ? `, and marked ${body.reblogs} of them boosted` : ''}`);
  if (body.dropped) console.log(`${body.dropped} fell past the 1000-status cap`);
  if (!body.landed) { console.error('the state write did NOT land — nothing is saved'); process.exit(1); }
  if (!body.recovered && !has('from-notes')) {
    console.log('Nothing was missing. `--from-notes` looks past the outbox, at every note the pod still holds.');
  }
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}

export async function group() {
// Group operator commands, served by the running agent's admin API.
const GETS = ['members', 'announced', 'pending', 'requests', 'modqueue'];
const BY_ACTOR = ['mute', 'unmute', 'eject', 'admit', 'refuse'];
const TOGGLES = { review: ['on', 'off'], joins: ['open', 'approve'] };
const post = !GETS.includes(cmd);
const admitAll = cmd === 'admit' && has('all');
const modAct = cmd === 'modqueue' ? (flag('apply') || flag('dismiss') || null) : null;
const modVerb = cmd === 'modqueue' && flag('dismiss') ? 'dismiss' : 'apply';
const arg = post ? (flag('actor') || flag('note') || args[1]) : null;
if (post && !TOGGLES[cmd] && !arg && !admitAll) {
  console.error(`usage: fedipod ${cmd} <${BY_ACTOR.includes(cmd) ? 'actor' : 'note'}-url>`
    + (cmd === 'admit' ? '   (or: fedipod admit --all)' : ''));
  process.exit(2);
}
if (TOGGLES[cmd] && !TOGGLES[cmd].includes(arg)) {
  console.error(`usage: fedipod ${cmd} <${TOGGLES[cmd].join('|')}>`);
  process.exit(2);
}
const payload = modAct ? { id: modAct, action: modVerb }
  : cmd === 'review' ? { on: arg === 'on' }
  : cmd === 'joins' ? { approve: arg === 'approve' }
  : admitAll ? { all: true }
  : BY_ACTOR.includes(cmd) ? { actor: arg } : { noteId: arg };
let body;
try {
  const asPost = post || !!modAct;
  const res = await localFetch(HOME, PORT, `/${cmd}`, asPost
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
if (cmd === 'modqueue' && modAct) {
  console.log(`${body.action === 'apply' ? 'applied' : 'dismissed'}: ${body.type} from ${body.moderator}`);
  console.log(`${body.remaining} left in the queue`);
} else if (cmd === 'modqueue') {
  // Moderation asked for over federation. A delivery does not prove who sent
  // it, so a moderator's request waits here instead of acting on arrival.
  const q = Array.isArray(body) ? body : (body.queue || []);
  if (!q.length) console.log('nothing waiting — no moderator has asked for anything');
  for (const e of q) console.log(`${e.id}  ${e.at}  ${e.type}  from ${e.moderator}`);
  if (q.length) {
    console.log('\ncarry one out: fedipod modqueue --apply <id>');
    console.log('turn one down: fedipod modqueue --dismiss <id>');
  }
} else if (cmd === 'members') {
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
  if (admitAll) console.log(`admitted ${body.admitted} — ${body.requests} still waiting`);
  else console.log(`${cmd === 'admit' ? 'admitted' : 'refused'} ${arg} — ${body.requests} still waiting`);
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
}

export async function archive() {
// Whether drained mail's original bytes are kept in the private half's
// inbox-archive/. On by default; served by the running agent.
requireIdentity();
if (!['on', 'off'].includes(args[1])) {
  console.error('usage: fedipod archive <on|off>');
  process.exit(2);
}
try {
  const res = await localFetch(HOME, PORT, `/archive`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on: args[1] === 'on' }),
  });
  const body = await res.json();
  if (res.status >= 400) { console.error(body.error || `HTTP ${res.status}`); process.exit(1); }
  console.log(body.archiveInbox
    ? 'inbox archive is on — drained mail keeps its original bytes in the private half'
    : 'inbox archive is off — drained mail leaves no copy behind');
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}

export async function bsky() {
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
    const res = await localFetch(HOME, PORT, `/atproto/connect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, appPassword, service: flag('service') }),
    });
    out = await res.json();
    if (res.status >= 400) { console.error(out.error || `HTTP ${res.status}`); process.exit(1); }
    console.log(`connected: @${out.handle} on ${out.service}`);
    console.log('public posts will cross-post; turn off: fedipod bsky crosspost off');
  } else if (sub === 'disconnect') {
    const res = await localFetch(HOME, PORT, `/atproto/disconnect`, {
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
    const res = await localFetch(HOME, PORT, `/atproto`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ crossPost: args[2] === 'on' }),
    });
    out = await res.json();
    if (res.status >= 400) { console.error(out.error || `HTTP ${res.status}`); process.exit(1); }
    console.log(`cross-posting is ${out.atproto.crossPost ? 'on' : 'off'}`);
  } else {
    const res = await localFetch(HOME, PORT, `/status`);
    out = await res.json();
    const a = out.atproto;
    if (!a?.connected) console.log('no bluesky account connected — fedipod bsky connect <handle> <app-password>');
    else console.log(`@${a.handle} (${a.did}) on ${a.service}${a.lastError ? `\nlast error: ${a.lastError}` : ''}`);
  }
} catch (e) {
  console.error(`agent not reachable on :${PORT} (${e.message})`);
  process.exit(1);
}
}
