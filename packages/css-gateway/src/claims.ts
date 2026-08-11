// claims.ts — which requests the gateway owns, so canHandle can reject the rest
// and let normal pod/LDP traffic fall through to CSS. Scoped by HOST: on the
// front's apex the gateway answers the fediverse routes; a pod subdomain is a
// real Solid pod and is never claimed.

const FRONT_PATHS = new Set(['/', '/signup', '/new-account',
  '/.well-known/webfinger', '/api/handle', '/api/attach']);

export function claims(input: { host?: string; pathname: string }, frontHost: string): boolean {
  if (!input.host || !frontHost) return false;
  const bare = String(input.host).split(':')[0].toLowerCase();
  if (bare !== String(frontHost).toLowerCase()) return false;   // a pod subdomain → not ours
  return FRONT_PATHS.has(input.pathname) || input.pathname.startsWith('/u/');
}
