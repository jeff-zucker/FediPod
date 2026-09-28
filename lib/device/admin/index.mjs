// The DeviceAgent's door to the surface: the surface itself is
// lib/surface/, the listener is server.mjs beside this file, and the setup
// and process routes are routes/setup.mjs.

export { buildAdminSurface, namedOrigin, secureOrigin, wsOrigins } from '../../surface/index.mjs';
export { startAdmin } from './server.mjs';
