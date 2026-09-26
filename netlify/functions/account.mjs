// netlify/functions/account.mjs — the routes that act for an account: the
// owner's browser reaching the account's copy at the gateway (state-api.mjs).
// Kept apart from front.mjs, which answers every delivery, so the pieces that
// act for an account are loaded only when an account is being worked on.
import { gatewayCtx, ACCOUNT_PATHS } from './front.mjs';
import { verifyPodToken } from '../../lib/gateway/front-core.mjs';
import { routeStateApi } from '../../lib/gateway/state-api.mjs';

export default async function handler(request, context) {
  const startedAt = Date.now();
  const pathname = new URL(request.url).pathname;
  const ctx = gatewayCtx();
  ctx.waitUntil = (p) => context?.waitUntil?.(p);
  let out;
  try {
    out = await routeStateApi(request, pathname, ctx, { verifyPodToken })
      || { status: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'no such route' }) };
  } catch (e) {
    console.log(`account: ${e?.stack || e}`);
    out = { status: 503, headers: { 'content-type': 'text/plain' }, body: `unavailable: ${e?.message || e}\n` };
  }
  console.log(`${request.method} ${pathname} ${out.status} ${Date.now() - startedAt}ms`);
  return new Response(out.body ?? null, { status: out.status, headers: out.headers });
}

export const config = { path: ACCOUNT_PATHS };
