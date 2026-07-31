// setup.js — the questions the CLI used to ask, asked here instead. Every
// request is relative, so the page behaves identically whether it was reached
// at localhost:<port> or at <handle>.localhost:<port>.
//
// External file, not an inline script: the CSP allows 'self' plus the hashes
// of Phanpy's own inline bootstrap, and nothing else.

const $ = (id) => document.getElementById(id);
const show = (id) => { for (const s of document.querySelectorAll('body > section')) s.hidden = s.id !== id; };
const api = async (path, init) => {
  const res = await fetch(path, init);
  return { status: res.status, json: await res.json().catch(() => null) };
};
const postJson = (path, body) => api(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

let state = null;

// ---- what the agent needs from us ----

async function start() {
  const { json } = await api('/setup/state');
  state = json || {};
  if (state.phase === 'running' || state.phase === 'done' || state.phase === 'error') return watchRun();
  if (state.configured) return paneConfigured();
  return paneForm();
}

function paneConfigured() {
  $('strap').textContent = 'already set up';
  $('configured-address').textContent = state.handle ? `@${state.handle}` : '';
  $('configured-client').hidden = state.kind === 'group';
  show('pane-configured');
  // The address needs the pod host, which only /config knows.
  api('/config').then(({ json }) => {
    if (json?.address) $('configured-address').textContent = json.address;
  });
}

// ---- the form ----

function paneForm() {
  $('strap').textContent = state.resumable
    ? 'finishing a setup that did not complete'
    : 'two questions were asked in the terminal; the rest are here';
  if (state.handle) $('handle').value = state.handle;
  // Resuming: the account exists and the credential is minted. Asking for a
  // password again would mint a second one and orphan the first, which cannot
  // be recovered.
  if (state.resumable) {
    $('fs-pod').hidden = true;
    $('row-password').hidden = true;
    $('submit').textContent = 'Finish setting up';
  } else if (state.passwordSupplied) {
    $('row-password').hidden = true;      // AP_PASSWORD is set in the environment
  }
  show('pane-form');
  for (const el of $('form').elements) {
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  }
  $('form').addEventListener('submit', onSubmit);
  onEdit();
}

function answers() {
  const f = $('form').elements;
  const kind = f.kind.value;
  const mode = state.resumable ? 'existing' : f.mode.value;
  const a = {
    kind,
    mode,
    handle: f.handle.value.trim(),
    name: f.name.value.trim() || f.handle.value.trim(),
    issuer: f.issuer.value.trim(),
    email: f.email.value.trim(),
    summary: f.summary.value.trim() || undefined,
    icon: f.icon.value.trim() || undefined,
  };
  if (mode === 'new') a.podName = f.podName.value.trim() || a.handle;
  else a.pod = f.pod.value.trim();
  if (!state.resumable && !state.passwordSupplied) a.password = f.password.value;
  if (f.uiPassword.value) a.uiPassword = f.uiPassword.value;
  return a;
}

// Every warning the CLI printed before it asked "create pod and fediverse
// account?", in the same words, as you type.
const NOTES = {
  'pod-is-a-path': (a) =>
    `This pod is a path on ${host(a.pod)}, not the root of its own host. WebFinger is `
    + 'answered only at a host root, which this pod cannot write to, so other servers '
    + 'will not find this address. Posting and reading still work; being discovered does not.',
  'subdomain-not-guaranteed': (a) =>
    `— provided ${host(a.issuer)} gives each pod its own subdomain. Some servers put pods `
    + `at ${host(a.issuer)}/<name>/ instead, and a pod sharing a host cannot answer WebFinger `
    + 'for an address. Setup checks which you got and says so before publishing anything.',
};
const REFUSALS = {
  'group-needs-host-root': () =>
    'A group needs a pod at the root of its own host, or nobody could ever find it. '
    + 'Give the group a pod of its own, or set this up as a person.',
};
const host = (u) => { try { return new URL(u).host; } catch { return u; } };

let editTimer = null;
function onEdit() {
  const mode = state.resumable ? 'existing' : $('form').elements.mode.value;
  $('row-podname').hidden = mode !== 'new';
  $('row-pod').hidden = mode === 'new';
  clearTimeout(editTimer);
  editTimer = setTimeout(preview, 150);
}

async function preview() {
  const a = answers();
  $('preview-notes').textContent = '';
  if (!a.handle || (a.mode === 'existing' && !a.pod)) { $('preview').textContent = '…'; return; }
  if (state.resumable) { $('preview').textContent = `@${a.handle}@…`; return; }
  const { json } = await postJson('/setup/check', a);
  if (!json) return;
  $('preview').textContent = json.address || '…';
  const notes = $('preview-notes');
  for (const w of json.warnings || []) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = NOTES[w] ? NOTES[w](a) : w;
    notes.appendChild(p);
  }
  if (json.refusal) {
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = REFUSALS[json.refusal] ? REFUSALS[json.refusal]() : json.refusal;
    notes.appendChild(p);
  }
  $('submit').disabled = !!json.refusal;
}

