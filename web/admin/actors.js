// actors.js — the other actors on this machine: the picker, going to one,
// starting a stopped one, and the form for a new one.

// Somewhere to go, and nothing else. A stopped actor is left out — the link
// would land on nothing. The one you are on keeps its place in the row but
// offers only `app`, because its admin page is the page you are reading.

let actors = [];

async function renderOthers() {
  const { json } = await api('/profiles');
  actors = json?.identities || [];
  const sel = $('actor-pick');
  sel.textContent = '';
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
  // The way to a NEW actor rides the same dropdown as the existing ones.
  const add = document.createElement('option');
  add.value = '__add';
  add.textContent = '+ add a new account…';
  sel.appendChild(add);
}

// Going to an actor commits a navigation and, for a stopped one, a POST that
// boots its pod — so it must run once per choice. Pressing Enter on the select
// fires BOTH a keydown (handled below) and a native `change`, so without a
// guard a keyboard commit would start the actor twice.
let goingToActor = false;
const goToActor = async () => {
  if (goingToActor) return;
  if ($('actor-pick').value === '__add') { renderOthers(); openNewActor(); return; }
  const r = actors[Number($('actor-pick').value)];
  if (!r || r.current) return;
  goingToActor = true;
  try {
    if (r.mode) { location.href = r.admin; return; }
    $('actor-pick').disabled = true;
    say(`starting ${r.name}`);
    const started = await write('/start-actor', { name: r.name }, `${r.name} is up`);
    $('actor-pick').disabled = false;
    if (started?.url) location.href = `${started.url}admin/`;
    else renderOthers();            // put the picker back on the current actor
  } finally {
    goingToActor = false;
  }
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
const RECORD_PANES = ['pane-identity', 'pane-group', 'pane-inbox', 'rail'];
let putBack = [];

function showNewActor(on) {
  if (on) closePanels();              // nothing of the old actor left open behind it
  document.body.classList.toggle('adding', on);   // see body.adding in the CSS
  $('new-actor-form').hidden = !on;
  if (on) {
    putBack = RECORD_PANES.filter(id => !$(id).hidden);
    for (const id of putBack) $(id).hidden = true;
  } else {
    for (const id of putBack) $(id).hidden = false;
    putBack = [];
  }
}

// `add a new account` is the last item of the Local Actors dropdown; choosing
// it opens the form in place. Arriving with ?new does the same.
function openNewActor() {
  showNewActor(true);
  newActorRows();
  $('new-handle').focus();
}
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

