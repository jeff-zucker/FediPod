// boot.mjs — the page side of the browser agent.
//
// Login is a Solid-OIDC redirect: the page sends you to your pod's login, and on
// return the session is kept in IndexedDB (a non-extractable DPoP key + refresh
// token, see oidc-session.mjs). The agent runs in the service worker, which reads
// that same session from IndexedDB. So a returning visit restores silently, and
// a new browser signs in with one redirect.
//
//   New account:  fedipodSignup(answers)  — create the account, then redirect.
//   Returning:    fedipodSignin({ issuer }) — redirect to the pod's login.
//   On every load: fedipodOnLoad() — finish a redirect, or restore, then boot.
import { signUp, handleProblem, AP_ROOT } from './signup.mjs';
import * as podActor from '../../lib/pod/actor.mjs';
import { beginLogin, completeLogin, getSession, signOut } from './oidc-session.mjs';
import { unwrapKeys, isKeyEnvelope } from './keystore.mjs';
import { kvPut } from './idb-kv.mjs';
import { keyCacheKey } from './keys-browser.mjs';

const REDIRECT = `${location.origin}/`;   // the app root doubles as the OIDC callback

async function bootWorker({ reset = false } = {}) {
  const reg = await navigator.serviceWorker.register('/sw.js', { type: 'module' });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  }
  const worker = reg.active || navigator.serviceWorker.controller;
  // A fresh login means a possibly different identity, and the worker may still
  // be holding the last one. Make it let go before it is asked to boot, and
  // wait for the acknowledgement — posting and racing on would let the boot
  // land while the old agent was still installed.
  if (reset) {
    await new Promise((res) => {
      const on = (e) => {
        if (e.data?.type !== 'reset-done') return;
        navigator.serviceWorker.removeEventListener('message', on);
        res();
      };
      navigator.serviceWorker.addEventListener('message', on);
      worker.postMessage({ type: 'reset' });
      setTimeout(res, 2000);      // an older worker will not answer; boot anyway
    });
  }
  const booted = new Promise((res, rej) => {
    const on = (e) => {
      if (e.data?.type === 'booted') { navigator.serviceWorker.removeEventListener('message', on); res(); }
      if (e.data?.type === 'boot-error') { navigator.serviceWorker.removeEventListener('message', on); const err = new Error(e.data.error); err.detail = e.data.stack || ''; err.code = e.data.code || null; rej(err); }
    };
    navigator.serviceWorker.addEventListener('message', on);
  });
  worker.postMessage({ type: 'boot', frontOrigin: location.origin });
  await booted;
}

// A browser that has signed in but has never opened this account's signing key.
//
// The key on the pod is wrapped under the account password (signup.mjs), which
// is what keeps the pod's host from being able to sign as you. Opening it needs
// the password once per browser; after that the opened copy lives in this
// origin's IndexedDB and the worker boots from it with nothing to ask.
//
// The unwrap happens HERE, in the page, and not in the worker: the worker boots
// itself whenever the browser restarts it, with nobody present to type anything.
window.fedipodUnlock = async (password) => {
  if (!password) throw new Error('Enter your account password.');
  const session = await getSession();
  if (!session) throw new Error('Sign in first.');
  // The config on the pod says where this account's state lives; the key sits
  // beside it. Both are read with the session, as the owner.
  const podFromWebId = new URL(session.webId).origin + '/';
  const state = `${podFromWebId}${AP_ROOT}ap-state/`;
  const readJson = async (url) => {
    const r = await session.fetch(url, { headers: { accept: 'application/json' } });
    if (r.status >= 400) throw new Error(`could not read ${url} (HTTP ${r.status})`);
    return r.json();
  };
  const [cfg, doc] = await Promise.all([readJson(state + 'config.json'), readJson(state + 'keys.json')]);
  if (!isKeyEnvelope(doc)) throw new Error('this account\'s key is not locked — nothing to unlock');
  const rec = await unwrapKeys(doc, password);          // throws 'wrong password'
  const actorUrl = `${cfg.remotePod}${cfg.root || AP_ROOT}ap/actor`;
  await kvPut(keyCacheKey(actorUrl), rec);
  await bootWorker();
};

