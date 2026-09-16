// refresh-contexts.mjs — re-copy the JSON-LD contexts from @fedify/vocab-runtime.
//
// Fedify keeps that set current against real fediverse traffic; we hold our own
// copies so nothing in lib/ depends on a transitive package's internals, and so
// what we serve for a stranger's document is a file in this repo.
//
//   node scripts/refresh-contexts.mjs
//
// Run it after a fedify upgrade, then check `git diff lib/core/contexts/`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules/@fedify/vocab-runtime/src/contexts');
const dest = path.join(root, 'lib/core/contexts');
const module_ = fs.readFileSync(path.join(src, '..', 'contexts.ts'), 'utf8');

const idents = Object.fromEntries(
  [...module_.matchAll(/import (\w+) from "\.\/contexts\/([^"]+)"/gu)].map((m) => [m[1], m[2]]),
);
const map = {};
for (const m of module_.matchAll(/"([^"]+)":\s*(\w+),/gu)) {
  if (idents[m[2]]) map[m[1]] = idents[m[2]];
}

// Held beside fedify's set, not from it: fetched once by hand and kept.
const EXTRA = {
  'http://www.w3.org/ns/anno.jsonld': 'anno.json',
  // The litepub schema Pleroma and Akkoma serve per instance, and the quote
  // terms Mastodon declares inline; see lib/core/contexts/index.mjs.
  'http://litepub.social/ns': 'litepub-0.1.json',
  'https://w3id.org/fep/044f': 'quotes.json',
};

for (const file of Object.values(map)) fs.copyFileSync(path.join(src, file), path.join(dest, file));
Object.assign(map, EXTRA);
fs.writeFileSync(path.join(dest, 'map.json'), `${JSON.stringify(map, null, 2)}\n`);

const names = Object.fromEntries(Object.keys(map).map((u, i) => [u, `ctx${i}`]));
const header = fs.readFileSync(path.join(dest, 'index.mjs'), 'utf8').split('\nimport ')[0];
let out = `${header}\n`;
for (const [url, file] of Object.entries(map)) out += `import ${names[url]} from './${file}' with { type: 'json' };\n`;
// (EXTRA entries ride along in `map` above, so index.mjs and map.json keep them.)
out += '\n/** URL → the context document itself. Nothing outside this map is ever resolved. */\nexport const CONTEXTS = {\n';
for (const url of Object.keys(map)) out += `  '${url}': ${names[url]},\n`;
out += '};\n';
fs.writeFileSync(path.join(dest, 'index.mjs'), out);

console.log(`refreshed ${Object.keys(map).length} contexts into lib/core/contexts/`);
