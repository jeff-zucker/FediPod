// masterkey.ts — the key that unseals every pod's wallet record.
//
// A record holds the mnemonic and PIN that open one pod's wallet, and the
// server opens wallets with nobody present, so it has to hold them somewhere.
// Sealing them under a key that is NOT in the wallets directory is what stops
// a copy of that directory — a backup, a synced folder, a support tarball —
// from being every pod on the server.
//
// The key comes from a systemd credential when the host has one (systemd keeps
// it sealed to the machine and hands it over in memory only), from the
// environment otherwise, and from an unlock while the server runs when there
// is neither. It is never written down.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The credential name to give `LoadCredentialEncrypted=`, and the environment variable that stands in for it. */
export const CREDENTIAL_NAME = 'css-nextgraph-key';
export const KEY_ENV = 'CSS_NEXTGRAPH_KEY';

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** A sealed payload as it sits in a record file. */
export interface Sealed {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
}

export function isSealed(value: unknown): value is Sealed {
  const s = value as Sealed | undefined;
  return !!s && s.v === 1 && s.alg === 'A256GCM' && typeof s.iv === 'string' && typeof s.ct === 'string';
}

/** A new master key, the only form the server accepts: 32 random bytes, base64url. */
export function newKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString('base64url');
}

/**
 * The key bytes behind a key string. Only a key this package minted is
 * accepted — a passphrase somebody chose would be guessable, and stretching
 * one well enough to store a mnemonic under is not something to improvise.
 */
export function parseKey(text: string): Buffer {
  const key = Buffer.from(String(text).trim(), 'base64url');
  if (key.length !== KEY_BYTES) {
    throw new Error(`not a css-nextgraph master key: expected ${KEY_BYTES} bytes base64url, got ${key.length}`);
  }
  return key;
}

export function seal(key: Buffer, payload: unknown): Sealed {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64url'), ct: Buffer.concat([body, cipher.getAuthTag()]).toString('base64url') };
}

export function unseal<T>(key: Buffer, sealed: Sealed): T {
  const packed = Buffer.from(sealed.ct, 'base64url');
  const tag = packed.subarray(packed.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
  decipher.setAuthTag(tag);
  const body = Buffer.concat([decipher.update(packed.subarray(0, packed.length - 16)), decipher.final()]);
  return JSON.parse(body.toString('utf8')) as T;
}

/** Where the key this process holds came from, for the log and the unlock page. */
export type KeySource = 'credential' | 'environment' | 'unlock' | 'none';

/**
 * The master key this server runs on. One instance, shared by the accessor
 * and by whatever offers the unlock, so supplying it once brings the pods up.
 */
export class MasterKey {
  private key?: Buffer;
  private from: KeySource = 'none';
  private waiting?: Promise<Buffer>;
  private arrived?: (key: Buffer) => void;

  public constructor() {
    const dir = process.env.CREDENTIALS_DIRECTORY;
    const file = dir ? path.join(dir, CREDENTIAL_NAME) : undefined;
    if (file && fs.existsSync(file)) {
      this.key = parseKey(fs.readFileSync(file, 'utf8'));
      this.from = 'credential';
    } else if (process.env[KEY_ENV]) {
      this.key = parseKey(process.env[KEY_ENV]!);
      this.from = 'environment';
    }
  }

  /** Whether a key is here now. A server with none serves nothing from its pods until one is supplied. */
  public get present(): boolean {
    return !!this.key;
  }

  public get source(): KeySource {
    return this.from;
  }

  /** The key, once there is one. A request that needs a wallet waits here. */
  public async ready(): Promise<Buffer> {
    if (this.key) return this.key;
    this.waiting ??= new Promise<Buffer>((resolve) => { this.arrived = resolve; });
    return this.waiting;
  }

  /**
   * The unlock: the key a person supplied while the server runs. Held in
   * memory and nowhere else. `verify` is given the key and says whether it
   * opens what is already here — a wrong key accepted here would be a server
   * that never opens a pod again until it is restarted.
   */
  public supply(text: string, verify?: (key: Buffer) => boolean): void {
    const key = parseKey(text);
    if (this.key) {
      if (!this.key.equals(key)) throw new Error('a different master key is already open on this server');
      return;
    }
    if (verify && !verify(key)) throw new Error('that key does not open this server\'s wallet records');
    this.key = key;
    this.from = 'unlock';
    this.arrived?.(key);
  }
}
