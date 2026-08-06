// admin.js — the record, as a page. Everything here is an existing admin
// route; the CLI's own group commands are thin clients over the same ones.
//
// Two rules the routes enforce and this page respects: a write is a MERGE, so a
// form that never mentions a field cannot delete it; and anything on the wire is
// not real until the actor is republished, which POST /config does for itself.
//
// The UI password is deliberately not here — `solid-activitypub passwd` sets it. It
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
const MODERATION = $('moderation');
const STATUS = $('status-ctl');
const STATUS_PICK = $('status-pick');   // held: getElementById can't see it mid-render

// #say and #fatal live in the accessibility tree from load and hide by being
// empty (see the stylesheet). Unhiding a live region and filling it in the same
// task is the classic way to get no announcement at all.
function say(text, cls = 'ok') {
  const el = $('say');
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
    $('fatal').textContent = 'This agent has no identity yet.';
    const a = document.createElement('a');
    a.href = '/admin/setup/';
    a.textContent = ' Set it up.';
    $('fatal').appendChild(a);
    return;
  }
  if (status !== 200 || !json) {
    $('fatal').textContent = json?.error || `could not read the record (HTTP ${status})`;
    return;
  }
  config = json;
  render();
  if (new URLSearchParams(location.search).has('new')) openNewActor();
}

