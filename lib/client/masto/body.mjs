// body.mjs — reading what a client sent: JSON or form-encoded bodies, the
// poll a compose request carries, and the text of a post back out of its
// HTML.



/**
 * A poll out of a compose request, or null when there is none. A JSON client
 * sends a `poll` object; a form-encoded one spells the same thing out in
 * Rails's bracket notation, which is the shape the option list arrives in.
 */
export function pollParams(body) {
  const nested = body?.poll && typeof body.poll === 'object' ? body.poll : null;
  const options = [].concat(nested?.options ?? body?.['poll[options][]'] ?? [])
    .map(o => String(o ?? '').trim()).filter(Boolean);
  const rawExpiry = nested?.expires_in ?? body?.['poll[expires_in]'];
  const rawMultiple = nested?.multiple ?? body?.['poll[multiple]'];
  if (!options.length && rawExpiry === undefined) return null;
  return {
    options,
    expiresIn: rawExpiry === undefined || rawExpiry === null || rawExpiry === ''
      ? null : Number(rawExpiry),
    multiple: rawMultiple === true || rawMultiple === 'true' || rawMultiple === '1',
  };
}

// Accepts JSON or form-encoded bodies (OAuth posts are often form-encoded).
// The source of a post that predates raw-text storage: its HTML back to
// typed text, near enough to edit.
export function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .trim();
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      // Destroying the socket without settling left the awaiting handler
      // pending for the life of the process and the client waiting on a
      // response that would never come.
      if (data.length > 1e6) { req.destroy(); reject(new Error('request body too large')); }
    });
    req.on('end', () => {
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.includes('application/json')) return resolve(data ? JSON.parse(data) : {});
        // A form-encoded list is the same key repeated, spelled with a
        // trailing `[]`. Reading it as a plain object kept only the last one,
        // so a client sending its poll or its media that way lost all but the
        // final value. Only the `[]` keys become lists: everything else keeps
        // the single value the rest of this file reads.
        const form = new URLSearchParams(data);
        const out = {};
        for (const key of new Set(form.keys())) {
          out[key] = key.endsWith('[]') ? form.getAll(key) : form.get(key);
        }
        resolve(out);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
