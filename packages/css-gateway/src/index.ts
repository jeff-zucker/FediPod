// Public entry: the class Components.js instantiates. The pure helpers are
// imported by the package's own tests directly from their built modules, so
// they are deliberately NOT re-exported here — the generator would otherwise
// try to treat the helper functions as components.
export { FediPodGatewayHandler } from './handler';
export type { FediPodGatewayArgs } from './handler';
