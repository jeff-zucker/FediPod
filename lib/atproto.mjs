// atproto.mjs — the agent's connection to an ATProto (Bluesky) account. The
// agent is an API CLIENT of an existing account on bsky.social or any PDS —
// the same relationship a Mastodon app has to this agent. Nothing here hosts
// ATProto; the pod stays the only public surface.
//
// Credential at AP_HOME/atproto.json (0600, atomic, stamped with the actor it
// was connected for — the keys.json rules). The app password is kept so an
// expired refresh token re-logins instead of demanding a reconnect.

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './home.mjs';
import { safeFetch, retryAfterMs } from './safefetch.mjs';

const FILE = 'atproto.json';
const POST_NSID = 'app.bsky.feed.post';
const MAX_GRAPHEMES = 300;
const MAX_IMAGES = 4;
const MAX_BLOB_BYTES = 950_000;

const enc = new TextEncoder();
const seg = new Intl.Segmenter();
const graphemes = (s) => { let n = 0; for (const _ of seg.segment(s)) n++; return n; };
const byteLen = (s) => enc.encode(s).length;

// Facet byte offsets are UTF-8 BYTE indexes into the text, not code units.
function detectFacets(text) {
  const facets = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'\])]+/g)) {
    facets.push({
      index: { byteStart: byteLen(text.slice(0, m.index)), byteEnd: byteLen(text.slice(0, m.index + m[0].length)) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index + m[1].length;
    const tagText = '#' + m[2];
    facets.push({
      index: { byteStart: byteLen(text.slice(0, start)), byteEnd: byteLen(text.slice(0, start + tagText.length)) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }],
    });
  }
  return facets;
}

// The post text Bluesky gets: the note's own text when it fits, otherwise a
// grapheme-safe cut with a link to the pod note, which holds the whole thing.
export function bskyText(text, noteUrl) {
  const clean = String(text || '').trim();
  if (graphemes(clean) <= MAX_GRAPHEMES) {
    return { text: clean, facets: detectFacets(clean), truncated: false };
  }
  const tail = '… ' + noteUrl;
  const budget = MAX_GRAPHEMES - graphemes(tail);
  let cut = '';
  let used = 0;
  for (const s of seg.segment(clean)) {
    if (used >= budget) break;
    cut += s.segment;
    used++;
  }
  const out = cut.trimEnd() + tail;
  const facets = detectFacets(out);
  return { text: out, facets, truncated: true };
}

const filePath = (dir) => path.join(dir, FILE);

export class Atproto {
  constructor({ localDir, actorId = null, log = console.log, fetcher = null }) {
    this.localDir = localDir;
    this.actorId = actorId;
    this.log = log;
    // Injectable for tests; the default is the politeness stack.
    this.fetcher = fetcher || ((url, init) => safeFetch(url, init));
    this.pausedUntil = 0;
    this.lastError = null;
  }

  // The stamped-record guard: a credential minted for another actor is treated
  // as absent, never silently adopted across identities.
  read() {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(filePath(this.localDir), 'utf8')); } catch { return null; }
    if (rec?.mintedFor && this.actorId && rec.mintedFor !== this.actorId) {
      this.log(`atproto.json belongs to ${rec.mintedFor} — not reusing it for ${this.actorId}`);
      return null;
    }
    return rec;
  }

  write(rec) {
    fs.mkdirSync(this.localDir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(filePath(this.localDir), rec);
  }

  connected() { return !!this.read()?.did; }

  status() {
    const rec = this.read();
    return {
      connected: !!rec?.did,
      service: rec?.service || null,
      handle: rec?.handle || null,
      did: rec?.did || null,
      lastError: this.lastError,
      cooldownFor: Math.max(0, Math.round((this.pausedUntil - Date.now()) / 1000)),
    };
  }

  async _fetch(url, init) {
    const left = this.pausedUntil - Date.now();
    if (left > 0) throw new Error(`bluesky asked us to back off — ${Math.ceil(left / 1000)}s left`);
    const res = await this.fetcher(url, init);
    if (res.status === 429 || res.status === 503) {
      const ms = retryAfterMs(res) ?? 60_000;
      this.pausedUntil = Date.now() + ms;
      this.log(`bluesky answered ${res.status} — pausing for ${Math.round(ms / 1000)}s`);
    }
    return res;
  }

  async _json(res) {
    const body = await res.json().catch(() => ({}));
    if (res.status >= 400) {
      const err = new Error(body.message || body.error || `bluesky answered ${res.status}`);
      err.status = res.status;
      err.code = body.error || null;
      throw err;
    }
    return body;
  }

  // One session mint, straight from service + identifier + app password.
  async connect({ service, identifier, appPassword }) {
    const base = String(service || 'https://bsky.social').replace(/\/+$/, '');
    const res = await this._fetch(`${base}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password: appPassword }),
    });
    const s = await this._json(res);
    this.write({
      service: base, identifier, appPassword,
      did: s.did, handle: s.handle,
      accessJwt: s.accessJwt, refreshJwt: s.refreshJwt,
      ...(this.actorId ? { mintedFor: this.actorId } : {}),
    });
    this.lastError = null;
    this.log(`bluesky connected: @${s.handle} (${s.did})`);
    return { did: s.did, handle: s.handle, service: base };
  }

  // Best-effort session teardown, then the local record is gone regardless.
  async disconnect() {
    const rec = this.read();
    if (rec?.refreshJwt) {
      await this._fetch(`${rec.service}/xrpc/com.atproto.server.deleteSession`, {
        method: 'POST', headers: { authorization: `Bearer ${rec.refreshJwt}` },
      }).catch(() => {});
    }
    try { fs.rmSync(filePath(this.localDir)); } catch {}
    this.log('bluesky disconnected');
  }

  async _refresh(rec) {
    const res = await this._fetch(`${rec.service}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST', headers: { authorization: `Bearer ${rec.refreshJwt}` },
    });
    if (res.status >= 400) {
      // The refresh token died; the stored app password re-mints the session.
      await this._json(res).catch(() => {});
      return this.connect({ service: rec.service, identifier: rec.identifier, appPassword: rec.appPassword })
        .then(() => this.read());
    }
    const s = await this._json(res);
    const next = { ...rec, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt };
    this.write(next);
    return next;
  }

  // Mirror one public note. Returns { uri, cid } — the caller records it on
  // the status so a later delete can find the mirror.
  async crossPost({ text, published, attachments = [] }, { noteUrl }) {
    const rec = this.read();
    if (!rec?.did) throw new Error('no bluesky account connected');
    const body = bskyText(text, noteUrl);
    const images = [];
    for (const a of attachments.filter(x => /^image\//.test(x.mediaType || '')).slice(0, MAX_IMAGES)) {
      const res = await this._fetch(a.url, {});
      if (res.status >= 400) throw new Error(`attachment fetch failed (${res.status}): ${a.url}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_BLOB_BYTES) { this.log(`bluesky: image too large, skipped (${a.url})`); continue; }
      const up = await this.xrpc('com.atproto.repo.uploadBlob', {
        body: bytes, contentType: a.mediaType,
      });
      images.push({ image: up.blob, alt: a.description || '' });
    }
    const record = {
      $type: POST_NSID,
      text: body.text,
      ...(body.facets.length ? { facets: body.facets } : {}),
      ...(images.length ? { embed: { $type: 'app.bsky.embed.images', images } } : {}),
      createdAt: published || new Date().toISOString(),
    };
    const out = await this.xrpc('com.atproto.repo.createRecord', {
      body: { repo: rec.did, collection: POST_NSID, record },
    });
    return { uri: out.uri, cid: out.cid, ...(body.truncated ? { truncated: true } : {}) };
  }

  // at://did/collection/rkey → deleteRecord. Absence on the far side is fine.
  async deleteCrossPost(uri) {
    const m = String(uri).match(/^at:\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) throw new Error(`not an at:// uri: ${uri}`);
    await this.xrpc('com.atproto.repo.deleteRecord', {
      body: { repo: m[1], collection: m[2], rkey: m[3] },
    });
  }

  // The one door every call goes through. GET when there is no body.
  // Retries exactly once after an expired-token refresh.
  async xrpc(nsid, { params = null, body = null, contentType = 'application/json', method = null } = {}) {
    let rec = this.read();
    if (!rec?.did) throw new Error('no bluesky account connected');
    const qs = params
      ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString()
      : '';
    const doCall = (r) => this._fetch(`${r.service}/xrpc/${nsid}${qs}`, {
      method: method || (body != null ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${r.accessJwt}`,
        ...(body != null ? { 'content-type': contentType } : {}),
      },
      ...(body != null ? { body: contentType === 'application/json' ? JSON.stringify(body) : body } : {}),
    });
    let res = await doCall(rec);
    if (res.status === 400 || res.status === 401) {
      const peek = await res.clone().json().catch(() => ({}));
      if (peek.error === 'ExpiredToken' || peek.error === 'InvalidToken') {
        rec = await this._refresh(rec);
        res = await doCall(rec);
      }
    }
    try {
      const out = await this._json(res);
      this.lastError = null;
      return out;
    } catch (e) {
      this.lastError = e.message;
      throw e;
    }
  }
}
