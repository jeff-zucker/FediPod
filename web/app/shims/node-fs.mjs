// node-fs.mjs — the tiny synchronous slice of node:fs touched at import time.
// ua.mjs and publisher.mjs read package.json for the version; everything else
// (FileStorage, home, certs) is never constructed in the browser.
const PKG = JSON.stringify({ version: '0.18.0', name: 'fedipod' });
export const readFileSync = (p) => {
  if (String(p).endsWith('package.json')) return PKG;
  throw new Error(`node:fs readFileSync(${p}) is not available in the browser agent`);
};
export const existsSync = () => false;
const nope = (name) => () => { throw new Error(`node:fs ${name} is not available in the browser agent`); };
export const writeFileSync = nope('writeFileSync');
export const mkdirSync = nope('mkdirSync');
export const readdirSync = () => [];
export const statSync = nope('statSync');
export const unlinkSync = nope('unlinkSync');
export const rmSync = nope('rmSync');
export default { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync };
