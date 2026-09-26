// keeper-due.mjs — when each kept account's keeper next has work
// (keeper.mjs), kept per account in a small key-value store: Netlify Blobs on
// Netlify, a Map in a test. `store` answers get(key) -> object|null,
// set(key, object) and keys() -> [key].
//
// A run sets the time from what it left (nextAt). A follow held at the door
// sets it to now, and one that arrives while a run is going is not lost when
// the run finishes. A run that could not take the account's lease tries again
// next round; one that failed, in an hour.

const RETRY_FAILED_MS = 3_600_000;

// The sooner of two times (ISO strings, either of them null).
export const earliest = (a, b) => (!a ? b || null : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);

export function keeperBook(store) {
  return {
    async noteKept(handle, out, started = 0, now = Date.now()) {
      const prev = (await store.get(handle)) || {};
      const next = out?.retry === 'soon' ? prev.nextAt
        : out?.retry === 'later' ? new Date(now + RETRY_FAILED_MS).toISOString() : out?.nextAt;
      const woken = prev.noted >= started ? prev.nextAt : null;
      await store.set(handle, { at: now, waiting: out?.waiting || 0, skipped: out?.skipped || null,
        nextAt: earliest(next || null, woken) });
    },
    async noteNext(handle, nextAt, { earliest: keepSooner = false } = {}) {
      const prev = (await store.get(handle)) || {};
      await store.set(handle, { ...prev, nextAt: keepSooner ? earliest(prev.nextAt, nextAt) : nextAt, noted: Date.now() });
    },
    async keeperDue(now = Date.now()) {
      const due = [];
      for (const key of await store.keys()) {
        const k = (await store.get(key)) || {};
        if (k.nextAt && Date.parse(k.nextAt) <= now) due.push(key);
      }
      return due;
    },
  };
}
