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

export interface AgentRegistry {
  listHosts(): Promise<string[]>;
  get(host: string): Promise<AgentRegistryRecord | null>;
  add(record: AgentRegistryRecord): Promise<void>;
  remove(host: string): Promise<void>;
}

// The registry of runtime-opted-in pods, keyed by host (the claim key). The
// IO layer cannot enumerate a container, so index.json carries the host list;
// the row is written FIRST, so a crash between the two writes still leaves a
// row the next boot claims once the index catches up on the next change.
export function makeAgentRegistry(io: IO, containerUrl: string): AgentRegistry {
  const table = jsonTable<AgentRegistryRecord>(io, containerUrl);
  const index = jsonTable<{ hosts: string[] }>(io, containerUrl);
  const INDEX = 'index';
  const hosts = async (): Promise<string[]> => (await index.get(INDEX))?.hosts ?? [];
  return {
    listHosts: hosts,
    get: (host) => table.get(host),
    async add(record: AgentRegistryRecord): Promise<void> {
      await table.put(record.host, record);
      const list = await hosts();
      if (!list.includes(record.host)) await index.put(INDEX, { hosts: [ ...list, record.host ] });
    },
    async remove(host: string): Promise<void> {
      const list = await hosts();
      await index.put(INDEX, { hosts: list.filter((h) => h !== host) });
      await table.remove(host);
    },
  };
}

// podPut for the gateway core: write an inbox item straight through the store.
export function makeStorePodPut(io: IO) {
  return async (url: string, body: string, contentType: string): Promise<boolean> => {
    try { await io.write(url, body, contentType); return true; } catch { return false; }
  };
}
