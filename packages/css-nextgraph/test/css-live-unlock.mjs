// css-live-unlock.mjs — a real CSS on a locked wallets directory: the pods
// refuse, the unlock page takes the key, the pods answer. Proves the config
// wiring (the key component, the handler in the waterfall) that the offline
// tests cannot see.
//
//   cd claude/validation/nextgraph-spike && ./ngd.sh start
//   node packages/css-nextgraph/test/css-live-unlock.mjs
//
// The daemon, its log and its control script stay in the spike directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PKG, '../..');
const SPIKE = path.join(REPO, 'claude/validation/nextgraph-spike');
const { AppRunner } = require(path.join(PKG, 'node_modules/@solid/community-server'));
const { mintCredential, createGrantSession } = require(path.join(REPO, 'vendor/idp-grant.cjs'));

let fails = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) fails += 1; };

const PORT = 3459;
const BASE = `http://localhost:${PORT}/`;
const POD = `http://alice.localhost:${PORT}/`;
const UNLOCK = `${BASE}nextgraph/unlock`;
const peer = fs.readFileSync(path.join(SPIKE, 'ngd.log'), 'utf8').match(/PeerId of node:\s*(\S+)/)[1];
const keyFile = () => path.join(process.argv[3] ?? '', 'key');
const KEY = process.argv[2] === 'phase2'
  ? fs.readFileSync(keyFile(), 'utf8').trim()
  : execFileSync('node', [path.join(PKG, 'bin/css-nextgraph.mjs'), 'key'], { encoding: 'utf8' }).trim();

// Phase 2 runs in a process of its own: a credential minted twice in one
// process does not authenticate the second time.
const PHASE2 = process.argv[2] === 'phase2';
const tmp = PHASE2 ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'css-nextgraph-unlock-'));
const walletsDir = path.join(SPIKE, 'wallets', 'css-live-unlock');
if (!PHASE2) fs.rmSync(walletsDir, { recursive: true, force: true });
const seed = path.join(tmp, 'seed.json');
if (!PHASE2) fs.writeFileSync(seed, JSON.stringify([{ email: 'alice@example.com', password: 'sekrit', pods: [{ name: 'alice' }] }]));
const config = path.join(tmp, 'config.json');
if (!PHASE2) fs.writeFileSync(config, JSON.stringify({
  '@context': [
    'https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld',
    'https://linkedsoftwaredependencies.org/bundles/npm/css-nextgraph/^0.0.0/components/context.jsonld',
  ],
  import: ['cng:config/server.json'],
}, null, 2));

// The owner, signed in. Authorization runs ahead of the store, so an
// unauthenticated request never reaches the wallet and cannot show whether
// this server is locked. The credential is minted while the server is
// unlocked — minting one reads the owner's profile, which is on the pod.
const mint = async () => mintCredential({
  origin: BASE.replace(/\/$/u, ''), email: 'alice@example.com', password: 'sekrit', podUrl: POD, name: 'css-live-unlock',
});

const boot = async (seedConfig) => {
  const app = await new AppRunner().create({
    config,
    loaderProperties: { mainModulePath: PKG },
    shorthand: {
      port: PORT, baseUrl: BASE, rootFilePath: path.join(tmp, 'data'), loggingLevel: process.env.LOG || 'error',
      walletsDir, ngdPeerId: peer, ...(seedConfig ? { seedConfig } : {}),
    },
  });
  await app.start();
  return app;
};

// ---- phase 1: a key in the environment, so the pod and its sealed record exist
if (!PHASE2) {
  fs.writeFileSync(path.join(tmp, 'key'), KEY);
  process.env.CSS_NEXTGRAPH_KEY = KEY;
  const app = await boot(seed);
  try {
    const session = await createGrantSession(await mint());
    const put = await session.fetch(`${POD}notes/one`, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: '<> a <http://example.org/Note> .' });
    check(put.status === 201, `the owner writes a note to their pod (${put.status})`);
  } finally {
    await app.stop();
  }
  const records = fs.readdirSync(walletsDir).filter((f) => f.endsWith('.json'));
  check(records.length === 1, `one wallet record was written (${records.length})`);
  check(!!JSON.parse(fs.readFileSync(path.join(walletsDir, records[0]), 'utf8')).sealed, 'and it is sealed');

  let phase2 = 0;
  try {
    execFileSync('node', [process.argv[1], 'phase2', tmp], { stdio: 'inherit', timeout: 300000, env: { ...process.env, CSS_NEXTGRAPH_KEY: '' } });
  } catch (error) {
    phase2 = error.status ?? 1;
  }
  console.log(fails || phase2 ? `\n${fails} FAILED in phase 1${phase2 ? ', and phase 2 failed' : ''}` : '\nall passed');
  process.exit(fails || phase2 ? 1 : 0);
}

// ---- phase 2: the same directory, no key anywhere
const app = await boot(seed);
try {
  // Not the pod root: with css:config/app/init/static-root.json the path / on
  // every host is the static intro page, so a pod has to be asked for a
  // resource of its own. Authorization runs ahead of the store, so what this
  // can show is that the note is not served — the 503 itself is asserted
  // offline in accessor.test.mjs, where a call reaches the accessor directly.
  const locked = await fetch(`${POD}notes/one`, { headers: { accept: 'text/turtle' } });
  check(locked.status !== 200, `a locked server does not serve a pod resource (${locked.status})`);

  const gate = await fetch(UNLOCK);
  const gateBody = await gate.text();
  check(gate.status === 200 && /This server is locked/u.test(gateBody), `the unlock page is served on the base URL (${gate.status})`);
  check(/<form method="post" action="\/nextgraph\/unlock">/u.test(gateBody), 'and the form says where it posts');

  const onPod = await fetch(`${POD}nextgraph/unlock`);
  check(onPod.status !== 200 || !/This server is locked/u.test(await onPod.text()), 'a pod origin does not offer the unlock');

  const wrong = await fetch(UNLOCK, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: execFileSync('node', [path.join(PKG, 'bin/css-nextgraph.mjs'), 'key'], { encoding: 'utf8' }).trim() }),
  });
  check(wrong.status === 400, `a wrong key is refused (${wrong.status})`);
  check((await fetch(UNLOCK)).status === 200 && /This server is locked/u.test(await (await fetch(UNLOCK)).text()),
    'and the server is still locked');

  const right = await fetch(UNLOCK, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ key: KEY }),
  });
  const rightBody = await right.text();
  check(right.status === 200 && /open and answering/u.test(rightBody), `the right key unlocks (${right.status})`);

  const session = await createGrantSession(await mint());
  const after = await session.fetch(`${POD}notes/one`, { headers: { accept: 'text/turtle' } });
  check(after.status === 200 && /example.org\/Note/u.test(await after.text()),
    `the note written before the restart is readable again once unlocked (${after.status})`);

  const again = await fetch(UNLOCK);
  check(/This server is unlocked/u.test(await again.text()), 'and the page says so from then on');
} finally {
  await app.stop();
}

// ---- the hand-over still works, with the key
const out = execFileSync('node', [path.join(PKG, 'bin/css-nextgraph.mjs'), 'wallet', POD, '--dir', walletsDir, '--key', KEY], { encoding: 'utf8' });
check(/mnemonic: +(\S+ ){11}\S+/u.test(out) && /password: +\S+/u.test(out), 'the owner can still be handed their wallet');

console.log(fails ? `\n${fails} FAILED (phase 2)` : '\nphase 2 passed');
process.exit(fails ? 1 : 0);
