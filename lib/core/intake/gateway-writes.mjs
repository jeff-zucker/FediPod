// gateway-writes.mjs — what fedipod.net did for this account while its owner
// was away, handed over through the pod inbox (lib/gateway/pod-mail.mjs)
// because fedipod.net never writes the pod itself. The drain finds the item by
// its name, believes it only with a receipt stamped by this account's door
// secret for this account, and applies it with the owner's own sign-in:
//
// - the pod writes (posts, pictures, collections, rules), in order, and only
//   inside the account's own folder or the pod's discovery documents;
// - the changes to state documents, except those the agent is working from at
//   the gateway right now (the copy has them already), and only once: the
//   pod's replica.json says how far it has been brought.
import { applyDelta } from '../doc-delta.mjs';

// gw-<seq, ten digits>-<hash>.json: sorted by name is applied in order.
export const isGatewayWrites = (url) => /\/gw-\d{10}-[0-9a-f]{16,64}\.json$/u.test(url);
export const gatewayWritesName = (seq, hash) => `gw-${String(seq).padStart(10, '0')}-${hash}.json`;
export const MAX_GATEWAY_WRITES_BYTES = 8 * 1024 * 1024;
export const REPLICA = 'replica.json';

// A document's change, or its changes in order (several runs handed over as one).
const applyAll = (doc, delta) => (Array.isArray(delta) ? delta : [delta]).reduce((d, one) => applyDelta(d, one), doc);

const sha256Hex = async (text) => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

function b64bytes(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Where fedipod.net may write on this pod, for this account. */
function allowed(intake, url) {
  const home = intake.urls.home;
  const base = intake.urls.base;
  return typeof url === 'string' && !url.includes('..')
    && (url.startsWith(home) || (base && url.startsWith(base + '.well-known/')));
}

/**
 * Apply one item. `receipt` is what readReceipt returned: verified against
 * this account's secret, or null. Returns null when applied, or the reason it
 * was refused (a dead letter). Throws when the pod refused a write, so the
 * item is tried again on a later sweep.
 */
export async function applyGatewayWrites(intake, url, raw, receipt) {
  if (!receipt || receipt.method !== 'gateway-writes' || receipt.actor !== intake.urls.actor) {
    return 'an item named as fedipod.net\'s, without fedipod.net\'s stamp for this account';
  }
  if (receipt.hash !== await sha256Hex(raw)) return 'fedipod.net\'s stamp is for a different item';
  let item;
  try { item = JSON.parse(raw); } catch { return 'unparsable item from fedipod.net'; }
  if (item?.type !== 'fedipod:GatewayWrites' || item.seq !== receipt.seq) return 'not an item of fedipod.net\'s writes';

  let written = 0;
  for (const w of item.writes || []) {
    if (!allowed(intake, w.url)) { intake.log(`fedipod.net's item ${item.seq}: not written outside the account: ${w.url}`); continue; }
    const body = w.method === 'DELETE' ? undefined : (w.text ?? (w.base64 ? b64bytes(w.base64) : ''));
    const res = await intake.remote.fetch(w.url, {
      method: w.method, ...(body !== undefined ? { body } : {}),
      ...(w.contentType ? { headers: { 'content-type': w.contentType } } : {}),
    });
    if (res.status >= 500 || res.status === 429) throw new Error(`the pod answered ${res.status} to ${w.method} ${w.url}`);
    if (res.status >= 400 && !(w.method === 'DELETE' && res.status === 404)) {
      intake.log(`fedipod.net's item ${item.seq}: the pod refused ${w.method} ${w.url} (${res.status})`);
      continue;
    }
    written++;
  }

  const replica = intake.store.read(REPLICA, { seq: 0 });
  let changed = 0;
  if (item.seq > (replica.seq || 0)) {
    for (const [name, delta] of Object.entries(item.deltas || {})) {
      if (intake.inCopy?.(name)) {
        // The store works on this one at the gateway, which already has the
        // change: it is the pod's own document that is brought up to date.
        if (!intake.podState) continue;
        const r = await intake.podState.read(name);
        if (!r.ok && r.status !== 404) throw new Error(`${name} could not be read on the pod (${r.status})`);
        let doc = null;
        try { doc = r.ok ? JSON.parse(r.body) : null; } catch { doc = null; }
        const w = await intake.podState.write(name, JSON.stringify(applyAll(doc, delta), null, 2) + '\n', 'application/json');
        if (!w.ok) throw new Error(`${name} could not be written on the pod (${w.why})`);
      } else {
        intake.store.write(name, applyAll(intake.store.read(name, null), delta));
      }
      changed++;
    }
    intake.store.write(REPLICA, { seq: item.seq, at: new Date().toISOString() });
  }
  intake.log(`fedipod.net's item ${item.seq} applied: ${written} pod write(s), ${changed} document change(s)`);
  intake.appliedSeq = Math.max(intake.appliedSeq || 0, item.seq);
  return null;
}
