// store-css.mjs — the real IO over CSS's ResourceStore. This is the only file
// that imports CSS, so everything else tests without a running server. It turns
// the store's Representation-based API into the tiny { read, write } shape the
// directory and podPut are written against.
//
// Writing here bypasses WAC by design: the lowest store "assumes the necessary
// Solid checks have already been made" (CSS docs), and the gateway handler is
// the thing that made them — it only ever writes verified mail into an inbox,
// or a directory row into the gateway's own internal container.

import { BasicRepresentation, readableToString, NotFoundHttpError } from '@solid/community-server';

export function makeStoreIO(resourceStore) {
  return {
    async read(url) {
      try {
        const rep = await resourceStore.getRepresentation({ path: url }, {});
        return await readableToString(rep.data);
      } catch (e) {
        if (NotFoundHttpError.isInstance?.(e) || e?.statusCode === 404) return null;
        throw e;
      }
    },
    async write(url, body, contentType) {
      const rep = new BasicRepresentation(body, { path: url }, contentType);
      await resourceStore.setRepresentation({ path: url }, rep);
    },
  };
}
