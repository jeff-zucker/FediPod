// build-app.mjs — bundle the in-browser agent (and its pieces) with esbuild.
//
// The agent's brain is lib/, written for Node. This bundles it for a browser by
// swapping the Node-only edges for shims (web/app/shims/) and stubbing the Node
// modules the browser agent never uses (a local HTTP server, the filesystem,
// DNS pinning). A stubbed module that is actually called throws a named error,
// so a missing port shows up loudly rather than as silent wrong behaviour.
//
//   node scripts/build-app.mjs [--entry <file>] [--out <file>]
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shim = (p) => path.join(root, 'web/app/shims', p);

// Node modules the browser agent does not use. Stubbed to an empty module so an
// unrelated transitive import does not fail the build; anything that truly needs
// one will fail at runtime with a clear message, which is the signal to port it.
const STUBBED = ['node:fs/promises', 'node:os', 'node:net', 'node:http',
  'node:https', 'node:dns', 'node:dns/promises', 'node:child_process', 'node:tls',
  'undici', 'node-forge'];

const aliasPlugin = {
  name: 'fedipod-agent-aliases',
  setup(build) {
    build.onResolve({ filter: /^@fedify\/fedify\/sig$/ }, () => ({ path: shim('fedify-sig.mjs') }));
    build.onResolve({ filter: /^node:crypto$/ }, () => ({ path: shim('node-crypto.mjs') }));
    build.onResolve({ filter: /^node:path$/ }, () => ({ path: shim('node-path.mjs') }));
    build.onResolve({ filter: /^node:url$/ }, () => ({ path: shim('node-url.mjs') }));
    build.onResolve({ filter: /^node:fs$/ }, () => ({ path: shim('node-fs.mjs') }));
    build.onResolve({ filter: /^web-push$/ }, () => ({ path: shim('web-push.mjs') }));
    build.onResolve({ filter: /\/safefetch\.mjs$/ }, () => ({ path: shim('safefetch.mjs') }));
    const stub = new RegExp(`^(${STUBBED.map((s) => s.replace('/', '\\/')).join('|')})$`);
    build.onResolve({ filter: stub }, (args) => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: `const fail = () => { throw new Error(${JSON.stringify(args.path)} + ' is not available in the browser agent'); };`
        + 'export default new Proxy({}, { get: () => fail });',
      loader: 'js',
    }));
  },
};

export async function buildApp({ entry, out, minify = false, format = 'esm' } = {}) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true, format, platform: 'browser', target: 'es2022',
    outfile: out, sourcemap: true, minify, logLevel: 'silent', metafile: true,
    plugins: [aliasPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: fs.readFileSync(shim('prelude.js'), 'utf8') },
  });
  return { out, bytes: Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const entry = args[args.indexOf('--entry') + 1] || path.join(root, 'web/app/agent.mjs');
  const out = args[args.indexOf('--out') + 1] || path.join(root, 'web/app/dist/agent.js');
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : 'esm';
  const { bytes } = await buildApp({ entry, out, format });
  console.log(`built ${path.relative(root, out)} — ${Math.round(bytes / 1024)} KB`);
}
