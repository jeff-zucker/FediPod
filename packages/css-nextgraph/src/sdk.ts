// sdk.ts — the NextGraph Node SDK, loaded once, and the small conversions
// its calls need: key strings, the bootstrap for a daemon, a client info,
// a wallet made or opened. Everything else goes through a session.
import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sdk = any;

let sdk: Sdk | undefined;

/** The SDK module, required on first use so a config that never touches a pod never loads WASM. */
export function loadSdk(): Sdk {
  if (!sdk) sdk = require('@ng-org/nextgraph');
  return sdk;
}

/** Ed25519 key bytes to the string form NextGraph prints and parses. */
export function keyToString(pub: { Ed25519PubKey?: number[] } | number[]): string {
  const bytes = Array.isArray(pub) ? pub : pub.Ed25519PubKey;
  return Buffer.from([...bytes].reverse().concat(0)).toString('base64url');
}

export function keyFromString(str: string): { Ed25519PubKey: number[] } {
  const bytes = [...Buffer.from(str, 'base64url')].reverse();
  if (bytes[0] !== 0) throw new Error(`not an Ed25519 public key: ${str}`);
  return { Ed25519PubKey: bytes.slice(1) };
}

/** The bootstrap a wallet needs to reach a daemon on this machine. */
export function localhostBootstrap(peerId: string, port: number): unknown {
  return { servers: [{ server_type: { Localhost: port }, can_verify: false, can_forward: true, peer_id: keyFromString(peerId) }] };
}

/**
 * What user_connect sends about this client. Built here rather than by the
 * SDK's own client_info(), whose Node shim requires a package.json one
 * directory above the package and throws.
 */
export function clientInfo(version: string): unknown {
  const now = Math.floor(Date.now() / 1000);
  const details = JSON.stringify({ platform: { type: 'program', arch: process.arch }, os: { name: process.platform, version: process.version } });
  return { V0: { client_type: 'NodeService', details, version, timestamp_install: now, timestamp_updated: now } };
}

export interface WalletRecord {
  wallet_name: string;
  user: string;
  mnemonic: string[];
  pin: number[];
  /** The NextGraph app opens an imported wallet file with a password; the mnemonic and PIN are the SDK's way in. */
  password: string;
}

export interface OpenedSession {
  sessionId: number;
  /** The private store's Nuri, `did:ng:o:…:v:…`. */
  privateStore: string;
  user: string;
}

/**
 * Reconnects a user whose broker connection dropped (the daemon restarted,
 * say). The session keeps answering reads from its own state meanwhile and
 * queues writes; connecting again sends them. Retries with a growing wait.
 */
export async function reconnect(ng: Sdk, user: string, version: string, log: (message: string) => void): Promise<void> {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 30000)) {
    try {
      const connections = await ng.user_connect(clientInfo(version), user, undefined);
      const failed = Object.values(connections as Record<string, { error?: string }>).find((c) => c.error);
      if (!failed) {
        log(`NextGraph broker connection back for user ${user}`);
        return;
      }
      log(`NextGraph broker still unreachable for user ${user}: ${failed.error}; next try in ${wait / 1000}s`);
    } catch (error: unknown) {
      log(`NextGraph reconnect for user ${user} failed: ${String(error)}; next try in ${wait / 1000}s`);
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * Calls back with the user id each time a broker connection closes. The SDK
 * takes one subscriber per process, so this is called once.
 */
export async function watchDisconnections(ng: Sdk, onDisconnect: (user: string) => void): Promise<void> {
  await ng.disconnections_subscribe((user: unknown) => {
    const id = typeof user === 'string' ? user : (user as { user_id?: string })?.user_id;
    if (id) onDisconnect(id);
  });
}

/** The base64url part of an invitation link (`…/#/i/<code>`), or the code as given. */
export function invitationCode(link: string): string {
  const m = /#\/i\/([A-Za-z0-9_-]+)/u.exec(link);
  return m ? m[1] : link.trim();
}

/**
 * Makes a wallet on the daemon's broker for one pod. With an invitation the
 * wallet registers under it (a fresh daemon's first user must); without one
 * the daemon has to run with registration open.
 */
export async function createWallet(ng: Sdk, peerId: string, port: number, invitation?: string):
Promise<{ record: WalletRecord; file: Buffer; wallet: unknown }> {
  let core_bootstrap = localhostBootstrap(peerId, port);
  let core_registration: number[] | undefined;
  if (invitation) {
    const inv = await ng.decode_invitation(invitationCode(invitation));
    if (!inv || !inv.V0) throw new Error('the setup invitation could not be decoded');
    core_bootstrap = inv.V0.bootstrap;
    core_registration = inv.V0.code?.ChaCha20Key ?? inv.V0.code;
  }
  const pin = [...crypto.randomBytes(4)].map((b) => b % 10);
  const password = crypto.randomBytes(18).toString('base64url');
  const res = await ng.wallet_create({
    security_img: undefined, security_txt: `css-nextgraph ${crypto.randomBytes(8).toString('hex')}`, pin, pazzle_length: 9,
    password, mnemonic: true, send_bootstrap: false, send_wallet: false, result_with_wallet_file: true,
    local_save: false, core_bootstrap, core_registration, additional_bootstrap: undefined, pdf: false, device_name: 'css-nextgraph',
  });
  const record: WalletRecord = { wallet_name: res.wallet_name, user: keyToString(res.user), mnemonic: res.mnemonic_str, pin, password };
  return { record, file: Buffer.from(res.wallet_file), wallet: res.wallet };
}

/**
 * Opens a wallet in memory, starts its session and connects it to the
 * broker. `source` is the saved file, or the wallet object a creation in
 * this process already holds (reading the file again would say
 * WalletAlreadyAdded).
 */
export async function openWallet(ng: Sdk, source: Buffer | { wallet: unknown }, record: WalletRecord, version: string): Promise<OpenedSession> {
  const wallet = Buffer.isBuffer(source) ? await ng.wallet_read_file(source) : source.wallet;
  const opened = await ng.wallet_open_with_mnemonic_words(wallet, record.mnemonic, record.pin);
  try {
    await ng.wallet_import(wallet, opened, true);
  } catch (error: unknown) {
    // A wallet made in this process is already added; it still has to be
    // marked opened, which is the half of wallet_import that did not run.
    if (!String(error).includes('WalletAlreadyAdded')) throw error;
    await ng.wallet_was_opened(opened);
  }
  const session = await ng.session_in_memory_start(opened.V0.wallet_id, opened.V0.personal_site);
  const user = opened.V0.personal_site_id;
  const connections = await ng.user_connect(clientInfo(version), user, undefined);
  const failed = Object.values(connections as Record<string, { error?: string }>).find((c) => c.error);
  if (failed) throw new Error(`NextGraph broker connection failed: ${failed.error}`);
  return { sessionId: session.session_id, privateStore: `did:ng:${session.private_store_id}`, user };
}