// Every disclosure on the page — a form, the log, a lifecycle confirmation —
// is a panel declared inside the floating window and shown by window.js. It
// used to be an accordion at the foot of the page, which pushed whatever you
// were reading out from under you and could only ever show one thing.
//
// The reset lives here rather than in window.js: the window knows how to show a
// panel, not what any of them mean.
function resetConfirm() {
  pending = null;
  for (const k of Object.keys(LIFECYCLE)) $(`warn-${k}`)?.hidden !== undefined && ($(`warn-${k}`).hidden = true);
  $('confirm-handle').value = '';
  $('confirm-handle-move').value = '';
  $('move-target').value = '';
  $('state-path').value = '';
  $('state-url').value = '';
  document.querySelector('input[name=stateWhere][value=path]').checked = true;
  stateRows();
}
function closePanels(keep = null) {
  if (!keep) solWindow.close();
  if (keep !== 'output') outputSource = null;
  if (keep !== 'confirm-form') resetConfirm();
}
// Closing it by the ✕ or by Escape has to clear the same state a Cancel does.
document.getElementById('win').addEventListener('win:closed', () => {
  outputSource = null;
  resetConfirm();
});


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
  // Two of these are addresses of things you can open, so they are links. The
  // fediverse one goes to this actor's own page in the client, same origin, so
  // it stays in the tab. The Solid one leaves for the pod, so it does not.
  const rows = [
    ['kind', config.kind ? config.kind[0].toUpperCase() + config.kind.slice(1) : config.kind],
    // The value is the select itself — what it shows IS the state, and
    // changing the word is the whole action, like the moderation controls.
    ['status', 'ctl'],
    ['Fediverse identity', config.address || `@${config.handle} — no resolvable address`,
      config.accountId && config.address ? { href: `/admin/client/#/a/${config.accountId}` } : null],
    ['Solid identity', config.webId, config.remotePod ? { href: config.remotePod, blank: true } : null],
    ['local store', config.home],
    // The address you actually open, not the bare number — the named origin when
    // there is one, since that is what the client and the OAuth redirect use.
    ['local host', (origins.named || origins.loopback || `http://localhost:${config.port}`)
      .replace(/\/$/, '')],
  ];
  if (config.quiescedAt) rows.push(['parked since', config.quiescedAt]);
  if (config.movedTo) rows.push(['moved to', config.movedTo]);
  for (const [k, v, link] of rows) {
    if (!v) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.textContent = v;
      if (link.blank) {
        a.target = '_blank';
        // noopener because the pod is another origin: without it the page we
        // open gets a handle on this one through window.opener.
        a.rel = 'noopener';
        a.title = `   Open ${link.href} in a new tab`;
      } else {
        a.title = `   This actor's page in our client`;
      }
      dd.appendChild(a);
    } else {
      dd.textContent = v;
    }
    // What a group can be moderated into is a property of BEING a group, so the
    // controls sit on the row that says so. Moved rather than built here: the
    // page still declares them, and `facts` is emptied on every render.
    if (k === 'kind' && config.kind === 'group') dd.append(MODERATION);
    if (k === 'status') {
      dd.textContent = '';
      dd.append(STATUS);
      STATUS.hidden = false;
      renderStatus();
    }
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
  for (const id of ['pane-others', 'pane-identity', 'pane-bluesky', 'pane-upkeep']) $(id).hidden = false;
  renderBluesky();
  renderOthers();
  renderInbox();
  if (config.kind === 'group') {
    // Its lists have no bound, so this page scrolls — see body.group in the CSS.
    document.body.classList.add('group');
    $('pane-group').hidden = false;
    MODERATION.hidden = false;           // only a group has any
    renderGroupToggles();
    refreshGroup();
  } else {
    // A person has a follow-request queue too now: nothing binds an inbound
    // Follow to the actor it names, so one that cannot be verified waits here
    // rather than being accepted on the strength of who it claims to be.
    refreshRequests();
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
  // The fediverse address, which is what the actor IS to everyone else, and the
  // only form that stays distinct: two identities can share a local handle, but
  // never a handle AND a pod. A stopped one has no address to report — nothing
  // answered — so it falls back to the name it is filed under.
  const label = (r) => (r.address || r.handle || r.name)
    + (r.mode && r.mode !== 'active' ? ` (${r.mode})` : '') + (r.mode ? '' : ' (stopped)');
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

// Choosing one and GOING to it are separate, because they have to be. Arrowing
// through a closed <select> fires `change` on every keypress on Windows and
// Linux, so navigating from the event meant a keyboard user was taken to the
// first actor they arrowed past — and, for a stopped one, started its pod on
// the way. Choosing is now free; the button commits.
const goToActor = async () => {
  const r = actors[Number($('actor-pick').value)];
  if (!r || r.current) return;
  if (r.mode) { location.href = r.admin; return; }
  $('actor-pick').disabled = true;
  say(`starting ${r.name}`);
  const started = await write('/start-actor', { name: r.name }, `${r.name} is up`);
  $('actor-pick').disabled = false;
  if (started?.url) location.href = `${started.url}admin/`;
  else renderOthers();            // put the picker back on the current actor
};
// Choosing one goes to its record, as it always has.
//
// Arrowing is the one case that must not: on a closed select every Arrow
// keypress fires `change`, so a keyboard user browsing the list would be
// carried off to the first actor they passed — and for a stopped one that
// boots its pod. An arrow key arms a flag and the change it causes is ignored;
// Enter commits. A mouse never sets the flag, so clicking behaves as before.
let arrowing = false;
$('actor-pick').addEventListener('keydown', (ev) => {
  if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(ev.key)) arrowing = true;
  if (ev.key === 'Enter') { arrowing = false; goToActor(); }
});
$('actor-pick').addEventListener('pointerdown', () => { arrowing = false; });
$('actor-pick').addEventListener('change', () => {
  if (!arrowing) goToActor();
  arrowing = false;
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
// It is a link to ?new=1 so it behaves like one everywhere else, but on THIS
// page the form is already here — open it in place rather than reloading.
$('bar-add').addEventListener('click', (ev) => { ev.preventDefault(); openNewActor(); });
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

// ---- bluesky ----

// The card is either a connect form or the connected account; never both.
function renderBluesky() {
  const on = !!config.atproto?.connected;
  $('bsky-form').hidden = on;
  $('bsky-connected').hidden = !on;
  if (!on) return;
  const facts = $('bsky-facts');
  facts.textContent = '';
  for (const [dt, dd] of [['account', `@${config.atproto.handle}`], ['service', config.atproto.service]]) {
    const t = document.createElement('dt'); t.textContent = dt;
    const d = document.createElement('dd'); d.textContent = dd;
    facts.append(t, d);
  }
  $('bsky-crosspost').value = config.atproto.crossPost ? 'on' : 'off';
}

let bskyBusy = false;
$('bsky-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (bskyBusy) return;
  bskyBusy = true;
  try {
    const r = await write('/atproto/connect', {
      service: $('bsky-service').value.trim(),
      identifier: $('bsky-identifier').value.trim(),
      appPassword: $('bsky-password').value,
    }, 'bluesky account connected');
    if (r) {
      $('bsky-password').value = '';
      await load();
    }
  } finally { bskyBusy = false; }
});
$('bsky-disconnect').addEventListener('click', async () => {
  if (bskyBusy) return;
  bskyBusy = true;
  try {
    if (await write('/atproto/disconnect', {}, 'bluesky account disconnected')) await load();
  } finally { bskyBusy = false; }
});
const setCrossPost = async (on) => {
  if (bskyBusy || on === !!config.atproto?.crossPost) return;
  bskyBusy = true;
  try {
    if (await write('/atproto', { crossPost: on }, on ? 'public posts will cross-post' : 'cross-posting off')) {
      config.atproto.crossPost = on;
    }
    renderBluesky();
  } finally { bskyBusy = false; }
};

// ---- group ----

// Each control shows the setting it would change, so what it displays IS the
// current state — no separate sentence reporting it.
const MOD = { on: 'moderated', off: 'unmoderated' };
function renderGroupToggles() {
  $('joins-mod').value = config.approveJoins ? MOD.on : MOD.off;
  $('review-mod').value = config.review ? MOD.on : MOD.off;
}
function renderStatus() {
  STATUS_PICK.value = config.quiescedAt ? 'parked' : 'active';
}

// Parking is reversible — the follow graph is saved first and going back to
// active re-sends a Follow to everyone in it — so the word applies directly,
// like the moderation controls. The result line says what actually happened.
let statusBusy = false;
const setStatus = async (parked) => {
  if (statusBusy || parked === !!config.quiescedAt) return;
  statusBusy = true;
  try {
    const r = await write(parked ? '/park' : '/revive', {},
      parked ? 'parking — unfollowing everyone and closing the inbox' : 'reviving — re-following the saved graph');
    if (r) {
      say(parked
        ? `parked ${r.quiescedAt}: unfollowed ${r.unfollowed}/${r.following}, inbox closed`
        : `revived: inbox open, ${r.refollowed}/${r.of} follow(s) re-sent`);
      await load();
    }
    renderStatus();
  } finally { statusBusy = false; }
};

// One write at a time, because committing an open picker with Enter fires our
// keydown AND the browser's change — the second call must find the first still
// holding the flag, or config, not yet updated by the awaited write, lets a
// duplicate POST through.
let modBusy = false;
const setJoins = async (approve) => {
  // Picking the value already in force is not a change: no write, and no
  // republish of the actor for a setting that did not move.
  if (modBusy || approve === !!config.approveJoins) return;
  modBusy = true;
  try {
    if (await write('/joins', { approve }, approve ? 'join requests will wait' : 'anyone may join')) {
      config.approveJoins = approve;
      refreshGroup();
    }
    // Both ways: refused, the control must not keep the value it did not get;
    // granted, a blur meanwhile may have repainted it to the old state.
    renderGroupToggles();
  } finally { modBusy = false; }
};
const setReview = async (on) => {
  if (modBusy || on === !!config.review) return;
  modBusy = true;
  try {
    if (await write('/review', { on }, on ? 'posts will be held' : 'posts will be carried at once')) {
      config.review = on;
      refreshGroup();
    }
    renderGroupToggles();
  } finally { modBusy = false; }
};

// Arrowing a closed select fires `change` on every keypress, so a keyboard user
// running down the list would apply each value they passed — here that silently
// opens or closes the group. An arrow arms a flag and the change it causes is
// ignored; Enter commits. A mouse never sets the flag, so clicking is unchanged.
// Same guard as the actor picker above, for the same reason.
function onPick(el, apply, repaint = renderGroupToggles) {
  let arrowing = false;
  el.addEventListener('keydown', (ev) => {
    if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(ev.key)) arrowing = true;
    if (ev.key === 'Enter') { arrowing = false; apply(el.value); }
    // Escape abandons the armed value; what shows must return to what is.
    if (ev.key === 'Escape') { arrowing = false; repaint(); }
  });
  // Leaving abandons too. Unconditional, because the swallow above already
  // consumed the flag — the select may show a state that was never applied,
  // and repainting from config costs nothing when it does match.
  el.addEventListener('blur', () => { arrowing = false; repaint(); });
  el.addEventListener('pointerdown', () => { arrowing = false; });
  el.addEventListener('change', () => {
    if (!arrowing) apply(el.value);
    arrowing = false;
  });
}

