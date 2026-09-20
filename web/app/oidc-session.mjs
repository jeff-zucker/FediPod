// oidc-session.mjs — FediPod's Solid-OIDC session: the solid-oidc-session
// library (lib/session/) bound to this app's database and client name. The
// page and the service worker both import this file, so both read one session.
import { solidOidcSession } from '../../lib/session/oidc-session.mjs';

export const { beginLogin, completeLogin, getSession, signOut } = solidOidcSession({ dbName: 'fedipod-oidc', clientName: 'FediPod' });
