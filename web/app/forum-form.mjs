// forum-form.mjs — what the sign-up page's forum fields say, read into what
// the forum is made from. No imports, so a test reads it as the page does.

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;

// One category per line: a short name for the address, then a colon and the
// name readers see; a line with no colon is both.
export function categoriesFrom(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('Categories: at least one is required.');
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const i = line.indexOf(':');
    const slug = (i < 0 ? line : line.slice(0, i)).trim().toLowerCase();
    const name = (i < 0 ? '' : line.slice(i + 1)).trim() || slug;
    if (!SLUG.test(slug)) throw new Error(`Categories: "${slug}" is not a short name. Letters, digits and hyphens, starting with a letter or digit.`);
    if (seen.has(slug)) throw new Error(`Categories: "${slug}" is listed twice.`);
    seen.add(slug);
    out.push({ slug, name: name.slice(0, 200) });
  }
  return out;
}

// Who moderates, as an actor id: an address at this site, or a web address
// given outright. Empty is nobody named yet.
export function moderatorFrom(text, frontOrigin) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^https?:\/\//iu.test(s)) {
    try { return new URL(s).href; } catch { throw new Error('Moderator: not a valid web address.'); }
  }
  const m = /^@?([a-z0-9][a-z0-9._-]*)@([a-z0-9.-]+(?::\d+)?)$/iu.exec(s);
  if (!m) throw new Error('Moderator: write it as @name@server, or as a web address.');
  const front = frontOrigin ? new URL(frontOrigin) : null;
  if (front && m[2].toLowerCase() === front.host.toLowerCase()) return `${front.origin}/u/${m[1].toLowerCase()}/ap/actor`;
  throw new Error(`Moderator: only an address at ${front ? front.host : 'this site'} can be named here. Others can be added on the forum's settings page.`);
}
