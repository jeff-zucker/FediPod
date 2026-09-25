// boot.mjs — the page side of the browser agent.
//
// Login is a Solid-OIDC redirect: the page sends you to your pod's login, and on
// return the session is kept in IndexedDB (a non-extractable DPoP key + refresh
// token, see oidc-session.mjs). The agent runs in the service worker, which reads
// that same session from IndexedDB. So a returning visit restores silently, and
// a new browser signs in with one redirect.
//
//   New account:  fedipodPodLogin({ issuer }) — sign in at the pod, and come
//                 back to the identity screen; fedipodSignup(answers) then
//                 sets the account up on that session and boots.
//   Move in:      the same door, on a pod whose account lives at ANOTHER
//                 gateway: the identity screen becomes a move, and
//                 fedipodMoveIn(answers) brings the address here.
//   Returning:    fedipodSignin({ address }) — redirect to the pod's login.
//   On every load: fedipodOnLoad() — finish a redirect, or restore, then boot.
import { signUp, moveIn, readAccount, handleProblem } from './signup.mjs';
import { podRootPath, chosenRoot } from '../../lib/core/place.mjs';
import * as podActor from '../../lib/pod/actor.mjs';
import * as podState from '../../lib/pod/state.mjs';
import { podBaseOfWebId } from '../../lib/pod/urls.mjs';
import { resourceExists } from '../../lib/pod/root.mjs';
import { BrowserRemotePod } from './pod-remote.mjs';
import { beginLogin, completeLogin, getSession, signOut } from './oidc-session.mjs';
import { generateKeys, unwrapKeys, isKeyEnvelope } from './keystore.mjs';
import { cacheOpenedKeys } from './keys-browser.mjs';

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

// An account made before 1.28.0, whose key on the pod is still under the
// sign-up password. Since 1.28.0 the key is stored as it is, behind the pod's
// own login, and a new browser reads it with its session (keys-browser.mjs).
// One of these older accounts is opened once, with the password, and the key
// is then written back as it is — so no browser ever asks again.
//
// The unwrap happens HERE, in the page, and not in the worker: the worker boots
// itself whenever the browser restarts it, with nobody present to type anything.
//
// Both paths below read the account's config and key the same way: with the
// session, as the owner, through the transport rather than the bare session —
// a pod read like any other, with the retry ladder that exists because the pod
// host throttles bursts.
async function readAccountState() {
  const session = await getSession();
  if (!session) throw new Error('Sign in first.');
  // Wherever its owner put it: the type index says, or it is an older account
  // at `fedipod/` (signup.mjs readAccount).
  const here = await readAccount(session);
  if (!here) throw new Error(`could not find a FediPod account on ${podBaseOfWebId(session.webId)}`);
  const remote = new BrowserRemotePod(session, { webId: session.webId, role: 'signup', log: () => {} });
  const urls = { state: `${here.pod}${here.root}ap-state/` };
  const doc = await podState.readKeys(remote, urls);
  const actorUrl = `${here.config.remotePod || here.pod}${here.config.root || here.root}ap/actor`;
  return { remote, urls, cfg: here.config, doc, actorUrl };
}

window.fedipodUnlock = async (password) => {
  if (!password) throw new Error('Enter your password.');
  const { remote, urls, doc, actorUrl } = await readAccountState();
  if (!doc) throw new Error('could not read this account\'s key on the pod');
  if (!isKeyEnvelope(doc)) throw new Error('this account\'s key is not under a password — nothing to unlock');
  const rec = await unwrapKeys(doc, password);          // throws 'wrong password'
  // Stored as it is from here on: the next browser reads it with the pod
  // login and asks for nothing.
  await podState.writeKeys(remote, urls, rec);
  await cacheOpenedKeys(actorUrl, rec);
  await bootWorker();
};

// The same pane, for someone who no longer has the old password: a new key,
// stored as it is, written over the pod's copy. Nothing is unwrapped, so the
// old password is never needed. The boot that follows publishes the new public
// key (agent.goActive → publishProfile).
window.fedipodNewKey = async () => {
  const { remote, urls, cfg, actorUrl } = await readAccountState();
  const keys = await generateKeys();
  keys.mintedFor = cfg.gateway?.frontActor || actorUrl;   // one key, one actor (signup.mjs)
  await podState.writeKeys(remote, urls, keys);
  await cacheOpenedKeys(actorUrl, keys);
  await bootWorker();
};