onPick($('joins-mod'), (v) => setJoins(v === MOD.on));
onPick($('review-mod'), (v) => setReview(v === MOD.on));
onPick(STATUS_PICK, (v) => setStatus(v === 'parked'), renderStatus);
onPick($('bsky-crosspost'), (v) => setCrossPost(v === 'on'), renderBluesky);

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
  for (const [label, run, hint] of actions) {
    const b = document.createElement('button');
    b.className = 'inline';           // sized like the page's other buttons
    b.textContent = label;
    // Three leading spaces: the tooltip appears under the pointer, and without
    // them the first word sits behind the cursor.
    if (hint) b.title = `   ${hint}`;
    // Where focus should land afterwards. `b.disabled = true` blurs it to
    // <body> at once, and refreshGroup() then wipes and rebuilds the list, so
    // without this every mute, eject, admit or refuse dropped a keyboard user
    // back to the top of the page.
    b.addEventListener('click', async () => {
      const list = li.parentNode;
      focusAfterRefresh = { listId: list?.id, index: [...(list?.children || [])].indexOf(li), label };
      b.disabled = true;
      await run();
      refreshGroup();
    });
    li.appendChild(b);
  }
  return li;
}

// Set by a row action, consumed by the fill() that replaces that row.
let focusAfterRefresh = null;

