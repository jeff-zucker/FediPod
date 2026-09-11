// record.js — the record itself: what the page holds of the config, the
// messages it says, every write, the load, the panels, and the rows of the
// facts list with the identity rows and their controls.
// admin.js — the record, as a page. Everything here is an existing admin
// route; the CLI's own group commands are thin clients over the same ones.
//
// Two rules the routes enforce and this page respects: a write is a MERGE, so a
// form that never mentions a field cannot delete it; and anything on the wire is
// not real until the actor is republished, which POST /config does for itself.
//
// The UI password is deliberately not here — `fedipod passwd` sets it. It
// only gates /oauth/authorize, so it does nothing for a loopback-only agent.

let config = null;
// Held, because render() moves it into a generated row and empties that row's
// list on the next pass — after which getElementById would not find it again.
const MODERATION = $('moderation');
const STATUS = $('status-ctl');
const STATUS_PICK = $('status-pick');   // held: getElementById can't see it mid-render
const IDENT_CTL = $('ident-ctl');
const FOLLOWS_CTL = $('follows-ctl');
const FOLLOWS_PICK = $('follows-pick');
const UPDATE_CTL = $('update-ctl');
const UPDATE_WORD = $('update-word');
const UPDATE_GO = $('update-go');

// #say and #fatal live in the accessibility tree from load and hide by being
// empty (see the stylesheet). Unhiding a live region and filling it in the same
// task is the classic way to get no announcement at all.
function say(text, cls = 'ok') {
  const el = $('say');
  el.className = cls;
  // Clear first, then set on the next task: a live region that is handed the
  // same text it already holds announces nothing, so two identical messages in
  // a row ("nothing changed", "nothing changed") would be silent the second time.
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}

// Every write goes through here, so nothing silently half-succeeds.
async function write(path, body, done) {
  const { status, json } = await postJson(path, body);
  if (status >= 400) { say(json?.error || `refused (HTTP ${status})`, 'err'); return null; }
  say(done);
  return json;
}

UPDATE_GO.onclick = async () => {
  UPDATE_GO.disabled = true;
  const r = await write('/update', {}, 'updating — the agents restart when it finishes; reload in a moment');
  if (!r) UPDATE_GO.disabled = false;
};

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
  $('rotate-password').value = '';
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
  $('bsky-password').value = '';        // never leave a secret in a closed panel
});


// One row per identity connected elsewhere, indented under the row that adds
// them. Each carries its own way out: disconnecting one has nothing to do with
// the others.
function identityRows() {
  const out = [];
  const row = (label, ...nodes) => {
    const dt = document.createElement('dt');
    dt.className = 'under';
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.append(...nodes);
    out.push([dt, dd]);
  };
  // One descriptor shape for every connected account — Bluesky and each
  // fediverse account — so the row and its Options menu build the same way.
  const accounts = [];
  if (config.atproto?.connected) accounts.push({
    label: 'Bluesky', handle: `@${config.atproto.handle}`,
    href: `https://bsky.app/profile/${config.atproto.handle}`,
    storage: config.atproto.storage || null,
    feedPaused: 'feedPaused' in config.atproto ? config.atproto.feedPaused : null,
    crossPost: 'crossPost' in config.atproto ? config.atproto.crossPost : null,
    feed: (paused) => ['/atproto', { feedPaused: paused }],
    cross: (on) => ['/atproto', { crossPost: on }],
    store: (w) => ['/atproto', { storage: w }],
    off: () => ['/atproto/disconnect', {}],
  });
  for (const acct of config.fediAccounts || []) accounts.push({
    label: acct.host,
    handle: acct.needsReconnect ? `${acct.handle} — sign in again` : acct.handle,
    warn: acct.needsReconnect,
    storage: acct.storage || null,
    feedPaused: !acct.enabled,
    crossPost: null,
    feed: (paused) => ['/fediacct', { id: acct.id, enabled: !paused }],
    store: (w) => ['/fediacct', { id: acct.id, storage: w }],
    off: () => ['/fediacct/disconnect', { id: acct.id }],
  });
  for (const acct of accounts) {
    const name = document.createElement(acct.href ? 'a' : 'span');
    name.textContent = acct.handle;
    if (acct.href) { name.href = acct.href; name.target = '_blank'; name.rel = 'noopener'; name.title = '   Open this account elsewhere in a new tab'; }
    if (acct.warn) name.className = 'warn';
    // Where storage is a real choice (every browser-build account today), two
    // dropdowns sit in the row itself. Where it isn't (the Node agent's
    // Bluesky, which shows a cross-post toggle instead), the Options
    // disclosure it always has is unchanged.
    row(acct.label, name, ' ', ...(acct.storage ? connectionControls(acct) : [optionsMenu(acct)]));
  }
  return out;
}

