// connections.js — the accounts held elsewhere: the rail, the connect forms
// for Bluesky and for a fediverse account, and the migration aliases.

// The connect form lives in the floating window, like every other form here.
// The inbound transfer panel: the aliases live here now, not in the facts.
$('do-transfer-in').addEventListener('click', () => {
  solWindow.show('transfer-in-form', 'Transfer an account here');
});

// The rail: one click hides the actions; on a phone it starts hidden.
function setRail(closed) {
  $('rail').classList.toggle('closed', closed);
  const t = $('rail-toggle');
  t.setAttribute('aria-expanded', String(!closed));
  t.querySelector('.rail-arrow').textContent = closed ? '»' : '«';
  t.title = closed ? '   Show the action panel' : '   Hide the action panel';
}
$('rail-toggle').addEventListener('click', () => setRail(!$('rail').classList.contains('closed')));
if (matchMedia('(max-width: 47rem)').matches) setRail(true);

// One way in for both networks, because from the record they are the same
// thing: an account elsewhere whose timeline joins the one you read here.
$('ident-open').addEventListener('click', () => {
  closePanels();
  solWindow.show('ident-form', 'Connect an identity');
});
$('ident-pick-fedi').addEventListener('click', () => {
  solWindow.show('fediacct-form', 'Connect a Fediverse account');
});
$('ident-pick-bsky').addEventListener('click', () => {
  solWindow.show('bsky-form', 'Connect a Bluesky account');
});

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
      closePanels();
      await load();
    }
  } finally { bskyBusy = false; }
});
// The sign-in happens at the other server, so this hands the browser over
// rather than taking a password. What comes back lands on /fediacct/callback,
// which this machine answers and nowhere else does.
let fediBusy = false;
$('fediacct-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (fediBusy) return;
  fediBusy = true;
  try {
    const r = await write('/fediacct/connect', { host: $('fediacct-host').value.trim() }, '');
    if (r?.authorize) location.href = r.authorize;
  } finally { fediBusy = false; }
});

// Disconnecting Bluesky, pausing its feed and choosing its storage all live in
// the account's Options menu now (see optionsMenu). Connecting is still here.
// Adding resolves the old account on the agent side, so what lands in
// alsoKnownAs is its canonical id, not the string typed here.
// The accounts elsewhere this one may receive a Move from — the chips in the
// Transfer-an-account-here panel. Each entry is removable, behind a second
// click: servers still retrying a Move check the list, so removal is not a
// tidy-up.
function renderAliases() {
  const box = $('alias-chips');
  box.textContent = '';
  for (const alias of config.aliases || []) {
    let armed = false;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'inline danger';
    rm.textContent = '✕';
    rm.title = '   Remove this alias';
    rm.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        rm.textContent = 'confirm ✕';
        rm.title = '   Servers still retrying the Move check this alias — click again to remove it anyway';
        return;
      }
      const r = await write('/alias', { remove: alias, confirm: true }, 'alias removed and the actor republished');
      if (r) { config.aliases = r.aliases; render(); }
    });
    const chip = document.createElement('span');
    chip.append(alias, ' ', rm);
    box.append(chip, ' ');
  }
}

let aliasBusy = false;
$('alias-add').addEventListener('click', async () => {
  if (aliasBusy) return;
  const v = $('alias-input').value.trim();
  if (!v) { say('enter the old account first — @you@old.server', 'err'); return; }
  aliasBusy = true;
  try {
    const r = await write('/alias', { add: v }, 'alias added and the actor republished');
    if (r) { $('alias-input').value = ''; config.aliases = r.aliases; render(); }
  } finally { aliasBusy = false; }
});


