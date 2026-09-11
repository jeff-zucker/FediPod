// setup.mjs — the setup flow itself, lifted out of the CLI so a browser page
// can drive it. Same order, same decisions as `fedipod setup` always had:
// create the account and pod (or use one you already have), mint a revocable
// credential, provision the pod, publish the actor, check it is really public.
//
// The caller owns the run record and polls it; runSetup only fills it in. That
// is deliberate. The credential a CSS server mints is shown once and cannot be
// recovered, so the durable record of a run has to be the credential file on
// disk, never an HTTP response a closed tab can take with it.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as $rdf from 'rdflib';

import { createAccountWithPod as realCreateAccount } from './account.mjs';
import { mintCredential as realMint } from './remote.mjs';
import { hashPassword } from '../client/masto/index.mjs';
import { webfingerHost } from '../core/wire.mjs';
import { rootOf, recordLastUsed, writeJsonAtomic } from './home.mjs';
import { insecureUrlReason } from '../shared/safefetch.mjs';
import { CURRENT_LAYOUT, isCurrent } from './migrate.mjs';

const SOLID = $rdf.Namespace('http://www.w3.org/ns/solid/terms#');

export const STEPS = ['account', 'credential', 'bootstrap', 'connect', 'publish', 'verify'];

// Read-only pre-check on the pod behind an existing-pod setup, before a
// credential is minted or the first write is attempted. Two failures it turns
// from a bare "PUT … → 401" into a plain sentence:
//   1. the pod host is unreachable — no account should be built on a pod that
//      is not there;
//   2. the pod's WebID document declares no OIDC issuer. A pod verifies a token
//      by dereferencing its WebID and looking for solid:oidcIssuer; an empty or
//      issuer-less profile makes it reject every write with 401, so setup would
//      stall on the first one. Only judged when the document is publicly
//      readable — a protected one cannot be read here and is left to bootstrap.
export async function checkPodUsable(pod, { webId, fetch: doFetch = globalThis.fetch } = {}) {
  const base = pod.endsWith('/') ? pod : pod + '/';
  const wid = webId || new URL('profile/card#me', base).href;
  const cardUrl = wid.split('#')[0];

  let root;
  try { root = await doFetch(base, { headers: { accept: 'text/turtle' } }); }
  catch (e) { return { ok: false, error: `${base} could not be reached (${e.message}). Check the address and that the server is running.` }; }
  if (root.status === 404) return { ok: false, error: `there is no pod at ${base} — the server answered 404.` };
  if (root.status >= 500) return { ok: false, error: `the pod host at ${base} is not responding (HTTP ${root.status}).` };

  let card;
  try { card = await doFetch(cardUrl, { headers: { accept: 'text/turtle' } }); }
  catch (e) { return { ok: false, error: `the pod's WebID document ${cardUrl} could not be read (${e.message}).` }; }
  if (card.status === 404) return { ok: false, error: `the pod has no WebID document at ${cardUrl} — the identity it needs is missing.` };
  if (card.status >= 500) return { ok: false, error: `the pod host is not serving ${cardUrl} (HTTP ${card.status}).` };
  if (card.status === 401 || card.status === 403) return { ok: true };   // cannot read unauthenticated; leave it to bootstrap

  const body = await card.text().catch(() => '');
  const g = $rdf.graph();
  try { $rdf.parse(body, g, cardUrl, (card.headers.get('content-type') || 'text/turtle').split(';')[0].trim()); }
  catch { return { ok: false, error: `the pod's WebID document ${cardUrl} could not be parsed as RDF.` }; }
  if (!g.each($rdf.sym(wid), SOLID('oidcIssuer'), null).length) {
    return { ok: false, error: `the pod's WebID document ${cardUrl} declares no OIDC issuer, so the pod will reject every write. It looks empty or incomplete — restore it, or set up with a fresh pod.` };
  }
  return { ok: true };
}

export const credentialPath = (home) => path.join(home, 'credential.json');
export const hasCredential = (home) => fs.existsSync(credentialPath(home));

export function newRun() {
  return {
    phase: 'running',
    startedAt: new Date().toISOString(),
    steps: STEPS.map(key => ({ key, state: 'waiting', note: null })),
    error: null,
    result: null,
  };
}

