// shapes-text.mjs — the shapes document, as text.
//
// The shapes are authored as Turtle in activitystreams.ttl, which is the one
// source of truth and opens in any RDF tool. Reading it differs by where this
// runs: Node reads the file, and the browser bundle swaps this module for a
// shim that imports the same .ttl through esbuild's text loader.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Beside this file, or — in a bundled deploy, where this file's own location
// is the bundle's — at its place in the project, which the Netlify functions
// ship (netlify.toml: included_files). The shapes decide nothing, so if
// neither is there they are left out rather than the process failing to
// start (2026-09-26).
const candidates = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'activitystreams.ttl'),
  path.join(process.cwd(), 'lib/core/shapes/activitystreams.ttl'),
];
const found = candidates.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
export const SHAPES_TTL = found ? fs.readFileSync(found, 'utf8') : '';
