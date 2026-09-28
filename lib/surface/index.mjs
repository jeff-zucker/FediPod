// The identity's HTTP surface: the Mastodon client API and OAuth, the
// ActivityPub client-to-server door, nodeinfo, the owner's door and routes,
// and the pages and client served off disk. buildAdminSurface returns one
// request handler; whatever listens hands it requests.

export { buildAdminSurface } from './surface.mjs';
export { namedOrigin, secureOrigin, wsOrigins } from './origins.mjs';
