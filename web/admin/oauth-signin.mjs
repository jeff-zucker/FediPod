// oauth-signin.mjs — a client asked this account to sign its owner in. The
// owner signs in at their own pod, with the fediverse-session library, and the
// page proves that sign-in to the account with one signed request; the account
// then hands the client its code. No password of ours anywhere.
import { fediLogin } from './fedi-login.mjs';

const $ = (id) => document.getElementById(id);
const say = (text, error = false) => { const s = $('signin-status'); s.textContent = text; s.setAttribute('role', error ? 'alert' : 'status'); };
const webId = $('webid').href;
const here = location.origin + location.pathname;
const params = new URLSearchParams(location.search);
const login = fediLogin({ dbName: 'fedipod-signin', clientName: 'FediPod sign-in', redirectUri: here });
// The owner's own yes to this client, given by pressing Allow in this tab. It
// rides the trip to the pod and back, and nothing else stands for it: a link
// that lands here with a pod sign-in already stored gets nothing without it.
// The same rule as the Gateway's app sign-in (web/app-signin/app-signin.mjs).
const CONSENT = 'fedipod-signin-consent';
const request = `${params.get('client_id')}\n${params.get('redirect_uri') || ''}`;
const consented = () => { try { return sessionStorage.getItem(CONSENT) === request; } catch { return false; } };
const consent = (on) => { try { if (on) sessionStorage.setItem(CONSENT, request); else sessionStorage.removeItem(CONSENT); } catch { /* keeps no site data */ } };

// Back from the pod: this finishes the sign-in and returns to the client's
// request, which carries the client's own parameters.
try { await login.resume(); } catch (e) { say(e.message, true); }

// Proves the pod sign-in to the account. True when nothing more is asked here.
async function prove() {
  const s = await login.getSession();
  if (!s || !consented()) return false;
  consent(false);
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

const choices = (shown) => { $('signin').hidden = !shown; $('cancel').hidden = !shown; };

$('signin').addEventListener('click', async () => {
  consent(true);
  choices(false);
  if (await prove()) return;
  say('Taking you to your pod…');
  try { await login.login(webId, { returnTo: location.href, redirectUri: here }); } catch (e) { say(e.message, true); choices(true); }
});
$('cancel').addEventListener('click', () => {
  consent(false);
  choices(false);
  say('Nothing was allowed. You can close this page.');
});

// Back from the pod after pressing Allow: finish. Otherwise ask.
if (params.get('client_id') && !(consented() && await prove())) choices(true);
