// outbox-door.mjs — the owner's own post, taken at the outbox door
// (front-core.mjs routes it here). The owner is proved by a pod sign-in. The
// post is written into the pod inbox with a receipt (gateway-core:
// handleOwnerPost); for a kept account whose FediPod is closed, the keeper is
// started at once to publish it.
import { handleOwnerPost } from './gateway-core.mjs';
import { keptNow, isPersonal } from './copy.mjs';
import { isPresent, holdsMail, holdingPut } from './held-mail.mjs';

export async function ownerPostAtDoor(request, pathname, ctx, rec, handle, { cors, identFor, verifyPodToken, webidUnderPod }) {
  const json = (status, obj, extra = {}) => ({ status,
    headers: { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(obj) });
  const webid = await verifyPodToken(request, pathname, ctx.verifier);
  if (!webid) return json(401, { error: 'a Solid-OIDC token proving this account\'s owner is required' });
  const owner = rec.webId ? webid === rec.webId : webidUnderPod(webid, rec.podHome);
  if (!owner) return json(403, { error: 'this outbox belongs to its owner alone' });
  const onPod = (u) => u.replace(rec.actorUrl.replace(/ap\/actor$/u, ''), rec.podHome);
  // A person's FediPod closed: the post is kept here, where the keeper reads
  // it in (it reads nothing on their pod but the key); open, it goes to the pod.
  const keepHere = isPersonal(rec) && keptNow(ctx, rec) && holdsMail(ctx, rec) && !(await isPresent(ctx, handle).catch(() => false));
  const { status, reason, location, object } = await handleOwnerPost(request, identFor(rec),
    { podPut: keepHere ? holdingPut(ctx, handle, rec) : (u, b, ct) => ctx.podPut(handle, u, b, ct), ownerWebId: webid,
      exists: async (u) => ((await (ctx.podGet || fetch)(onPod(u), { podHome: rec.podHome })).status !== 404) });
  console.log(`door @${handle}: owner post → ${status} (${reason})`);
  if (status !== 201) return json(status, { error: reason });
  // Kept and closed: the keeper publishes it now rather than at the next visit.
  let now = false;
  if (keptNow(ctx, rec) && ctx.startKeeper && !(await isPresent(ctx, handle).catch(() => false))) {
    now = await ctx.startKeeper(handle).then(() => true, (e) => { console.log(`door @${handle}: keeper not started: ${e?.message || e}`); return false; });
  }
  return json(201, { accepted: true, ...(location ? { id: location } : {}), ...(object ? { object } : {}),
    note: now ? 'it goes out in a moment' : 'it goes out when your FediPod agent next runs' }, location ? { location } : {});
}
