// fake-pod.mjs — one pod kept in memory, for the forum's tests: documents,
// ACLs, the inbox as a listing, the lease with its ETag, and owner-only
// state containers; plus a stranger's documents as fetched at their origin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const POD = 'https://forum.example/';
export const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
export const MEI = 'https://mei.pod.example/fedipod/ap/actor';
export const KWAME = 'https://kwame.example/users/kwame';

// One pod, shared by every agent in a test: documents, ACLs, the inbox as a
// listing, the lease with its ETag, and owner-only state containers.
export function fakePod() {
  const docs = new Map();
  const acls = [];
  const inbox = [];
  const state = new Map();                         // base → Map(name → body)
  let leaseEtag = 0;
  const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
  const pod = {
    docs, acls, inbox, state, webId: 'https://forum.example/profile/card#me',
    putJson: async (u, o) => { docs.set(u, o); return { ok: true }; },
    put: async (u, body) => { docs.set(u, body); return { ok: true }; },
    getJson: async (u) => docs.get(u) ?? null,
    setAcl: async (u, modes, opts) => { acls.push([u, modes, opts || null]); },
    delete: async (u) => {
      const i = inbox.findIndex(x => x.url === u);
      if (i >= 0) inbox.splice(i, 1);
      docs.delete(u);
      return true;
    },
    listContainer: async (u) => (u.endsWith('ap/inbox/') && u.startsWith(POD + 'fedipod-bb/ap/') ? inbox.map(x => ({ ...x })) : []),
    linkAccountInProfile: async () => false,
    stats: () => ({}),
    fetch: async (u, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      if (u.endsWith('lease.json')) {
        const cur = docs.get(u);
        if (method === 'GET') return cur ? json(cur, 200, { etag: `"${leaseEtag}"` }) : new Response('', { status: 404 });
        if (method === 'PUT') {
          const im = init.headers?.['if-match'] ?? init.headers?.['If-Match'];
          if (im && im !== `"${leaseEtag}"`) return new Response('', { status: 412 });
          docs.set(u, JSON.parse(init.body));
          leaseEtag++;
          return new Response(null, { status: 204, headers: { etag: `"${leaseEtag}"` } });
        }
      }
      const item = inbox.find(x => x.url === u);
      if (item && method === 'GET') return new Response(item.body, { status: 200, headers: { 'content-type': 'application/activity+json' } });
      return new Response('', { status: 404 });
    },
  };
  // Owner-only state, per container: what PodStore reads and writes.
  pod.storageFor = (base) => {
    const m = state.get(base) || new Map();
    state.set(base, m);
    return {
      base, kind: 'mem',
      list: async () => ({ notModified: false, names: [...m.keys()], etag: null }),
      read: async (name) => (m.has(name) ? { ok: true, notModified: false, status: 200, body: m.get(name), etag: null }
        : { ok: false, notModified: false, status: 404, body: null, etag: null }),
      write: async (name, body) => { m.set(name, body); return { ok: true, retry: false, why: '' }; },
      remove: async (name) => { m.delete(name); return true; },
    };
  };
  pod.deliver = (url, activity) => {
    const body = JSON.stringify(activity);
    inbox.push({ url: POD + 'fedipod-bb/ap/inbox/' + url, size: body.length, modified: new Date().toISOString(), body });
  };
  return pod;
}

export function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fedipod-bb-'));
  fs.writeFileSync(path.join(dir, 'credential.json'), JSON.stringify({ remotePod: POD, webId: 'https://forum.example/profile/card#me' }));
  return dir;
}

// A stranger's pod, as fetched at its origin.
export const remoteDocs = {
  [MEI]: { id: MEI, type: 'Person', preferredUsername: 'mei', inbox: MEI.replace('actor', 'inbox/'), endpoints: { sharedInbox: 'https://mei.pod.example/fedipod/ap/inbox/' } },
  [KWAME]: { id: KWAME, type: 'Person', preferredUsername: 'kwame', inbox: KWAME + '/inbox' },
};
export const note = (id, { by = MEI, type = 'Note', name = null, content = '<p>hello</p>', inReplyTo = null, context = null, audience = null, to = null, published = '2026-09-15T10:00:00Z' } = {}) => ({
  '@context': 'https://www.w3.org/ns/activitystreams', id, type, attributedTo: by, content, published,
  ...(name ? { name } : {}), ...(inReplyTo ? { inReplyTo } : {}), ...(context ? { context } : {}), ...(audience ? { audience } : {}),
  to: to || [PUBLIC, ...(audience ? [audience] : [])], cc: [],
});