// What must be answered before a run can start. `resuming` is a run that
// already has its credential: the account and the pod are settled, and only
// the actor's own details are still open.
export function setupInputError(a, resuming = false) {
  if (!a.handle) return 'a handle is required';
  if (a.kind && a.kind !== 'person' && a.kind !== 'group') return 'kind must be person or group';
  if (a.privateRoot) {
    try { new URL(a.privateRoot); } catch { return `"${a.privateRoot}" is not a container address`; }
    // A pod one, at least. A file: private root is a directory and has no
    // transport to secure.
    if (/^https?:/i.test(a.privateRoot)) {
      const bad = insecureUrlReason(a.privateRoot, 'private-data address');
      if (bad) return bad;
    }
  }
  if (a.gateway) {
    if (typeof a.gateway.url !== 'string') return 'a gateway needs its door URL';
    const badGw = insecureUrlReason(a.gateway.url, 'gateway address');
    if (badGw) return badGw;
  }
  if (resuming) return null;
  if (a.mode !== 'new' && a.mode !== 'existing') return 'mode must be "new" or "existing"';
  if (!a.issuer) return 'an identity provider is required';
  // Checked BEFORE the password is asked for, let alone sent: the issuer is
  // where it goes, and the pod is where the credential it buys is used.
  const badIssuer = insecureUrlReason(a.issuer, 'identity provider address');
  if (badIssuer) return badIssuer;
  if (!a.email) return 'an account email is required';
  if (!a.password) return 'the account password is required';
  if (a.mode === 'existing' && !a.pod) return 'a pod address is required';
  const badPod = insecureUrlReason(a.pod, 'pod address');
  if (badPod) return badPod;
  return null;
}

// What the CLI printed before asking "create pod and fediverse account?"
// (bin/fedipod.mjs, the address preview) — as data, so the page can show
// the same warnings. Pure: no network, so it can answer while you type.
export function preflight({ mode, pod, issuer, podName, handle, kind }) {
  const warnings = [];
  if (!handle) return { ok: false, error: 'a handle is required' };
  let issuerHost;
  try { issuerHost = new URL(issuer || 'https://solidcommunity.net').host; }
  catch { return { ok: false, error: `"${issuer}" is not a URL` }; }

  if (mode === 'new') {
    // No warning about whether the server gives the pod its own subdomain. The
    // run checks what it actually got and fails the account step when a group
    // lands on a shared host, which is the case that matters; saying it up
    // front only made the form noisy.
    return {
      ok: true, mode, handle, kind,
      address: `@${handle}@${podName || handle}.${issuerHost}`,
      webfingerHost: null, resolvable: null, warnings, refusal: null,
    };
  }

  let podUrl;
  try { podUrl = new URL(pod); }
  catch { return { ok: false, error: `"${pod}" is not a pod address` }; }
  // A handle resolves through <host>/.well-known/webfinger, so it only works
  // when the pod owns the root of its host.
  const wfHost = webfingerHost(podUrl.href);
  let refusal = null;
  if (!wfHost) {
    warnings.push('pod-is-a-path');
    // A person warned about an unresolvable handle is the one who suffers, so
    // that is their call to accept. Nobody could ever find this group, and the
    // people it would fail are not the operator reading the warning.
    if (kind === 'group') refusal = 'group-needs-host-root';
  }
  return {
    ok: !refusal, mode: 'existing', handle, kind,
    address: `@${handle}@${wfHost || podUrl.host}`,
    webfingerHost: wfHost, resolvable: !!wfHost, warnings, refusal,
  };
}

