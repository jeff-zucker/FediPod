// netlify/functions/push-background.mjs — a delivery that becomes one of an
// account's notifications arrived while its apps were closed: the mail held
// for it is read into the account's copy, and each notification that makes is
// pushed to the phones and browsers its owner signed up
// (lib/gateway/masto-gateway.mjs: pushHeld). Started only by the door
// (front.mjs startPush), whose request is signed with the keeper's secret.
import crypto from 'node:crypto';
import { gatewayCtx, keeperCredential } from './front.mjs';
import { pushHeld } from '../../lib/gateway/masto-gateway.mjs';

export default async function handler(request) {
  const secret = process.env.FEDIPOD_KEEPER_CLIENT_SECRET;
  const body = await request.text();
  const said = Buffer.from(request.headers.get('x-fedipod-push') || '');
  const want = Buffer.from(secret ? crypto.createHmac('sha256', `fedipod-push:${secret}`).update(body).digest('hex') : '');
  if (!want.length || said.length !== want.length || !crypto.timingSafeEqual(said, want)) return new Response(null, { status: 403 });
  const { handle, at } = JSON.parse(body);
  if (!handle || Date.now() - Number(at) > 5 * 60_000) return new Response(null, { status: 400 });
  const ctx = gatewayCtx();
  ctx.keeperCredential = await keeperCredential();
  const rec = await ctx.lookup(handle);
  if (rec) await pushHeld(ctx, handle, rec).catch((e) => console.log(`push @${handle}: ${e?.message || e}`));
  return new Response(null, { status: 204 });
}