function fill(listId, countId, items, make) {
  const ul = $(listId);
  ul.textContent = '';
  $(countId).textContent = items.length ? `(${items.length})` : '(none)';
  for (const it of items) ul.appendChild(make(it));
  if (!focusAfterRefresh || focusAfterRefresh.listId !== listId) return;
  const { index, label } = focusAfterRefresh;
  focusAfterRefresh = null;
  // The same action on the row that took this one's place, or the row before it
  // when the list just got shorter. Nothing left to land on is the one case
  // where the heading is the honest answer.
  const rows = [...ul.children];
  const li = rows[Math.min(index, rows.length - 1)];
  const same = li && [...li.querySelectorAll('button')].find(x => x.textContent === label);
  (same || li?.querySelector('button') || $(countId).closest('h3'))?.focus?.();
}

// The request rows, shared: a group calls them joins, a person calls them
// follows, and the two do exactly the same thing to exactly the same queue.
function fillRequests(list) {
  fill('requests', 'requests-count', list, (r) => row(r.actor, r.at, [
    ['Accept', () => write('/admit', { actor: r.actor }, 'accepted'), 'Let them follow you'],
    ['Refuse', () => write('/refuse', { actor: r.actor }, 'refused'), 'Turn this down; they may ask again'],
  ]));
}

// A person's whole group pane is this one block, and only when it has something
// in it — an empty heading promising a list is what the group console avoids too.
async function refreshRequests() {
  const { json } = await api('/requests');
  const list = json?.requests || [];
  $('pane-group').hidden = !list.length;
  $('block-requests').hidden = !list.length;
  if (list.length) fillRequests(list);
}

async function refreshGroup() {
  const [members, requests, pending, announced] = await Promise.all(
    ['/members', '/requests', '/pending', '/announced'].map(p => api(p).then(r => r.json || {})));

  fill('requests', 'requests-count', requests.requests || [], (r) => row(r.actor, r.at, [
    ['Admit', () => write('/admit', { actor: r.actor }, 'admitted'), 'Let them in — they become a member'],
    ['Refuse', () => write('/refuse', { actor: r.actor }, 'refused'), 'Turn this request down; they may ask again'],
  ]));

  fill('pending', 'pending-count', pending.pending || [], (p) => row(p.noteId, `${p.actor} · ${p.at}`, [
    ['Carry it', () => write('/approve', { noteId: p.noteId }, 'carried'), 'Announce this post to every member'],
    ['Decline', () => write('/decline', { noteId: p.noteId }, 'declined'), 'Do not carry it — the post stays up on its author\u2019s pod'],
  ]));

  // A queue nothing can arrive in is not an empty list, it is a list that does
  // not apply — so the setting has to be on before the heading appears at all.
  $('block-requests').hidden = !(config.approveJoins && (requests.requests || []).length);
  $('block-pending').hidden = !(config.review && (pending.pending || []).length);

  fill('members', 'members-count', members.members || [], (m) => row(
    m.handle || m.actor, m.muted ? 'muted — their posts are not carried' : null,
    [
      m.muted
        ? ['Unmute', () => write('/unmute', { actor: m.actor }, 'unmuted'), 'Carry their posts again']
        : ['Mute', () => write('/mute', { actor: m.actor }, 'muted'), 'Stop carrying their posts; they stay a member'],
      ['Eject', () => write('/eject', { actor: m.actor }, 'ejected'), 'Remove them and tell their server; also mutes'],
    ]));

  fill('announced', 'announced-count', announced.announced || [], (a) => row(
    a.noteId, `${a.actor} · ${a.announcedAt}`,
    [['Retract', () => write('/retract', { noteId: a.noteId }, 'retracted'), 'Un-say this announcement to everyone it reached']]));
}

