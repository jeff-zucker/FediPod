// vault.mjs — where an identity keeps the credentials for accounts it holds on
// OTHER servers: a full-access token on a Mastodon-API server, a Bluesky app
// password. Not its own key, and nothing published.
//
// Two places, and which one is right depends on where the identity runs. On a
// laptop the pod is somebody else's server, so a token goes on this machine
// and nowhere near the pod. Inside a pod server the two are the same computer,
// and the pod is the thing that travels — a token left on the host is a
// connection the owner loses the day they take their pod elsewhere.
//
// The same rule decides this and the signing key: a credential file says
// `keysMode: 'pod'` or it does not.
//
// `read`, `write` and `names` are synchronous because every caller here is.
// The pod's writes land through the store's own retrying queue; `commit`
// waits for them, and callers that have just taken a credential from a remote
// server use it before they answer.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../device/home.mjs';

/** What every connection document in pod state is named from. */
export const CONNECTION_PREFIX = 'conn-';

/** One directory, one document per name, 0600 and atomic — the laptop. */
export function fileVault(dir) {
  const file = (name) => path.join(dir, `${name}.json`);
  return {
    kind: 'file',
    where: dir,
    names() {
      try { return fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)); }
      catch { return []; }
    },
    read(name) {
      try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return null; }
    },
    write(name, rec) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeJsonAtomic(file(name), rec);
    },
    async remove(name) {
      try { fs.rmSync(file(name)); return true; } catch { return false; }
    },
    async commit() { return true; },
  };
}

/** Documents in the identity's own pod state, one per name under `prefix`. */
export function podVault(store, prefix) {
  const doc = (name) => `${prefix}${name}.json`;
  return {
    kind: 'pod',
    where: `pod state (${prefix}*)`,
    names() {
      return store.names()
        .filter(n => n.startsWith(prefix) && n.endsWith('.json'))
        .map(n => n.slice(prefix.length, -5));
    },
    read(name) { return store.read(doc(name), null); },
    write(name, rec) { store.write(doc(name), rec); },
    async remove(name) { return store.remove(doc(name)); },
    async commit() { return store.commit(); },
  };
}

/**
 * Move whatever a file vault holds into a pod vault, and only then take the
 * host's copies away. A token here is full access to an account on a server
 * this project does not run: losing one in the move is a connection its owner
 * has to make again, and cannot be told about.
 */
export async function moveVault(from, to, log = () => {}) {
  const names = from.names();
  if (!names.length) return 0;
  let moved = 0;
  for (const name of names) {
    const rec = from.read(name);
    if (!rec) continue;
    if (to.read(name)) { await from.remove(name); continue; }
    to.write(name, rec);
    moved += 1;
  }
  if (!await to.commit()) {
    log('could not write the connected-account credentials to the pod — they stay on this host for now');
    return 0;
  }
  for (const name of names) await from.remove(name);
  if (moved) log(`${moved} connected-account credential(s) moved into the pod`);
  return moved;
}