// New account: create the account, pod, key, config and gateway attach (this
// needs the password once), then redirect to the pod's login to establish the
// durable session. The agent boots on return, reading config + key from the pod.
window.fedipodSignup = async ({ onStep, ...answers }) => {
  await signUp(answers, { onStep, frontOrigin: location.origin });
  const { authorizationUrl } = await beginLogin({ issuer: answers.issuer, redirectUri: REDIRECT });
  location.href = authorizationUrl;
};

// Returning / new browser: sign-in takes the full Fediverse address, @you@yourpod.
// The host part IS the pod (a FediPod address lives at a host root), so the pod is
// `https://<host>/`. The pod's actor says where to sign in; we fall back to the
// host's parent domain when the pod does not answer. Everything else — the account
// config and the key — is read from the pod on return.
export function parseAddress(input) {
  let s = String(input || '').trim();
  if (s.startsWith('@')) s = s.slice(1);          // @you@yourpod → you@yourpod
  const at = s.indexOf('@');
  if (at < 1) return null;                         // needs a handle and a host
  const handle = s.slice(0, at).toLowerCase();
  const host = s.slice(at + 1).toLowerCase().replace(/\/+$/, '');
  if (!handle || !host || !host.includes('.')) return null;
  return { handle, host };
}
async function issuerForPod(pod) {
  // The pod's actor says where a client signs in (oauthAuthorizationEndpoint's
  // origin); failing that, the account provider is the pod host's parent domain.
  try {
    const authz = await podActor.readIssuer(`${pod}${AP_ROOT}ap/actor`);
    if (authz) return new URL(authz).origin;
  } catch { /* fall through */ }
  const host = new URL(pod).host;
  const parent = host.split('.').slice(1).join('.');
  return `https://${parent || host}`;
}
window.fedipodSignin = async ({ address }) => {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error('Enter your address as @you@yourpod (for example @alice@alice.solidcommunity.net).');
  const bad = handleProblem(parsed.handle);
  if (bad) throw new Error(bad);
  const pod = `https://${parsed.host}/`;
  const issuer = await issuerForPod(pod);
  const { authorizationUrl } = await beginLogin({ issuer, redirectUri: REDIRECT });
  location.href = authorizationUrl;
};

// Called on every page load. Returns 'signed-in' | 'restored' | 'anonymous'.
window.fedipodOnLoad = async () => {
  if (new URLSearchParams(location.search).get('code')) {
    await completeLogin({ currentUrl: location.href });
    history.replaceState({}, '', REDIRECT);
    await bootWorker({ reset: true });        // this may be a different account
    return 'signed-in';
  }
  if (await getSession()) { await bootWorker(); return 'restored'; }
  return 'anonymous';
};

window.fedipodSignOut = async () => {
  await signOut();
  // The client (Phanpy) keeps its own account and token in this origin's
  // localStorage, which outlives the OIDC sign-out and would silently sign you
  // back in as the same identity — so signing out has to clear it too.
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage blocked */ }
  // The worker holds a connection to the connected-accounts store, so stop it
  // before deleting that store. Browser-stored Bluesky/fediverse keys are wiped
  // here; pod-stored ones stay on the pod and return when you sign in again.
  const reg = await navigator.serviceWorker.getRegistration(); await reg?.unregister();
  await new Promise((res) => {
    let req; try { req = indexedDB.deleteDatabase('fedipod-accounts'); } catch { res(); return; }
    req.onsuccess = req.onerror = req.onblocked = () => res();
  });
};
window.fedipodHandleProblem = handleProblem;

