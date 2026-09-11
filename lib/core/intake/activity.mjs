// activity.mjs — what an inbound activity IS, before anything is done with
// it: the AS2 types the fediverse actually posts, the caps that bound what a
// stranger can make the agent hold, and the pure checks on ids, origins and
// authorship that every other intake module shares.

// A note's replies collection is rewritten WHOLE every time one is added, so
// without a cap the bytes are quadratic in a number a stranger chooses.
export const MAX_REPLIES_RECORDED = 500;
// Ids of activities already forwarded to our followers (§7.1.2), so a re-drain
// never re-broadcasts one. A ceiling on the record, not on forwarding.
export const MAX_FORWARDED = 2000;
// How many posts may wait for a group operator's decision. A ceiling, not a
// window: full refuses the newest rather than dropping the oldest.
export const MAX_PENDING_REVIEW = 500;
// A group's membership, cached: it changes when someone joins or leaves, and
// re-reading it on every arriving post would spend one stranger's fetch per
// message on a list that moves in days.
export const CO_MEMBER_TTL_MS = 24 * 60 * 60_000;
export const CO_MEMBER_MAX = 5000;
// An activity is a few kB. This is generous by two orders of magnitude and
// still bounds what one Append can make us hold in memory.
export const MAX_ITEM_BYTES = 512 * 1024;
// The AS2 actor types. A group is as much an actor as a person is.
export const ACTOR_TYPES = new Set(['Person', 'Group', 'Service', 'Application', 'Organization']);
// The AS2 types the fediverse actually posts. `Note` alone is Mastodon's world
// and not the fediverse's: an Article is a Plume or WriteFreely post, a
// Question is a poll, a Video is PeerTube, a Page is Lemmy, an Audio is
// Funkwhale. Insisting on Note dead-lettered every one of them as "not a
// verifiable Note" — from people the owner had chosen to follow, silently.
//
// They share the shape this code reads: attributedTo, content, published,
// inReplyTo, tag, attachment. A poll's options are dropped, which is a
// degraded rendering rather than a lost post.
export const CONTENT_TYPES = new Set(['Note', 'Article', 'Question', 'Page', 'Video', 'Audio', 'Image', 'Event']);

// A Question is a poll: its options live in oneOf (pick one) or anyOf (pick
// several), each carrying the tally its author's server maintains.
// Custom emojis ride the tag list; the images live at the author's server and
// the client fetches them from there.
// Content, name and summary were capped; nothing else was. One remote Question
// with thousands of options, or thousands of emoji, mention or attachment
// entries, put megabytes into a single statuses.json row — a document rewritten
// whole on every change. These are display lists: past a few dozen, nothing can
// render them and nobody meant them to be rendered.
// http(s) only. An emoji, attachment or mention URL is written straight into
// the client's markup, so `javascript:` and `data:` have no business in one.
// The store has guarded avatars this way all along (safeUrl, lib/store.mjs);
// these three lists were simply never put through it.
export const httpOnly = (u) => {
  if (!u) return null;
  try {
    const p = new URL(String(u));
    return (p.protocol === 'https:' || p.protocol === 'http:') ? String(u) : null;
  } catch { return null; }
};

export const MAX_MODQUEUE = 200;
export const MAX_EMOJIS = 60;
export const MAX_POLL_OPTIONS = 50;
export const MAX_OPTION_CHARS = 200;
export const MAX_MENTIONS = 60;
export const MAX_URL_CHARS = 2048;

export function emojisOf(note) {
  return [].concat(note?.tag || [])
    .filter(t => t?.type === 'Emoji' && t.icon?.url && t.name)
    .slice(0, MAX_EMOJIS)
    .map(t => ({
      shortcode: String(t.name).replace(/^:|:$/g, '').slice(0, 64),
      url: httpOnly(String(t.icon.url).slice(0, MAX_URL_CHARS)),
    }))
    .filter(e => e.url);
}

