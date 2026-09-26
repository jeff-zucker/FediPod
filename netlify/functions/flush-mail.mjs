// netlify/functions/flush-mail.mjs — every fifteen minutes, the mail held for
// browser accounts whose apps are closed goes to their pods, in batches
// (lib/gateway/held-mail.mjs). A kept account whose keeper has work due (a
// follow held at the door, a failed delivery's next try, a scheduled post, a
// poll's end) is handed to its keeper instead (keeper-background.mjs), which
// delivers the mail and reads it. Mail alone does not start a run. An app that
// opens takes its own mail sooner.
import { gatewayCtx } from './front.mjs';
import { signRun } from './keeper-background.mjs';
import { flushAll, isPresent } from '../../lib/gateway/held-mail.mjs';
import { closedState } from '../../lib/gateway/quiet.mjs';

export default async function handler() {
  const ctx = gatewayCtx();
  const secret = process.env.FEDIPOD_KEEPER_CLIENT_SECRET;
  const kept = (rec) => !!(rec?.keeper && ctx.keeperWebId && secret && process.env.URL);
  const start = async (handle) => {
    const body = JSON.stringify({ handle });
    const res = await fetch(`${process.env.URL}/.netlify/functions/keeper-background`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fedipod-keeper': signRun(body, secret) }, body,
    }).catch((e) => ({ status: 0, error: e }));
    console.log(`keeper @${handle}: run started (${res.status})`);
  };
  const due = new Set(await ctx.keeperDue());
  const started = new Set();
  await flushAll(ctx, {
    isGone: async (handle, rec) => (await closedState(ctx, handle, rec)).closed,
    keep: async (handle, rec) => {
      if (!due.has(handle) || !kept(rec) || await isPresent(ctx, handle)) return false;
      await start(handle);
      started.add(handle);
      return true;
    },
  });
  // Work due where no mail was held this round.
  for (const handle of due) {
    if (started.has(handle)) continue;
    const rec = await ctx.lookup(handle);
    if (kept(rec) && !await isPresent(ctx, handle)) await start(handle);
  }
  return new Response(null, { status: 204 });
}

export const config = { schedule: '*/15 * * * *' };
