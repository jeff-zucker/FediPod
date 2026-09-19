// body.mjs — reading what a client sent: JSON, form-encoded or multipart
// bodies, the poll a compose request carries, and the text of a post back out
// of its HTML.



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
        // A multipart body is not a query string: read as one it becomes a
        // single nonsense key, so every field a client sent that way arrived
        // undefined. Sengi registers its OAuth client with a FormData, which
        // is multipart, so /api/v1/apps saw no redirect_uris and handed back
        // the out-of-band URN, leaving the client nowhere to come back to.
        if (ct.includes('multipart/form-data')) return resolve(textFields(data, ct));
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

/**
 * The text fields of a multipart body that arrived as text. readBody
 * accumulates the body as a string, so this reads the fields out of that
 * string rather than out of bytes — which is all a client sending a plain
 * form this way has in it. A body with a FILE in it is not this reader's:
 * a text round trip corrupts binary, and the upload endpoints take their
 * bytes from readMultipart below.
 */
function textFields(data, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  if (!m) return {};
  const out = {};
  for (const part of data.split('--' + (m[1] || m[2]).trim())) {
    const sep = part.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    const name = /name="([^"]*)"/.exec(head)?.[1];
    // A file part is skipped rather than kept as mangled text.
    if (!name || /filename="/.test(head)) continue;
    const value = part.slice(sep + 4).replace(/\r\n$/, '');
    if (name.endsWith('[]')) (out[name] ||= []).push(value);
    else out[name] = value;
  }
  return out;
}

// Minimal multipart/form-data reader for media uploads: string fields plus
// at most one file part (Mastodon's media endpoints send exactly one).
export function readMultipart(req, limit = 12e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('upload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(String(req.headers['content-type'] || ''));
        if (!m) return resolve({ fields: {}, file: null });
        const buf = Buffer.concat(chunks);
        const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
        const fields = {};
        // `file` is the last one seen, which is what the single-file media
        // upload wants. `files` keys them by field name, because the profile
        // editor submits an avatar and a header in one request.
        const files = {};
        let file = null;
        let i = buf.indexOf(boundary);
        while (i >= 0) {
          const start = i + boundary.length;
          if (buf.slice(start, start + 2).toString() === '--') break;
          const next = buf.indexOf(boundary, start);
          if (next < 0) break;
          const part = buf.slice(start + 2, next - 2);        // strip the CRLFs framing the part
          const sep = part.indexOf('\r\n\r\n');
          if (sep >= 0) {
            const head = part.slice(0, sep).toString();
            const body = part.slice(sep + 4);
            const name = /name="([^"]*)"/.exec(head)?.[1];
            const filename = /filename="([^"]*)"/.exec(head)?.[1];
            if (filename !== undefined) {
              file = {
                filename,
                contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() || 'application/octet-stream',
                data: body,
              };
              if (name) files[name] = file;
            } else if (name) fields[name] = body.toString();
          }
          i = next;
        }
        resolve({ fields, file, files });
      } catch (e) { reject(e); }
    });
  });
}

