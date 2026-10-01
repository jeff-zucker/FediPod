// app-signins.mjs — which outside apps are signed in to which account, kept
// beside the apps' tokens (masto-gateway.mjs). While any is, the account's copy
// at the gateway holds what apps show; when the last one signs out or runs
// out, that goes from the copy at once (state-api.mjs: setFull). Everything in
// it is on the pod or in its inbox.
import { setFull } from './state-api.mjs';

export const TOKEN_TTL_MS = 90 * 86400_000;
export const CODE_TTL_MS = 10 * 60_000;

async function getJson(kv, key) {
  const got = await kv.get(key);
  if (!got) return null;
  try { return JSON.parse(got.text); } catch { return null; }
}

/** An app signed out, or its sign-in ran out: its token goes, and the copy is made slim if it was the last. */
export async function signOut(ctx, tokenHash, log = console.log) {
  const kv = ctx.mastoKv;
  const tok = await getJson(kv, `token/${tokenHash}`);
  await kv.delete(`token/${tokenHash}`);
  if (!tok?.handle) return;
  await kv.delete(`signedin/${tok.handle}/${tokenHash}`).catch(() => {});
  await dropFullIfNoApps(ctx, tok.handle, log);
}

/** The account's apps, those that ran out let go; the copy made slim when none is left. Returns how many are left. */
export async function dropFullIfNoApps(ctx, handle, log = console.log) {
  const kv = ctx.mastoKv;
  if (!kv?.list) return 0;
  let left = 0;
  for (const b of await kv.list(`signedin/${handle}/`)) {
    const id = b.key.slice(`signedin/${handle}/`.length);
    const code = id.startsWith('code-');
    const mark = await getJson(kv, b.key);
    if (!mark || Date.now() - mark.at > (code ? CODE_TTL_MS : TOKEN_TTL_MS)) {
      await kv.delete(b.key);
      if (!code) await kv.delete(`token/${id}`).catch(() => {});
    } else left++;
  }
  if (!left && ctx.copyKv) await setFull(ctx, handle, false, log);
  return left;
}
