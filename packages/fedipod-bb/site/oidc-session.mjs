// The forum uses the same IndexedDB session as the FediPod browser app.
import { solidOidcSession } from './solid-oidc-session.mjs';

export const { beginLogin, completeLogin, getSession, signOut } = solidOidcSession({ dbName: 'fedipod-oidc', clientName: 'FediPod' });
