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
import { namesPrivateAddress, safeFetch, readCapped } from '../shared/safefetch.mjs';

function claimsOf(request) {
  const token = /^(?:DPoP|Bearer)\s+([\w-]+)\.([\w-]+)\./u.exec(request.headers.get('authorization') || '');
  if (!token) return null;
  try { return JSON.parse(Buffer.from(token[2], 'base64url').toString('utf8')); } catch { return null; }
}

export function claimedWebId(request) {
  const webid = claimsOf(request)?.webid;
  return typeof webid === 'string' ? webid : null;
}

// Whether checking this token would stay off private addresses: the WebID it
// names, its identity provider, and the key set that provider names. A token
// the check cannot read fetches nothing. A provider whose settings cannot be
// read here, by a fetch that refuses private addresses at every redirect, is
// refused: the check's own fetch follows redirects anywhere.
async function fetchesArePublic(request) {
  const c = claimsOf(request);
  if (!c) return true;
  if (typeof c.webid === 'string' && await namesPrivateAddress(c.webid)) return false;
  if (typeof c.iss !== 'string') return true;
  if (await namesPrivateAddress(c.iss)) return false;
  let jwks = null;
  try {
    const res = await safeFetch(`${c.iss.replace(/\/$/u, '')}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } });
    jwks = JSON.parse(await readCapped(res, 64 * 1024))?.jwks_uri;
  } catch { return false; }
  return !(typeof jwks === 'string' && await namesPrivateAddress(jwks));
}

// Verify a Solid-OIDC token (DPoP-bound) and return its WebID, or null. The
// verifier is injected so tests stub it; in production it is the same library
// the agent's own C2S auth uses.
// Checking fetches the WebID and the identity provider the token names, and a
// stranger names them. `only`, when the caller knows whose token it wants,
// refuses a token naming anyone else before that; `publicOnly`, where any
// token may arrive, refuses one whose check would reach a private address.
export async function verifyPodToken(request, pathname, verifier, { only = null, publicOnly = false } = {}) {
  const authz = request.headers.get('authorization');
  if (!authz) return null;
  const claimed = claimedWebId(request);
  if (only && claimed && !only(claimed)) {
    console.log(`front: pod token for somebody else refused unchecked on ${pathname}`);
    return null;
  }
  if (publicOnly && !await fetchesArePublic(request)) {
    console.log(`front: pod token naming a private address refused unchecked on ${pathname}`);
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
