// admin.js — the record, as a page. Everything here is an existing admin
// route; the CLI's own group commands are thin clients over the same ones.
//
// Two rules the routes enforce and this page respects: a write is a MERGE, so a
// form that never mentions a field cannot delete it; and anything on the wire is
// not real until the actor is republished, which POST /config does for itself.
//
// The UI password is deliberately not here — `activitypod passwd` sets it. It
// only gates /oauth/authorize, so it does nothing for a loopback-only agent.

const $ = (id) => document.getElementById(id);
const api = async (path, init) => {
  const res = await fetch(path, init);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const postJson = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

let config = null;
// Held, because render() moves it into a generated row and empties that row's
// list on the next pass — after which getElementById would not find it again.
const MODERATION = $('do-moderation');

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
  if (new URLSearchParams(location.search).has('new')) openNewActor();
}

// One panel open at a time. Every disclosure on the page — the log/dead-letter
// output, a lifecycle confirmation — closes through here,
// so opening one puts the others away rather than stacking them down the page.
const PANELS = ['output', 'confirm-form', 'moderation'];

function closePanels(keep = null) {
  for (const id of PANELS) if (id !== keep) $(id).hidden = true;
  if (keep !== 'output') outputSource = null;
  if (keep !== 'confirm-form') {
    pending = null;
    for (const k of Object.keys(LIFECYCLE)) $(`warn-${k}`).hidden = true;
    $('confirm-handle').value = '';
  }
}


function render() {
  // The bar names the actor, the same way on every page. Only the tab title is
  // this page's own business.
  document.title = `Solid ActivityPub — ${config.handle}`;
  const facts = $('facts');
  facts.textContent = '';
  // What this actor IS comes first. The handle is already in the address beside
  // the heading; the pod, the issuer and the actor URL all read off the WebID;
  // and where the private half sits is not something you act on from here.
  const origins = config.origins || {};
  const rows = [
    ['kind', config.kind ? config.kind[0].toUpperCase() + config.kind.slice(1) : config.kind],
    ['Fediverse identity', config.address || `@${config.handle} — no resolvable address`],
    ['Solid identity', config.webId],
    ['local store', config.home],
    // The address you actually open, not the bare number — the named origin when
    // there is one, since that is what the client and the OAuth redirect use.
    ['local host', (origins.named || origins.loopback || `http://localhost:${config.port}`)
      .replace(/\/$/, '')],
  ];
  if (config.quiescedAt) rows.push(['parked since', config.quiescedAt]);
  if (config.movedTo) rows.push(['moved to', config.movedTo]);
  for (const [k, v] of rows) {
    if (!v) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    // What a group can be moderated into is a property of BEING a group, so the
    // way in sits on the row that says so. Moved rather than built here: the
    // page still declares the button, and `facts` is emptied on every render.
    if (k === 'kind' && config.kind === 'group') dd.append(MODERATION);
    facts.append(dt, dd);
  }
  if (!config.address) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = `${config.remotePod} is not the root of its own host, so this actor cannot be `
      + 'discovered as a handle by other servers. Posting and reading still work.';
    $('pane-identity').appendChild(p);
  }

  // pane-others carries the create control too, so it appears even when this is
  // the only actor and even if /profiles cannot be read.
  for (const id of ['pane-others', 'pane-identity', 'pane-upkeep']) $(id).hidden = false;
  renderOthers();
  renderInbox();
  if (config.kind === 'group') {
    // Its lists have no bound, so this page scrolls — see body.group in the CSS.
    document.body.classList.add('group');
    $('pane-group').hidden = false;
    MODERATION.hidden = false;           // only a group has any
    renderGroupToggles();
    refreshGroup();
  }
}

// ---- the actors running on this machine ----
// Somewhere to go, and nothing else. A stopped actor is left out — the link
// would land on nothing. The one you are on keeps its place in the row but
// offers only `app`, because its admin page is the page you are reading.

let actors = [];

async function renderOthers() {
  const { json } = await api('/profiles');
  actors = json?.identities || [];
  const sel = $('actor-pick');
  sel.textContent = '';
  if (!actors.length) return;
  // Two actors can present the same word — a profile directory named for a
  // handle another identity already answers to, which is what a half-finished
  // setup leaves behind. Say the port in that case rather than offering the
  // same name twice with no way to tell them apart.
  const label = (r) => (r.handle || r.name) + (r.mode && r.mode !== 'active' ? ` (${r.mode})` : '')
    + (r.mode ? '' : ' (stopped)');
  const seen = {};
  for (const r of actors) seen[label(r)] = (seen[label(r)] || 0) + 1;

  for (const [i, r] of actors.entries()) {
    const o = document.createElement('option');
    o.value = String(i);
    o.selected = !!r.current;      // it opens showing where you already are
    o.textContent = label(r) + (seen[label(r)] > 1 && r.port ? ` :${r.port}` : '');
    sel.appendChild(o);
  }
}

