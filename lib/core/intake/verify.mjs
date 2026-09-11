// verify.mjs — how the drain decides what to believe: a signed fetch of the
// claimed document at its own origin, what local state already knows of, and
// the receipt a gateway left beside a delivery.

import * as podInbox from '../../pod/inbox.mjs';
import { readCapped } from '../../shared/safefetch.mjs';
import { isActorType, sameOrigin, ACCEPT_AP } from './activity.mjs';

export async function fetchAP(intake, url) {
  const res = await intake.deliverer.signedFetch(url, { headers: { accept: ACCEPT_AP } });
  if (res.status >= 400) return null;
  // Remote servers are untrusted: read with a byte budget rather than
  // letting res.json() buffer whatever they choose to send.
  const { readCapped } = await import('../../shared/safefetch.mjs');
  // Plenty of servers answer 200 text/html however politely we ask for AS2 —
  // people reply to ordinary web pages, and their id is that page. Say so,
  // rather than handing the HTML to JSON.parse and logging the parser's
  // complaint about an unexpected `<`.
  // Not logged: people reply to ordinary web pages, so the reply's object id
  // is that page and this is the expected answer, not a fault. Only a server
  // that CLAIMS to be sending JSON and then does not is worth a line.
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct && !ct.endsWith('json')) return null;
  let doc = null;
  try { doc = JSON.parse(await readCapped(res)); }
  catch (e) { intake.log(`fetch ${url}: unreadable as JSON — ${e.message}`); return null; }
  // A document is only evidence about its OWN origin.
  //
  // signedFetch follows redirects and hands back only the final response, and
  // every caller checks `doc.id` against the URL it ASKED for — so an open
  // redirector on a victim's origin let an attacker's server answer for a
  // victim's URL and be believed by that check.
  //
  // Only a redirect that CROSSED AN ORIGIN is refused here. A same-origin
  // redirect is ordinary (canonicalisation, trailing slashes), and a document
  // fetched with no redirect at all is still returned whatever it claims —
  // the callers reject it on id, and they say something more useful about it
  // than this could ("actor id mismatch", "object not verifiable content").
  const landed = res.finalUrl || url;
  if (!sameOrigin(landed, url) && doc && doc.id && !sameOrigin(doc.id, landed)) {
    intake.log(`fetch ${url}: redirected to ${landed}, which is not where ${doc.id} lives — refused`);
    return null;
  }
  // Every actor type, not just Person. A Group was fetched, used and thrown
  // away, so nothing knew its preferredUsername — and a client rendering it
  // fell back to the last path segment of the actor URL, which is the literal
  // word `actor`. That is where @actor@host came from.
  // Under the id the document CLAIMS, but only when its own origin vouches
  // for that id. A stranger's actor document naming someone else's id used to
  // overwrite that actor's cached name, bio, avatar and Person/Group flag —
  // one appended Follow was enough, and the id-mismatch checks in onFollow
  // and ingestNote both run after this line and never undid it.
  //
  // Same origin rather than exact equality: signedFetch follows redirects
  // without reporting where it landed, so a server that redirects its own
  // canonical actor URL would otherwise stop being cached at all.
  if (isActorType(doc?.type) && doc.id && sameOrigin(doc.id, url)) {
    intake.store.cacheActor(doc.id, doc);
  }
  return doc;
}

// Have we ever heard of this actor or object? Answered entirely from local
// state, so asking costs nothing. It is what stops a stranger's Delete or
// Update — of which Mastodon broadcasts a great many, and of which anyone at
// all can Append one — turning into a signed request to a host they chose.
export function known(intake, id) {
  const c = intake.store.getContacts();
  return c.followers.some(f => f.actor === id)
    || c.following.some(f => f.actor === id)
    || intake.store.getStatuses().some(s => s.noteId === id || s.actor === id)
    || !!intake.store.getActors()[id];
}

// Returns a rejection reason string, or undefined when handled.
// The gateway's shared HMAC secret, or null when no gateway is configured.
// Its absence is what makes the whole receipt path dormant by default.
export function gatewaySecret(intake) {
  return intake.store.getConfig()?.gateway?.hmacSecret || null;
}

// Shadow-mode measurement: how much real traffic actually verified. The one
// number an operator needs before trusting receipts. Only touched while a
// gateway is configured, so it costs a non-gateway install nothing.
export function bumpGatewayStat(intake, verified) {
  const s = intake.store.read('gateway-stats.json', { verified: 0, unverified: 0 });
  if (verified) s.verified++; else s.unverified++;
  s.lastAt = new Date().toISOString();
  intake.store.write('gateway-stats.json', s);
}

// Read and authenticate the receipt a gateway wrote beside an inbox item.
// Returns the receipt object only when its HMAC verifies against our secret;
// null otherwise (no gateway, no receipt, a stranger's forged one, or a read
// failure) — and null means "unverified", the pre-gateway behavior.
export async function readReceipt(intake, itemUrl) {
  const secret = intake.gatewaySecret();
  if (!secret) return null;
  try {
    const { readCapped: cap } = await import('../../shared/safefetch.mjs');
    const receipt = await podInbox.readDeliveryReceipt(intake.remote, itemUrl, { maxBytes: 64 * 1024, readCapped: cap });
    if (!receipt) return null;
    const { verifyReceipt } = await import('../../gateway/httpsig.mjs');
    return verifyReceipt(receipt, secret) ? receipt : null;
  } catch { return null; }
}

// Whether a receipt says anything about THIS actor. Verified-and-about-someone
// -else is worth exactly as much as unverified, and is treated the same way:
// the drain's verify-by-dereference still stands behind it.
export function receiptVouchesFor(intake, receipt, actor) {
  if (!receipt?.verified) return false;
  if (!receipt.actor || receipt.actor !== actor) return false;
  // A missing keyId with verified:true cannot come from our own door
  // (makeReceipt fills both from the same key), so refuse rather than waive.
  if (!receipt.keyId || !sameOrigin(receipt.keyId, actor)) return false;
  return true;
}

// Is this really gone at its origin? true / false / null when the origin
// could not be asked. Delivered bodies carry no signature, so this is how a
// Delete is verified — the same verify-by-dereference the rest of intake uses.
export async function isGone(intake, url) {
  let res;
  try { res = await intake.deliverer.signedFetch(url, { headers: { accept: ACCEPT_AP } }); }
  catch { return null; }
  if (res.status === 404 || res.status === 410) return true;
  if (res.status < 400) {
    // A Tombstone answers 200 and still means deleted.
    try {
      const { readCapped } = await import('../../shared/safefetch.mjs');
      return JSON.parse(await readCapped(res))?.type === 'Tombstone';
    } catch { return false; }
  }
  return null;                       // 401/403/5xx — no answer, not a denial
}