// Connected, Paused or Disconnected, and where the key lives — one dropdown
// each, in the row. Replaces the separate feed and connect dropdowns that used
// to sit behind an Options disclosure; only reached where acct.storage is set.
function connectionControls(acct) {
  const send = async ([path, payload], msg) => { if (await write(path, payload, msg)) await load(); };
  const pick = (opts, current, onChange, title) => {
    const el = document.createElement('select');
    if (title) el.title = title;
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; o.selected = v === current; el.appendChild(o); }
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };
  const conn = pick(
    [['connected', 'Connected'], ['paused', 'Paused'], ['disconnected', 'Disconnected']],
    acct.feedPaused ? 'paused' : 'connected',
    (v) => (v === 'disconnected'
      ? send(acct.off(), 'disconnected')
      : send(acct.feed(v === 'paused'), v === 'paused' ? 'paused adding to your feed' : 'added to your home feed')),
    '   Connected feeds this account into your home feed here; Paused keeps the account but stops adding its posts; Disconnected removes it.');
  const storage = pick(
    [['pod', 'Store key on Pod'], ['browser', 'Store key in Browser']],
    acct.storage,
    (v) => {
      if (v === 'pod' && !confirm('Store this account on your pod?\n\nIt will follow you to any browser you sign in from — but a full-access token to that account then lives on your pod.')) { load(); return; }
      send(acct.store(v), v === 'pod' ? 'stored on your pod' : 'stored in this browser');
    },
    '   On your pod the key follows you to any browser you sign in from, and a full-access token then lives there; in this browser the token never leaves this device.');
  const wrap = document.createElement('span');
  wrap.className = 'conn-controls';
  wrap.append(conn, ' ', storage);
  return [wrap];
}

// Every connected account without a storage choice carries an Options menu
// instead: pause its feed, its cross-post toggle (the Node agent's Bluesky),
// disconnect.
function optionsMenu(acct) {
  const d = document.createElement('details');
  d.className = 'opts';
  const sum = document.createElement('summary');
  sum.textContent = 'Options';
  d.appendChild(sum);
  const body = document.createElement('div');
  d.appendChild(body);

  // Each control is one dropdown whose options ARE the states, so it needs no
  // separate label — the chosen option reads as the current state.
  const pick = (opts, current, onChange) => {
    const el = document.createElement('select');
    for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; o.selected = v === current; el.appendChild(o); }
    el.addEventListener('change', () => onChange(el.value));
    body.appendChild(el);
  };
  const send = async ([path, payload], msg) => { if (await write(path, payload, msg)) await load(); };

  // Feed: shown in / hidden from the feed you read here.
  if (acct.feedPaused !== null) {
    pick([['show', 'Add to home feed'], ['hide', 'Pause adding to home feed']], acct.feedPaused ? 'hide' : 'show',
      (v) => send(acct.feed(v === 'hide'), v === 'hide' ? 'paused adding to your feed' : 'added to your home feed'));
  }
  // Storage where the browser offers the choice; the Node agent's Bluesky shows
  // its cross-post toggle in the same slot instead.
  if (acct.storage) {
    pick([['browser', 'Store key in Browser'], ['pod', 'Store key on Pod']], acct.storage, (v) => {
      if (v === 'pod' && !confirm('Store this account on your pod?\n\nIt will follow you to any browser you sign in from — but a full-access token to that account then lives on your pod.')) { load(); return; }
      send(acct.store(v), v === 'pod' ? 'stored on your pod' : 'stored in this browser');
    });
  } else if (acct.crossPost !== null) {
    pick([['on', 'Cross-post On'], ['off', 'Cross-post Off']], acct.crossPost ? 'on' : 'off',
      (v) => send(acct.cross(v === 'on'), ''));
  }
  // Connection: staying connected, or disconnecting.
  pick([['connected', 'Connected'], ['disconnect', 'Disconnect']], 'connected',
    (v) => { if (v === 'disconnect') send(acct.off(), 'disconnected'); else load(); });

  // The storage consequence, at the bottom of the box under every dropdown.
  if (acct.storage) {
    const hint = document.createElement('p'); hint.className = 'opt-hint';
    hint.textContent = acct.storage === 'pod'
      ? 'Follows you to every browser you sign in from; a full-access token lives on your pod.'
      : 'Stays in this browser; the token never leaves this device.';
    body.appendChild(hint);
  }
  return d;
}