// --- page UI wiring (runs only in the page, never the worker) ---
//
// Three ways in, matching the front page:
//   signed-in / restored session  → straight to the feed (/app/)
//   have an account, new browser  → type @you@yourpod, redirect to your pod's login
//   no account                    → "create an account" reveals the register form
if (typeof document !== 'undefined') (async () => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  // The client shell's bar returns here for two things, and neither continues
  // into the client: `?signout` clears the FediPod session, the client's stored
  // account, and the worker on this browser; `?add` comes back to reach a
  // different pod (signing in anew replaces the session). Both show the sign-in
  // page.
  if (params.has('signout') || params.has('add')) {
    if (params.has('signout')) { try { await window.fedipodSignOut(); } catch { /* nothing to tear down */ } }
    history.replaceState({}, '', '/');
    $('loading').hidden = true;
    $('landing').hidden = false;
  } else {
    let state = 'anonymous';
    try { state = await window.fedipodOnLoad(); }
    catch (e) {
      // A browser that has never opened this account's key is not a failure —
      // it is the ordinary state of a NEW browser, and the answer is a password
      // field rather than a stack trace. Everything else falls through below.
      if (e.code === 'key-password-needed') {
        $('loading').hidden = true; $('hero').hidden = true; $('landing').hidden = true;
        $('brand').hidden = false; $('unlock').hidden = false;
        $('unlock-password').focus();
        return;
      }
      // We logged in (or had a saved session) but the agent could not start.
      // Show exactly why — including where it threw — instead of silently
      // dropping back to the landing, which hides every real failure.
      console.error(e);
      $('loading').hidden = true; $('hero').hidden = true; $('landing').hidden = true;
      $('brand').hidden = false; $('running').hidden = false;
      $('running-title').textContent = 'Signed in, but the agent could not start';
      $('run-error').style.whiteSpace = 'pre-wrap';
      $('run-error').textContent = (e.message || String(e)) + (e.detail ? `\n\n${e.detail}` : '');
      $('run-actions').hidden = false;
      $('run-retry').textContent = 'Reload'; $('run-retry').addEventListener('click', () => location.reload());
      $('run-back').textContent = 'Sign out'; $('run-back').addEventListener('click', async () => { try { await window.fedipodSignOut(); } catch {} location.href = '/'; });
      return;
    }
    // Into the client shell: the FediPod bar over the framed client (the same
    // web/admin surface as local). Its own script signs the framed client in on
    // a fresh session and forwards deep links on a returning one, so both a
    // fresh sign-in and a restored session land in the same place.
    if (state === 'signed-in' || state === 'restored') { location.href = '/admin/client/'; return; }

    // Anonymous: show the landing (sign-in address + create-account); form stays hidden.
    $('loading').hidden = true;
    $('landing').hidden = false;
  }

  // Views. The register form stands alone: the marketing hero and the sign-in
  // landing give way to the short brand, so only "FediPod" and the form show.
  const showLanding = () => { $('pane-form').hidden = true; $('running').hidden = true; $('brand').hidden = true; $('hero').hidden = false; $('landing').hidden = false; };
  const showForm = () => { $('hero').hidden = true; $('landing').hidden = true; $('brand').hidden = false; $('pane-form').hidden = false; goStep(1); };

  // --- unlock: this browser's first use of an account whose key is locked ---
  const doUnlock = async () => {
    $('unlock-error').textContent = '';
    const btn = $('unlock-go'); btn.disabled = true;
    try {
      await window.fedipodUnlock($('unlock-password').value);
      $('unlock-password').value = '';
      location.href = '/admin/client/';
    } catch (err) {
      // 'wrong password' is what unwrapKeys throws on a failed AES-GCM auth,
      // which is the only way to tell a typo from a real problem.
      $('unlock-error').textContent = err.message || String(err);
      btn.disabled = false;
      $('unlock-password').select();
    }
  };
  $('unlock-go')?.addEventListener('click', doUnlock);
  $('unlock-password')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });

  // --- sign in: the full @you@yourpod address → redirect to your pod's login ---
  const doSignin = async () => {
    $('signin-error').textContent = '';
    try { await window.fedipodSignin({ address: $('signin-address').value }); }
    catch (err) { $('signin-error').textContent = err.message; }
  };
  $('signin').addEventListener('click', doSignin);
  $('signin-address').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSignin(); } });

  // --- register form: two screens, pod first then Fediverse identity ---
  const f = () => $('form').elements;
  // The pod provider is a free-text URL; default and normalise to a scheme.
  const providerUrl = () => { let v = f().provider.value.trim(); if (!v) v = 'https://solidcommunity.net'; if (!/^https?:\/\//i.test(v)) v = 'https://' + v; return v; };
  const providerHost = () => { try { return new URL(providerUrl()).host; } catch { return ''; } };
  // The pod is always a subdomain of the provider, so both new and existing pods
  // resolve to https://<subdomain>.<provider-host>/ and carry a host-root address.
  const podHostOf = () => { const sub = f().podName.value.trim().toLowerCase(); const ph = providerHost(); return (sub && ph) ? `${sub}.${ph}` : ''; };
  const answers = () => {
    const mode = f().mode.value;
    const a = { mode, handle: f().handle.value.trim().toLowerCase(), email: f().email.value.trim(),
      password: f().password.value, issuer: providerUrl() };
    if (mode === 'new') a.podName = f().podName.value.trim().toLowerCase();
    else a.pod = `https://${podHostOf()}/`;
    return a;
  };
  const previewAddr = () => {
    const handle = f().handle.value.trim().toLowerCase(); const ph = podHostOf();
    $('preview').textContent = (handle && ph) ? `@${handle}@${ph}` : '@…@…';
  };
  for (const el of $('form').elements) el.addEventListener('input', previewAddr);

  // Step machine: one screen at a time, each gated by its own validation.
  const STEP_IDS = ['step-1', 'step-2'];
  const FOCUS = { 1: 'provider', 2: 'handle' };
  const goStep = (n) => {
    STEP_IDS.forEach((id, i) => { $(id).hidden = i !== n - 1; });
    $('err-1').textContent = ''; $('form-error').textContent = '';
    if (n === 2) previewAddr();
    if (FOCUS[n]) $(FOCUS[n]).focus();
  };
  const validateStep1 = () => {
    if (!providerHost()) return 'A valid pod provider URL is required.';
    const sub = f().podName.value.trim().toLowerCase();
    if (!sub) return 'A pod username/subdomain is required.';
    const sp = window.fedipodHandleProblem(sub);
    if (sp) return `Pod username: ${sp}`;
    if (!f().email.value.trim()) return 'A pod email is required.';
    if (!f().password.value) return 'A pod password is required.';
    return null;
  };
  const validateStep2 = () => {
    const hp = window.fedipodHandleProblem(f().handle.value.trim().toLowerCase());
    if (hp) return `Fediverse handle: ${hp}`;
    return null;
  };
  $('create').addEventListener('click', showForm);
  $('cancel').addEventListener('click', () => { showLanding(); goStep(1); });
  $('to-2').addEventListener('click', () => { const e = validateStep1(); if (e) { $('err-1').textContent = e; return; } goStep(2); });
  $('back-1').addEventListener('click', () => goStep(1));

  // From the setup screen back to the form (a failed run) or the landing.
  const backToForm = (errMsg) => {
    $('running').hidden = true; $('brand').hidden = false; $('pane-form').hidden = false;
    goStep(1);
    if (errMsg) $('err-1').textContent = errMsg;   // remind them what failed
  };
  $('run-retry').addEventListener('click', () => backToForm($('run-error').textContent));
  $('run-back').addEventListener('click', () => { showLanding(); goStep(1); });

  const LABELS = { account: 'Creating your account and pod', credential: 'Preparing this browser', keys: 'Making your signing key', gateway: 'Connecting your mail door' };
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('form-error').textContent = '';
    const e1 = validateStep1(); if (e1) { $('form-error').textContent = e1; goStep(1); $('err-1').textContent = e1; return; }
    const e2 = validateStep2(); if (e2) { $('form-error').textContent = e2; goStep(2); return; }
    const a = answers();
    $('pane-form').hidden = true; $('running').hidden = false;
    $('running-title').textContent = 'Setting up…'; $('run-error').textContent = ''; $('run-actions').hidden = true;
    const steps = $('steps'); steps.textContent = ''; const mark = {};
    const onStep = (k, st) => { if (!mark[k]) { const li = document.createElement('li'); steps.appendChild(li); mark[k] = li; } mark[k].textContent = (st === 'ok' ? '✓ ' : st === 'running' ? '… ' : '') + (LABELS[k] || k); };
    try { await window.fedipodSignup({ ...a, onStep }); }
    catch (err) {
      $('running-title').textContent = 'Setup did not finish';
      $('run-error').textContent = err.message || String(err);
      $('run-actions').hidden = false;                // the way out of the failure screen
    }
  });
})();
