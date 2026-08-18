// store-pod.ts — the agent's transport, over CSS's ResourceStore instead of
// the network. RemotePod funnels every pod operation through one fetch(), so
// swapping that one function moves the whole agent inside the server: no
// credential, no token, no socket to the pod it is already running in.
//
// The shape is WHATWG fetch because that is what RemotePod, Lease and Storage
// already speak — ETags and If-Match included, which is what keeps the lease's
// conditional-PUT protocol working unchanged.
//
// Writing here bypasses WAC by design, exactly as store-css.ts does: the agent
// acts as the pod's owner, and the server operator put it there.

import {
  BasicRepresentation, BasicConditions, BasicETagHandler, readableToString,
  NotFoundHttpError, PreconditionFailedHttpError, NotImplementedHttpError,
} from '@solid/community-server';
import type { ResourceStore, Representation, RepresentationPreferences } from '@solid/community-server';

export interface StoreFetchStats {
  reads: number;
  writes: number;
  deletes: number;
}

export interface StoreFetch {
  (url: string, init?: RequestInit): Promise<Response>;
  stats: () => StoreFetchStats;
}

/** Header lookup that does not care about case, over either shape fetch accepts. */
function headerReader(init?: RequestInit): (name: string) => string | null {
  const raw = init?.headers as Record<string, string> | Headers | undefined;
  if (!raw) return () => null;
  if (typeof (raw as Headers).get === 'function') return (n): string | null => (raw as Headers).get(n);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, string>)) lower[k.toLowerCase()] = String(v);
  return (n): string | null => lower[n.toLowerCase()] ?? null;
}

// Only Turtle needs asking for: a container's listing is quads until something
// requests a syntax, and listContainer parses Turtle. Everything else is read
// back exactly as it was written.
function preferencesFor(accept: string | null): RepresentationPreferences {
  return accept?.includes('text/turtle') ? { type: { 'text/turtle': 1 }} : {};
}

function isNotFound(e: unknown): boolean {
  return NotFoundHttpError.isInstance?.(e) === true || (e as { statusCode?: number })?.statusCode === 404;
}

/** A store path is the URL itself; a doubled slash would name a different resource. */
function pathOf(url: string): string {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/{2,}/gu, '/');
  u.hash = '';
  return u.href;
}

async function discard(rep: Representation): Promise<void> {
  rep.data.destroy();
}

export function makeStoreFetch(resourceStore: ResourceStore): StoreFetch {
  const stats: StoreFetchStats = { reads: 0, writes: 0, deletes: 0 };
  const etags = new BasicETagHandler();

  const respond = (status: number, body: string | null, etag?: string, contentType?: string): Response => {
    const headers: Record<string, string> = {};
    if (etag) headers.etag = etag;
    if (contentType) headers['content-type'] = contentType;
    return new Response(status === 204 || status === 205 || status === 304 ? null : body, { status, headers });
  };

  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const header = headerReader(init);
    const identifier = { path: pathOf(url) };

    if (method === 'GET' || method === 'HEAD') {
      stats.reads++;
      let rep: Representation;
      try {
        rep = await resourceStore.getRepresentation(identifier, preferencesFor(header('accept')));
      } catch (e: unknown) {
        if (isNotFound(e)) return respond(404, 'Not Found');
        throw e;
      }
      const etag = etags.getETag(rep.metadata);
      const noneMatch = header('if-none-match');
      // Weak comparison, per RFC 7232 — the drain re-reads the inbox listing
      // every couple of minutes and it is usually the same listing.
      if (etag && noneMatch && noneMatch.split(',').some((t) => etags.matchesETag(rep.metadata, t.trim(), false))) {
        await discard(rep);
        return respond(304, null, etag);
      }
      const contentType = rep.metadata.contentType;
      if (method === 'HEAD') {
        await discard(rep);
        return respond(200, null, etag, contentType);
      }
      return respond(200, await readableToString(rep.data), etag, contentType);
    }

    if (method === 'PUT') {
      stats.writes++;
      const ifMatch = header('if-match');
      const conditions = ifMatch
        ? new BasicConditions(etags, { matchesETag: ifMatch.split(',').map((t) => t.trim()) })
        : undefined;
      const contentType = header('content-type') ?? 'application/octet-stream';
      const rep = new BasicRepresentation(String(init.body ?? ''), identifier, contentType);
      let changes;
      try {
        changes = await resourceStore.setRepresentation(identifier, rep, conditions);
      } catch (e: unknown) {
        if (PreconditionFailedHttpError.isInstance?.(e)) return respond(412, 'Precondition Failed');
        throw e;
      }
      // The lease renews with a conditional PUT, so hand back the new ETag when
      // the store reported one; without it the lease re-reads first, which is
      // slower but just as correct.
      const written = changes?.get?.(identifier);
      return respond(205, null, written && etags.getETag(written));
    }

    if (method === 'DELETE') {
      stats.deletes++;
      try {
        await resourceStore.deleteResource(identifier);
      } catch (e: unknown) {
        if (isNotFound(e)) return respond(404, 'Not Found');
        throw e;
      }
      return respond(205, null);
    }

    throw new NotImplementedHttpError(`${method} is not something the pod store can answer`);
  };

  fetchImpl.stats = (): StoreFetchStats => ({ ...stats });
  return fetchImpl as StoreFetch;
}

/**
 * The session shape RemotePod consumes — the same three members its
 * credential-backed session has, so the class itself needs no other change.
 */
export function makeStoreSession(resourceStore: ResourceStore): {
  fetch: StoreFetch;
  warmup: () => Promise<void>;
  stats: () => StoreFetchStats;
} {
  const storeFetch = makeStoreFetch(resourceStore);
  return {
    fetch: storeFetch,
    warmup: async (): Promise<void> => undefined,   // nothing to mint
    stats: (): StoreFetchStats => storeFetch.stats(),
  };
}
