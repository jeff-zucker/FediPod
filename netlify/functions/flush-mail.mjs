// netlify/functions/flush-mail.mjs — every fifteen minutes, the mail held for
// browser accounts whose apps are closed goes to their pods, in batches
// (lib/gateway/held-mail.mjs). An app that opens takes its own sooner.
import { gatewayCtx } from './front.mjs';
import { flushAll } from '../../lib/gateway/held-mail.mjs';
import { closedState } from '../../lib/gateway/quiet.mjs';

export default async function handler() {
  const ctx = gatewayCtx();
  await flushAll(ctx, { isGone: async (handle, rec) => (await closedState(ctx, handle, rec)).closed });
  return new Response(null, { status: 204 });
}

export const config = { schedule: '*/15 * * * *' };
