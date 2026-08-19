// streaming-handler.ts — the Mastodon live feed, on the pod's own origin.
//
// A second class rather than more of the server handler: CSS routes websocket
// upgrades through a waterfall of its own, whose handlers take a socket rather
// than a request and response, and one class cannot be both. It shares the
// server handler’s state by holding the same instance, so a socket is handed
// to the identity that owns the host it arrived on.
//
// CSS completes the handshake before any of this runs, so a client that may not
// listen is closed rather than refused — there is no status code left to send.

import { WebSocketHandler, getLoggerFor } from '@solid/community-server';
import type { WebSocketHandlerInput } from '@solid/community-server';
import type { FediPodServerHandler } from './handler';

export interface FediPodStreamingArgs {
  /** The server handler, which owns the running identities. */
  server: FediPodServerHandler;
}

const STREAMING_PATH = '/api/v1/streaming';

export class FediPodStreamingHandler extends WebSocketHandler {
  private readonly server: FediPodServerHandler;
  private readonly logger = getLoggerFor(this);

  public constructor(args: FediPodStreamingArgs) {
    super();
    this.server = args.server;
  }

  public async canHandle({ upgradeRequest }: WebSocketHandlerInput): Promise<void> {
    const host = upgradeRequest.headers.host;
    const { pathname } = new URL(upgradeRequest.url ?? '/', `http://${host}`);
    if (!pathname.startsWith(STREAMING_PATH) || !this.server.surfaceFor(host)) {
      throw new Error('not a FediPod streaming socket');
    }
  }

  public async handle({ webSocket, upgradeRequest }: WebSocketHandlerInput): Promise<void> {
    const identity = this.server.surfaceFor(upgradeRequest.headers.host);
    const streaming = identity?.surface?.streaming as {
      authorizeUpgrade: (req: unknown, url: URL) => string | null;
      adopt: (ws: unknown) => unknown;
    } | undefined;
    if (!streaming) {
      webSocket.close(1011, 'identity not running');
      return;
    }
    const url = new URL(upgradeRequest.url ?? '/', `http://${upgradeRequest.headers.host}`);
    const refusal = streaming.authorizeUpgrade(upgradeRequest, url);
    if (refusal) {
      this.logger.info(refusal);
      webSocket.close(1008, refusal);
      return;
    }
    streaming.adopt(webSocket);
  }
}
