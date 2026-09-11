// upkeep.js — upkeep and the lifecycle: the output pane, drain, recover,
// log and dead letters; the confirmations for rotate, retire and move; and
// the inbox backlog panel.

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
  move: { path: '/move', title: 'Transfer this account away', go: 'Transfer it', focus: 'move-target',
    done: (r) => `transferred to ${r.target}: Move delivered to ${r.inboxes} inbox(es), unfollowed ${r.unfollowed}/${r.following}` },
};
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
      // Only where the field is shown (the browser build — see index.html).
      // On the Node agent the row stays hidden and nothing is sent, which is
      // what that agent expects.
      : what === 'rotate-key' && !$('rotate-pw-row').hidden
        ? { password: $('rotate-password').value }
        : {};
  if (what === 'move' && !body.target) { say('name the account to transfer to', 'err'); return; }
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

// The gateway, as a facts row under software: attach through a multi-user
// front with this agent's own credential, detach back to the pod inbox. The
// forms live in the floating window, like every other disclosure.
