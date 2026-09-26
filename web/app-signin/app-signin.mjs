// app-signin.mjs — a Mastodon app asked to use an account at this gateway
// (lib/gateway/masto-gateway.mjs). The person gives their address here, signs
// in at their own pod with the fediverse-account library, and the page proves
// that sign-in to the gateway with one signed request; the gateway hands the
// app its code. No password of ours anywhere.
import { fediLogin } from './fedi-login.mjs';

const $ = (id) => document.getElementById(id);
const say = (text, error = false) => { const s = $('signin-status'); s.textContent = text; s.setAttribute('role', error ? 'alert' : 'status'); };
const here = location.origin + location.pathname;
const params = new URLSearchParams(location.search);
// The address last used here, so the trip to the pod and back does not ask again.
const KEY = 'fedipod-app-address';
const remembered = () => { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY) || ''; } catch { return ''; } };
const remember = (a) => { try { sessionStorage.setItem(KEY, a); localStorage.setItem(KEY, a); } catch { /* keeps no site data */ } };
const login = fediLogin({ dbName: 'fedipod-app-signin', clientName: 'Sign in to an app', redirectUri: here });
// The person's own yes to this app, given by pressing the button in this tab.
// It rides the trip to the pod and back, and nothing else stands for it: a
// page that sends someone here, signed in before, gets nothing without it.
const CONSENT = 'fedipod-app-consent';
const request = `${params.get('client_id')}\n${params.get('redirect_uri') || ''}`;
const consented = () => { try { return sessionStorage.getItem(CONSENT) === request; } catch { return false; } };
const consent = (on) => { try { if (on) sessionStorage.setItem(CONSENT, request); else sessionStorage.removeItem(CONSENT); } catch { /* keeps no site data */ } };

// Back from the pod: this finishes the sign-in and returns to the app's request.
try { await login.resume(); } catch (e) { say(e.message, true); }

// Proves the pod sign-in to the gateway. True when the app has its code.
async function prove(address) {
  const s = await login.getSession();
  if (!s || !consented()) return false;
  consent(false);
  say('Signing you in…');
  const res = await s.fetch(`${location.origin}/api/authorize`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...Object.fromEntries(params), address }),
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d.redirect) { say('Signed in. Going back to the app…'); location.href = d.redirect; return true; }
  if (res.ok && d.code) { say(`Signed in. The app asks you to paste this code into it: ${d.code}`); return true; }
  say(d.error || `The sign-in was refused (HTTP ${res.status}).`, true);
  return false;
}

async function start() {
  if (!params.get('client_id')) { say('This page is for an app that asked to use your account. Start from the app.', true); return; }
  const r = await fetch(`/api/authorize?${new URLSearchParams({ client_id: params.get('client_id'), redirect_uri: params.get('redirect_uri') || '' })}`);
  const app = await r.json().catch(() => ({}));
  if (!r.ok) { say(app.error || `This app cannot sign in here (HTTP ${r.status}).`, true); return; }
  const asking = $('asking');
  const name = document.createElement('strong');
  name.textContent = app.name;
  asking.append(name, ' is asking to use your account');
  if (app.sendsTo) { const where = document.createElement('code'); where.textContent = app.sendsTo; asking.append(', and will be sent back to ', where); }
  asking.append('.');
  asking.hidden = false;
  const address = remembered();
  $('address').value = address;
  // Back from the pod after pressing the button: finish. Otherwise ask.
  if (!(address && consented() && await prove(address))) $('signin-form').hidden = false;
}

$('signin-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const address = $('address').value.trim();
  if (!address) { say('Write your address here first.', true); return; }
  const r = await fetch(`/api/authorize?address=${encodeURIComponent(address)}`);
  const who = await r.json().catch(() => ({}));
  if (!r.ok) { say(who.error || `That address was not found (HTTP ${r.status}).`, true); return; }
  remember(address);
  consent(true);
  const s = await login.getSession();
  if (s && s.webId === who.webId) { await prove(address); return; }
  say('Taking you to your pod…');
  try { await login.login(who.webId, { returnTo: location.href, redirectUri: here }); } catch (e) { say(e.message, true); }
});

await start();
