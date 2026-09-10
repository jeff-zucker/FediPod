// urls.mjs — where an ActivityPub actor's documents live on a Solid pod.
//
// Everything the actor owns nests under ONE top-level container (`root`), so
// the pod stays tidy and one pod could host several actors under different
// roots. WebFinger and host-meta are the exception: fediverse discovery only
// ever looks at the host root, so they sit at the pod base.
//
// `root` is REQUIRED. It used to default, and the default disagreed with what
// one of the two callers actually passed — which is the kind of bug that puts
// an actor's state in one container and its published documents in another.
// A library has no business having an opinion about which container an
// application uses; the application states it.
//
// When `publicBase` is given — an identity whose ADVERTISED ids live somewhere
// else, e.g. "https://front.example/u/me/" — the ids a remote server sees build
// on that instead, while the pod-side trees and every write target stay on the
// pod. `toPod`/`toPublic` map between the two spaces, and a transport applies
// `toPod` at its one request choke point, so callers keep passing advertised
// ids and the writes still land on the pod. With no `publicBase` the returned
// object is byte-identical to the unfronted form — an invariant worth keeping,
// because it is what lets the fronted case be tested against the plain one.

export function apUrls(remotePod, root, { publicBase = null } = {}) {
  if (!root) throw new Error('apUrls: a container root is required — the caller states it, this library does not guess');
  const base = remotePod.endsWith('/') ? remotePod : remotePod + '/';
  const home = base + (root.endsWith('/') ? root : root + '/');
  // The face a remote sees: the fronted home, or the pod home when unfronted.
  const face = publicBase ? (publicBase.endsWith('/') ? publicBase : publicBase + '/') : home;
  const urls = {
    base, home,
    webfinger: base + '.well-known/webfinger',
    actor: face + 'ap/actor',
    inbox: face + 'ap/inbox/',
    outbox: face + 'ap/outbox',
    followers: face + 'ap/followers',
    following: face + 'ap/following',
    notes: face + 'ap/notes/',
    privateNotes: face + 'ap/private/',
    featured: face + 'ap/featured',
    // FEP-1b12: the moderator roster a recipient validates announced
    // moderation against. Published only when moderators are configured.
    moderators: face + 'ap/moderators',
    // FEP-4ccd and FEP-c648: follows in limbo and the block list, as
    // collections. They live in the private container so the owner-only ACL
    // is inherited, not re-stated per document.
    pendingFollowers: face + 'ap/private/pending-followers',
    pendingFollowing: face + 'ap/private/pending-following',
    blocked: face + 'ap/private/blocked',
    profileHtml: face + 'ap/profile.html',
    // Media stays on the pod even when fronted: attachment urls are not
    // identity-checked by remotes, and proxying blobs would be pure cost.
    media: home + 'ap/media/',
    state: home + 'ap-state/',
  };
  if (publicBase) {
    urls.podHome = home;
    urls.publicHome = face;
    urls.toPod = (u) => (typeof u === 'string' && u.startsWith(face) ? home + u.slice(face.length) : u);
    urls.toPublic = (u) => (typeof u === 'string' && u.startsWith(home) ? face + u.slice(home.length) : u);
  }
  return urls;
}

// The host a handle would resolve through, or null when no handle can point
// here. @name@host is looked up at https://host/.well-known/webfinger, so only
// a pod that owns the root of its host can answer for one; a pod living at
// https://server/name/ may publish the document but nothing will ever ask.
export function webfingerHost(podUrl) {
  const u = new URL(podUrl);
  return u.pathname === '/' ? u.host : null;
}
