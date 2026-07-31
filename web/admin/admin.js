// admin.js — the record, as a page. Everything here is an existing admin
// route; the CLI's own group commands are thin clients over the same ones.
//
// Two rules the routes enforce and this page respects: a write is a MERGE, so
// a form that never mentions the UI password cannot delete it; and anything on
// the wire is not real until the actor is republished, which POST /config does
// for itself.

const $ = (id) => document.getElementById(id);
const api = async (path, init) => {
  const res = await fetch(path, init);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const postJson = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

let config = null;

function say(text, cls = 'ok') {
  const el = $('say');
  el.hidden = false;
  el.className = cls;
  el.textContent = text;
}

// Every write goes through here, so nothing silently half-succeeds.
async function write(path, body, done) {
  const { status, json } = await postJson(path, body);
  if (status >= 400) { say(json?.error || `refused (HTTP ${status})`, 'err'); return null; }
  say(done);
  return json;
}

async function load() {
  const { status, json } = await api('/config');
  if (status === 409) {
    $('strap').textContent = 'not set up yet';
    $('fatal').hidden = false;
    $('fatal').textContent = 'This agent has no identity yet.';
    const a = document.createElement('a');
    a.href = '/admin/setup/';
    a.textContent = ' Set it up.';
    $('fatal').appendChild(a);
    return;
  }
  if (status !== 200 || !json) {
    $('fatal').hidden = false;
    $('fatal').textContent = json?.error || `could not read the record (HTTP ${status})`;
    return;
  }
  config = json;
  render();
}

function render() {
  $('strap').textContent = `${config.kind === 'group' ? 'group' : 'actor'} · ${config.mode || 'unknown'}`;
  $('address').textContent = config.address || `@${config.handle} — no resolvable address`;

  const facts = $('facts');
  facts.textContent = '';
  const rows = [
    ['handle', config.handle],
    ['pod', config.remotePod],
    ['identity provider', config.issuer],
    ['WebID', config.webId],
    ['actor', config.actor],
    ['kind', config.kind],
    ['state dir', config.home],
    ['port', String(config.port)],
    ['private data', config.privateRoot || 'on your pod, with everything else'],
  ];
  if (config.quiescedAt) rows.push(['parked since', config.quiescedAt]);
  if (config.movedTo) rows.push(['moved to', config.movedTo]);
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  }
  if (!config.address) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = `${config.remotePod} is not the root of its own host, so this actor cannot be `
      + 'discovered as a handle by other servers. Posting and reading still work.';
    $('pane-identity').appendChild(p);
  }

  $('name').value = config.name || '';
  $('summary').value = config.summary || '';
  $('icon').value = config.icon || '';

  const o = config.origins || {};
  $('origins').textContent = o.named
    ? `This agent answers at ${o.named} and at ${o.loopback}`
    : `This agent answers at ${o.loopback}`;
  $('password-state').textContent = config.hasUiPassword
    ? 'Set. Clients are asked for it before they are authorized.'
    : 'Not set. Any client on this machine is authorized without being asked, which is fine '
      + 'while the agent is reachable only from this machine.';

  for (const id of ['pane-identity', 'pane-profile', 'pane-access', 'pane-upkeep']) $(id).hidden = false;
  renderInbox();
  if (config.kind === 'group') {
    $('pane-group').hidden = false;
    renderGroupToggles();
    refreshGroup();
  }
}

// ---- profile ----

$('profile-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = await write('/config', {
    name: $('name').value.trim(),
    summary: $('summary').value.trim(),
    icon: $('icon').value.trim(),
  }, 'saved and republished');
  if (r) config = { ...config, ...r.config };
});

// ---- access ----

$('access-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!$('password').value) { say('type a password first', 'err'); return; }
  const r = await write('/config', { password: $('password').value }, 'password set');
  if (r) { $('password').value = ''; config.hasUiPassword = true; render(); }
});
$('password-clear').addEventListener('click', async () => {
  const r = await write('/config', { password: '' }, 'password removed');
  if (r) { config.hasUiPassword = false; render(); }
});

// ---- group ----

function renderGroupToggles() {
  $('joins-state').textContent = config.approveJoins
    ? 'Each join request waits for you.'
    : 'Anyone who follows becomes a member at once.';
  $('joins-open').disabled = !config.approveJoins;
  $('joins-approve').disabled = !!config.approveJoins;
  $('review-state').textContent = config.review
    ? 'Members’ posts are held until you approve them.'
    : 'Members’ posts are carried to the group as they arrive.';
  $('review-off').disabled = !config.review;
  $('review-on').disabled = !!config.review;
}

const setJoins = async (approve) => {
  if (await write('/joins', { approve }, approve ? 'join requests will wait' : 'anyone may join')) {
    config.approveJoins = approve;
    renderGroupToggles();
    refreshGroup();
  }
};
const setReview = async (on) => {
  if (await write('/review', { on }, on ? 'posts will be held' : 'posts will be carried at once')) {
    config.review = on;
    renderGroupToggles();
    refreshGroup();
  }
};
$('joins-open').addEventListener('click', () => setJoins(false));
$('joins-approve').addEventListener('click', () => setJoins(true));
$('review-off').addEventListener('click', () => setReview(false));
$('review-on').addEventListener('click', () => setReview(true));

