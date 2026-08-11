// directory.ts — the handle→pod directory, one small JSON resource per handle,
// read and written through a minimal IO shape { read, write } so it tests
// without a running CSS. store-css.ts supplies the real IO over a ResourceStore.

export interface IO {
  read(url: string): Promise<string | null>;
  write(url: string, body: string, contentType: string): Promise<void>;
}

export interface DirectoryRecord {
  handle: string; podHome: string; actorUrl: string; kind: string;
  webId?: string; hmacSecret?: string; gatewayWebId?: string | null;
}

export interface Directory {
  lookup(handle: string): Promise<DirectoryRecord | null>;
  putDirectory(handle: string, record: DirectoryRecord): Promise<void>;
}

export function makeDirectory(io: IO, containerUrl: string): Directory {
  const base = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';
  const docFor = (handle: string) => base + encodeURIComponent(handle) + '.json';
  return {
    async lookup(handle: string): Promise<DirectoryRecord | null> {
      const raw = await io.read(docFor(handle));
      if (!raw) return null;
      try { return JSON.parse(raw) as DirectoryRecord; } catch { return null; }
    },
    async putDirectory(handle: string, record: DirectoryRecord): Promise<void> {
      await io.write(docFor(handle), JSON.stringify(record), 'application/json');
    },
  };
}

// podPut for the gateway core: write an inbox item straight through the store.
export function makeStorePodPut(io: IO) {
  return async (url: string, body: string, contentType: string): Promise<boolean> => {
    try { await io.write(url, body, contentType); return true; } catch { return false; }
  };
}
