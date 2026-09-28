// credential.mjs — a client credential for the forum's pod, minted at the
// pod's server by the account that owns it and saved where the forum reads
// it. Nothing is written to the pod. The password is asked at the terminal
// and never written anywhere.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { mintCredential } from 'fedipod/remote';

const askHidden = (prompt) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const onData = (c) => { if (String(c) !== '\n' && String(c) !== '\r') { readline.moveCursor(process.stdout, -1, 0); process.stdout.write('*'); } };
  process.stdin.on('data', onData);
  rl.question(prompt, (a) => { process.stdin.off('data', onData); rl.close(); process.stdout.write('\n'); resolve(a); });
});

/**
 * Mint the credential and write DIR/credential.json. `issuer` defaults to
 * the pod server's origin: for a subdomained pod, one label up from the pod.
 * Refuses to overwrite: a minted credential is shown once.
 */
export async function mintForumCredential({ email, pod, home, issuer = null, root = 'fedipod-bb/', password = null, log = console.log }) {
  const base = String(pod).replace(/\/*$/u, '/');
  const iss = (issuer || new URL(base).origin.replace(/^https?:\/\/[^.]+\./u, (m) => m.slice(0, m.indexOf('//') + 2))).replace(/\/+$/u, '');
  const webId = base + 'profile/card#me';
  const file = path.join(home, 'credential.json');
  if (fs.existsSync(file)) throw new Error(`${file} exists — a minted credential is shown once; nothing was done`);
  log(`pod ${base}\nwebId ${webId}\nissuer ${iss}`);
  const pw = password || process.env.AP_PASSWORD || await askHidden(`password for ${email} at ${iss}: `);
  if (!pw) throw new Error('no password given; nothing was done');
  const credential = await mintCredential({ origin: iss, email, password: pw, webId, name: 'fedipod-bb' });
  const rec = { ...credential, remotePod: base, root: root.replace(/^\/+|\/+$/gu, '') + '/', createdAt: new Date().toISOString() };
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  return file;
}