// New account, first half: sign in at the pod. The pod already exists — made
// on the provider's own page, or brought — and its login is the only place
// a password is ever typed. `returnTo` marks the way back as a sign-up, so
// the load that follows shows the identity screen instead of booting.
const SIGNUP_RETURN = 'signup';
const issuerOf = (v) => { let s = String(v || '').trim(); if (!s) throw new Error('A pod provider is required.'); if (!/^https?:\/\//i.test(s)) s = 'https://' + s; return new URL(s).origin; };
window.fedipodPodLogin = async ({ issuer }) => {
  const { authorizationUrl } = await beginLogin({ issuer: issuerOf(issuer), redirectUri: REDIRECT, returnTo: SIGNUP_RETURN });
  location.href = authorizationUrl;
};
// Second half, back on the session: key, config and gateway attach on the pod,
// then the agent boots here. Nothing is typed and nothing leaves the browser
// but pod writes on the session the pod itself issued.
window.fedipodSignup = async ({ onStep, ...answers }) => {
  const session = await getSession();
  if (!session) throw new Error('Sign in at your pod first.');
  await signUp(answers, { session, onStep, frontOrigin: location.origin });
  await bootWorker({ reset: true });
};
// An account whose address lives at another gateway, moving here: the pod's
// part (signup.mjs moveIn), then a boot under the new ids, which finishes
// the move by telling the old gateway and the followers (gateway-move.mjs).
window.fedipodMoveIn = async ({ onStep, ...answers }) => {
  const session = await getSession();
  if (!session) throw new Error('Sign in at your pod first.');
  await moveIn(answers, { session, onStep, frontOrigin: location.origin });
  await bootWorker({ reset: true });
};
// Set on the load that finds an account at another gateway; read by the
// identity screen, which then offers a move instead of a new account.
let moveFrom = null;

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
async function issuerForActor(actorUrl) {
  // The pod's actor says where a client signs in (oauthAuthorizationEndpoint's
  // origin). Failing that: a host that answers OpenID discovery itself is the
  // provider (a pod on a path of a shared host), and otherwise the provider is
  // the pod host's parent domain (a subdomain pod).
  try {
    const authz = await podActor.readIssuer(actorUrl);
    if (authz) return new URL(authz).origin;
  } catch { /* fall through */ }
  const u = new URL(actorUrl);
  const own = await fetch(`${u.origin}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }).catch(() => null);
  if (own?.ok) return u.origin;
  const parent = u.host.split('.').slice(1).join('.');
  return `https://${parent || u.host}`;
}
// An address on a pod names its actor through the pod host's own WebFinger;
// an older pod that does not answer is taken to keep it at `fedipod/`.
async function actorForPodAddress(handle, host) {
  const res = await fetch(`https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${handle}@${host}`)}`,
    { headers: { accept: 'application/jrd+json, application/json' } }).catch(() => null);
  const doc = res?.ok ? await res.json().catch(() => ({})) : {};
  const self = (doc.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/u.test(l.type || ''));
  return self?.href || `https://${host}/fedipod/ap/actor`;
}
// An address at this site names a fronted identity. Its documents live on a
// pod this site's WebFinger names as an alias — the pod's own actor id.
async function actorForFrontedAddress(handle) {
  const res = await fetch(`/.well-known/webfinger?resource=${encodeURIComponent(`acct:${handle}@${location.host}`)}`,
    { headers: { accept: 'application/jrd+json, application/json' } }).catch(() => null);
  if (res?.status === 410) throw new Error(`@${handle}@${location.host} is closed: nothing on the pod behind it was touched, but the address is gone for good.`);
  if (!res || res.status >= 400) throw new Error(`nobody at this site is called @${handle}@${location.host}`);
  const doc = await res.json().catch(() => ({}));
  const podActorId = (doc.aliases || []).find((a) => /\/ap\/actor$/u.test(String(a)));
  if (!podActorId) throw new Error(`@${handle}@${location.host} lives here but names no pod to sign in to`);
  return podActorId;
}
window.fedipodSignin = async ({ address }) => {
  const parsed = parseAddress(address);
  if (!parsed) throw new Error('Enter your address as @you@yourpod (for example @alice@alice.solidcommunity.net).');
  const bad = handleProblem(parsed.handle);
  if (bad) throw new Error(bad);
  const actor = parsed.host === location.host.toLowerCase()
    ? await actorForFrontedAddress(parsed.handle)
    : await actorForPodAddress(parsed.handle, parsed.host);
  const issuer = await issuerForActor(actor);
  const { authorizationUrl } = await beginLogin({ issuer, redirectUri: REDIRECT });
  location.href = authorizationUrl;
};

// Called on every page load. Returns 'signed-in' | 'restored' | 'anonymous' |
// 'signup' | 'move-in' — the last two being a return from the pod's login
// in the middle of creating an account: with no account on the pod yet, or
// with one whose address lives at another gateway.
window.fedipodOnLoad = async () => {
  if (new URLSearchParams(location.search).get('code')) {
    const done = await completeLogin({ currentUrl: location.href });
    history.replaceState({}, '', REDIRECT);
    if (done?.returnTo === SIGNUP_RETURN) {
      const here = await readAccount(done).catch(() => null);
      if (!here) return 'signup';
      // An address at ANOTHER gateway: "create an account" here is a move
      // in, not a second account. One at this gateway, or on the pod
      // itself, is a sign-in.
      if (here.frontHost && here.frontHost !== location.host) { moveFrom = here; return 'move-in'; }
    }
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
  // Set by the load below and acted on at the end, once the form is wired:
  // the identity screen needs the step machine, which is built further down.
  let pendingIdentity = false;

  // --- unlock: this browser's first use of an account whose key is locked ---
  //
  // Wired FIRST, before anything that can leave this function early. Showing the
  // pane is one of those early exits, so registering the handler further down
  // meant the pane appeared with a dead button: the one browser that needs it is
  // the only one that never got it.
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
  // The new-key path: one click reveals the confirmation, the second acts.
  $('unlock-newkey')?.addEventListener('click', () => {
    $('unlock-newkey-confirm').hidden = false;
    $('unlock-password').focus();
  });
  const doNewKey = async () => {
    $('unlock-error').textContent = '';
    const btn = $('unlock-newkey-go'); btn.disabled = true;
    try {
      await window.fedipodNewKey();
      $('unlock-password').value = '';
      location.href = '/admin/client/';
    } catch (err) {
      $('unlock-error').textContent = err.message || String(err);
      btn.disabled = false;
    }
  };
  $('unlock-newkey-go')?.addEventListener('click', doNewKey);


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
      // What the agent could name. Most of these the page can act on ITSELF,
      // and does: a sign-in the pod will not take is renewed (and, if the
      // renewal is refused too, taken back to the pod's own login), and a pod
      // that was busy or unreachable is asked again on a timer. Nobody is
      // asked to press a button to find out what happened, and nobody is left
      // pressing Reload by hand. A button is still there for whoever does not
      // want to wait — and for the failures where waiting would not help.
      //
      // Each automatic step happens ONCE per tab (`once` below): a renewal
      // that comes back refused, or a retry that fails the same way, means
      // something the page cannot fix, and the reader gets the message rather
      // than a loop.
      const once = (key) => {
        try {
          if (sessionStorage.getItem(key)) return false;
          sessionStorage.setItem(key, '1');
          return true;
        } catch { return false; }        // no storage: never automatic, always the button
      };
      const reload = () => location.reload();
      const signIn = () => { location.href = '/?add'; };
      const known = {
        'sign-in-refused': { title: 'Your pod refused this sign-in', retry: 'Sign in again', go: signIn },
        'pod-busy': { title: 'Your pod is asking for a pause', retry: 'Reload', go: reload, wait: 45 },
        'pod-error': { title: 'Your pod had an error', retry: 'Reload', go: reload, wait: 20 },
        'pod-unreachable': { title: 'Your pod could not be reached', retry: 'Reload', go: reload, wait: 20 },
        // A session with no account behind it is a sign-up that has not
        // happened yet — the person who closed the tab between the pod's
        // login and the identity screen lands here.
        'no-account-here': { title: 'No FediPod account in that pod', retry: 'Create one on this pod', go: () => showIdentity() },
        'no-account': { title: 'No FediPod account in that pod', retry: 'Create one on this pod', go: () => showIdentity() },
        'device-account': { title: 'This account is run from a device', retry: 'Use another pod', go: signIn },
        'address-closed': { title: 'This address is closed', retry: 'Sign in with another account', go: signIn },
      }[e.code];

      // A sign-in the pod would not take: renew it here, and if the pod will
      // not renew it either, go to the pod's own login. Both without asking.
      if (e.code === 'sign-in-refused' && once('fedipod-renewing')) {
        $('loading').hidden = true; $('hero').hidden = true; $('landing').hidden = true;
        $('brand').hidden = false; $('running').hidden = false;
        $('running-title').textContent = 'Renewing your sign-in';
        // Not red: nothing has gone wrong for the reader yet, something is
        // being done about it. The pane is shared with the real failures,
        // which keep the alarm colouring.
        $('run-error').style.color = 'var(--sub)';
        $('run-error').style.borderLeftColor = 'var(--line)';
        $('run-error').textContent = 'Your pod would not take the sign-in this browser is holding. Renewing it now.';
        $('run-actions').hidden = true;
        const session = await getSession().catch(() => null);
        if (session) {
          try {
            await session.refresh();
            location.reload();                     // renewed: boot again with it
            return;
          } catch { /* the pod will not renew it either: its login is the only way */ }
          try {
            const { authorizationUrl } = await beginLogin({ issuer: session.issuer, redirectUri: REDIRECT });
            location.href = authorizationUrl;
            return;
          } catch { /* cannot even reach the login: fall through and say so */ }
        }
      }

      console.error(e);
      $('loading').hidden = true; $('hero').hidden = true; $('landing').hidden = true;
      $('brand').hidden = false; $('running').hidden = false;
      $('running-title').textContent = known ? known.title : 'Signed in, but the agent could not start';
      $('run-error').style.whiteSpace = 'pre-wrap';
      $('run-error').textContent = (e.message || String(e)) + (!known && e.detail ? `\n\n${e.detail}` : '');
      $('run-actions').hidden = false;
      // The button that leads somewhere goes first. The pane is shared with the
      // sign-up flow, where "Start over" leads and "Try again" follows; here
      // the reader is being told what to do, so what to do is the first thing
      // under it.
      $('run-actions').prepend($('run-retry'));
      $('run-retry').textContent = known ? known.retry : 'Reload';
      $('run-retry').addEventListener('click', known ? known.go : reload);
      // Busy, broken or out of reach: the transport already climbed its own
      // retry ladder to get here, so this waits longer and asks once more by
      // itself. The button counts down so the wait is not a blank stare, and
      // pressing it goes now.
      if (known?.wait && once(`fedipod-waited-${e.code}`)) {
        let left = known.wait;
        const tick = () => {
          $('run-retry').textContent = left > 0 ? `Trying again in ${left}s` : 'Trying again…';
          if (left-- <= 0) { clearInterval(timer); location.reload(); }
        };
        const timer = setInterval(tick, 1000);
        tick();
      }
      $('run-back').textContent = 'Sign out'; $('run-back').addEventListener('click', async () => { try { await window.fedipodSignOut(); } catch {} location.href = '/'; });
      return;
    }
    // Into the client shell: the FediPod bar over the framed client (the same
    // web/admin surface as local). Its own script signs the framed client in on
    // a fresh session and forwards deep links on a returning one, so both a
    // fresh sign-in and a restored session land in the same place.
    if (state === 'signed-in' || state === 'restored') { location.href = '/admin/client/'; return; }
    // Back from the pod's login with no account there yet, or with one to
    // move here: the identity screen, once the form below is wired.
    if (state === 'signup' || state === 'move-in') pendingIdentity = true;
    else {
      // Anonymous: show the landing (sign-in address + create-account); form stays hidden.
      $('loading').hidden = true;
      $('landing').hidden = false;
    }
  }

  // Views. The register form stands alone: the marketing hero and the sign-in
  // landing give way to the short brand, so only "FediPod" and the form show.
  const showLanding = () => { $('pane-form').hidden = true; $('running').hidden = true; $('brand').hidden = true; $('hero').hidden = false; $('landing').hidden = false; };
  const showForm = () => { $('hero').hidden = true; $('landing').hidden = true; $('brand').hidden = false; $('pane-form').hidden = false; goStep(1); };
  // The identity screen, on a pod session: the pod is read off the WebID and
  // fixes what the form can offer (a path pod is fronted, no choice). For a
  // move in, the handle is the old one to start with, the address lives here
  // by definition, and the button says what it does.
  let signedPod = '';
  async function showIdentity() {
    const session = await getSession();
    if (!session) { showLanding(); return; }
    signedPod = podBaseOfWebId(session.webId);
    $('loading').hidden = true; $('hero').hidden = true; $('landing').hidden = true; $('running').hidden = true;
    $('brand').hidden = false; $('pane-form').hidden = false;
    $('signed-pod').textContent = signedPod;
    // The container that holds `fedipod/`: the pod's own root unless they say
    // otherwise. A move keeps the place the account already has.
    $('container').placeholder = podRootPath(signedPod);
    $('container-field').hidden = !!moveFrom;
    $('movein-note').hidden = !moveFrom;
    if (moveFrom) {
      $('movein-from').textContent = moveFrom.address;
      if (!f().handle.value) f().handle.value = moveFrom.config.handle;
      $('submit').textContent = 'Move your account here';
    }
    goStep(2);
  }


  // --- sign in: the full @you@yourpod address → redirect to your pod's login ---
  const doSignin = async () => {
    $('signin-error').textContent = '';
    try { await window.fedipodSignin({ address: $('signin-address').value }); }
    catch (err) { $('signin-error').textContent = err.message; }
  };
  $('signin').addEventListener('click', doSignin);
  $('signin-address').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSignin(); } });

  // --- register form: two screens, the pod's login first, then the identity ---
  const f = () => $('form').elements;
  // The pod provider is a free-text URL; default and normalise to a scheme.
  // The provider is picked from the list, or typed under "Other…".
  const providerUrl = () => { let v = (f().provider.value || f().providerOther.value).trim(); if (!v) return ''; if (!/^https?:\/\//i.test(v)) v = 'https://' + v; return v; };
  const providerHost = () => { try { return new URL(providerUrl()).host; } catch { return ''; } };
  // Where a new pod is made: the provider's own sign-up page. Every provider
  // in the list runs Community Solid Server, whose page is at this path; a
  // typed provider gets its front page, which links to it.
  const registerUrl = () => {
    if (!providerHost()) return '';
    const origin = new URL(providerUrl()).origin;
    return f().provider.value ? `${origin}/.account/login/password/register/` : `${origin}/`;
  };
  // A pod on a suffix-based host cannot answer WebFinger, so its address
  // lives at this site; a pod at its own host root gets the choice. Known
  // from the signed-in pod, not guessed from the provider.
  const pathPod = () => { try { return new URL(signedPod).pathname !== '/'; } catch { return false; } };
  // A move between gateways is an address at a gateway: no choice either.
  const shape = () => ((pathPod() || moveFrom) ? 'front' : f().shape.value);
  const answers = () => ({ handle: f().handle.value.trim().toLowerCase(), shape: shape(), container: f().container.value.trim() });
  // Where the data will be, in full, as the person types.
  const previewPlace = () => {
    if (!signedPod) return;
    const r = chosenRoot(signedPod, f().container.value);
    $('place').textContent = r.problem ? '…' : signedPod + r.root;
  };
  const previewAddr = () => {
    const handle = f().handle.value.trim().toLowerCase();
    let host = '';
    try { host = shape() === 'front' ? location.host : new URL(signedPod).host; } catch { host = ''; }
    $('preview').textContent = (handle && host) ? `@${handle}@${host}` : '@…@…';
  };
  // The shape choice is fixed for a path pod, and open for a host-root pod.
  // A path pod has no choice to make: the radios go away and the note says why.
  const applyShape = () => {
    const fixed = pathPod() || !!moveFrom;
    for (const r of f().shape) { if (fixed) r.checked = r.value === 'front'; }
    $('shape-group').hidden = fixed;
    $('shape-hint').hidden = !fixed || !!moveFrom;   // a move explains itself in its own note
  };
  const applyMode = () => {
    const existing = f().mode.value === 'existing';
    $('newpod-field').hidden = existing;
    $('provider-other-field').hidden = f().provider.value !== '';
    const url = registerUrl();
    $('register-link').href = url || '#';
    $('register-link').textContent = providerHost() ? `Create your pod at ${providerHost()}` : 'Create your pod at your provider';
  };
  for (const el of $('form').elements) for (const evt of ['input', 'change']) el.addEventListener(evt, () => { applyMode(); applyShape(); previewAddr(); previewPlace(); });
  applyMode();

  // Step machine: one screen at a time, each gated by its own validation.
  const STEP_IDS = ['step-1', 'step-2'];
  const FOCUS = { 1: 'provider', 2: 'handle' };
  const goStep = (n) => {
    STEP_IDS.forEach((id, i) => { $(id).hidden = i !== n - 1; });
    $('err-1').textContent = ''; $('form-error').textContent = '';
    if (n === 2) { applyShape(); previewAddr(); previewPlace(); $('index-ask').hidden = true; }
    if (FOCUS[n]) $(FOCUS[n]).focus();
  };
  const validateStep1 = () => {
    if (!providerHost()) return f().provider.value === '' ? 'A pod provider address is required under Other….' : 'A valid pod provider URL is required.';
    return null;
  };
  const validateStep2 = () => {
    const hp = window.fedipodHandleProblem(f().handle.value.trim().toLowerCase());
    if (hp) return `Fediverse handle: ${hp}`;
    if (!moveFrom) {
      const where = chosenRoot(signedPod, f().container.value).problem;
      if (where) return `Where to store it: ${where}`;
    }
    return null;
  };
  $('create').addEventListener('click', showForm);
  $('cancel').addEventListener('click', () => { showLanding(); goStep(1); });
  // Off to the pod's login. The identity screen is shown by the load that
  // brings the person back (fedipodOnLoad → 'signup').
  $('to-2').addEventListener('click', async () => {
    const e = validateStep1(); if (e) { $('err-1').textContent = e; return; }
    $('err-1').textContent = ''; $('to-2').disabled = true;
    try { await window.fedipodPodLogin({ issuer: providerUrl() }); }
    catch (err) { $('err-1').textContent = err.message || String(err); $('to-2').disabled = false; }
  });
  $('back-1').addEventListener('click', () => goStep(1));

  // From the setup screen back to the form (a failed run) or the landing.
  const backToForm = (errMsg) => {
    $('running').hidden = true; $('brand').hidden = false; $('pane-form').hidden = false;
    goStep(2);
    if (errMsg) $('form-error').textContent = errMsg;   // remind them what failed
  };
  $('run-retry').addEventListener('click', () => backToForm($('run-error').textContent));
  $('run-back').addEventListener('click', () => { showLanding(); goStep(1); });

  const LABELS = { pod: 'Checking your pod', keys: 'Making your signing key', gateway: 'Connecting your mail door',
    place: 'Recording where your account lives' };
  const MOVE_LABELS = { pod: 'Reading your account on your pod', gateway: 'Taking your address here', keys: 'Moving your key and account record' };
  // Run the setup. `createIndex` is the person's yes to a new public type index.
  const run = async (createIndex = false) => {
    const a = { ...answers(), ...(createIndex ? { createIndex: true } : {}) };
    $('pane-form').hidden = true; $('running').hidden = false;
    $('running-title').textContent = 'Setting up…'; $('run-error').textContent = ''; $('run-actions').hidden = true;
    const steps = $('steps'); steps.textContent = ''; const mark = {};
    const labels = moveFrom ? MOVE_LABELS : LABELS;
    const onStep = (k, st) => { if (!mark[k]) { const li = document.createElement('li'); steps.appendChild(li); mark[k] = li; } mark[k].textContent = (st === 'ok' ? '✓ ' : st === 'running' ? '… ' : '') + (labels[k] || k); };
    try {
      if (moveFrom) await window.fedipodMoveIn({ handle: a.handle, onStep });
      else await window.fedipodSignup({ ...a, onStep });
      location.href = '/admin/client/';
    }
    catch (err) {
      // No type index: nothing has been written. Ask, on the form.
      if (err?.code === 'needs-index') {
        backToForm();
        $('index-ask').hidden = false;
        $('index-yes').focus();
        return;
      }
      $('running-title').textContent = 'Setup did not finish';
      $('run-error').textContent = err.message || String(err);
      $('run-actions').hidden = false;                // the way out of the failure screen
    }
  };
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('form-error').textContent = '';
    const e2 = validateStep2(); if (e2) { $('form-error').textContent = e2; goStep(2); return; }
    await run();
  });
  $('index-yes').addEventListener('click', () => { $('index-ask').hidden = true; run(true); });
  $('index-no').addEventListener('click', () => {
    $('index-ask').hidden = true;
    $('form-error').textContent = 'Sign-up stopped. Nothing was written to your pod.';
  });

  if (pendingIdentity) await showIdentity();
})();
