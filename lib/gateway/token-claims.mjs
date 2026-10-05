// token-claims.mjs — who a Solid access token says it is for, unchecked.
//
// Only for choosing where to send a read that the pod checks anyway: the
// owner's full outbox lives on the pod under the owner's own rule, so reading
// the claim decides nothing but the address. Verifying it here would let
// anyone make the front fetch signing keys from a server they name, on every
// read.
//
// And checking one: verifyPodToken, which the front's routes share.

import { podTokenVerifier } from './caches.mjs';

export function claimedWebId(request) {
  const token = /^(?:DPoP|Bearer)\s+([\w-]+)\.([\w-]+)\./u.exec(request.headers.get('authorization') || '');
  if (!token) return null;
  try {
    const claims = JSON.parse(Buffer.from(token[2], 'base64url').toString('utf8'));
    return typeof claims?.webid === 'string' ? claims.webid : null;
  } catch { return null; }
}

// Verify a Solid-OIDC token (DPoP-bound) and return its WebID, or null. The
// verifier is injected so tests stub it; in production it is the same library
// the agent's own C2S auth uses.
// `only`, when the caller knows whose token it wants, refuses a token that
// names anyone else before it is checked: checking fetches the WebID and the
// identity provider the token names, and a stranger names them.
export async function verifyPodToken(request, pathname, verifier, { only = null } = {}) {
  const authz = request.headers.get('authorization');
  if (!authz) return null;
  const claimed = claimedWebId(request);
  if (only && claimed && !only(claimed)) {
    console.log(`front: pod token for somebody else refused unchecked on ${pathname}`);
    return null;
  }
  try {
    const dpop = request.headers.get('dpop');
    // Solid-OIDC binds the token to a key the client proves on every request;
    // a token shown without the proof is one anyone who saw it could show.
    if (!dpop) { console.log(`front: pod token without a DPoP proof refused on ${pathname}`); return null; }
    const v = verifier || await podTokenVerifier();
    const url = request.url;
    const { webid } = await v(authz, { header: dpop, method: request.method, url });
    return webid || null;
  } catch (e) {
    // Said aloud: a token the front will not take is otherwise a bare 401 to
    // the caller and nothing at all here.
    console.log(`front: pod token refused on ${pathname}: ${e?.message || e}`);
    return null;
  }
}
