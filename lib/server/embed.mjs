// embed.mjs — the agent, running inside the pod server that holds its pod.
//
// Nothing here reimplements the agent: it is the same Agent class, the same
// intake, deliverer, publisher and lease. What changes is the transport. The
// caller hands in a session that reaches the pod through the server's own
// store, and RemotePod takes it instead of minting a credential — so an
// identity acts on its pod with no token, no socket, and no second process.
//
// The one thing a pod server can do that a laptop cannot is notice a write the
// moment it happens, so the notification socket is replaced by the store's own
// change events.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createRequire } from 'node:module';

import { Agent } from '../../run-agent.mjs';
import { RemotePod } from '../device/remote.mjs';
import { apUrls, DEFAULT_ROOT } from '../core/wire.mjs';
import { writeJsonAtomic } from '../device/home.mjs';
import { buildAdminSurface } from '../device/admin/index.mjs';
import { FixedAuthorities } from '../shared/guard.mjs';
import { CONNECTION_PREFIX, fileVault, moveVault, podVault } from '../connections/vault.mjs';

const require = createRequire(import.meta.url);
const { makeGate } = require('../../vendor/gate.cjs');

// How long to gather store events before draining, so a delivery of several
// items costs one sweep rather than one each.
const DRAIN_COALESCE_MS = 250;

// How every secret in this project is minted (the attach flow's recipe).
const mintSecret = () => crypto.randomBytes(32).toString('base64');

/**
 * The secret guarding one identity's owner door, kept in its pod's state
 * beside its signing key. Minted when absent; `rotate` re-mints over an
 * existing one — which is how a lost secret is recovered, by proving pod
 * control again. Never logged.
 *
 * `dataDir`, when given, is where an identity set up before this kept it: the
 * secret is moved into the pod and the host's copy removed, so the owner's
 * existing door link goes on working.
 */
export async function ensureDoorSecret(session, podBase, { rotate = false, dataDir = null, handle = null, log = () => {} } = {}) {
  const base = podBase.endsWith('/') ? podBase : podBase + '/';
  const url = apUrls(base, DEFAULT_ROOT).state + 'door-secret.json';
  const onHost = dataDir && handle ? path.join(dataDir, handle, 'door-secret.json') : null;

  if (!rotate) {
    const res = await session.fetch(url, { headers: { accept: 'application/json' } });
    if (res.ok) {
      try {
        const rec = JSON.parse(await res.text());
        if (rec?.secret) {
          if (onHost) fs.rmSync(onHost, { force: true });
          return { secret: rec.secret, url, rotated: false };
        }
      } catch { /* unreadable: mint below */ }
    }
    // Set up before the secret lived on the pod: keep the one the owner has.
    if (onHost && fs.existsSync(onHost)) {
      try {
        const rec = JSON.parse(fs.readFileSync(onHost, 'utf8'));
        if (rec?.secret && await putSecret(session, url, rec)) {
          fs.rmSync(onHost, { force: true });
          log('door secret moved into the pod');
          return { secret: rec.secret, url, rotated: false };
        }
      } catch { /* unreadable: mint below */ }
    }
  }

  const rec = { secret: mintSecret(), mintedAt: new Date().toISOString() };
  if (!await putSecret(session, url, rec)) throw new Error(`could not write the door secret to ${url}`);
  if (onHost) fs.rmSync(onHost, { force: true });
  return { secret: rec.secret, url, rotated: rotate };
}

async function putSecret(session, url, rec) {
  const res = await session.fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rec, null, 2) + '\n',
  });
  return res.ok;
}

/** The identity's name: a subdomain pod is its label, a path pod its last segment. */
export function handleFor(podBase) {
  const u = new URL(podBase);
  const segments = u.pathname.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : u.hostname.split('.')[0];
}

/**
 * The credential file an embedded identity runs on. It names the pod and
 * nothing else: there is no client id and no secret, because there is nobody
 * to authenticate to. Absent `privateRoot`, so the state tree stays on the pod.
 *
 * `keysMode: 'pod'` because here the pod's server and the agent are the same
 * process: keeping the signing key on the host's disk puts it somewhere the
 * pod does not travel to, so handing the pod over hands over an identity that
 * cannot sign. An identity set up before this gets the mode added.
 */