// ---- upkeep ----

// Which button filled the output pane, so clicking that one again closes it
// rather than re-fetching the same thing under an already-open panel.
let outputSource = null;

const OUTPUT_TITLES = { log: 'Log', deadletter: 'Dead letters', drain: 'Inbox drain', rebuild: 'Recovered posts' };
const output = (obj, source = null) => {
  closePanels('output');
  outputSource = source;
  solWindow.show('output', OUTPUT_TITLES[source] || 'Output');
  $('output').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
};

const showingFrom = (source) => outputSource === source && solWindow.openId() === 'output';

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
  'rotate-key': { path: '/rotate-key', title: 'Rotate the signing key', done: (r) => (r.changed ? 'rotated and republished' : 'no change — the key was already fresh') },
  retire: { path: '/retire', title: 'Retire this identity', go: 'Retire it', danger: true, done: (r) => `retired ${r.deletedAt}: Delete delivered to ${r.inboxes} inbox(es)` },
  move: { path: '/move', title: 'Transfer this identity', go: 'Transfer it', focus: 'move-target',
    done: (r) => `transferred to ${r.target}: Move delivered to ${r.inboxes} inbox(es), unfollowed ${r.unfollowed}/${r.following}` },
  'move-state': { path: '/state-move', title: 'Move private data', go: 'Move it', focus: 'state-path',
    done: (r) => (r.unchanged ? 'already there — nothing moved'
      : `moved ${r.docs} document(s) and ${r.notes} post(s) — private data is now ${r.now}`) },
};

// The destination choice reveals the field it needs: a directory for this
// device, an address for another one, nothing for the pod.
function stateRows() {
  const w = picked('stateWhere');
  $('state-row-path').hidden = w !== 'path';
  $('state-row-url').hidden = w !== 'url';
}
for (const el of document.querySelectorAll('input[name=stateWhere]')) {
  el.addEventListener('change', stateRows);
}
let pending = null;

const closeConfirm = () => closePanels();

for (const btn of document.querySelectorAll('[data-confirm]')) {
  btn.addEventListener('click', () => {
    const what = btn.dataset.confirm;
    // The same button again closes its question rather than re-asking it.
    if (pending === what && solWindow.openId() === 'confirm-form') { closePanels(); return; }
    closePanels();                    // including whatever else was open
    pending = what;
    const spec = LIFECYCLE[what];
    $(`warn-${what}`).hidden = false;
    solWindow.show('confirm-form', spec.title);
    $('confirm-go').className = spec.danger ? 'danger' : 'primary';
    $('confirm-go').textContent = spec.go || 'Confirm';
    if (spec.focus) $(spec.focus).focus();
    else if (what === 'retire') $('confirm-handle').focus();
  });
}

// Offered from inside the retire warning: someone reading it has already said
// what they want ("not this account, here, any more") and these are the two
// answers that are not destruction. Switching panels rather than closing means
// they do not have to go and find the button themselves.
const openConfirm = (what) => {
  closePanels();                 // or `show` toggles: same panel, different warning
  document.querySelector(`[data-confirm="${what}"]`).click();
};
// Park lives on the status control now; from inside the retire warning it is
// still one click — close the question and park.
$('go-park').addEventListener('click', () => { closePanels(); setStatus(true); });
$('go-move').addEventListener('click', () => openConfirm('move'));

$('confirm-cancel').addEventListener('click', () => { closeConfirm(); say('nothing changed'); });

$('confirm-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!pending) return;
  const what = pending;
  const body = what === 'retire' ? { confirm: $('confirm-handle').value.trim() }
    : what === 'move' ? { target: $('move-target').value.trim(), confirm: $('confirm-handle-move').value.trim() }
      : what === 'move-state' ? {
        to: picked('stateWhere') === 'pod' ? 'pod'
          : picked('stateWhere') === 'url' ? $('state-url').value.trim() : $('state-path').value.trim(),
      }
        : {};
  if (what === 'move' && !body.target) { say('name the account to transfer to', 'err'); return; }
  if (what === 'move-state' && !body.to) { say('name the destination', 'err'); return; }
  $('confirm-go').disabled = true;
  say(what === 'move-state' ? 'moving your private data — copying, checking, then switching over'
    : `${what} — this talks to the pod and to other servers, so it takes a moment`);
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
