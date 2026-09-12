// shapes-text.mjs — the shapes document in the browser agent.
//
// Same activitystreams.ttl the Node agent reads; esbuild's text loader turns
// it into a string at build time, so there is no filesystem here and no second
// copy of the shapes.
import ttl from '../../../lib/core/shapes/activitystreams.ttl';

export const SHAPES_TTL = ttl;
