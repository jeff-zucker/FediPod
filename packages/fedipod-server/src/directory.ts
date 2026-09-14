// directory.ts — the handle→pod directory, one small JSON resource per handle,
// read and written through a minimal IO shape { read, write } so it tests
// without a running CSS. store-css.ts supplies the real IO over a ResourceStore.

export interface IO {
  read(url: string): Promise<string | null>;
  write(url: string, body: string, contentType: string): Promise<void>;
  /** Absence is not an error: removing what is already gone succeeds. */
  remove?(url: string): Promise<void>;
}

// One JSON document per key in a container — the shape both registries share.
function jsonTable<T>(io: IO, containerUrl: string) {
  const base = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';
  const docFor = (key: string) => base + encodeURIComponent(key) + '.json';
  return {
    docFor,
    async get(key: string): Promise<T | null> {
      const raw = await io.read(docFor(key));
      if (!raw) return null;
      try { return JSON.parse(raw) as T; } catch { return null; }
    },
    async put(key: string, record: T): Promise<void> {
      await io.write(docFor(key), JSON.stringify(record), 'application/json');
    },
    async remove(key: string): Promise<void> {
      await io.remove?.(docFor(key));
    },
  };
}

export interface DirectoryRecord {
  handle: string; podHome: string; actorUrl: string; kind: string;
  webId?: string; hmacSecret?: string; gatewayWebId?: string | null;
  /** Inbox-only fronting: the row exists to resolve @handle@front and take verified delivery; the actor keeps its own ids on the pod. */
  inboxOnly?: boolean;
}

export interface Directory {
  lookup(handle: string): Promise<DirectoryRecord | null>;
  putDirectory(handle: string, record: DirectoryRecord): Promise<void>;
}

/**
 * The row an identity this server runs should have in the door's directory,
 * or null to leave what is already there alone.
 *
 * A row an owner made by attaching is theirs, and is never touched. A row this
 * server wrote for this same pod is corrected when it still names the pod root
 * rather than the identity's own tree — the place the door writes deliveries
 * and the agent watches. The secret rides across the correction, because a
 * gateway holding it has to go on working.
 */
export function frontRow(
  existing: DirectoryRecord | null,
  next: DirectoryRecord,
  podBase: string,
): DirectoryRecord | null {
  if (!existing) return next;
  const ours = existing.inboxOnly === true && existing.podHome === podBase;
  if (!ours || existing.podHome === next.podHome) return null;
  return { ...existing, podHome: next.podHome, actorUrl: next.actorUrl };
}

export function makeDirectory(io: IO, containerUrl: string): Directory {
  const table = jsonTable<DirectoryRecord>(io, containerUrl);
  return {
    lookup: (handle) => table.get(handle),
    putDirectory: (handle, record) => table.put(handle, record),
  };
}

/** A pod whose owner opted in at runtime. The door secret is never in the row. */
export interface AgentRegistryRecord {
  podBase: string; handle: string; host: string; webId: string; optedInAt: string;
}

/**
 * The registry key for an opted-in pod: its host plus its path. Several pods
 * can share a host (suffix pods on one origin), so the host alone is not
 * unique. A host-root or subdomain pod has an empty path, so its key is just
 * its host — exactly the shape rows were keyed by before suffix pods existed,
 * which is why old rows still resolve with no migration.
 */
export function agentKey(host: string, podBase: string): string {
  return host + new URL(podBase).pathname.replace(/\/+$/u, '');
}

export interface AgentRegistry {
  listKeys(): Promise<string[]>;
  get(key: string): Promise<AgentRegistryRecord | null>;
  add(record: AgentRegistryRecord): Promise<void>;
  remove(key: string): Promise<void>;
}

// The registry of runtime-opted-in pods, keyed by agentKey (host+path). The
// IO layer cannot enumerate a container, so index.json carries the key list;
// the row is written FIRST, so a crash between the two writes still leaves a
// row the next boot claims once the index catches up on the next change. The
// index field stays named `hosts`: for a host-root pod a key IS its host, so
// documents an older server wrote are read back unchanged.
export function makeAgentRegistry(io: IO, containerUrl: string): AgentRegistry {
  const table = jsonTable<AgentRegistryRecord>(io, containerUrl);
  const index = jsonTable<{ hosts: string[] }>(io, containerUrl);
  const INDEX = 'index';
  const keys = async (): Promise<string[]> => (await index.get(INDEX))?.hosts ?? [];
  return {
    listKeys: keys,
    get: (key) => table.get(key),
    async add(record: AgentRegistryRecord): Promise<void> {
      const key = agentKey(record.host, record.podBase);
      await table.put(key, record);
      const list = await keys();
      if (!list.includes(key)) await index.put(INDEX, { hosts: [ ...list, key ] });
    },
    async remove(key: string): Promise<void> {
      const list = await keys();
      await index.put(INDEX, { hosts: list.filter((h) => h !== key) });
      await table.remove(key);
    },
  };
}

// podPut for the gateway core: write an inbox item straight through the store.
export function makeStorePodPut(io: IO) {
  return async (url: string, body: string, contentType: string): Promise<boolean> => {
    try { await io.write(url, body, contentType); return true; } catch { return false; }
  };
}
