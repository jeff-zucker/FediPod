// check-letter.mjs — the gateway's test letter. Every six hours it writes to
// its admin's own account through the account's door, as any server would,
// and FediPod answers once it has taken the letter in (POST /api/check), or
// the gateway's own reader does when it reads held mail (account-agent.mjs).
// A letter still unanswered after FediPod has been open an hour means mail is
// not getting through, and the owner's phones are told. The letter itself is
// shown nowhere (lib/core/intake: checkLetters).
import crypto from 'node:crypto';
import { PRESENT_MS } from './held-mail.mjs';

export const LETTER_EVERY_MS = 6 * 3600_000;
export const ANSWER_WITHIN_MS = 3600_000;
const LETTER_ID = /^https?:\/\/[^/]+\/check\/letters\/[0-9a-f]{24}$/u;

const base = (origin) => String(origin || '').replace(/\/$/u, '');
export const checkActor = (origin) => `${base(origin)}/check/actor`;
const stateKey = (handle) => `check/${handle}`;
const read = async (kv, handle) => { try { return JSON.parse((await kv.get(stateKey(handle)))?.text || 'null') || {}; } catch { return {}; } };
const save = (kv, handle, st) => kv.set(stateKey(handle), JSON.stringify(st));

// Who gets letters: the admin's own browser accounts, still at this gateway.
const checked = (ctx, rec) => !!(ctx.adminWebId && rec?.openedAt && rec.actorUrl && rec.webId === ctx.adminWebId && !rec.movedTo);

/** The letter, as the door takes it: a direct note to the account. */
export function letterFor(origin, letter, to) {
  const actor = checkActor(origin);
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: letter, type: 'Create', actor, to: [to],
    object: { id: `${letter}#note`, type: 'Note', attributedTo: actor, to: [to], content: '<p>A test letter from this gateway.</p>' },
  };
}

/**
 * The round's part: for each account checked, a letter unanswered after an
 * hour of FediPod open is alerted once, and a new one goes when none is
 * waiting and six hours have passed since the last. `send(handle, rec, doc)`
 * delivers a letter; `alert(handle, text)` tells the owner's phones.
 */
export async function roundChecks(ctx, { kv = ctx.mastoKv, now = Date.now(), send, alert, log = console.log } = {}) {
  if (!kv || !ctx.adminWebId || !ctx.listDirectory || !ctx.frontOrigin) return;
  const rows = await ctx.listDirectory();
  for (const [handle, rec] of Object.entries(rows || {})) {
    if (!checked(ctx, rec)) continue;
    const st = await read(kv, handle);
    const presentAt = Number(await ctx.presentAt?.(handle).catch(() => 0)) || 0;
    const open = !!presentAt && now - presentAt < PRESENT_MS;
    const waiting = st.letter && !st.answeredAt && !st.alertedAt;
    if (waiting) {
      // Open since this round, or since an earlier one; closed starts it again.
      st.openSince = open ? (st.openSince ?? now) : null;
      if (open && now - st.openSince >= ANSWER_WITHIN_MS) {
        st.alertedAt = now;
        await alert(handle, 'Its test letter has not reached your FediPod after an hour with FediPod open. Mail may not be getting through.')
          .catch((e) => log(`check @${handle}: alert not sent: ${e?.message || e}`));
        log(`check @${handle}: letter not answered after an hour open — owner told`);
      }
      await save(kv, handle, st);
      continue;
    }
    if (typeof st.sentAt === 'number' && now - st.sentAt < LETTER_EVERY_MS) continue;
    const letter = `${base(ctx.frontOrigin)}/check/letters/${crypto.randomBytes(12).toString('hex')}`;
    const status = await send(handle, rec, letterFor(ctx.frontOrigin, letter, rec.actorUrl)).catch((e) => { log(`check @${handle}: letter not sent: ${e?.message || e}`); return 0; });
    if (status !== 202) { log(`check @${handle}: the door answered ${status} to the letter`); continue; }
    await save(kv, handle, { letter, sentAt: now });
    log(`check @${handle}: letter sent`);
  }
}

/** The letter taken in: true when it is the one waiting. */
export async function answerLetter(kv, handle, letter, { now = Date.now() } = {}) {
  if (!kv || !LETTER_ID.test(String(letter || ''))) return false;
  const st = await read(kv, handle);
  if (st.letter !== letter) return false;
  if (!st.answeredAt) await save(kv, handle, { ...st, answeredAt: now });
  return true;
}

/** When the letter waiting was alerted and is still unanswered, its time; else null. */
export async function missingLetter(kv, handle) {
  if (!kv) return null;
  const st = await read(kv, handle);
  return st.alertedAt && !st.answeredAt ? new Date(st.alertedAt).toISOString() : null;
}

/** What the gateway's reader needs to take a letter in at the gateway itself. */
export const checkLettersFor = (ctx, handle) => (ctx?.frontOrigin && ctx.mastoKv
  ? { actor: checkActor(ctx.frontOrigin), taken: async (letter) => { await answerLetter(ctx.mastoKv, handle, letter); } }
  : null);

// The letter's sender, for anything that looks it up: an application, whose
// inbox takes and keeps nothing. Returns a response, or null for other paths.
export function routeCheckActor(request, pathname, ctx, { j }) {
  if (pathname === '/check/actor' && (request.method === 'GET' || request.method === 'HEAD')) {
    const id = checkActor(ctx.frontOrigin || new URL(request.url).origin);
    return j(200, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id, type: 'Application', preferredUsername: 'check', name: `${ctx.host || new URL(id).host} test letters`,
      inbox: `${base(new URL(id).origin)}/check/inbox`,
    }, 'application/activity+json');
  }
  if (pathname === '/check/inbox' && request.method === 'POST') return { status: 202, headers: {}, body: null };
  return null;
}

// The owner's FediPod, saying it took the letter in, proved like /api/here;
// and the letter's sender, for anything that looks it up.
export async function routeCheckApi(request, pathname, ctx, deps) {
  if (pathname.startsWith('/check/')) return routeCheckActor(request, pathname, ctx, deps);
  if (pathname !== '/api/check') return null;
  const { j } = deps;
  if (request.method === 'OPTIONS') return deps.apiPreflight();
  if (request.method !== 'POST') return null;
  let body;
  try { body = JSON.parse(await request.clone().text()); } catch { return j(400, { error: 'bad JSON' }); }
  const handle = String(body.handle || '').toLowerCase();
  const rec = await ctx.lookup(handle);
  if (!rec) return j(404, { error: 'no such account' });
  const who = await deps.provedOwner(request, pathname, ctx, rec, deps);
  if (who.error) return who.error;
  const answered = await answerLetter(ctx.mastoKv, handle, String(body.letter || ''));
  return j(200, { ok: true, handle, answered });
}
