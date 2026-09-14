// claims.ts — which requests the gateway owns, so canHandle can reject the rest
// and let normal pod/LDP traffic fall through to CSS. Scoped by HOST: on the
// front's apex the gateway answers the fediverse routes; a pod subdomain is a
// real Solid pod and is never claimed.

const FRONT_PATHS = new Set(['/', '/signup', '/new-account', '/run', '/roster',
  '/.well-known/webfinger', '/api/handle', '/api/attach', '/api/agent',
  '/api/roster', '/api/revoke',
  // What the pages load: the sign-in library the /run and /admin pages use, and
  // the installer the signup page hands every new user.
  '/solid-oidc-client.js', '/install']);

export function claims(input: { host?: string; pathname: string }, frontHost: string): boolean {
  if (!input.host || !frontHost) return false;
  const bare = String(input.host).split(':')[0].toLowerCase();
  if (bare !== String(frontHost).toLowerCase()) return false;   // a pod subdomain → not ours
  return FRONT_PATHS.has(input.pathname) || input.pathname.startsWith('/u/');
}

// What an identity answers on its own pod's origin: the protocol routes other
// software addresses it by, and the one path its owner's pages live under.
// Everything else on that origin is the pod, and falls through to CSS.
const AGENT_PATHS = new Set([
  '/ap/actor', '/ap/outbox',
  // The owner reading their own mail. Deliveries still go to the inbox
  // container on the pod, which the actor document names; nothing about
  // receiving changes, and nothing at this address was ever served before.
  '/ap/inbox',
  '/.well-known/nodeinfo', '/nodeinfo/2.0',
  // Where a client looks first to learn how to sign in. Nothing was served
  // at this name before, so no pod resource is displaced.
  '/.well-known/oauth-authorization-server',
]);
const AGENT_PREFIXES = [ '/api/', '/oauth/' ];

// An identity's inbox is the container `/<root>/ap/inbox/`, matched by shape
// rather than a fixed root. A POST here is a delivery, verified at the door
// before it is written; the handler checks the exact path per identity. The
// path is relative to the identity's mount (see agentClaims), so a suffix pod's
// `/aisha/fedipod/ap/inbox/` arrives here already stripped to `/fedipod/ap/inbox/`.
export const isInboxPath = (pathname: string): boolean => /^\/[^/]+\/ap\/inbox\/$/u.test(pathname);

/**
 * True when this path belongs to an identity's client surface.
 *
 * `pathname` is RELATIVE to the identity's mount: the handler has already
 * matched the request's host and mount to one identity (see resolveClaim) and
 * stripped the mount, so a host-root/subdomain pod passes its path unchanged
 * and a suffix pod on `/aisha/` passes the part after `/aisha`. That keeps this
 * a pure statement about which routes an identity owns, with no notion of host
 * or of where on the origin it lives.
 */
export function agentClaims(
  input: { pathname: string; method?: string },
  uiPath = '/fp/',
): boolean {
  const { pathname } = input;
  if (isInboxPath(pathname)) return String(input.method ?? '').toUpperCase() === 'POST';
  if (AGENT_PATHS.has(pathname)) return true;
  if (AGENT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  // The owner's door, when there is one: '' turns the pages off entirely.
  return uiPath !== '' && (pathname === uiPath.slice(0, -1) || pathname.startsWith(uiPath));
}
