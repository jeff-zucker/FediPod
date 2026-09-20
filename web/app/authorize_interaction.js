// authorize_interaction.js — the script for the remote-follow page.
//
// It reads who is to be followed out of the `uri` parameter, asks the agent in
// this browser who it is, and sends the follow through the same same-origin
// route the record page uses (/follow, admin-facade.mjs). The header is what
// the service worker's gate reads: a cross-site form cannot set one, and a
// cross-origin fetch that does is preflighted and never answered (sw-src.mjs).
const PAGE = { 'x-fedipod-page': '1' };
const $ = (id) => document.getElementById(id);

const say = (text, kind = '') => { const m = $('msg'); m.textContent = text; m.className = `msg ${kind}`.trim(); };

// What the other server put in `uri`: an acct URI, a bare or @-prefixed
// handle, or the actor's address. Anything with a scheme is taken as the
// actor itself — pasting an actor url is a normal way to follow.
function readTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^https?:\/\//iu.test(s)) return { actor: s, label: s };
  const handle = s.replace(/^acct:/iu, '').replace(/^@/u, '');
  if (!/^[^@\s/]+@[^@\s/]+$/u.test(handle)) return null;
  return { handle, label: `@${handle}` };
}

const target = readTarget(new URLSearchParams(location.search).get('uri'));

async function whoIsHere() {
  try {
    const res = await fetch('/config', { headers: PAGE });
    if (!res.ok) return null;
    const cfg = await res.json();
    return cfg.address || (cfg.handle ? `@${cfg.handle}` : null);
  } catch { return null; }
}

async function follow() {
  $('go').disabled = true;
  say('sending…');
  try {
    const res = await fetch('/follow', {
      method: 'POST', headers: { ...PAGE, 'content-type': 'application/json' },
      body: JSON.stringify(target.actor ? { actor: target.actor } : { handle: target.handle }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { say(out.error || `the follow was refused (${res.status})`, 'err'); $('go').disabled = false; return; }
    // A Follow is delivered, not granted: it counts once the other server
    // answers it, and a locked account answers when its owner gets to it.
    say(`sent to ${target.label} — it counts once their server accepts it`, 'ok');
    $('go').hidden = true;
  } catch (err) {
    say(err.message || 'the follow could not be sent', 'err');
    $('go').disabled = false;
  }
}

(async () => {
  if (!target) {
    $('target').textContent = 'nobody';
    say('This address opens from another server’s Follow button, and it did not name anybody to follow.', 'err');
    return;
  }
  $('target').textContent = target.label;
  const me = await whoIsHere();
  if (!me) { $('by-hand').hidden = false; return; }
  $('as').textContent = `signed in as ${me}`;
  $('as').hidden = false;
  $('go').hidden = false;
  $('go').addEventListener('click', follow);
})();
