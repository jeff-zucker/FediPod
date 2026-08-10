// directory.mjs — the handle→pod directory, stored as one small JSON resource
// per handle inside CSS itself (a `.internal` container), read and written
// through the same store the handler already holds. Pure over a minimal IO
// shape { read(url)->string|null, write(url, body, contentType) }, so it tests
// without a running CSS; store-css.mjs supplies the real IO over a ResourceStore.

export function makeDirectory(io, containerUrl) {
  const base = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';
  const docFor = (handle) => base + encodeURIComponent(handle) + '.json';
  return {
    async lookup(handle) {
      const raw = await io.read(docFor(handle));
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async putDirectory(handle, record) {
      await io.write(docFor(handle), JSON.stringify(record), 'application/json');
    },
  };
}

// podPut for the gateway core: write an inbox item straight through the store,
// no HTTP, no credential. The store's own writes bypass WAC — the handler
// having decided this is verified mail for this inbox is the authorization.
export function makeStorePodPut(io) {
  return async (url, body, contentType) => {
    try { await io.write(url, body, contentType); return true; } catch { return false; }
  };
}
