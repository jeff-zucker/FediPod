// shapes-text.mjs — the shapes document, as text.
//
// The shapes are authored as Turtle in activitystreams.ttl, which is the one
// source of truth and opens in any RDF tool. Reading it differs by where this
// runs: Node reads the file, and the browser bundle swaps this module for a
// shim that imports the same .ttl through esbuild's text loader.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHAPES_TTL = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'activitystreams.ttl'), 'utf8',
);
