// netlify/functions/keeper-background.mjs — one account's keeper run
// (lib/gateway/keeper.mjs), started by the fifteen-minute round in
// flush-mail.mjs. A background function, so a slow pod has fifteen minutes
// rather than ten seconds. Only the round may start it: the body is signed with
// the keeper's own secret.
import crypto from 'node:crypto';
import { gatewayCtx, keeperCredential } from './front.mjs';
import { keepOnce } from '../../lib/gateway/keeper.mjs';

export const signRun = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

export default async function handler(request) {
  const secret = process.env.FEDIPOD_KEEPER_CLIENT_SECRET;
  const body = await request.text();
  const said = Buffer.from(request.headers.get('x-fedipod-keeper') || '');
  const want = Buffer.from(secret ? signRun(body, secret) : '');
  if (!want.length || said.length !== want.length || !crypto.timingSafeEqual(said, want)) {
    return new Response(null, { status: 403 });
  }
  const { handle } = JSON.parse(body);
  const ctx = gatewayCtx();
  ctx.keeperCredential = await keeperCredential();
  const rec = await ctx.lookup(handle);
  const out = await keepOnce(ctx, handle, rec).catch((e) => ({ skipped: `failed: ${e?.message || e}` }));
  if (out.skipped) console.log(`keeper @${handle}: ${out.skipped}`);
  await ctx.noteKept(handle, out);
  return new Response(null, { status: 204 });
}
