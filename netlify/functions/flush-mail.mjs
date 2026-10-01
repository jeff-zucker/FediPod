// netlify/functions/flush-mail.mjs — every fifteen minutes, the mail held for
// browser accounts whose apps are closed goes to their pods, in batches
// (lib/gateway/held-mail.mjs). A kept account whose keeper has work due (a
// follow held at the door, a failed delivery's next try, a scheduled post, a
// poll's end), or with an outside app signed in and mail held, is handed to
// its keeper instead (keeper-background.mjs). A person's copy is never written
// to their pod here: the gateway hands its changes to the pod inbox as it
// makes them (lib/gateway/pod-mail.mjs). The forum's copies, and a person's
// copy from before version 2, are written to the pod as before.
import { gatewayCtx } from './front.mjs';
import { signRun } from './keeper-background.mjs';
import { flushAll, isPresent } from '../../lib/gateway/held-mail.mjs';
import { closedState } from '../../lib/gateway/quiet.mjs';
import { listCopies, copyMeta, flushCopy, dropCopy, forgetCopy, lockCopy, renewPodLease, keptBefore, keptNow, isPersonal } from '../../lib/gateway/copy.mjs';
import { readsMailHere, flushPending } from '../../lib/gateway/pod-mail.mjs';
import { dropFullIfNoApps } from '../../lib/gateway/app-signins.mjs';
import { HttpStorage } from '../../lib/core/storage.mjs';

export default async function handler() {
  const ctx = gatewayCtx();
  const secret = process.env.FEDIPOD_KEEPER_CLIENT_SECRET;
  const kept = (rec) => !!(keptNow(ctx, rec) && secret && process.env.URL);
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
      // Read here rather than sent to the pod: an outside app shows it.
      const meta = ctx.copyKv && isPersonal(rec) ? await copyMeta(ctx.copyKv, handle) : null;
      const appsRead = !!meta && meta.v === 2 && readsMailHere(meta);
      if (!(due.has(handle) || appsRead) || !kept(rec) || await isPresent(ctx, handle)) return false;
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
  // The working copies of kept accounts, written to their pods (copy.mjs),
  // several at a time so a long list fits in the round.
  if (ctx.copyKv) {
    const podFetch = await ctx.keeperFetch();
    const handles = podFetch ? await listCopies(ctx.copyKv) : [];
    const one = async (handle) => {
      const meta = await copyMeta(ctx.copyKv, handle);
      if (!meta?.stateUrl) return;
      const pod = new HttpStorage(meta.stateUrl, podFetch);
      // An account no longer kept here — closed, moved, gone, or its keeper
      // stopped — has its copy written to the pod and given up.
      const rec = await ctx.lookup(handle);
      // Kept under the gateway's former identity: this one cannot write it
      // back; the owner's FediPod hands it over on its next start.
      if (keptBefore(ctx, rec)) return;
      // A person's copy now: nothing to write back. An account that has gone
      // just has it forgotten (the pod has everything); one whose apps have
      // all signed out or run out has what only apps needed dropped.
      if (meta.v === 2 && (!rec || isPersonal(rec))) {
        const gone = !rec || rec.movedTo || !rec.keeper || (await closedState(ctx, handle, rec)).closed;
        if (gone) { await forgetCopy(ctx.copyKv, handle, { log: console.log }); return; }
        // What was set aside for the pod since the last round goes now.
        await flushPending(ctx, handle, rec, { log: console.log }).catch((e) => console.log(`@${handle}: not handed to the pod: ${e?.message || e}`));
        if (meta.full) await dropFullIfNoApps(ctx, handle, console.log);
        return;
      }
      const leaving = !rec || rec.movedTo || !rec.keeper || (await closedState(ctx, handle, rec)).closed;
      if (leaving) {
        const unlock = await lockCopy(ctx.copyKv, handle, { waitMs: 2000 });
        if (!unlock) return;
        try {
          const left = await dropCopy(ctx.copyKv, handle, { pod, podFetch, stateUrl: meta.stateUrl, log: console.log });
          if (!left.ok) console.log(`copy @${handle}: not given up: ${left.why}`);
        } finally { await unlock(); }
        return;
      }
      await flushCopy(ctx.copyKv, handle, { pod, log: console.log });
      await renewPodLease(ctx.copyKv, handle, { podFetch, log: console.log });
    };
    for (let i = 0; i < handles.length; i += 6) {
      await Promise.all(handles.slice(i, i + 6).map((h) => one(h)
        .catch((e) => console.log(`copy @${h}: not written to the pod: ${e?.message || e}`))));
    }
  }
  return new Response(null, { status: 204 });
}

export const config = { schedule: '*/15 * * * *' };
