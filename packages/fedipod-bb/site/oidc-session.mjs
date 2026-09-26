// oidc-session.mjs — signing in to a pod: the session library bound to the
// FediPod app's database and client name, so the app and the forum on one
// site share one session.
import { solidOidcSession } from 'fediverse-account/oidc-session.mjs';

export const { beginLogin, completeLogin, getSession, signOut } = solidOidcSession({ dbName: 'fedipod-oidc', clientName: 'FediPod' });