// Choosing one goes to its record. A stopped actor has no page until it is
// running, so it is started first — that takes a few seconds, mostly its pod.
$('actor-pick').addEventListener('change', async (ev) => {
  const r = actors[Number(ev.target.value)];
  if (!r || r.current) return;
  if (r.mode) { location.href = r.admin; return; }
  ev.target.disabled = true;
  say(`starting ${r.name}`);
  const started = await write('/start-actor', { name: r.name }, `${r.name} is up`);
  ev.target.disabled = false;
  if (started?.url) location.href = `${started.url}admin/`;
  else renderOthers();            // put the picker back on the current actor
});

// Setting up a new actor asks for exactly what this page cannot already tell
// it: the pod and the account behind it, and its permanent name. Display name,
// bio and pictures are the client's job now — Phanpy's profile editor writes
// them through /api/v1/accounts/update_credentials. Where the private data goes
// is not a question either: it lands beside the credential, and `state --to`
// moves it afterwards.

const picked = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;

function newActorRows() {
  const mode = picked('newMode');
  $('new-row-podname').hidden = mode !== 'new';
  $('new-row-pod').hidden = mode !== 'existing';
}
for (const el of document.querySelectorAll('input[name=newMode]')) {
  el.addEventListener('change', newActorRows);
}

// While the form is up the page IS the new actor's setup — so the record of
// the actor you came from goes away, list included. Which panes were showing
// is remembered rather than recomputed: whether Group and Inbox belong is a
// decision render() already made.
const RECORD_PANES = ['pane-identity', 'pane-group', 'pane-inbox', 'pane-upkeep'];
let putBack = [];

function showNewActor(on) {
  if (on) closePanels();              // nothing of the old actor left open behind it
  document.body.classList.toggle('adding', on);   // see body.adding in the CSS
  $('others-line').hidden = on;
  $('new-actor-form').hidden = !on;
  if (on) {
    putBack = RECORD_PANES.filter(id => !$(id).hidden);
    for (const id of putBack) $(id).hidden = true;
  } else {
    for (const id of putBack) $(id).hidden = false;
    putBack = [];
  }
}

// `add new account` lives in the bar now. On this page it opens the form in
// place; on the others it comes back here as ?new.
function openNewActor() {
  showNewActor(true);
  newActorRows();
  $('new-handle').focus();
}
$('bar-add').addEventListener('click', openNewActor);
$('new-actor-cancel').addEventListener('click', () => { showNewActor(false); say('nothing changed'); });

$('new-actor-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const handle = $('new-handle').value.trim();
  const answers = {
    handle,
    kind: picked('newKind'),
    mode: picked('newMode'),
    issuer: $('new-issuer').value.trim(),
    email: $('new-email').value.trim(),
    password: $('new-password').value,
  };
  if (answers.mode === 'new') answers.podName = $('new-podname').value.trim() || handle;
  else answers.pod = $('new-pod').value.trim();
  $('new-actor-go').disabled = true;
  say(`setting up ${handle || 'the new actor'} — this takes a while`);
  const r = await write('/new-actor', answers, `setting up ${handle}`);
  $('new-actor-go').disabled = false;
  if (r?.url) location.href = r.url;      // its own page, where the progress is
});

// ---- group ----