function ensureCredential(home, { podBase, webId }) {
  const file = path.join(home, 'credential.json');
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rec.keysMode === 'pod') return rec;
    const updated = { ...rec, keysMode: 'pod' };
    writeJsonAtomic(file, updated, { mode: 0o600 });
    return updated;
  } catch { /* first run for this identity */ }
  const rec = {
    webId,
    remotePod: podBase.endsWith('/') ? podBase : podBase + '/',
    root: 'activitypods-js/',
    keysMode: 'pod',
  };
  writeJsonAtomic(file, rec, { mode: 0o600 });
  return rec;
}

/**
 * Move an identity's signing key off the host's disk and into its pod.
 *
 * Only after the pod has it: the private key is the one thing here that
 * nothing can rebuild, and remote servers have its public half cached, so a
 * copy lost between the two places is an identity that can never sign again
 * under the name it already published.
 */
async function keyIntoPod(agent, home, log) {
  const local = path.join(home, 'keys.json');
  if (!fs.existsSync(local)) return;
  if (agent.store.read('keys.json', null)) {
    fs.rmSync(local, { force: true });
    log('this identity signs with the key in its pod; removed the copy on this host');
    return;
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(local, 'utf8'));
  } catch (e) {
    log(`the local signing key could not be read (${e.message}) — leaving it where it is`);
    return;
  }
  agent.store.write('keys.json', rec);
  if (!await agent.store.commit()) {
    log('could not write the signing key to the pod — it stays on this host for now');
    return;
  }
  fs.rmSync(local, { force: true });
  log('signing key moved into the pod');
}

/**
 * Move an identity's credentials for accounts it holds on OTHER servers off
 * the host's disk and into its pod. A token here is full access to somebody's
 * account on a server this project does not run, so the host's copy goes only
 * after the pod has taken it.
 */
async function connectionsIntoPod(agent, home, log) {
  const moves = [
    [fileVault(path.join(home, 'fediaccts')), podVault(agent.store, `${CONNECTION_PREFIX}fedi-`)],
    [fileVault(path.join(home, 'fediaccts', '_apps')), podVault(agent.store, `${CONNECTION_PREFIX}fediapp-`)],
    [fileVault(home), podVault(agent.store, CONNECTION_PREFIX)],
  ];
  // The last pair is the whole home directory, where only the Bluesky
  // credential is ours to move.
  for (const [from, to] of moves.slice(0, 2)) await moveVault(from, to, log);
  const bluesky = moves[2][0].read('atproto');
  if (bluesky && !moves[2][1].read('bluesky')) {
    moves[2][1].write('bluesky', bluesky);
    if (await moves[2][1].commit()) {
      await moves[2][0].remove('atproto');
      log('the Bluesky connection moved into the pod');
    } else {
      log('could not write the Bluesky connection to the pod — it stays on this host for now');
    }
  }
}

/**
 * Bring one identity up inside the server.
 *
 * `session` is the store-backed transport ({ fetch, warmup, stats }).
 * `resourceStore` is optional and used only to watch for inbox writes.
 * Returns the running agent and a stop() that leaves the pod tidy.
 */
