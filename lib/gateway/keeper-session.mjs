// keeper-session.mjs — the gateway's own pod identity at work: one grant per
// running copy, shared by every account it works for, so a round is one token,
// not one per account (keeper.mjs, state-api.mjs).
import crypto from 'node:crypto';
import grant from '../../vendor/idp-grant.cjs';

// The same credential is the same session, however it arrives: the deployment
// reads its settings into a new object each time, and comparing objects made
// a new session, and so a new sign-in at the issuer, for every request that
// reached a pod. Kept as a hash, so the secret is not held here a second time.
const markOf = (cred) => crypto.createHash('sha256')
  .update(`${cred.clientId}\n${cred.secret}\n${cred.tokenEndpoint}`).digest('hex');

let shared = null;
export function keeperSession(cred) {
  const mark = markOf(cred);
  if (!shared || shared.mark !== mark) shared = { mark, session: grant.createGrantSession(cred) };
  return shared.session;
}