function render() {
  // The bar names the actor, the same way on every page. Only the tab title is
  // this page's own business.
  document.title = `FediPod — ${config.handle}`;
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
    ['Other identities', 'ctl'],
    ['local store', config.home],
    // The address you actually open, not the bare number — the named origin when
    // there is one, since that is what the client and the OAuth redirect use. An
    // agent with no local host of its own (embedded in a pod server, or in a
    // browser) sends none, and then there is no row rather than a bare number.
    ['local host', (origins.named || origins.loopback || '').replace(/\/$/, '') || null],
  ];
  if (config.version || config.update || config.pendingUpgrade?.length) rows.push(['software', 'ctl']);
  rows.push(['gateway', 'ctl']);
  if (config.quiescedAt) rows.push(['parked since', config.quiescedAt]);
  if (config.movedTo) rows.push(['moved to', config.movedTo]);
  // A person gates followers here; a group's gate is the joins control on its
  // kind row, so the row would be a second switch for the same thing.
  if (config.kind !== 'group') rows.splice(2, 0, ['new followers', 'ctl']);
  // Rows that belong under the one being written, appended after it.
  let kids = null;
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
    if (k === 'new followers') {
      dd.textContent = '';
      dd.append(FOLLOWS_CTL);
      FOLLOWS_CTL.hidden = false;
      FOLLOWS_PICK.value = config.autoAcceptFollows ? 'auto' : 'approve';
    }
    if (k === 'gateway') {
      dd.textContent = '';
      dd.append(GATEWAY_CTL);
      refreshGateway();
    }
    if (k === 'software') {
      dd.textContent = '';
      dd.append(UPDATE_CTL);
      UPDATE_CTL.hidden = false;
      const u = config.update;
      // The version this agent is running, never the one sitting in the
      // checkout — saying otherwise would name a version nobody is serving.
      const running = config.version || u?.current || null;
      const words = [];
      if (running) words.push(u?.available ? `FediPod ${running} — ${u.latest} available` : `FediPod ${running}`);
      if (config.versionOnDisk && running && config.versionOnDisk !== running)
        words.push(`${config.versionOnDisk} is on disk — restart to run it`);
      if (config.pendingUpgrade?.length) words.push('older data layout — run `fedipod upgrade` in a terminal');
      UPDATE_WORD.textContent = words.join('; ');
      UPDATE_GO.hidden = !u?.available;
    }
    // The way to add one. Each account already connected is a row of its own
    // underneath, so this row stays the action and never becomes a list.
    if (k === 'Other identities') {
      dd.textContent = '';
      dd.append(IDENT_CTL);
      IDENT_CTL.hidden = false;
      kids = identityRows();
    }
    facts.append(dt, dd);
    if (kids) {
      for (const [ckt, ckd] of kids) facts.append(ckt, ckd);
      kids = null;
    }
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
  for (const id of ['pane-others', 'pane-identity', 'rail']) $(id).hidden = false;
  renderAliases();
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

