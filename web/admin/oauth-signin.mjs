// oauth-signin.mjs — a client asked this account to sign its owner in. The
// owner signs in at their own pod, with the fediverse-account library, and the
// page proves that sign-in to the account with one signed request; the account
// then hands the client its code. No password of ours anywhere.
import { fediLogin } from './fedi-login.mjs';

const $ = (id) => document.getElementById(id);
const say = (text, error = false) => { const s = $('signin-status'); s.textContent = text; s.setAttribute('role', error ? 'alert' : 'status'); };
const webId = $('webid').href;
const here = location.origin + location.pathname;
const login = fediLogin({ dbName: 'fedipod-signin', clientName: 'FediPod sign-in', redirectUri: here });

// Back from the pod: this finishes the sign-in and returns to the client's
// request, which carries the client's own parameters.
try { await login.resume(); } catch (e) { say(e.message, true); }

async function prove() {
  const s = await login.getSession();
  if (!s) return false;
  if (s.webId !== webId) { say(`You signed in as ${s.webId}, but this account belongs to ${webId}. Sign out there and sign in as the owner.`, true); return true; }
  say('Signing you in…');
  const res = await s.fetch(here, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: location.search.replace(/^\?/u, ''),
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d.redirect) { location.href = d.redirect; return true; }
  if (res.ok && d.code) { say(`Your authorization code: ${d.code}`); return true; }
  say(d.error || `The account refused the sign-in (HTTP ${res.status}).`, true);
  return true;
}

if (location.search.includes('client_id=') && !(await prove())) $('signin').hidden = false;
$('signin').addEventListener('click', async () => {
  say('Taking you to your pod…');
  try { await login.login(webId, { returnTo: location.href, redirectUri: here }); } catch (e) { say(e.message, true); }
});
