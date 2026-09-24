// token-claims.mjs — who a Solid access token says it is for, unchecked.
//
// Only for choosing where to send a read that the pod checks anyway: the
// owner's full outbox lives on the pod under the owner's own rule, so reading
// the claim decides nothing but the address. Verifying it here would let
// anyone make the front fetch signing keys from a server they name, on every
// read.

export function claimedWebId(request) {
  const token = /^(?:DPoP|Bearer)\s+([\w-]+)\.([\w-]+)\./u.exec(request.headers.get('authorization') || '');
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token[2], 'base64url').toString('utf8'));
    return typeof claims?.webid === 'string' ? claims.webid : null;
  } catch { return null; }
}