// One row: what it is, then what can be done to it.
function row(text, sub, actions) {
  const li = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = text;
  if (sub) {
    const small = document.createElement('div');
    small.className = 'muted';
    small.textContent = sub;
    span.appendChild(small);
  }
  li.appendChild(span);
  for (const [label, run] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', async () => { b.disabled = true; await run(); refreshGroup(); });
    li.appendChild(b);
  }
  return li;
}

function fill(listId, countId, items, make) {
  const ul = $(listId);
  ul.textContent = '';
  $(countId).textContent = items.length ? `(${items.length})` : '(none)';
  for (const it of items) ul.appendChild(make(it));
}

async function refreshGroup() {
  const [members, requests, pending, announced] = await Promise.all(
    ['/members', '/requests', '/pending', '/announced'].map(p => api(p).then(r => r.json || {})));

  fill('requests', 'requests-count', requests.requests || [], (r) => row(r.actor, r.at, [
    ['Admit', () => write('/admit', { actor: r.actor }, 'admitted')],
    ['Refuse', () => write('/refuse', { actor: r.actor }, 'refused')],
  ]));

  fill('pending', 'pending-count', pending.pending || [], (p) => row(p.noteId, `${p.actor} · ${p.at}`, [
    ['Carry it', () => write('/approve', { noteId: p.noteId }, 'carried')],
    ['Decline', () => write('/decline', { noteId: p.noteId }, 'declined')],
  ]));

  fill('members', 'members-count', members.members || [], (m) => row(
    m.actor, m.muted ? 'muted — their posts are not carried' : null,
    [
      m.muted
        ? ['Unmute', () => write('/unmute', { actor: m.actor }, 'unmuted')]
        : ['Mute', () => write('/mute', { actor: m.actor }, 'muted')],
      ['Eject', () => write('/eject', { actor: m.actor }, 'ejected')],
    ]));

  fill('announced', 'announced-count', announced.announced || [], (a) => row(
    a.noteId, `${a.actor} · ${a.announcedAt}`,
    [['Retract', () => write('/retract', { noteId: a.noteId }, 'retracted')]]));
}

// ---- upkeep ----

const output = (obj) => {
  $('output').hidden = false;
  $('output').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
};
$('do-publish').addEventListener('click', async () => {
  const r = await write('/publish-profile', {}, 'actor republished');
  if (r?.unreachable?.length) say(`republished, but not readable without credentials: ${r.unreachable.join(', ')}`, 'warn');
});
$('do-drain').addEventListener('click', async () => {
  const r = await write('/drain', {}, 'inbox drained');
  if (r) output(r);
});
$('do-log').addEventListener('click', async () => {
  const { json } = await api('/log');
  output((json?.lines || []).slice(-60).join('\n') || 'nothing logged yet');
});
$('do-deadletter').addEventListener('click', async () => {
  const { json } = await api('/deadletter');
  output(json?.items?.length ? json.items : 'no dead letters');
});

// ---- inbox ----
// Only appears when there is enough waiting to be worth a decision. The agent
// drains oldest-first regardless; this exists to let the owner say "do not
// bother with that fortnight", which is not a call an agent should make on
// someone's mail by itself.
const INBOX_PROMPT_AT = 500;
let dismissed = false;

async function renderInbox() {
  if (dismissed) return;
  const { json: st } = await api('/status');
  const box = st?.inbox;
  const panel = $('pane-inbox');
  if (!box || box.count < INBOX_PROMPT_AT) { panel.hidden = true; return; }
  const mb = box.bytes >= 1048576
    ? `${(box.bytes / 1048576).toFixed(1)} MB` : `${Math.round(box.bytes / 1024)} kB`;
  const since = box.oldest ? new Date(box.oldest).toLocaleDateString() : 'unknown';
  $('inbox-summary').textContent =
    `${box.count.toLocaleString()} deliveries waiting (${mb}), the oldest from ${since}.`;
  // One request each to read and delete, and the agent holds itself to 60 a
  // minute, so the honest number is minutes not seconds.
  $('inbox-warn').hidden = box.count < 2000;
  $('inbox-warn').textContent = box.count >= 2000
    ? `At 60 requests a minute this is roughly ${Math.ceil(box.count * 2 / 60)} minutes of `
      + 'draining if you keep everything. Discarding the old content is much quicker.'
    : '';
  panel.hidden = false;
}

$('inbox-keep').addEventListener('click', () => {
  dismissed = true;
  $('pane-inbox').hidden = true;
  say('leaving it to the agent — it drains oldest first');
});

$('inbox-prune').addEventListener('click', async () => {
  const days = Number($('inbox-before').value);
  const before = new Date(Date.now() - days * 86400_000).toISOString();
  $('inbox-prune').disabled = true;
  say(`discarding content older than ${days} days — this takes a while`);
  const r = await write('/inbox/prune', { before }, 'done');
  $('inbox-prune').disabled = false;
  if (r) {
    say(`applied ${r.applied} follow/unfollow/delete, discarded ${r.dropped + r.discarded} posts`
      + (r.failed ? `, ${r.failed} failed` : ''));
    renderInbox();
  }
});

load();