export function pollOf(note) {
  const opts = note?.oneOf || note?.anyOf;
  if (!Array.isArray(opts) || !opts.length) return null;
  return {
    multiple: !!note.anyOf,
    expiresAt: note.endTime || null,
    closed: !!note.closed,
    options: opts.slice(0, MAX_POLL_OPTIONS).map(o => ({
      title: String(o?.name ?? '').slice(0, MAX_OPTION_CHARS),
      votes: Number(o?.replies?.totalItems) || 0,
    })),
  };
}
// AS2 lets `type` be one string or a list, and implementations use both —
// `["Person","Service"]` is an ordinary actor. Read either form.
export const typesOf = (t) => (Array.isArray(t) ? t : [t]).filter(x => typeof x === 'string');
export const isContentType = (t) => typesOf(t).some(x => CONTENT_TYPES.has(x));
export const isActorType = (t) => typesOf(t).some(x => ACTOR_TYPES.has(x));

// What we will carry to our followers on someone else's behalf (§7.1.2): the
// activities a conversation is made of, and nothing else. A type this file
// does not handle falls out of handle() with no rejection, and "no rejection"
// is what qualifies an activity for forwarding — so without this gate a
// stranger could have anything at all, of a type nothing here reads,
// re-delivered to every follower over our signature.
export const FORWARDABLE = new Set(['Create', 'Update', 'Delete', 'Like', 'Announce', 'Undo']);
// Of those, the ones we may re-deliver to our own followers over our own
// signature (§7.1.2). Deliberately narrower than FORWARDABLE: these three are
// the ones whose object this drain fetched from the author's origin and checked
// before accepting. A Like, an Announce or an Undo is taken on the envelope's
// word alone — relaying one is signing for a claim nothing corroborated.
export const FORWARD_TYPES = new Set(['Create', 'Update', 'Delete']);
// How many forwards one drain may send. A reply into a busy thread of ours is a
// handful; anything near this is a flood using us as an amplifier.
export const MAX_FORWARDS_PER_DRAIN = 20;
export const ACCEPT_AP = 'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"';

// What is worth keeping of an activity we are filing rather than acting on.
//
// A dead letter, a moderation entry and a waiting follow request each used to
// hold the WHOLE delivered activity — up to the 512 KB item cap — in documents
// that are serialized and PUT whole on every change. A stranger could inflate
// deadletter.json to ~100 MB and requests.json to ~250 MB and make us rewrite
// them on every batch.
//
// Everything the consumers need survives: `acceptActivity` wraps this as the
// Accept's object (and {id, type, actor, object} IS the standard Follow shape),
// `applyModeration` reads only `object`, and a dead letter is read by a human
// who wants to know what arrived, not to replay it.
export function trimActivity(a) {
  if (!a || typeof a !== 'object') return a ?? null;
  const idOf = (v) => (typeof v === 'string' ? v : v?.id ?? null);
  const out = {};
  for (const k of ['id', 'type', 'actor', 'target']) {
    const v = idOf(a[k]);
    if (v) out[k] = String(v).slice(0, 2048);
  }
  const obj = idOf(a.object);
  if (obj) out.object = String(obj).slice(0, 2048);
  // A typed object with no id still says what it was — a Block of nobody, an
  // Undo of a Follow — and that is the whole of what the queue reads.
  else if (a.object && typeof a.object === 'object' && a.object.type) {
    out.object = { type: String(a.object.type).slice(0, 64) };
  }
  return out;
}

// Same origin AND, where the origin holds more than one identity, the same
// identity within it.
//
// Origin alone is the right test when an origin is one person — the ordinary
// fediverse server, and a subdomain pod. It is the WRONG test on a path-based
// host, and above all on a multi-tenant front: every tenant of fedipod.net has
// ids under `https://fedipod.net/u/<name>/`, so origin-equality made every
// tenant able to vouch for every other. One tenant could publish posts
// attributed to another, Update a neighbour's post, or Delete it — and a
// receiving Mastodon would believe it for the same reason we did.
//
// So when both ids carry an identity prefix, the prefixes must match too. The
// two shapes that exist here are the front's `/u/<name>/` and a pod's own AP
// root (`…/<root>/ap/…`); anything else has no prefix and falls back to origin,
// which is what a plain remote server should be judged by.
function identityPrefix(u) {
  const m = /^(https?:\/\/[^/]+\/u\/[^/]+\/)/u.exec(u);
  if (m) return m[1];
  const ap = /^(https?:\/\/[^/]+\/(?:[^/]+\/)*?)ap\//u.exec(u);
  return ap ? ap[1] : null;
}

