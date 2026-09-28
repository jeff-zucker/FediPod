// private-read.ts — a signed read of a followers-only or direct post at its
// address on this pod, answered to a server the post was sent to (ActivityPub
// §3.2). The same rule the front applies (lib/gateway/private-read.mjs); the
// post is read through the server's own store and the followers come from the
// identity's live state. Anyone the post was not sent to gets 404.

import type { HttpHandlerInput } from '@solid/community-server';
import { nodeToWhatwg } from './adapt';
import { EMBED, esmImport } from './fedipod';
import type { EmbeddedIdentity } from './identities';
import type { FediPodServerHandler } from './handler';

export async function readPrivateAtDoor(h: FediPodServerHandler, identity: EmbeddedIdentity,
  request: HttpHandlerInput['request'], response: HttpHandlerInput['response']): Promise<void> {
  const s = h.internals();
  const { readPrivateForSigner } = await esmImport(EMBED) as {
    readPrivateForSigner: (agent: unknown, req: Request, opts: Record<string, unknown>) =>
      Promise<{ status: number; reason: string; body?: string }>;
  };
  let whatwg: Request;
  try {
    // The pod's own origin: the signature covers the path and the Host header, and both are the pod's.
    whatwg = await nodeToWhatwg(request as never, new URL(identity.podHome).origin);
  } catch (e: unknown) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  const out = await readPrivateForSigner(identity.agent, whatwg, { read: (url: string) => s.io.read(url) });
  s.logger.info(`FediPod: private read for @${identity.handle} — ${out.reason} (${out.status})`);
  const noStore = { 'cache-control': 'no-store', vary: 'Signature' };
  if (out.status !== 200) { response.writeHead(out.status, noStore); response.end(); return; }
  response.writeHead(200, { ...noStore, 'content-type': 'application/activity+json' });
  response.end(String(request.method).toUpperCase() === 'HEAD' ? '' : out.body);
}
