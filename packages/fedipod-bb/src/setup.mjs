// setup.mjs — bringing a forum into being on its pod, from wherever its owner
// is: a moderator's machine (`fedipod-bb init`, `attach`, `keep`) or the
// browser at a Gateway's sign-up page. Config, containers and rules, the rows
// at a Gateway and the keeper's name: nothing here runs the forum. Every
// function takes the pod transport and the fetch it is handed; none reaches
// for a file, a credential or the network on its own, so the same code runs
// in Node and in a page.

import { restateRules } from 'fedipod/pod/containers.mjs';
import { forumUrls, ROOT, isSlug } from './urls.mjs';

export { ROOT };
import { provisionForum, provisionCategory } from './provision.mjs';

/**
 * The forum's config, from what it was and what is asked. A renamed forum or
 * a changed reader list has to be published again — the actors and the rules
 * are only rewritten when something asks — so the config says so.
 */
export function forumConfig(existing = {}, { remotePod, root = ROOT, handle, name, categories = [], moderators = [],
  moderatorWebIds = [], membersOnly = [], memberWebIds = {}, approveJoins = false, review = false, replyPolicy = 'open' }) {
  if (!isSlug(handle)) throw new Error(`not a forum handle: ${handle}`);
  const cats = categories.map(c => (typeof c === 'string' ? { slug: c, name: c } : c));
  for (const c of cats) if (!isSlug(c.slug)) throw new Error(`not a category slug: ${c.slug}`);
  const was = JSON.stringify((existing.categories || []).map(c => [c.slug, c.name]));
  const access = JSON.stringify([existing.membersOnly || [], existing.memberWebIds || {}, existing.moderatorWebIds || []]);
  const accessChanged = !!existing.handle && access !== JSON.stringify([membersOnly, memberWebIds, moderatorWebIds]);
  const renamed = !!existing.handle
    && ((name || handle) !== existing.name || was !== JSON.stringify(cats.map(c => [c.slug, c.name])));
  return {
    ...existing, kind: 'application', handle, name: name || existing.name || handle,
    ...(renamed || accessChanged ? { republish: true } : {}),
    ...(accessChanged ? { reprovision: true } : {}),
    remotePod, root,
    categories: cats, moderators, moderatorWebIds, membersOnly, memberWebIds,
    approveJoins, review, replyPolicy,
  };
}

// The config document, written the way the state store writes it (one JSON
// document per name in the state container), without the store itself: a
// page that makes a forum need not carry the store's whole apparatus.
const CONFIG = 'config.json';
const serialise = (obj) => JSON.stringify(obj, null, 2) + '\n';
async function writeConfig(storage, config) {
  const w = await storage.write(CONFIG, serialise(config), 'application/json');
  if (!w.ok) throw new Error(`the forum's config could not be written${w.why ? ` (${w.why})` : ''}`);
}

/**
 * The first act on a pod: the forum's containers and its config, nothing
 * else — the actors are published by the first run. `storageFor(base,
 * fetch)` is the owner-only state storage the caller uses. Returns the
 * storage, the config and the forum's plain urls, for whatever the caller
 * does next.
 */
export async function writeForumConfig(remote, storageFor, opts, { log = () => {} } = {}) {
  const plain = forumUrls(opts.remotePod, opts.root || ROOT);
  await provisionForum(remote, plain);
  const storage = storageFor(plain.state, (u, i) => remote.fetch(u, i));
  const had = await storage.read(CONFIG).catch(() => null);
  let existing = {};
  if (had?.ok && had.body) { try { existing = JSON.parse(had.body) || {}; } catch { existing = {}; } }
  const config = forumConfig(existing, opts);
  await writeConfig(storage, config);
  log(`forum ${config.handle} initialised with ${config.categories.length} categor${config.categories.length === 1 ? 'y' : 'ies'}`);
  return { storage, config, plain };
}

/** The forum's rows at a Gateway: its own and one per category, all writing into its one inbox. */
export const gatewayRows = (config, plain) => [
  { handle: config.handle, podHome: plain.home, actorUrl: plain.actor, kind: 'application' },
  ...(config.categories || []).map(c => ({ handle: c.slug, podHome: plain.category(c.slug).home,
    actorUrl: plain.category(c.slug).actor, kind: 'group' })),
];

