// gateway.js — the gateway row and its attach and detach forms, the inbox
// prune actions, and the load that starts the page.

const GATEWAY_CTL = $('gateway-ctl');           // held: it rides into a generated row
const GATEWAY_WORD = $('gateway-word');
const GW_OPEN_ATTACH = $('gateway-open-attach');
const GW_OPEN_DETACH = $('gateway-open-detach');
let gwState = null;
async function refreshGateway() {
  const { status, json: g } = await api('/gateway');
  if (status !== 200 || !g) return;
  gwState = g;
  GATEWAY_CTL.hidden = false;
  if (g.configured) {
    let host = g.url;
    try { host = new URL(g.url).host; } catch { /* show it as-is */ }
    const frontName = g.frontActor?.match(/\/u\/([^/]+)\/ap\/actor\/?$/)?.[1];
    GATEWAY_WORD.textContent = frontName ? `${host} — publishing as @${frontName}@${host}` : host;
    GW_OPEN_ATTACH.hidden = true;
    GW_OPEN_DETACH.hidden = false;
  } else {
    GATEWAY_WORD.textContent = '';
    GW_OPEN_ATTACH.hidden = false;
    GW_OPEN_DETACH.hidden = true;
  }
}
const gwShape = () => document.querySelector('input[name=gwShape]:checked')?.value || 'pod';
function gwPreviews() {
  $('gw-pod-preview').textContent = config?.address || `@${config?.handle || 'you'}@your.pod`;
  try { $('gw-front-host').textContent = new URL($('gw-front').value.trim()).host; }
  catch { /* not a URL yet — the placeholder host stands */ }
}
function gwShapeChanged() { gwPreviews(); gwCheck(); }
for (const r of document.querySelectorAll('input[name=gwShape]')) r.addEventListener('change', gwShapeChanged);
// Typing in the blank IS choosing that shape.
$('gw-name').addEventListener('focus', () => {
  const r = document.querySelector('input[name=gwShape][value=front]');
  if (!r.checked) { r.checked = true; gwShapeChanged(); }
});
GW_OPEN_ATTACH.addEventListener('click', () => {
  gwShapeChanged();
  solWindow.show('gateway-attach-form', 'Attach to a gateway');
});
GW_OPEN_DETACH.addEventListener('click', () => {
  $('gw-detach-fronted').hidden = !gwState?.frontActor;
  $('gw-detach-plain').hidden = !!gwState?.frontActor;
  solWindow.show('gateway-detach-form', 'Detach from gateway');
});
// Live availability, asked through the agent (the front answers it without CORS).
let gwTimer = null;
function gwCheck() {
  clearTimeout(gwTimer);
  const front = $('gw-front').value.trim().replace(/\/+$/, '');
  const name = $('gw-name').value.trim().toLowerCase();
  $('gw-name-msg').textContent = ''; $('gw-name-msg').className = 'hint';
  if (gwShape() !== 'front' || !front || !name) return;
  gwTimer = setTimeout(async () => {
    const { status, json } = await postJson('/gateway', { action: 'check', front, handle: name });
    if (status !== 200 || !json) return;
    $('gw-name-msg').textContent = json.available
      ? `${name} is free at ${front.replace(/^https?:\/\//, '')}`
      : (json.reason || 'that name is taken');
    $('gw-name-msg').className = json.available ? 'hint' : 'warn';
  }, 300);
}
$('gw-front').addEventListener('input', () => { gwPreviews(); gwCheck(); });
$('gw-name').addEventListener('input', () => { gwPreviews(); gwCheck(); });
$('gw-attach').addEventListener('click', async () => {
  const front = $('gw-front').value.trim().replace(/\/+$/, '');
  const fronted = gwShape() === 'front';
  const name = $('gw-name').value.trim().toLowerCase();
  if (fronted && !name) { say('give the handle you want at the gateway', 'err'); return; }
  $('gw-attach').disabled = true;
  // Pod-based sends no name: the door's label is the agent's business, not
  // the user's, and the agent picks a free variant by itself.
  const r = await write('/gateway',
    { action: 'attach', front, ...(fronted ? { handle: name, fronted: true } : {}) },
    fronted ? 'attached — the agent is restarting to publish under the gateway handle; reload in a moment'
      : 'attached — your mail now arrives through the gateway, filtered');
  $('gw-attach').disabled = false;
  if (r) { closePanels(); refreshGateway(); }
});
$('gw-detach').addEventListener('click', async () => {
  const fronted = !!gwState?.frontActor;
  const r = await write('/gateway', { action: 'forget' },
    fronted ? 'detached — the agent is restarting under your pod\'s own name; reload in a moment'
      : 'detached — the actor was republished advertising your pod\'s own inbox');
  if (r) { closePanels(); refreshGateway(); }
});

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
