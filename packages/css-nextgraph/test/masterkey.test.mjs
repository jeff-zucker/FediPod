// masterkey.test.mjs — the key and the sealed wallet records: what a copy of
// the wallets directory is worth without the key, and what happens to a
// record written before there was one. Nothing here opens a wallet or a
// socket; the live path is proven by css-live.mjs beside this file.
//
//   node --test   (from packages/css-nextgraph, after npm run build)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MasterKey, isSealed, newKey, parseKey, seal, unseal } from '../dist/masterkey.js';
import { WalletPods, walletStem } from '../dist/wallets.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'css-nextgraph-key-'));
const ROOT = 'https://alice.pods.example/';
const SECRET = { wallet_name: 'w', mnemonic: ['one', 'two', 'three'], pin: [1, 2, 3, 4], password: 'p4ssw0rd' };

// The key a person is handed and pastes back, and nothing else.
test('a minted key is 32 bytes and anything else is refused', () => {
  assert.equal(parseKey(newKey()).length, 32);
  assert.throws(() => parseKey('hunter2'), /not a css-nextgraph master key/u);
  assert.throws(() => parseKey(''), /not a css-nextgraph master key/u);
});

test('a sealed payload comes back only under the key that sealed it', () => {
  const key = parseKey(newKey());
  const sealed = seal(key, SECRET);
  assert.ok(isSealed(sealed));
  assert.deepEqual(unseal(key, sealed), SECRET);
  assert.throws(() => unseal(parseKey(newKey()), sealed));
  // The mnemonic is not in the file in any readable form.
  assert.ok(!JSON.stringify(sealed).includes('two'));
});

test('a tampered payload is refused rather than returned wrong', () => {
  const key = parseKey(newKey());
  const sealed = seal(key, SECRET);
  const bytes = Buffer.from(sealed.ct, 'base64url');
  bytes[0] ^= 0xff;
  assert.throws(() => unseal(key, { ...sealed, ct: bytes.toString('base64url') }));
});

test('a key supplied while the server runs releases whoever was waiting', async () => {
  const master = new MasterKey();
  assert.equal(master.present, false);
  assert.equal(master.source, 'none');
  const waiting = master.ready();
  const key = newKey();
  master.supply(key);
  assert.equal(master.present, true);
  assert.equal(master.source, 'unlock');
  assert.ok((await waiting).equals(parseKey(key)));
});

test('a wrong key is refused at the unlock, not after', () => {
  const master = new MasterKey();
  assert.throws(() => master.supply(newKey(), () => false), /does not open/u);
  assert.equal(master.present, false);
  // And a second, different key cannot replace one already open.
  const open = new MasterKey();
  open.supply(newKey());
  assert.throws(() => open.supply(newKey()), /already open/u);
});

test('the roots stay readable without the key, and the secrets do not', async () => {
  const dir = tmpdir();
  const master = new MasterKey();
  master.supply(newKey());
  const pods = new WalletPods({ dir, peerId: 'p', port: 1440, version: '0', masterKey: master });
  const { record } = WalletPods.filesFor(dir, walletStem(ROOT));
  // What openOrCreate writes for a new pod.
  await pods.writeRecord(record, ROOT, { ...SECRET, user: 'u' }, () => {});

  const onDisk = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(onDisk.root, ROOT, 'the pod address is readable: it is not a secret and the server opens by it');
  assert.equal(onDisk.user, 'u');
  assert.equal(onDisk.mnemonic, undefined, 'the mnemonic is not in the clear');
  assert.ok(isSealed(onDisk.sealed));
  assert.deepEqual(pods.roots(), [ROOT], 'a server still knows which pods it has');

  const back = await pods.readRecord(record, ROOT, () => {});
  assert.deepEqual(back, { ...SECRET, user: 'u' });
});

test('a record written before there was a key is sealed the next time it is read', async () => {
  const dir = tmpdir();
  const { record } = WalletPods.filesFor(dir, walletStem(ROOT));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ root: ROOT, user: 'u', ...SECRET }));

  const keyless = new WalletPods({ dir, peerId: 'p', port: 1440, version: '0' });
  assert.deepEqual(await keyless.readRecord(record, ROOT, () => {}), { ...SECRET, user: 'u' },
    'a server with no key goes on working on what is already there');
  assert.ok(JSON.parse(fs.readFileSync(record, 'utf8')).mnemonic, 'and leaves it as it found it');

  const master = new MasterKey();
  master.supply(newKey());
  const sealing = new WalletPods({ dir, peerId: 'p', port: 1440, version: '0', masterKey: master });
  const said = [];
  assert.deepEqual(await sealing.readRecord(record, ROOT, (m) => said.push(m)), { ...SECRET, user: 'u' });
  assert.ok(isSealed(JSON.parse(fs.readFileSync(record, 'utf8')).sealed), 'and a server with one seals it in passing');
  assert.ok(said.some((m) => /sealed the wallet record/u.test(m)));
});

test('a key that does not open the records here is rejected by opens()', () => {
  const dir = tmpdir();
  const master = new MasterKey();
  const right = newKey();
  master.supply(right);
  const pods = new WalletPods({ dir, peerId: 'p', port: 1440, version: '0', masterKey: master });
  const { record } = WalletPods.filesFor(dir, walletStem(ROOT));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(record, JSON.stringify({ root: ROOT, user: 'u', sealed: seal(parseKey(right), SECRET) }));

  assert.equal(pods.opens(parseKey(right)), true);
  assert.equal(pods.opens(parseKey(newKey())), false);
  // A directory with nothing sealed in it has nothing to be wrong about.
  assert.equal(new WalletPods({ dir: tmpdir(), peerId: 'p', port: 1440, version: '0' }).opens(parseKey(newKey())), true);
});
