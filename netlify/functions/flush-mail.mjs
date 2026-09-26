// netlify/functions/flush-mail.mjs — every fifteen minutes, the mail held for
// browser accounts whose apps are closed goes to their pods, in batches
// (lib/gateway/held-mail.mjs). A kept account whose keeper has work due (a
// follow held at the door, a failed delivery's next try, a scheduled post, a
// poll's end) is handed to its keeper instead (keeper-background.mjs), which
// delivers the mail and reads it. Mail alone does not start a run. An app that
// opens takes its own mail sooner. Last, each kept account's working copy at
// the gateway is written to its pod (lib/gateway/copy.mjs).
import { gatewayCtx } from './front.mjs';
import { signRun } from './keeper-background.mjs';
import { flushAll, isPresent } from '../../lib/gateway/held-mail.mjs';
import { closedState } from '../../lib/gateway/quiet.mjs';
import { listCopies, copyMeta, flushCopy, dropCopy, lockCopy } from '../../lib/gateway/copy.mjs';
import { HttpStorage } from '../../lib/core/storage.mjs';

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
  // The working copies of kept accounts, written to their pods (copy.mjs).
  if (ctx.copyKv) {
    const podFetch = await ctx.keeperFetch();
    for (const handle of podFetch ? await listCopies(ctx.copyKv) : []) {
      const meta = await copyMeta(ctx.copyKv, handle);
      if (!meta?.stateUrl) continue;
      const pod = new HttpStorage(meta.stateUrl, podFetch);
      // An account no longer kept here — closed, moved, gone, or its keeper
      // stopped — has its copy written to the pod and given up.
      const rec = await ctx.lookup(handle);
      const leaving = !rec || rec.movedTo || !rec.keeper || (await closedState(ctx, handle, rec)).closed;
      if (leaving) {
        const unlock = await lockCopy(ctx.copyKv, handle, { waitMs: 2000 });
        if (!unlock) continue;
        try {
          const left = await dropCopy(ctx.copyKv, handle, { pod, podFetch, stateUrl: meta.stateUrl, log: console.log });
          if (!left.ok) console.log(`copy @${handle}: not given up: ${left.why}`);
        } catch (e) { console.log(`copy @${handle}: not given up: ${e?.message || e}`); } finally { await unlock(); }
        continue;
      }
      await flushCopy(ctx.copyKv, handle, { pod, log: console.log })
        .catch((e) => console.log(`copy @${handle}: not written to the pod: ${e?.message || e}`));
    }
  }
  return new Response(null, { status: 204 });
}

export const config = { schedule: '*/15 * * * *' };
