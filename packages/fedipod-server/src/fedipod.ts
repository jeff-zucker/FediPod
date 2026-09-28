// fedipod.ts — the fedipod modules this component loads, by name, at runtime.
// They are an ESM tree; a real dynamic import() built via Function keeps tsc
// from downleveling it to require(), which cannot load an ESM module with
// top-level await under a CommonJS build.

export const FRONT_CORE = 'fedipod/front';
export const FRONT_PAGES = 'fedipod/front-pages';
export const EMBED = 'fedipod/embed';
export const PLACE = 'fedipod/place';
export const TRANSPORT = 'fedipod/pod/transport.mjs';
export const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<Record<string, Function>>;

/** The front's pages and the files they load, as fedipod/front-pages reads them. */
export interface FrontPages {
  signupPage: string | null; runPage: string | null; adminPage: string | null; noticesPage: string | null;
  authBundle: string | null; pageScripts: Record<string, string | null>;
}
