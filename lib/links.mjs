// links.mjs — reading RFC 8288 Link headers.
//
// Solid says where a resource's access control lives, where a storage
// describes itself, and who owns a storage, by putting a link on the response.
// Working any of those out from the resource's own URL instead is exactly what
// the specs tell clients not to do, so this is the one place that reads them.

/**
 * Every target a Link header gives for one relation, resolved against the URL
 * the header came from. A header may carry several links, and one link may
 * carry several relation names.
 */
export function linkTargets(headerValue, rel, baseUrl) {
  if (!headerValue) return [];
  const wanted = String(rel).toLowerCase();
  const out = [];
  // Split on the commas BETWEEN links: one inside a URI has its closing angle
  // bracket still ahead of it, and is left alone.
  for (const part of String(headerValue).split(/,(?![^<]*>)/u)) {
    const link = /^\s*<([^>]*)>\s*(.*)$/u.exec(part);
    if (!link) continue;
    const relParam = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^;"\s]+))/iu.exec(link[2]);
    const names = (relParam?.[1] ?? relParam?.[2] ?? '').toLowerCase().split(/\s+/u);
    if (!names.includes(wanted)) continue;
    try { out.push(new URL(link[1], baseUrl).href); } catch { /* not a URL we can follow */ }
  }
  return out;
}

/** The relations this project follows. */
export const REL = {
  acl: 'acl',
  storageDescription: 'http://www.w3.org/ns/solid/terms#storageDescription',
  owner: 'http://www.w3.org/ns/solid/terms#owner',
};
