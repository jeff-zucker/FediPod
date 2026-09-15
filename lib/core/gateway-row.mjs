// gateway-row.mjs — is the Gateway's row for this account pointing at this
// pod? The row records where the pod's documents live, and the door writes
// deliveries and serves reads from it. A pod whose root moved leaves the row
// naming the old place: reads answer stale documents and mail lands where
// nobody drains. Attaching again from the same account on the same pod
// corrects the row; this asks first, with one public request, and attaches
// only when the row disagrees.

// The row's key, from the door address: /u/<key>/ap/inbox/. For an address
// at the Gateway the key is the handle; for an address on the pod it is the
// full handle@host.
export function rowKeyOf(doorInboxUrl) {
  try {
    const seg = new URL(doorInboxUrl).pathname.split('/');
    return seg[1] === 'u' && seg[2] ? decodeURIComponent(seg[2]) : null;
  } catch { return null; }
}

// Where the row says the pod is, read without credentials: a fronted row
// answers WebFinger with the profile page on the pod; a row for an address
// on the pod answers a GET of its outbox with a redirect to the pod's.
export async function recordedPodHome({ front, key, fronted, fetchImpl = fetch }) {
  if (fronted) {
    const host = new URL(front).host;
    const r = await fetchImpl(`${front}/.well-known/webfinger?resource=acct:${encodeURIComponent(key + '@' + host)}`,
      { headers: { accept: 'application/jrd+json, application/json' } }).catch(() => null);
    if (!r?.ok) return null;
    const jrd = await r.json().catch(() => null);
    const page = (jrd?.links || []).find(l => l?.rel === 'http://webfinger.net/rel/profile-page')?.href;
    return typeof page === 'string' && page.endsWith('ap/profile.html') ? page.slice(0, -'ap/profile.html'.length) : null;
  }
  const r = await fetchImpl(`${front}/u/${encodeURIComponent(key)}/ap/outbox`, { redirect: 'manual' }).catch(() => null);
  const loc = r?.headers?.get?.('location');
  return typeof loc === 'string' && loc.endsWith('ap/outbox') ? loc.slice(0, -'ap/outbox'.length) : null;
}

// Returns 'ok', 'fixed', 'unknown' (the row could not be read) or 'failed'.
export async function confirmGatewayRow({ gateway, podHome, kind = 'person', fetchImpl = fetch, sessionFetch, log = () => {} }) {
  if (!gateway?.url || !podHome || !sessionFetch) return 'ok';
  const front = new URL(gateway.url).origin;
  const key = rowKeyOf(gateway.url);
  if (!key) return 'unknown';
  const fronted = !!gateway.frontActor;
  const recorded = await recordedPodHome({ front, key, fronted, fetchImpl });
  if (!recorded) { log(`gateway row: could not read where ${front} thinks this pod is — left as is`); return 'unknown'; }
  if (recorded === podHome) return 'ok';
  log(`gateway row names ${recorded}, this pod is ${podHome} — attaching again`);
  const res = await sessionFetch(`${front}/api/attach`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle: key.split('@')[0], podHome, kind: kind === 'group' ? 'group' : 'person', fronted }),
  }).catch(() => null);
  if (res?.status === 201) { log(`gateway row corrected: ${front} now reaches ${podHome}`); return 'fixed'; }
  const d = res ? await res.json().catch(() => ({})) : {};
  log(`gateway row NOT corrected (HTTP ${res?.status ?? 'none'}${d.error ? ': ' + d.error : ''}) — reads and mail through ${front} still use ${recorded}`);
  return 'failed';
}
