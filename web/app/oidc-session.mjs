// oidc-session.mjs — FediPod's Solid-OIDC session: the solid-oidc-session
// library (fediverse-session) bound to this app's database and client name. The
// page and the service worker both import this file, so both read one session.
import { solidOidcSession } from 'fediverse-session/oidc-session.mjs';

export const { beginLogin, completeLogin, getSession, signOut } = solidOidcSession({ dbName: 'fedipod-oidc', clientName: 'FediPod' });