/**
 * Attach the forum at a Gateway: each row fronted, its receipts' secret kept.
 * `fetch` carries the owner's proof (the pod session). Returns what the config
 * records under `gateway`, and the handles.
 */
export async function attachRows({ fetch: f, front, config, plain }, { log = () => {} } = {}) {
  const origin = String(front).replace(/\/+$/u, '');
  const secrets = {};
  const rows = gatewayRows(config, plain);
  for (const row of rows) {
    const res = await f(`${origin}/api/attach`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...row, fronted: true, inboxUrl: plain.inbox }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.status !== 201 || !d.hmacSecret) throw new Error(`attach ${row.handle} at ${origin}: HTTP ${res.status}${d.error ? ' ' + d.error : ''}`);
    secrets[row.handle] = String(d.hmacSecret);
    log(`attached @${row.handle}@${new URL(origin).host}`);
  }
  return { gateway: { front: origin, mode: 'trust', secrets }, handles: rows.map(r => r.handle) };
}

/**
 * Let a Gateway keep the forum (or stop): every row, the categories first and
 * the forum's own row last, because turning the forum's row on is what starts
 * its first run, and that run wants every category kept already. `between`,
 * given the keeper's WebID, runs after the categories and before that last
 * switch: the caller names the keeper in the pod's rules there, so the first
 * run can read the pod the moment it starts. Returns the keeper's WebID.
 */
export async function keepRows({ fetch: f, front, config, on = true, between = null }) {
  const origin = String(front).replace(/\/+$/u, '');
  const forumHandle = config.handle;
  const handles = [...(config.categories || []).map(c => c.slug), forumHandle];
  let keeper = null;
  for (const handle of handles) {
    if (handle === forumHandle && between) await between(keeper);
    const res = await f(`${origin}/api/keeper`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, on, ...(handle === forumHandle ? {} : { forum: forumHandle }) }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${origin} would not ${on ? 'keep' : 'let go of'} @${handle}: ${d.error || res.status}`);
    keeper = d.keeper || keeper;
  }
  return { keeper: on ? keeper : null, handles, on };
}

/**
 * The forum's rules stated with the keeper's name beside the owner's (or
 * without it): the containers and what they inherit. For a forum that has
 * members and readers already, the host's own restatement (keep.mjs) also
 * rewrites the reader lists; a forum just made has none.
 */
export async function nameKeeperInRules(remote, { config, plain, keeper = null, ownerWebId = null }) {
  remote.keepers = keeper ? [keeper] : [];
  remote.aclOwner = ownerWebId || remote.aclOwner || null;
  await provisionForum(remote, plain, { moderatorWebIds: config.moderatorWebIds || [] });
  await restateRules(remote, plain);
  for (const c of config.categories || []) {
    const urls = plain.category(c.slug);
    const members = (config.membersOnly || []).includes(c.slug) ? (config.memberWebIds?.[c.slug] || []) : null;
    await provisionCategory(remote, urls, { memberWebIds: members });
    await restateRules(remote, urls);
  }
}

/**
 * A forum made at a Gateway's sign-up page, start to finish: config and
 * containers on the pod, its rows at the Gateway, the Gateway named as its
 * keeper in every rule, and the keeper's first run started by the last
 * switch. `remote` is the owner's pod transport, `fetch` their pod session's
 * fetch (the Gateway proves the owner by it). Returns the forum's handle and
 * the Gateway it lives at.
 */
export async function setUpForumAtGateway({ remote, storageFor, fetch: f, front, ownerWebId, ...opts }, { log = () => {}, onStep = () => {} } = {}) {
  // `onStep(key, state)`: write, attach, keep; running then ok.
  onStep('write', 'running');
  const { storage, config, plain } = await writeForumConfig(remote, storageFor, opts, { log });
  onStep('write', 'ok');
  onStep('attach', 'running');
  const { gateway, handles } = await attachRows({ fetch: f, front, config, plain }, { log });
  await writeConfig(storage, { ...config, gateway, republish: true });
  onStep('attach', 'ok');
  onStep('keep', 'running');
  const { keeper } = await keepRows({ fetch: f, front, config, on: true,
    between: (k) => nameKeeperInRules(remote, { config, plain, keeper: k, ownerWebId }) });
  onStep('keep', 'ok');
  return { handle: config.handle, front: gateway.front, handles, keeper };
}
