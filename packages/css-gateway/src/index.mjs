// Public entry: the class Components.js instantiates. Importing this pulls in
// CSS (a peer dependency), so it is loaded only inside a running server; the
// unit tests import the pure modules (adapt, claims, directory) directly.
export { FediPodGatewayHandler } from './handler.mjs';
