// unlock.ts — the page a host opens after a restart on a machine that cannot
// hold the master key for them.
//
// The key IS the credential. There is nothing here to guard beyond it:
// anyone who has the key can already read every wallet record on the host, and
// anyone who has not can do nothing but be refused. Asking for a WebID as well
// would not work anyway — a WebID kept on a pod this server stores cannot be
// resolved while its pod is closed, which is exactly when this page is used.
//
// The key is compared against a record already on disk before it is taken, so
// a mistyped key is refused here rather than leaving a server that opens no
// pod until it is restarted. It is never logged and never written down.
import { HttpHandler, getLoggerFor } from '@solid/community-server';
import type { HttpHandlerInput } from '@solid/community-server';
import type { MasterKey } from './masterkey';
import type { NextGraphDataAccessor } from './accessor';

export interface UnlockHandlerArgs {
  /** The server's base URL. The page answers on its host and on no pod's. */
  baseUrl: string;
  /** The key this server runs on, the same instance the accessor waits on. */
  masterKey: MasterKey;
  /** The accessor, so the pods open the moment the key arrives. */
  accessor: NextGraphDataAccessor;
  /** Path on the base URL. `/nextgraph/unlock` unless the host moves it. */
  path?: string;
}

/** Wrong keys in a row before the page stops answering for a while. */
const MAX_TRIES = 5;
const LOCKOUT_MS = 60_000;

const page = (title: string, body: string, action: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 2.5rem 1.5rem; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  .hint { color: #55524d; }
  @media (prefers-color-scheme: dark) { .hint { color: #b8b3ab; } }
  label { display: block; margin: 0 0 0.5rem; }
  input { font: inherit; width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem;
    border: 1px solid #8d887f; border-radius: 0.3rem; background: #fff; color: #16150f; }
  @media (prefers-color-scheme: dark) { input { background: #3a3730; color: #f3f1ec; border-color: #6f6a61; } }
  button { font: inherit; margin: 1rem 0 0; padding: 0.6rem 1.2rem; border-radius: 0.3rem; border: 0;
    background: #2d4f8e; color: #fff; cursor: pointer; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
${body}
<form method="post" action="${action}">
  <label for="key">Master key</label>
  <input type="password" id="key" name="key" autocomplete="off">
  <button type="submit">Unlock</button>
</form>
</main>
</body>
</html>
`;

const done = (title: string, body: string): string =>
  page(title, body, '').replace(/<form[\s\S]*<\/form>/u, '');

export class UnlockHandler extends HttpHandler {
  protected readonly logger = getLoggerFor(this);
  private readonly path: string;
  private readonly host: string;
  private tries = 0;
  private lockedUntil = 0;

  public constructor(private readonly args: UnlockHandlerArgs) {
    super();
    this.path = args.path ?? '/nextgraph/unlock';
    this.host = new URL(args.baseUrl).host;
  }

  public async canHandle({ request }: HttpHandlerInput): Promise<void> {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new Error('not the unlock page');
    if ((request.headers.host ?? '') !== this.host) throw new Error('the unlock is on the base URL only');
    if ((request.url ?? '').split('?')[0] !== this.path) throw new Error('not the unlock page');
  }

  public async handle({ request, response }: HttpHandlerInput): Promise<void> {
    const html = (status: number, body: string): void => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    };

    if (this.args.masterKey.present) {
      html(200, done('This server is unlocked',
        `<p>Its pods are open and answering. The key came from the ${this.args.masterKey.source}.</p>`));
      return;
    }

    if (request.method !== 'POST') {
      html(200, page('This server is locked',
        '<p>Its pods are here and encrypted, and nothing can open them until you paste the master key '
        + 'you were given when the server was set up. It is held in memory until the server stops.</p>',
        this.path));
      return;
    }

    if (Date.now() < this.lockedUntil) {
      html(429, done('Too many wrong keys',
        '<p class="hint">Wait a minute and open this page again.</p>'));
      return;
    }

    let supplied: string;
    try {
      supplied = new URLSearchParams(await readBody(request)).get('key') ?? '';
    } catch {
      html(400, done('That was not a form this page understands', '<p class="hint">Open the page again.</p>'));
      return;
    }

    try {
      this.args.masterKey.supply(supplied, (key): boolean => this.args.accessor.opensWith(key));
    } catch (error: unknown) {
      this.tries += 1;
      if (this.tries >= MAX_TRIES) {
        this.lockedUntil = Date.now() + LOCKOUT_MS;
        this.tries = 0;
      }
      // The message names what is wrong with the key, never the key.
      html(400, page('That key did not open this server', `<p class="hint">${escapeHtml((error as Error).message)}</p>`, this.path));
      return;
    }

    const open = await this.args.accessor.openAll();
    this.logger.info(`master key supplied at the unlock page; ${open} wallet(s) open`);
    html(200, done('Unlocked', `<p>${open} pod${open === 1 ? '' : 's'} open and answering.</p>`));
  }
}

/** The form body, with the same ceiling the rest of this server puts on a POST. */
const MAX_BODY_BYTES = 4096;

function readBody(request: HttpHandlerInput['request']): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer): void => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', (): void => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