// Fills `run` in as it goes. Never throws: a failure lands in run.error, so a
// page that polls sees it. `deps` is for tests — the real functions otherwise.
export async function runSetup({ home, agent, answers, run, deps = {}, log = () => {} }) {
  const createAccount = deps.createAccountWithPod || realCreateAccount;
  const mint = deps.mintCredential || realMint;
  const checkPod = deps.checkPodUsable || checkPodUsable;

  const at = (key) => run.steps.find(s => s.key === key);
  const begin = (key) => { at(key).state = 'running'; };
  const done = (key, note = null) => { at(key).state = 'ok'; at(key).note = note; };
  const skip = (key, note = null) => { at(key).state = 'skipped'; at(key).note = note; };

  const {
    mode, issuer, email, password, handle, name, podName,
    kind = 'person', approveJoins = false, summary, icon, keys, uiPassword,
    gateway = null,
  } = answers;
  let { pod, root } = answers;
  let accountWebId = null;   // what createAccountWithPod reported, when it ran
  // The private half always starts here, beside the credential and the keys —
  // not on the pod. Every activity you receive would otherwise cost the pod
  // several writes, and that pod is a server somebody runs. `state --to` moves
  // it afterwards; starting on the pod and moving later is strictly worse,
  // because the copy left behind was on the pod the whole time.
  const privateRoot = answers.privateRoot
    || pathToFileURL(path.join(home, 'private')).href + '/';
  // Everything that leaves this function — notes, errors, the log — goes
  // through here. Nothing today echoes a password back, but /setup/progress is
  // polled repeatedly and would re-serve one forever if anything ever did.
  const scrub = (s) => (password ? String(s).split(password).join('••••••') : String(s));

  const credPath = credentialPath(home);
  const resuming = fs.existsSync(credPath);

  try {
    // --- account: create it, or use the pod you already have ---
    if (resuming) {
      skip('account', 'the credential is already on disk');
    } else if (mode === 'new') {
      begin('account');
      const made = await createAccount({ issuer, email, password, podName: podName || handle });
      pod = made.pod;
      accountWebId = made.webId || null;
      log(`account + pod created: ${pod}`);
      // The server put the pod on a path rather than its own subdomain, so
      // nobody could ever find this group. A person was warned before we got
      // here and chose to continue; a group cannot.
      if (kind === 'group' && !webfingerHost(pod)) {
        throw new Error(`${issuer} created the pod at ${pod} — a path on a shared host, `
          + 'not a host root. WebFinger is only answered at a host root, so nobody '
          + 'could find this group. The pod exists; no actor was published.');
      }
      done('account', pod);
    } else {
      // A pod you bring must be there and carry a usable WebID before a
      // credential is minted against it — no account on a pod that is not
      // reachable, and no silent 401 later on a pod whose profile is empty.
      const usable = await checkPod(pod);
      if (!usable.ok) throw new Error(usable.error);
      skip('account', 'using the pod you already have');
    }

    // --- credential: the point of no return, and the durability boundary ---
    let resumeWebId = null;
    if (resuming) {
      const rec = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      pod = rec.remotePod;
      root = rec.root;
      resumeWebId = rec.webId || null;
      skip('credential', `already minted — ${credPath}`);
    } else {
      begin('credential');
      // The WebID matters as much as the pod: an account with more than one
      // pod has more than one, and a credential bound to the wrong one 403s
      // every write. Account creation knows which; otherwise the pod's origin
      // picks it out.
      const credential = await mint({
        origin: issuer, email, password, name: 'fedipod',
        webId: accountWebId || undefined, podUrl: pod,
      });
      const rec = {
        ...credential,
        remotePod: pod.endsWith('/') ? pod : pod + '/',
        ...(root ? { root } : {}),
        ...(keys === 'pod' ? { keysMode: 'pod' } : {}),
        // Where the private half lives. Per-machine, like keysMode.
        ...(privateRoot ? { privateRoot } : {}),
        // What shape this install is, so `upgrade` can tell an old one from a
        // new one without guessing from the fields.
        ...(isCurrent({ privateRoot }) ? { layout: CURRENT_LAYOUT } : {}),
      };
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      writeJsonAtomic(credPath, rec);
      // The identity you just made is the one you are using, so it becomes what
      // a plain command means. Here rather than earlier: the credential landing
      // is what makes this an identity at all.
      // NOT `root` — that name is already taken by the answers' AP container
      // root, destructured above, and shadowing it is a temporal dead zone.
      const apHomeRoot = rootOf(home);
      if (apHomeRoot !== home) recordLastUsed(apHomeRoot, path.basename(home));
      pod = rec.remotePod;
      log(`credential minted and saved to ${credPath}`);
      done('credential', credPath);
    }

    // --- provision the pod and bring federation up ---
    begin('bootstrap');
    // Resuming skipped the checks the fresh paths ran, and the credential it
    // carries may be the one bound to a pod whose profile is empty — the write
    // below would 401. Catch it here, as this step, with a sentence.
    if (resuming) {
      const ready = await checkPod(pod, { webId: resumeWebId || undefined });
      if (!ready.ok) throw new Error(ready.error);
    }
    await agent.bootstrap({ handle, name: name || handle, root, kind, approveJoins, summary, icon, gateway });
    done('bootstrap');

    begin('connect');
    // Direct, not connectWithRetry: setup wants to hear about a failure now,
    // not back off for an hour with a browser tab waiting on it.
    await agent.connect({ repair: false });          // publish below is the publish
    done('connect');

    begin('publish');
    if (uiPassword) {
      agent.store.setConfig({ ...agent.store.getConfig(), uiPassword: hashPassword(uiPassword) });
    }
    const published = await agent.publisher.publishProfile();
    await agent.store.flush();
    done('publish');

    // --- and say plainly whether the world can actually see it ---
    begin('verify');
    const unreachable = published?.unreachable || [];
    const wfHost = webfingerHost(pod);
    done('verify', unreachable.length
      ? `not readable without credentials: ${unreachable.join(', ')}`
      : 'the public surface is reachable');

    run.result = {
      kind,
      pod,
      handle,
      actor: agent.urls?.actor || null,
      webfingerHost: wfHost,
      resolvable: !!wfHost,
      address: wfHost ? `@${handle}@${wfHost}` : null,
      unreachable,
    };
    run.phase = 'done';
    log(wfHost
      ? `${kind === 'group' ? 'group' : 'actor'} published: @${handle}@${wfHost}`
      : `${kind === 'group' ? 'group' : 'actor'} published, but not reachable as a handle — `
        + `${pod} is not a host root`);
  } catch (e) {
    for (const s of run.steps) if (s.state === 'running') s.state = 'error';
    run.error = scrub(e.message);
    run.phase = 'error';
    log(`setup failed: ${run.error}`);
  }
  return run;
}
