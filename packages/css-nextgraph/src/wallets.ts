// wallets.ts — one wallet per pod root, made by the host on its own daemon
// and kept as a file plus its mnemonic beside the server, the two things the
// owner is handed the day NextGraph can open a pod on their own devices.
// A wallet is opened once per process and its session kept.
import fs from 'node:fs';
import path from 'node:path';
import type { PodStore } from './pod-store';
import { SdkPodStore } from './sdk-store';
import { createWallet, loadSdk, openWallet, reconnect, watchDisconnections } from './sdk';
import type { WalletRecord } from './sdk';

export interface PodStores {
  /**
   * The store of the pod rooted at `root`. `create` says whether a pod that
   * has no wallet yet gets one; a read on an unknown pod must not.
   */
  open: (root: string, create: boolean) => Promise<PodStore | undefined>;
  /** The roots of the pods already known here, for opening them all at start. */
  roots?: () => string[];
}

export interface WalletPodsOptions {
  dir: string;
  peerId: string;
  port: number;
  version: string;
  log?: (message: string) => void;
}

/** The file stem a pod root gets under the wallets directory. */
export function walletStem(root: string): string {
  return root.replace(/^https?:\/\//u, '').replace(/\/+$/u, '').replace(/[^A-Za-z0-9.-]+/gu, '_') || 'root';
}

/** The setup invitation a fresh daemon prints, pasted by the host; consumed by the first wallet. */
export const SETUP_INVITATION_FILE = 'setup-invitation';

export class WalletPods implements PodStores {
  private readonly opening = new Map<string, Promise<PodStore | undefined>>();
  private readonly users = new Map<string, string>();
  private watching?: Promise<void>;

  public constructor(private readonly options: WalletPodsOptions) {}

  public async open(root: string, create: boolean): Promise<PodStore | undefined> {
    const stem = walletStem(root);
    let pending = this.opening.get(stem);
    if (!pending) {
      if (!this.hasWallet(stem) && !create) return undefined;
      pending = this.openOrCreate(root, stem).catch((error: unknown) => {
        this.opening.delete(stem);
        throw error;
      });
      this.opening.set(stem, pending);
    }
    return pending;
  }

  /** The roots of every pod that has a wallet here, from the records beside the wallet files. */
  public roots(): string[] {
    if (!fs.existsSync(this.options.dir)) return [];
    const roots: string[] = [];
    for (const name of fs.readdirSync(this.options.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const { root } = JSON.parse(fs.readFileSync(path.join(this.options.dir, name), 'utf8')) as { root?: string };
        if (root) roots.push(root);
      } catch {
        // not a record of ours
      }
    }
    return roots;
  }

  /** Where a pod's wallet file and record are, for the hand-over command. */
  public static filesFor(dir: string, root: string): { file: string; record: string } {
    const stem = walletStem(root);
    return { file: path.join(dir, `${stem}.ngw`), record: path.join(dir, `${stem}.json`) };
  }

  private hasWallet(stem: string): boolean {
    const { file, record } = WalletPods.filesFor(this.options.dir, stem);
    return fs.existsSync(file) && fs.existsSync(record);
  }

  private async openOrCreate(root: string, stem: string): Promise<PodStore> {
    const ng = loadSdk();
    const { file, record } = WalletPods.filesFor(this.options.dir, stem);
    const log = this.options.log ?? ((): void => undefined);
    let source: Buffer | { wallet: unknown };
    let rec: WalletRecord;
    if (this.hasWallet(stem)) {
      source = fs.readFileSync(file);
      rec = JSON.parse(fs.readFileSync(record, 'utf8')) as WalletRecord;
    } else {
      fs.mkdirSync(this.options.dir, { recursive: true });
      const invitationPath = path.join(this.options.dir, SETUP_INVITATION_FILE);
      const invitation = fs.existsSync(invitationPath) ? fs.readFileSync(invitationPath, 'utf8').trim() : undefined;
      log(`making a NextGraph wallet for ${root}${invitation ? ' with the setup invitation' : ''}`);
      const made = await createWallet(ng, this.options.peerId, this.options.port, invitation);
      source = { wallet: made.wallet };
      rec = made.record;
      // The record is written before the wallet is used: a wallet whose
      // mnemonic is lost is a pod that is lost.
      fs.writeFileSync(record, JSON.stringify({ root, ...rec }, null, 2), { mode: 0o600 });
      fs.writeFileSync(file, made.file, { mode: 0o600 });
      if (invitation) fs.renameSync(invitationPath, `${invitationPath}.used`);
    }
    const session = await openWallet(ng, source, rec, this.options.version);
    log(`NextGraph wallet open for ${root} (user ${session.user})`);
    this.users.set(session.user, root);
    // A connection that drops (the daemon restarted) is made again; the
    // session answers reads meanwhile and sends its queued writes after.
    this.watching ??= watchDisconnections(ng, (user): void => {
      if (!this.users.has(user)) return;
      log(`NextGraph broker connection lost for ${this.users.get(user)}; reconnecting`);
      void reconnect(ng, user, this.options.version, log);
    }).catch((error: unknown) => { log(`could not watch NextGraph disconnections: ${String(error)}`); });
    return new SdkPodStore(ng, session.sessionId, session.privateStore);
  }
}
