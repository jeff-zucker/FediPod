// door.ts — a delivery to an identity's own inbox, verified here: the server
// that stores the inbox is the one the request reached, so the signature is
// checked while its headers exist and the receipt is written beside the
// activity. The same door code the front runs; nothing is renamed.

import type { HttpHandlerInput } from '@solid/community-server';
import { nodeToWhatwg } from './adapt';
import { EMBED, esmImport } from './fedipod';
import type { EmbeddedIdentity } from './identities';
import type { FediPodServerHandler } from './handler';

export async function deliverAtDoor(h: FediPodServerHandler, identity: EmbeddedIdentity,
  request: HttpHandlerInput['request'], response: HttpHandlerInput['response']): Promise<void> {
  const s = h.internals();
  const { deliverToInbox } = await esmImport(EMBED) as {
    deliverToInbox: (agent: unknown, req: Request, opts: Record<string, unknown>) =>
      Promise<{ status: number; reason: string }>;
  };
  let whatwg: Request;
  try {
    // The pod's own origin: the signature covers the path and the Host header, and both are the pod's.
    whatwg = await nodeToWhatwg(request as never, new URL(identity.podHome).origin);
  } catch (e: unknown) {
    const status = (e as { statusCode?: number }).statusCode === 413 ? 413 : 400;
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  const out = await deliverToInbox(identity.agent, whatwg, {
    podPut: (url: string, body: string, ct: string) => s.podPut(url, body, ct),
    gatewayWebId: s.args.gatewayWebId ?? null,
  });
  s.logger.info(`FediPod: delivery for @${identity.handle} at the door — ${out.reason} (${out.status})`);
  response.writeHead(out.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ reason: out.reason }));
}
