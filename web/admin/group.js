// group.js — the group operator's console and the status, joins, review and
// follower controls shared with a person: the pickers with their keyboard
// guard, the request rows, and the refresh of every list.

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

// A person's follower gate. Automatic is what a migration wave needs: every
// follower's server re-follows at once, and the waiting queue caps at 500.
let followsBusy = false;
const setAutoAccept = async (auto) => {
  if (followsBusy || auto === !!config.autoAcceptFollows) return;
  followsBusy = true;
  try {
    if (await write('/config', { autoAcceptFollows: auto },
      auto ? 'new followers are accepted automatically' : 'new followers will wait for you')) {
      config.autoAcceptFollows = auto;
    }
    FOLLOWS_PICK.value = config.autoAcceptFollows ? 'auto' : 'approve';
  } finally { followsBusy = false; }
};
onPick(FOLLOWS_PICK, (v) => setAutoAccept(v === 'auto'),
  () => { FOLLOWS_PICK.value = config?.autoAcceptFollows ? 'auto' : 'approve'; });

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
    // A list of fifteen buttons all reading "Mute" tells a screen-reader user
    // browsing by button nothing; name each one for the row it acts on.
    b.setAttribute('aria-label', `${label} ${text}`);
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
  const heading = $(countId).closest('h3');
  // A bare <h3> is not focusable, so the "nothing left" fallback would silently
  // drop focus to <body> — give it a programmatic-only tab stop first.
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  (same || li?.querySelector('button') || heading)?.focus?.();
}

// The request rows, shared: a group calls them joins, a person calls them
// follows, and the two do exactly the same thing to exactly the same queue.
function fillRequests(list) {
  fill('requests', 'requests-count', list, (r) => row(r.actor, r.at, [
    ['Accept', () => write('/admit', { actor: r.actor }, 'accepted'), 'Let them follow you'],
    ['Refuse', () => write('/refuse', { actor: r.actor }, 'refused'), 'Turn this down; they may ask again'],
  ]));
}

// The whole queue in one action — the shape a migration wave arrives in.
$('admit-all').addEventListener('click', async () => {
  if (await write('/admit', { all: true }, 'accepted everyone waiting')) {
    if (config.kind === 'group') refreshGroup(); else refreshRequests();
  }
});

// A person's whole group pane is this one block, and only when it has something
// in it — an empty heading promising a list is what the group console avoids too.
async function refreshRequests() {
  const { json } = await api('/requests');
  const list = json?.requests || [];
  $('pane-group').hidden = !list.length;
  $('block-requests').hidden = !list.length;
  if (list.length) fillRequests(list);
}

// What a queued moderation would do, in the words the buttons beside it use.
function describeModeration(e) {
  const o = e.activity?.object;
  const id = typeof o === 'string' ? o : o?.id || '';
  if (e.type === 'Block') return `block ${id}`;
  if (e.type === 'Remove') return `eject ${id}`;
  if (e.type === 'Delete') return `take down ${id}`;
  if (e.type === 'Add') return `add ${id}`;
  return id || 'no target named';
}

async function refreshGroup() {
  const [members, requests, pending, announced, modqueue] = await Promise.all(
    ['/members', '/requests', '/pending', '/announced', '/modqueue']
      .map(p => api(p).then(r => r.json || {})));

  fill('requests', 'requests-count', requests.requests || [], (r) => row(r.actor, r.at, [
    ['Admit', () => write('/admit', { actor: r.actor }, 'admitted'), 'Let them in — they become a member'],
    ['Refuse', () => write('/refuse', { actor: r.actor }, 'refused'), 'Turn this request down; they may ask again'],
  ]));

  fill('pending', 'pending-count', pending.pending || [], (p) => row(p.noteId, `${p.actor} · ${p.at}`, [
    ['Carry it', () => write('/approve', { noteId: p.noteId }, 'carried'), 'Announce this post to every member'],
    ['Decline', () => write('/decline', { noteId: p.noteId }, 'declined'), 'Do not carry it — the post stays up on its author\u2019s pod'],
  ]));

  // Moderation another server asked for: apply it, or turn it down. The route
  // answers with the list itself, not an object wrapping one.
  const modq = Array.isArray(modqueue) ? modqueue : (modqueue.queue || []);
  fill('modqueue', 'modqueue-count', modq, (e) => row(
    `${e.type} — ${describeModeration(e)}`, `asked by ${e.moderator} · ${e.at}`, [
      ['Carry it out', () => write('/modqueue', { id: e.id, action: 'apply' }, 'applied'),
        'Do what the moderator asked, as if you had asked it'],
      ['Turn it down', () => write('/modqueue', { id: e.id, action: 'dismiss' }, 'dismissed'),
        'Leave things as they are and drop the request'],
    ]));

  // A queue nothing can arrive in is not an empty list, it is a list that does
  // not apply — so the setting has to be on before the heading appears at all.
  // This one has no setting: it fills only when a moderator has asked.
  $('block-requests').hidden = !(config.approveJoins && (requests.requests || []).length);
  $('block-pending').hidden = !(config.review && (pending.pending || []).length);
  $('block-modqueue').hidden = !modq.length;

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

