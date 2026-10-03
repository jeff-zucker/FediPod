// check-netlify-bundles.mjs — before a deploy: the Netlify functions as Netlify
// ships them. Builds them with Netlify's own bundler (netlify functions:build),
// checks the account routes are the account function's and not the front's,
// and loads every function from its own unpacked bundle, outside this
// repository, where no node_modules beside the source can hide a missing
// module or file, under the rule Netlify's Node keeps: no require() of an
// ES-module-only package. The 1.40.0 and 1.40.2 failures (2026-09-26) are
// what this catches.
//
//   node scripts/check-netlify-bundles.mjs   (the deploy command runs it first)
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-bundles-'));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
try {
  execFileSync('netlify', ['functions:build', '--src', path.join(root, 'netlify/functions'), '--functions', path.join(tmp, 'zips')],
    { cwd: root, stdio: 'ignore' });
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'zips/manifest.json'), 'utf8'));
  const fn = Object.fromEntries(manifest.functions.map((f) => [f.name, f]));
  const routes = (f) => (f?.routes || []).map((r) => r.pattern).sort();
  const excluded = (f) => (f?.excludedRoutes || []).map((r) => r.pattern || r).sort();
  check(routes(fn.account).length > 0 && JSON.stringify(routes(fn.account)) === JSON.stringify(excluded(fn.front)),
    `the account function answers exactly the paths the front leaves out (${routes(fn.account).join(' ')})`);
  check(fn['flush-mail']?.schedule === '*/15 * * * *', 'the round is scheduled every fifteen minutes');
  // Netlify's storage, stood in for by the library's own local server, so a
  // request can run through each function and load what it loads on first use.
  const { BlobsServer } = await import(path.join(root, 'node_modules/@netlify/blobs/dist/server.js'));
  const blobs = new BlobsServer({ directory: path.join(tmp, 'blobs'), token: 'check', logger: () => {} });
  const { port } = await blobs.start();
  const env = {
    ...process.env,
    NETLIFY_BLOBS_CONTEXT: Buffer.from(JSON.stringify({ edgeURL: `http://127.0.0.1:${port}`, uncachedEdgeURL: `http://127.0.0.1:${port}`,
      siteID: 'check', token: 'check' })).toString('base64'),
    FEDIPOD_FRONT_HOST: 'fedipod.example', FEDIPOD_FRONT_ORIGIN: 'https://fedipod.example',
    FEDIPOD_KEEPER_WEBID: 'https://keeper.example/profile/card#me', FEDIPOD_KEEPER_CLIENT_SECRET: 'check-secret',
  };
  // What each function is asked, and the answers that mean it ran its code.
  const asks = {
    front: [['GET', '/', [200]], ['GET', '/.well-known/webfinger?resource=acct:nobody@fedipod.example', [404]],
      ['POST', '/u/nobody/ap/inbox/', [404, 410]]],
    account: [['GET', '/api/v2/instance', [200]], ['POST', '/api/v1/apps', [200], 'client_name=check&redirect_uris=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob'],
      ['GET', '/api/authorize?address=nobody', [404]], ['GET', '/api/v1/timelines/home', [401]], ['POST', '/api/state/open', [401]]],
    'keeper-background': [['POST', '/', [403], '{}']],
    'push-background': [['POST', '/', [403], '{}']],
    'flush-mail': [['POST', '/', [204]]],
  };
  for (const f of manifest.functions) {
    const dir = path.join(tmp, 'run', f.name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-q', path.join(tmp, 'zips', `${f.name}.zip`), '-d', dir]);
    const entry = path.join(dir, 'netlify/functions', `${f.name}.mjs`);
    // Netlify's Node will not require() a package that ships only as an ES
    // module; this machine's will. The flag makes this one refuse it too, which
    // is how 1.40.0 (jose) and 1.40.2 (htmlparser2 under sanitize-html) got
    // past a check that loaded fine here. Each run exits when it has answered
    // (a function may leave a timer behind), and not with execFileSync: the
    // storage stand-in runs in this process, and a blocked event loop would
    // never answer the function asking it.
    const run = (script) => promisify(execFile)(process.execPath, ['--no-experimental-require-module', '-e', script],
      { cwd: dir, env, encoding: 'utf8', timeout: 60_000 })
      .then((r) => r.stdout.trim().split('\n').pop())
      .catch((e) => `THREW ${String(e.stderr || e.message).trim().split('\n').pop()}`);
    const out = await run(`import(${JSON.stringify(entry)}).then((m) => console.log(typeof m.default))`
      + `.catch((e) => console.log('FAILS ' + e.message.split('\\n')[0])).finally(() => process.exit(0))`);
    check(out === 'function', `${f.name} loads from its own bundle${out === 'function' ? '' : ` (${out})`}`);
    for (const [method, p, ok, body] of asks[f.name] || []) {
      const got = await run(`import(${JSON.stringify(entry)}).then(async (m) => {
        const r = await m.default(new Request('https://fedipod.example' + ${JSON.stringify(p)}, { method: ${JSON.stringify(method)},
          ${body ? `body: ${JSON.stringify(body)}, headers: { 'content-type': ${JSON.stringify(body.startsWith('{') ? 'application/json' : 'application/x-www-form-urlencoded')} },` : ''} }), { waitUntil() {} });
        console.log(r.status);
      }).catch((e) => console.log('THREW ' + e.message.split('\\n')[0])).finally(() => process.exit(0))`);
      check(ok.includes(Number(got)), `${f.name} answers ${method} ${p} (${got})`);
    }
  }
  await blobs.stop();
} catch (e) { console.log('ERROR', e.message); fails++; }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall green');
process.exit(fails ? 1 : 0);
