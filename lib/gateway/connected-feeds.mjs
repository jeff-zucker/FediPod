// connected-feeds.mjs — the owner's other accounts read into theirs at the
// gateway, for an app such as Elk while FediPod is closed in the browser.
//
// FediPod in the browser reads the owner's connected Mastodon-API accounts and
// Bluesky account every five minutes while it is open (acctfeed.mjs,
// bskyfeed.mjs). Here the same reads are made, at most every five minutes,
// when an app asks for the home timeline or the notifications and nobody else
// holds the account. The logins are read from the pod for the one read and are
// never kept at the gateway (lib/core/pod-only.mjs); a login the far server
// renews goes back to the pod.
import { FediAccounts } from '../connections/fediacct.mjs';
import { AcctFeed } from '../connections/acctfeed.mjs';
import { Atproto } from '../connections/atproto.mjs';
import { BskyFeed } from '../connections/bskyfeed.mjs';
import { safeFetch } from '../shared/safefetch.mjs';
import { apUrls } from '../core/wire.mjs';
import { lockCopy, heldByBrowser } from './copy.mjs';
import { reachAccount, settle, stateAndLease } from './account-agent.mjs';

export const FEEDS_EVERY_MS = 5 * 60_000;
// An account with nothing connected is looked at again only this often.
export const NONE_EVERY_MS = 60 * 60_000;
// Each request to another server is cut short, and Bluesky is not started
// once this much of the read has gone, so an app's write waiting on the
// account does not wait long.
const ASK_MS = 6_000;
const READ_MS = 15_000;
const CONNECTED = ['fediaccts.json', 'atproto.json'];

// The logins as FediPod in the browser keeps them: one document for the
// Mastodon-API accounts, by id, and one for Bluesky.
function accountsVault(store) {
  const all = () => store.read('fediaccts.json', {}) || {};
  return {
    names: () => Object.keys(all()),
    read: (id) => all()[id] || null,
    write: (id, rec) => store.write('fediaccts.json', { ...all(), [id]: { ...rec, storage: 'pod' } }),
    remove: async () => false,
  };
}
const NO_APPS = { names: () => [], read: () => null, write: () => {}, remove: async () => false };
function blueskyVault(store) {
  return {
    names: () => (store.read('atproto.json', null) ? ['bluesky'] : []),
    read: () => store.read('atproto.json', null),
    write: (_, rec) => store.write('atproto.json', { ...rec, storage: 'pod' }),
    remove: async () => false,
  };
}

const dueKey = (handle) => `${handle}/feeds-due`;

/** For an app checking in: when due, and never over FediPod open in a browser. */
export async function readConnectedForApp(ctx, handle, rec, { log = console.log, fetcher = null, session = null } = {}) {
  if (!ctx.copyKv) return 0;
  const due = async () => Date.now() >= Number((await ctx.copyKv.get(dueKey(handle)))?.text || 0);
  // FediPod open in a browser reads them itself; the pod is not asked.
  if (!await due() || await heldByBrowser(ctx.copyKv, handle)) return 0;
  const unlock = await lockCopy(ctx.copyKv, handle, { waitMs: 1000 });
  if (!unlock) return 0;
  try {
    // Another request may have read them while this one waited.
    if (!await due()) return 0;
    await ctx.copyKv.set(dueKey(handle), String(Date.now() + FEEDS_EVERY_MS));
    const out = await readConnected(ctx, handle, rec, { log, fetcher, session });
    if (out.none) await ctx.copyKv.set(dueKey(handle), String(Date.now() + NONE_EVERY_MS));
    return out.added || 0;
  } finally { await unlock(); }
}

/**
 * One read of every connected account into the account, by a caller holding
 * lockCopy. Returns { added } or { none } when nothing is connected.
 */
export async function readConnected(ctx, handle, rec, { log = console.log, fetcher = null, session = null } = {}) {
  const at = await reachAccount(ctx, handle, rec, { log, session });
  if (at.skipped) return { added: 0 };
  if (!(await settle(ctx, handle, rec, at, { log })).ok) return { added: 0 };
  // The key is not needed to read: only the logins come from the pod.
  const { store, lease } = stateAndLease(ctx, handle, at, { log, podNames: [] });
  try { await store.refresh(CONNECTED); } catch (e) { log(`@${handle}: connected accounts: ${e.message}`); return { added: 0 }; }
  const out = fetcher || ctx.fetchImpl || null;
  const ask = (url, init = {}) => {
    const cut = { ...init, signal: AbortSignal.timeout(ASK_MS) };
    return out ? out(url, cut) : safeFetch(url, cut);
  };
  const said = (m) => log(`@${handle}: ${m}`);
  const masto = new FediAccounts({ vault: accountsVault(store), apps: NO_APPS, log: said, fetcher: ask });
  const bsky = new Atproto({ vault: blueskyVault(store), log: said, fetcher: ask });
  const bskyOn = () => bsky.connected() && !bsky.read()?.feedPaused;
  if (!masto.connected() && !bskyOn()) return { none: true };
  if (!await lease.acquire()) return { added: 0 };
  try {
    await store.load();
    const config = store.getConfig();
    if (!config || config.quiescedAt) return { added: 0 };
    // Stamped as FediPod in the browser stamps them, so a login made for
    // another actor is left alone here too.
    const publicBase = config.gateway?.frontActor ? config.gateway.frontActor.replace(/ap\/actor\/?$/u, '') : null;
    masto.actorId = bsky.actorId = apUrls(at.pod, config.root || at.root, { publicBase }).actor;
    const started = Date.now();
    let added = 0;
    if (masto.connected()) {
      const feed = new AcctFeed({ store, accounts: masto, log: said });
      await feed.sweep();
      added += feed.lastAdded;
    }
    if (bskyOn() && Date.now() - started < READ_MS) {
      const feed = new BskyFeed({ store, atproto: bsky, log: said });
      await feed.sweep();
      added += feed.lastAdded;
    }
    if (!await store.commit()) said('connected accounts read, but not written to the copy');
    return { added };
  } finally { await lease.release().catch(() => {}); }
}
