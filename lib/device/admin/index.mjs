// admin.mjs — loopback HTTP front: admin API + Mastodon client-API facade +
// the bundled Phanpy UI served same-origin (no CORS, no mixed content — the
// role data-kitchen's router plays for the in-app pane). Loopback-bound; the
// gate (vendor/gate.cjs) engages only when a token is configured, exactly
// its standalone behavior.
//
// The surface is surface.mjs, its routes are the modules under routes/, the
// static serving is static.mjs, the listener is server.mjs. This file is the
// door the rest of the agent imports through.

export { buildAdminSurface } from './surface.mjs';
export { startAdmin } from './server.mjs';
export { namedOrigin, secureOrigin, wsOrigins } from './origins.mjs';
