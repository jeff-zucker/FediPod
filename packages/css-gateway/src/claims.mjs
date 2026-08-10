// claims.mjs — which requests the gateway owns, so the handler's canHandle can
// reject everything else and let normal pod/LDP traffic fall through to CSS.
//
// Scoped by HOST. On the front's apex (e.g. fedipod.net) the gateway answers
// the fediverse-facing routes; a pod subdomain (alice.fedipod.net) is a real
// Solid pod and is never claimed — its requests pass straight to CSS. This is
// what lets one CSS host both the front and the pods without collision.

const FRONT_PATHS = new Set(['/', '/signup', '/new-account',
  '/.well-known/webfinger', '/api/handle', '/api/attach']);

export function claims({ host, pathname }, frontHost) {
  if (!host || !frontHost) return false;
  // The bare host, without a port, compared to the configured front host.
  const bare = String(host).split(':')[0].toLowerCase();
  if (bare !== String(frontHost).toLowerCase()) return false;   // a pod subdomain → not ours
  return FRONT_PATHS.has(pathname) || pathname.startsWith('/u/');
}
