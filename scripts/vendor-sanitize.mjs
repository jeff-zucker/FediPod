// vendor-sanitize.mjs — sanitize-html and the HTML parser it uses, packed into
// one CommonJS file, vendor/sanitize-html.cjs, which lib/core/wire.mjs imports.
//
// sanitize-html is CommonJS and require()s htmlparser2, which since 12 ships
// only as an ES module. Node 24 lets require() load one; the Node that runs
// the Netlify functions does not, so every function that cleans HTML failed to
// load there (2026-09-26). Packed, the parser is part of this one file and
// nothing is require()d that cannot be. Run again after sanitize-html changes:
//
//   node scripts/vendor-sanitize.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const entry = require.resolve('sanitize-html');
const version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version;
const out = path.join(root, 'vendor/sanitize-html.cjs');
await build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node18',
  outfile: out, legalComments: 'inline', logLevel: 'warning',
  banner: { js: `// sanitize-html ${version} with its dependencies, packed by scripts/vendor-sanitize.mjs. Do not edit.` },
});
console.log(`packed sanitize-html ${version} → vendor/sanitize-html.cjs (${Math.round(fs.statSync(out).size / 1024)} KB)`);