async function onSubmit(ev) {
  ev.preventDefault();
  $('form-error').hidden = true;
  $('submit').disabled = true;
  const { status, json } = await postJson('/setup', answers());
  if (status !== 202) {
    $('submit').disabled = false;
    $('form-error').hidden = false;
    $('form-error').textContent = json?.error || `setup refused (HTTP ${status})`;
    return;
  }
  watchRun();
}

// ---- the run ----

const LABELS = {
  account: 'Creating the account and pod',
  credential: 'Minting a credential for this machine',
  bootstrap: 'Provisioning the pod',
  connect: 'Connecting',
  publish: 'Publishing the actor',
  verify: 'Checking the world can see it',
};
const MARKS = { waiting: '·', running: '⟳', ok: '✓', skipped: '–', error: '✗' };

async function watchRun() {
  show('pane-run');
  $('strap').textContent = 'setting up';
  const { json: run } = await api('/setup/progress');
  if (!run) return;
  renderRun(run);
  if (run.phase === 'running') return setTimeout(watchRun, 700);
  if (run.phase === 'done') return paneDone(run.result);
  $('run-title').textContent = 'Setup stopped';
  $('run-error').hidden = false;
  $('run-error').textContent = run.error || 'unknown error';
  $('run-again').hidden = false;
  $('run-again').onclick = async () => {
    // Re-read the state: a run that got as far as the credential resumes from
    // there rather than minting a second one.
    const { json } = await api('/setup/state');
    state = json || state;
    paneForm();
  };
}

function renderRun(run) {
  const ul = $('run-steps');
  ul.textContent = '';
  for (const s of run.steps) {
    const li = document.createElement('li');
    const mark = document.createElement('span');
    mark.className = 'state';
    mark.textContent = MARKS[s.state] || '·';
    li.appendChild(mark);
    li.appendChild(document.createTextNode(LABELS[s.key] || s.key));
    if (s.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = s.note;
      li.appendChild(note);
    }
    ul.appendChild(li);
  }
}

function paneDone(result) {
  $('strap').textContent = 'set up';
  show('pane-done');
  $('done-address').textContent = result?.address || `@${result?.handle} — no resolvable address`;
  const notes = [];
  if (!result?.resolvable) {
    notes.push(`${result?.pod} is not the root of its own host, so this address cannot be `
      + 'discovered by other servers. Posting and reading still work.');
  }
  if (result?.unreachable?.length) {
    notes.push(`Not readable without credentials yet: ${result.unreachable.join(', ')}. `
      + 'Other servers cannot fetch this actor until that clears.');
  }
  $('done-note').className = notes.length ? 'warn' : '';
  $('done-note').textContent = notes.join(' ');

  const links = $('done-links');
  links.textContent = '';
  const add = (href, text) => {
    if (links.hasChildNodes()) links.appendChild(document.createTextNode(' · '));
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    links.appendChild(a);
  };
  if (result?.kind !== 'group') add('/', 'Open the client');
  add('/admin/', 'Edit the record');
}

start();