export function sameIdentity(a, b) {
  if (!sameOrigin(a, b)) return false;
  const pa = identityPrefix(String(a));
  const pb = identityPrefix(String(b));
  if (!pa || !pb) return true;              // no prefix to compare: origin is the answer
  return pa === pb;
}

export function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

// Is this socket URL the pod's own? The scheme has to be the socket form of the
// pod's — wss for https, ws for http — so a downgrade to plaintext from an https
// pod is somewhere else, not the same place unencrypted.
//
// The host may be the pod's, or a PARENT of it. Not a loosening for
// convenience: a CSS server that gives every pod a subdomain answers
// notifications from the server root, so jeff-zucker.teamid.live is served by
// wss://teamid.live/.notifications/… — which is the deployment this project
// actually runs on. Requiring an exact match dropped it to polling, and the
// live agents are how that was found rather than the suite.
//
// A sibling subdomain is still refused: only a suffix of our own host passes,
// and two labels minimum so `.live` cannot pose as everyone's parent. Not a
// public-suffix list — that is a dependency and a data file to keep current,
// and the party this guards against is the pod you already chose to trust.
//
// `localhost` is the one single-label parent allowed, because it is the one that
// cannot be anybody else: it is reserved to the loopback interface (RFC 6761),
// so `alice.localhost` and `localhost` are the same machine by definition and
// there is no stranger for the rule to keep out. Without this a pod served from
// a subdomain of localhost — which is how a Solid server with subdomain pods
// runs on a developer's machine — refused its own socket and fell back to
// polling, so every delivery waited up to two minutes.
export function sameSocketOrigin(socketUrl, podBase) {
  let s, p;
  try { s = new URL(socketUrl); p = new URL(podBase); } catch { return false; }
  if (s.protocol !== (p.protocol === 'https:' ? 'wss:' : 'ws:')) return false;
  if (s.host === p.host) return true;
  const parent = s.hostname.toLowerCase();
  return (parent.split('.').length >= 2 || parent === 'localhost')
    && s.port === p.port
    && p.hostname.toLowerCase().endsWith('.' + parent);
}

export function httpUrl(u) {
  try {
    const p = new URL(String(u)).protocol;
    return p === 'https:' || p === 'http:';
  } catch { return false; }
}

// Who a note is BY. A document may only speak for an actor at its own origin.
// `attributedTo` used to be taken at face value, so a note served anywhere
// could name anyone: one at a host the attacker controls, claiming to be by
// someone the owner follows, passed every check we had — the envelope's
// sameOrigin compares the ACTIVITY to its object, never the object to its
// author — and landed in the home timeline and in the pod as them. For a group
// it went further still, because amplify() gates on the author's membership,
// so the group signed an Announce of it and delivered it to every member.
//
// `delivered` is the actor that brought it, used only when the note names no
// author of its own; it has to clear the same test, which is why a boost of an
// unattributed note is refused rather than credited to the booster.
//
// Returns the author, or null when nothing at the note's origin vouches for one.
export function authorOf(note, delivered = null) {
  const claimed = [].concat(note?.attributedTo || [])
    .map(a => (typeof a === 'string' ? a : a?.id)).find(Boolean) || null;
  const author = claimed || delivered;
  if (!author) return null;
  // sameIdentity, not sameOrigin: on a multi-tenant front every tenant shares
  // an origin, so origin-equality let any of them be credited with any other's
  // post. See sameIdentity.
  return sameIdentity(note?.id, author) ? author : null;
}
