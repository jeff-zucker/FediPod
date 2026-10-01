// doc-delta.mjs — what changed in one state document, as something small that
// can be sent and applied to another copy of it. fedipod.net works on an
// account's copy and never writes the pod; what it changed reaches the pod as
// these, applied by the owner's FediPod (lib/gateway/pod-mail.mjs).
//
// A list of records is compared record by record, by the first field every
// record has (KEYS); an object by its top-level keys; anything else is sent
// whole. Applying never needs the document the change was made against, so a
// record added to a document the sender never had still lands.

const KEYS = ['noteId', 'id', 'actor', 'url', 'inbox', 'hash'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function keyOf(list) {
  if (!list.length) return null;
  if (list.every((e) => !isRecord(e) && !Array.isArray(e))) return '=';
  return KEYS.find((k) => list.every((e) => isRecord(e) && e[k] !== undefined && e[k] !== null)) || null;
}
const keyFn = (key) => (key === '=' ? (e) => JSON.stringify(e) : (e) => String(e[key]));

/**
 * The change from `before` to `after` (parsed documents; `before` null when
 * there was none). Null when nothing changed.
 */
export function deltaOf(before, after) {
  if (same(before, after)) return null;
  if (Array.isArray(after) && (before === null || before === undefined || Array.isArray(before))) {
    const was = before || [];
    const key = keyOf([...was, ...after]);
    if (key) {
      const k = keyFn(key);
      const old = new Map(was.map((e) => [k(e), e]));
      const now = new Set(after.map(k));
      const drop = [...old.keys()].filter((x) => !now.has(x));
      // New records ahead of every record the sender already had go to the
      // front, in order; others go to the end.
      const firstKnown = after.findIndex((e) => old.has(k(e)));
      const front = []; const back = []; const put = [];
      after.forEach((e, i) => {
        const id = k(e);
        if (!old.has(id)) (firstKnown < 0 || i < firstKnown ? front : back).push(e);
        else if (!same(old.get(id), e)) put.push(e);
      });
      if (!drop.length && !front.length && !back.length && !put.length) return null;
      return { list: key, ...(front.length ? { front } : {}), ...(back.length ? { back } : {}),
        ...(put.length ? { put } : {}), ...(drop.length ? { drop } : {}) };
    }
  }
  if (isRecord(after) && (before === null || before === undefined || isRecord(before))) {
    const was = before || {};
    const set = {}; const del = [];
    for (const [k, v] of Object.entries(after)) if (!same(was[k], v)) set[k] = v;
    for (const k of Object.keys(was)) if (!(k in after)) del.push(k);
    if (!Object.keys(set).length && !del.length) return null;
    return { object: true, ...(Object.keys(set).length ? { set } : {}), ...(del.length ? { del } : {}) };
  }
  return { whole: after };
}

/** `doc` (parsed, or null when absent) with `delta` applied. */
export function applyDelta(doc, delta) {
  if (!delta) return doc;
  if ('whole' in delta) return delta.whole;
  if (delta.object) {
    const out = isRecord(doc) ? { ...doc } : {};
    Object.assign(out, delta.set || {});
    for (const k of delta.del || []) delete out[k];
    return out;
  }
  if (delta.list) {
    const k = keyFn(delta.list);
    const drop = new Set(delta.drop || []);
    const put = new Map((delta.put || []).map((e) => [k(e), e]));
    let out = (Array.isArray(doc) ? doc : []).filter((e) => !drop.has(k(e))).map((e) => put.get(k(e)) ?? e);
    const have = new Set(out.map(k));
    // A record the receiving copy lacks, but the sender changed, is added.
    const missing = [...put.values()].filter((e) => !have.has(k(e)));
    const front = (delta.front || []).filter((e) => !have.has(k(e)));
    const back = [...(delta.back || []), ...missing].filter((e) => !have.has(k(e)));
    // Not trimmed here: the receiver's own store keeps its lists to length on
    // its next write, and a sender that never had the list cannot say how
    // long it should be.
    return [...front, ...out, ...back];
  }
  return doc;
}
