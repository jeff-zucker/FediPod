// app-fill.mjs — the app sign-in page, after the gateway accepted the sign-in:
// the account's copy at the gateway is filled from the pod with what apps
// show, since the gateway never reads the pod itself. Signed in at the pod,
// this page reads:
//
// - the account's state documents, as FediPod last wrote them;
// - what fedipod.net did since and handed to the pod inbox, not yet applied
//   by FediPod (lib/core/intake/gateway-writes.mjs): applied here, on the way
//   to the gateway, and believed only with the account's door-secret stamp;
// - mail waiting in the pod inbox that FediPod has not read: handed to the
//   gateway, which reads it into the copy, and taken out of the pod inbox.
//
// The gateway takes each document only where its copy has none (state-api.mjs:
// fill), so nothing an app or FediPod wrote since is written over.
import { applyDelta } from './doc-delta.mjs';   // lib/core/doc-delta.mjs, staged beside this page

// What an app shows, beside the slim copy's documents; the gateway keeps only
// those its copy holds.
const NAMES = ['statuses.json', 'notifications.json', 'lists.json', 'filters.json', 'muted.json', 'masto-markers.json',
  'webpush.json', 'media.json', 'ids.json', 'contacts.json', 'requests.json', 'blocklist.json', 'queue.json', 'deadletter.json',
  'scheduled.json', 'actors.json', 'published.json', 'outbox.json', 'outbox-removed.json', 'outbox-own.json', 'liked.json',
  'counts.json', 'poll-votes.json', 'intake-attempts.json', 'forwarded.json', 'c2s-seen.json'];
const PUBLIC_FIELDS = ['handle', 'name', 'summary', 'icon', 'image', 'fields', 'aliases', 'createdAt', 'movedTo', 'movedFrom',
  'quiescedAt', 'autoAcceptFollows', 'remotePod', 'root', 'inboxUrl', 'gateway', 'kind'];
const GW = /\/gw-\d{10}-[0-9a-f]{16,64}\.json$/u;
const BATCH = /\/batch-[^/]*\.json$/u;

const sortedKeys = (v) => (Array.isArray(v) ? v.map(sortedKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v);
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
async function stampOk(receipt, secret) {
  if (!receipt?.hmac || !secret) return false;
  const { hmac, ...rest } = receipt;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(sortedKeys(rest))))) === hmac;
}
const sha256 = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

async function readJson(fetchFn, url) {
  const r = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  try { return JSON.parse(await r.text()); } catch { return null; }
}

// The inbox's items, by address, from its JSON-LD listing.
async function inboxItems(fetchFn, inbox) {
  const r = await fetchFn(inbox, { headers: { accept: 'application/ld+json' } });
  if (!r.ok) return [];
  const doc = await r.json().catch(() => null);
  const nodes = Array.isArray(doc) ? doc : doc?.['@graph'] || [doc];
  const out = new Set();
  for (const n of nodes) {
    for (const k of ['http://www.w3.org/ns/ldp#contains', 'ldp:contains', 'contains']) {
      for (const c of [].concat(n?.[k] || [])) {
        const id = typeof c === 'string' ? c : c?.['@id'];
        if (id) out.add(new URL(id, inbox).href);
      }
    }
  }
  return [...out].filter((u) => !u.endsWith('.receipt.json') && !u.endsWith('.keep')).sort();
}

/**
 * Fill the copy at `fill.base` with `fill.token`, reading the pod with
 * `podFetch` (the pod sign-in's fetch). `say` reports progress. Never throws:
 * a fill that fails leaves the app to work from what the copy has, and
 * FediPod fills it on its next start.
 */
export async function fillAppCopy(fill, podFetch, say = () => {}) {
  try {
    const state = fill.podHome.replace(/\/?$/u, '/') + 'ap-state/';
    const inbox = fill.podHome.replace(/\/?$/u, '/') + 'ap/inbox/';
    say('Copying your timeline for the app…');
    const config = await readJson(podFetch, state + 'config.json');
    const docs = {};
    for (const name of NAMES) {
      const d = await readJson(podFetch, state + name);
      if (d !== null) docs[name] = d;
    }
    // What fedipod.net did since FediPod last ran.
    const secret = config?.gateway?.hmacSecret || null;
    const replica = (await readJson(podFetch, state + 'replica.json'))?.seq || 0;
    const items = await inboxItems(podFetch, inbox);
    for (const url of items.filter((u) => GW.test(u))) {
      const r = await podFetch(url, { headers: { accept: '*/*' } });
      if (!r.ok) continue;
      const raw = await r.text();
      const receipt = await readJson(podFetch, url + '.receipt.json');
      if (!await stampOk(receipt, secret) || receipt.method !== 'gateway-writes' || receipt.hash !== await sha256(raw)) continue;
      let item = null;
      try { item = JSON.parse(raw); } catch { continue; }
      if (!item || item.seq <= replica) continue;
      for (const [name, delta] of Object.entries(item.deltas || {})) {
        if (!NAMES.includes(name)) continue;
        for (const one of Array.isArray(delta) ? delta : [delta]) docs[name] = applyDelta(docs[name] ?? null, one);
      }
    }
    const body = { full: true, docs: Object.fromEntries(Object.entries(docs).map(([n, d]) => [n, JSON.stringify(d, null, 2) + '\n'])) };
    if (config) body.docs['config-public.json'] = JSON.stringify(Object.fromEntries(PUBLIC_FIELDS.filter((k) => config[k] !== undefined).map((k) => [k, config[k]])), null, 2) + '\n';
    const auth = { authorization: `Bearer ${fill.token}`, 'content-type': 'application/json' };
    const filled = await fetch(fill.base + 'fill', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    if (!filled.ok) return false;
    // Mail FediPod has not read yet: to the gateway, which reads it in for the app.
    const mail = [];
    const taken = [];
    for (const url of items.filter((u) => !GW.test(u))) {
      const r = await podFetch(url, { headers: { accept: '*/*' } });
      if (!r.ok) continue;
      const text = await r.text();
      if (BATCH.test(url)) {
        let b = null;
        try { b = JSON.parse(text); } catch { continue; }
        for (const e of b?.batch || []) if (typeof e?.body === 'string') mail.push({ name: e.name, body: e.body, receipt: e.receipt || null });
      } else {
        mail.push({ name: url.slice(inbox.length), body: text, receipt: await readJson(podFetch, url + '.receipt.json') });
      }
      taken.push(url);
    }
    if (mail.length) {
      say('Bringing your waiting mail into the app…');
      const handed = await fetch(fill.base + 'mail', { method: 'POST', headers: auth, body: JSON.stringify({ items: mail }) });
      // Handed over: out of the pod inbox, so FediPod does not read it twice.
      if (handed.ok) {
        for (const url of taken) {
          await podFetch(url, { method: 'DELETE' }).catch(() => {});
          await podFetch(url + '.receipt.json', { method: 'DELETE' }).catch(() => {});
        }
      }
    }
    return true;
  } catch { return false; }
}