export async function startEmbeddedAgent({
  podBase,
  dataDir,
  session,
  resourceStore = null,
  webIdSuffix = 'profile/card#me',
  log = () => {},
  pollSeconds = null,
  autoAcceptFollows = true,
  gateToken = null,
  uiPath = '/fedipod/',
}) {
  const base = podBase.endsWith('/') ? podBase : podBase + '/';
  const handle = handleFor(base);
  const home = path.join(dataDir, handle);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  const webId = base + webIdSuffix.replace(/^\//u, '');
  const cred = ensureCredential(home, { podBase: base, webId });

  const agent = new Agent({ home, log });
  agent.log = log;
  agent.store.log = log;
  // Read by connect() when it builds Intake: in-process, the pod's own change
  // events are the push channel.
  agent.embedded = true;
  if (pollSeconds) agent.pollSeconds = pollSeconds;
  agent.remote = new RemotePod(cred, { log, session });
  await agent.remote.warmup();

  // Whether this pod already carries an identity is the question connect()
  // assumes an answer to, so settle it first.
  const urls = apUrls(cred.remotePod, cred.root);
  agent.store.attach(agent.privateStorage(cred, 'state', urls));

  // A state container that is NOT THERE means a pod nobody has set up yet. A
  // state container we could not READ means a pod we could not ask, which is a
  // different answer: treating it as empty would provision a second identity
  // over the top of a working one.
  const state = await agent.remote.fetch(urls.state, { headers: { accept: 'text/turtle' } });
  const unprovisioned = state.status === 404 || state.status === 410;
  if (!unprovisioned && state.status >= 400) {
    throw new Error(`state at ${urls.state} → ${state.status} — cannot tell whether this pod is set up`);
  }
  if (!unprovisioned) {
    await agent.store.load();
    agent.stateLoaded = true;
  }

  if (!agent.store.getConfig()) {
    // The pod itself must exist first. A server creates its seeded pods after
    // it runs its initializers, so an agent that provisioned eagerly would
    // leave a container tree exactly where a pod is about to be created.
    const profile = await agent.remote.fetch(webId.split('#')[0], { headers: { accept: 'text/turtle' } });
    if (profile.status === 404 || profile.status === 410) {
      throw new Error(`no pod at ${base} yet — its owner profile is not there`);
    }
    log(`no identity on ${base} yet — provisioning @${handle}`);
    await agent.bootstrap({ handle, name: handle, kind: 'person' });
    if (autoAcceptFollows) {
      agent.store.setConfig({ ...agent.store.getConfig(), autoAcceptFollows: true });
      await agent.store.flush();
    }
    agent.stateLoaded = true;
  }

  // Before connect(), which is what looks the key and the connections up.
  await keyIntoPod(agent, home, log);
  await connectionsIntoPod(agent, home, log);

  await agent.connect();

  // The client surfaces, on the pod's own origin: the Mastodon API a phone app
  // speaks, the write API, nodeinfo, and behind the door the admin routes and
  // the web client. Same code the standalone agent serves, minus the routes
  // that only mean something to a process of one's own.
  const authorities = new FixedAuthorities(base);
  agent.authorities = authorities;
  const surface = buildAdminSurface({
    agent,
    log,
    gate: makeGate(gateToken, { secureCookie: authorities.secure }),
    allowed: authorities,
    embedded: true,
    basePath: uiPath,
    publicOrigin: base,
    scheme: new URL(base).protocol,
  });

  // A delivery landing in the inbox — through the door, or from any other
  // writer — wakes the drain at once. Only additions, and only in the inbox:
  // the drain's own DELETEs must not call it back.
  let coalesce = null;
  let onChanged = null;
  if (typeof resourceStore?.on === 'function') {
    const inbox = urls.inbox;
    onChanged = (identifier, activity) => {
      const kind = String(activity?.value ?? activity ?? '');
      if (!identifier?.path?.startsWith(inbox)) return;
      if (!kind.endsWith('Create') && !kind.endsWith('Add')) return;
      if (coalesce) return;
      coalesce = setTimeout(() => {
        coalesce = null;
        if (!agent.viewer) agent.intake?.drain().catch((e) => log(`drain: ${e.message}`));
      }, DRAIN_COALESCE_MS);
      coalesce.unref?.();
    };
    resourceStore.on('changed', onChanged);
  }

  const stop = async () => {
    if (onChanged) resourceStore.off('changed', onChanged);
    surface.streaming?.stop?.();
    clearTimeout(coalesce);
    agent.intake?.stop();
    agent.tagfeed?.stop();
    agent.bskyfeed?.stop();
    agent.deliverer?.stop();
    agent.importer?.stop();
    clearInterval(agent.schedTimer);
    clearInterval(agent.refreshTimer);
    agent.publisher?.stopPolls();
    // Same order the standalone agent's shutdown uses: write what is pending,
    // then let go of the lease so the next agent need not wait out the TTL.
    await Promise.allSettled([
      agent.store.flush(),
      agent.viewer ? Promise.resolve() : agent.lease?.release(),
    ]);
  };

  // podHome and actorUrl are the identity's own locations on the pod. They are
  // returned rather than rebuilt by the caller so the root name lives here.
  return {
    agent, handle, home, surface, host: authorities.host,
    podHome: urls.home, actorUrl: urls.actor, stop,
  };
}