function renderGroupToggles() {
  // Labelled, because the sentence alone reads like an instruction rather than
  // a report of what the group is doing right now.
  $('joins-state').textContent = config.approveJoins
    ? 'current state: each join request waits for you.'
    : 'current state: anyone who follows becomes a member at once.';
  $('joins-open').disabled = !config.approveJoins;
  $('joins-approve').disabled = !!config.approveJoins;
  $('review-state').textContent = config.review
    ? 'current state: members’ posts are held until you approve them.'
    : 'current state: members’ posts are carried to the group as they arrive.';
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
// The settings themselves are a panel like the log is: opened when you mean to
// change one, not standing between the heading and the lists.
MODERATION.addEventListener('click', () => {
  if (!$('moderation').hidden) { closePanels(); return; }
  closePanels('moderation');
  $('moderation').hidden = false;
});

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

  // A queue nothing can arrive in is not an empty list, it is a list that does
  // not apply — so the setting has to be on before the heading appears at all.
  $('block-requests').hidden = !(config.approveJoins && (requests.requests || []).length);
  $('block-pending').hidden = !(config.review && (pending.pending || []).length);

  fill('members', 'members-count', members.members || [], (m) => row(
    m.handle || m.actor, m.muted ? 'muted — their posts are not carried' : null,
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

// Which button filled the output pane, so clicking that one again closes it
// rather than re-fetching the same thing under an already-open panel.
let outputSource = null;

const output = (obj, source = null) => {
  closePanels('output');
  outputSource = source;
  $('output').hidden = false;
  $('output').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
};

const showingFrom = (source) => outputSource === source && !$('output').hidden;

// Drain is the one that does work rather than reveals it, so a second click
// re-runs instead of closing. It can take a while — the agent joins a sweep
// already in flight and queues another after it — and a button that looks dead
// for a minute reads as broken.
$('do-drain').addEventListener('click', async (ev) => {
  const b = ev.currentTarget;
  b.disabled = true;
  b.textContent = 'draining…';
  say('draining the inbox — if a sweep is already running this waits for it to finish');
  const r = await write('/drain', {}, 'inbox drained');
  b.disabled = false;
  b.textContent = 'Drain the inbox';
  if (r) {
    const box = r.inbox || {};
    say(`inbox drained — ${box.count ?? 0} still waiting`);
    output(r, 'drain');
  }
});

// Like the drain, this does work rather than reveals it, so a second click
// re-runs. Nothing here can lose anything: it only adds posts back.
$('do-rebuild').addEventListener('click', async (ev) => {
  const b = ev.currentTarget;
  b.disabled = true;
  b.textContent = 'recovering…';
  say('reading what the pod still holds — one request per post, so this takes a moment');
  const r = await write('/rebuild', {}, 'checked');
  b.disabled = false;
  b.textContent = 'Recover posts';
  if (!r) return;
  if (r.why) { say(r.why, 'err'); return; }
  if (!r.landed) { say('recovered posts could NOT be saved — see the log', 'err'); return; }
  say(r.recovered
    ? `recovered ${r.recovered} post(s) the pod had and this machine did not`
    : `nothing was missing — the pod indexed ${r.indexed} post(s), all of them already here`);
  output(r, 'rebuild');
});

$('do-log').addEventListener('click', async () => {
  if (showingFrom('log')) { closePanels(); return; }
  const { json } = await api('/log');
  output((json?.lines || []).slice(-60).join('\n') || 'nothing logged yet', 'log');
});

$('do-deadletter').addEventListener('click', async () => {
  if (showingFrom('deadletter')) { closePanels(); return; }
  const { json } = await api('/deadletter');
  output(json?.items?.length ? json.items : 'no dead letters', 'deadletter');
});

// ---- lifecycle ----
// None of these can be taken back by clicking again, so the button only opens
// the matching warning in the markup; the second click is the one that acts.
// Retire also wants the handle typed, because a misclick cannot produce it.

const LIFECYCLE = {
  park: { path: '/park', done: (r) => `parked ${r.quiescedAt}: unfollowed ${r.unfollowed}/${r.following}, inbox closed` },
  revive: { path: '/revive', done: (r) => `revived: inbox open, ${r.refollowed}/${r.of} follow(s) re-sent` },
  'rotate-key': { path: '/rotate-key', done: (r) => (r.changed ? 'rotated and republished' : 'no change — the key was already fresh') },
  retire: { path: '/retire', done: (r) => `retired ${r.deletedAt}: Delete delivered to ${r.inboxes} inbox(es)` },
};
let pending = null;

const closeConfirm = () => closePanels();

for (const btn of document.querySelectorAll('[data-confirm]')) {
  btn.addEventListener('click', () => {
    const what = btn.dataset.confirm;
    // The same button again closes its question rather than re-asking it.
    if (pending === what && !$('confirm-form').hidden) { closePanels(); return; }
    closePanels();                    // including whatever else was open
    pending = what;
    $(`warn-${what}`).hidden = false;
    $('confirm-form').hidden = false;
    $('confirm-go').className = what === 'retire' ? 'danger' : 'primary';
    $('confirm-go').textContent = what === 'retire' ? 'Retire this actor' : 'Confirm';
    if (what === 'retire') $('confirm-handle').focus();
  });
}

$('confirm-cancel').addEventListener('click', () => { closeConfirm(); say('nothing changed'); });

$('confirm-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!pending) return;
  const what = pending;
  const body = what === 'retire' ? { confirm: $('confirm-handle').value.trim() } : {};
  $('confirm-go').disabled = true;
  say(`${what} — this talks to the pod and to other servers, so it takes a moment`);
  const r = await write(LIFECYCLE[what].path, body, what);
  $('confirm-go').disabled = false;
  if (!r) return;                        // write() already said why
  closeConfirm();
  say(LIFECYCLE[what].done(r));
  load();                                // mode, and whether it is retired, both changed
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
