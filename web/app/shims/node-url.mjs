// node-url.mjs — the node:url slice the agent uses. URL is native; the two
// file-path converters are only ever called with data: or http URLs in the
// browser build, so plain string surgery suffices.
export const fileURLToPath = (u) => { const s = typeof u === 'string' ? u : u.href; return s.replace(/^file:\/\//, ''); };
export const pathToFileURL = (p) => new URL('file://' + (p.startsWith('/') ? p : '/' + p));
export { URL, URLSearchParams } from './_globals.mjs';
export default { URL: globalThis.URL, URLSearchParams: globalThis.URLSearchParams, fileURLToPath, pathToFileURL };
