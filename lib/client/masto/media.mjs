// media.mjs — an upload on its way to the pod's media container: what an
// attachment is allowed to be and the two media endpoints. The multipart
// reader moved to body.mjs, which is where a client's body is read.

import crypto from 'node:crypto';
import * as podMedia from '../../pod/media.mjs';
import { readBody, readMultipart } from './body.mjs';

// What an attachment is allowed to BE. Anything else is stored as bytes, which
// a browser downloads rather than runs.
const ATTACHMENT_KINDS = new Set(['image', 'video', 'audio']);
// image/* with an exception: an SVG is a document, it carries script, and a
// browser renders it rather than showing it. Mastodon does not take them as
// media either.
const NEVER = new Set(['image/svg+xml', 'image/svg']);
const OPAQUE = 'application/octet-stream';

export function attachmentType(claimed) {
  const t = String(claimed || '').split(';')[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) || NEVER.has(t)) return OPAQUE;
  return ATTACHMENT_KINDS.has(t.split('/')[0]) ? t : OPAQUE;
}

// From the TYPE we accepted, not from the name the client sent — an `.html`
// suffix on a file stored as octet-stream is what a pod would serve from, and
// a filename is the client's to choose.
export function extensionFor(mediaType, filename = '') {
  if (mediaType === OPAQUE) return 'bin';
  const sub = mediaType.split('/')[1].replace(/[^a-z0-9]/g, '');
  const given = String(filename || '').includes('.')
    ? filename.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  // Keep the client's suffix only when it plainly belongs to the accepted type,
  // so jpg/jpeg and mp4/m4v survive without a table of every media type.
  return given && (given === sub || sub.startsWith(given) || given.startsWith(sub)) ? given : (sub || 'bin');
}

export async function handle(api, ctx) {
  const { req, res, pathname, url, send } = ctx;   // eslint-disable-line no-unused-vars

  // Media upload: file → remote pod /ap/media/ (public-Read), entry in the
  // media registry so a later POST /statuses can attach it.
  if ((pathname === '/api/v2/media' || pathname === '/api/v1/media') && req.method === 'POST') {
    const { fields, file } = await readMultipart(req);
    if (!file?.data?.length) return send(422, { error: 'file required' });
    // The client said what this is, and we used to believe it. The media
    // container is world-readable and sits on the pod's own origin — the same
    // origin as the WebID and the ACLs — so a file stored as text/html is a
    // page served from your identity, and script in it runs as you in any
    // browser already logged into that pod. A bearer is not "only you": the
    // facade exists so third-party clients can connect, tokens last 90 days,
    // and no scope is enforced. So any client you authorize could leave that
    // page behind.
    const mediaType = attachmentType(file.contentType);
    const ext = extensionFor(mediaType, file.filename);
    const slug = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    const mediaUrl = api.urls.media + slug;
    await api.agent.publisher.ensureMediaContainer();
    await podMedia.write(api.agent.remote, mediaUrl, file.data, mediaType);
    const entry = { url: mediaUrl, mediaType, description: fields.description || '' };
    const id = api.store.idFor(mediaUrl);
    api.store.setMedia(id, entry);
    return send(200, api.mediaJson({ id, ...entry }));
  }
  const mMedia = /^\/api\/v1\/media\/([a-f0-9]+)$/.exec(pathname);
  if (mMedia) {
    const entry = api.store.getMedia()[mMedia[1]];
    if (!entry) return send(404, { error: 'Record not found' });
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (typeof body.description === 'string') {
        entry.description = body.description;
        api.store.setMedia(mMedia[1], entry);
      }
    }
    return send(200, api.mediaJson({ id: mMedia[1], ...entry }));
  }

  return false;
}
