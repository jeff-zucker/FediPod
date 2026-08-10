// oidc-auth.mjs — who may drive the C2S surface. Two proofs are accepted:
// the Mastodon facade's bearer (minted on this machine, so its holder is the
// operator by construction), or a Solid-OIDC token — DPoP-bound when the
// client sends the proof header — verified by the same library the wider
// Solid world uses. The token alone is not enough: the WebID it names must
// be THIS identity's owner, an authorization step the token does not carry.
//
// The verifier is injected so offline tests stub it, and wrapped so the
// library (CJS, older jose) can be replaced without touching any caller.

export function makeC2sAuth({ agent, masto = null, verifier = null, log = () => {} }) {
  let verify = verifier;
  const loadVerifier = async () => {
    if (!verify) {
      const { createSolidTokenVerifier } = await import('@solid/access-token-verifier');
      verify = createSolidTokenVerifier();
    }
    return verify;
  };

  return async function authenticate(req, pathname) {
    if (masto?.authed(req)) {
      return { ok: true, webid: agent.remote?.webId || null, via: 'bearer' };
    }
    if (!req.headers.authorization) {
      return { ok: false, status: 401, error: 'authentication required: a Solid-OIDC token (DPoP) or this agent\'s own bearer' };
    }
    let webid;
    try {
      const v = await loadVerifier();
      // The URL the client signed its proof over. The Host header already
      // passed the Authorities firewall, so whichever alias the client used
      // (localhost, 127.0.0.1, the named origin) is one this agent answers on.
      const htu = `http://${req.headers.host}${pathname}`;
      ({ webid } = await v(
        req.headers.authorization,
        req.headers.dpop ? { header: req.headers.dpop, method: req.method, url: htu } : undefined,
      ));
    } catch (e) {
      log(`c2s auth: token rejected — ${e.message}`);
      return { ok: false, status: 401, error: `token rejected: ${e.message}` };
    }
    const owner = agent.remote?.webId;
    if (!owner || webid !== owner) {
      // Verified is not authorized: a valid token from ANY WebID must not
      // post as this actor. (The gap jg10's outbox leaves open.)
      return { ok: false, status: 403, error: 'authenticated, but this outbox belongs to its owner alone' };
    }
    return { ok: true, webid, via: 'oidc' };
  };
}
