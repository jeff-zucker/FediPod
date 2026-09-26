// keeper-session.mjs — the gateway's own pod identity at work: one grant per
// running copy, shared by every account it works for, so a round is one token,
// not one per account (keeper.mjs, state-api.mjs).
import grant from '../../vendor/idp-grant.cjs';

let shared = null;
export function keeperSession(cred) {
  if (!shared || shared.cred !== cred) shared = { cred, session: grant.createGrantSession(cred) };
  return shared.session;
}
