// node-path.mjs — the POSIX slice of node:path the agent uses in the browser.
const normalize = (p) => {
  const up = p.startsWith('/');
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!up) parts.push('..'); }
    else parts.push(seg);
  }
  return (up ? '/' : '') + parts.join('/') || (up ? '/' : '.');
};
const join = (...segs) => normalize(segs.filter((s) => s != null && s !== '').join('/'));
const dirname = (p) => { const i = p.replace(/\/$/, '').lastIndexOf('/'); return i <= 0 ? (i === 0 ? '/' : '.') : p.slice(0, i); };
const basename = (p, ext) => { let b = p.slice(p.lastIndexOf('/') + 1); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; };
const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
const resolve = (...segs) => join(...segs);
const posix = { join, dirname, basename, extname, resolve, normalize, sep: '/' };
export { join, dirname, basename, extname, resolve, normalize, posix };
export default { join, dirname, basename, extname, resolve, normalize, posix, sep: '/' };
