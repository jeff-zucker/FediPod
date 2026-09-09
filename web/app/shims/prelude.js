// prelude.js — globals the bundled Node code expects, set once before it runs.
// Injected as the bundle's banner. Kept minimal and local: Buffer is a subclass
// of Uint8Array (not a prototype patch), so nothing else in the page is touched.
globalThis.process ??= { env: {}, argv: [], platform: 'browser', cwd: () => '/', nextTick: (f, ...a) => queueMicrotask(() => f(...a)) };
globalThis.Buffer ??= (() => {
  const b64 = (u) => btoa(String.fromCharCode(...u));
  const hex = (u) => { let s = ''; for (const b of u) s += b.toString(16).padStart(2, '0'); return s; };
  class Buf extends Uint8Array {
    // Uint8Array.indexOf finds a single BYTE; Node's Buffer finds a whole
    // subsequence, and lib/mastoapi.mjs's readMultipart walks a multipart body
    // by searching for the boundary and for the CRLFCRLF that ends each part's
    // headers. Without this every search returned -1, so an upload came back
    // "file required" however good the bytes were.
    indexOf(needle, from = 0) {
      const pat = typeof needle === 'string' ? new TextEncoder().encode(needle)
        : needle instanceof Uint8Array ? needle : null;
      if (pat === null) return super.indexOf(needle, from);      // a single byte
      if (pat.length === 0) return Math.min(from, this.length);
      const last = this.length - pat.length;
      outer: for (let i = Math.max(0, from); i <= last; i++) {
        for (let j = 0; j < pat.length; j++) if (this[i + j] !== pat[j]) continue outer;
        return i;
      }
      return -1;
    }
    toString(enc) {
      if (enc === 'hex') return hex(this);
      if (enc === 'base64') return b64(this);
      if (enc === 'base64url') return b64(this).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return new TextDecoder().decode(this);
    }
  }
  const fromString = (s, enc) => {
    if (enc === 'hex') return Buf.from(s.match(/.{1,2}/g) || [], (h) => parseInt(h, 16));
    if (enc === 'base64' || enc === 'base64url') {
      const n = s.replace(/-/g, '+').replace(/_/g, '/');
      return Buf.from(atob(n + '==='.slice((n.length + 3) % 4)), (c) => c.charCodeAt(0));
    }
    return Buf.from(new TextEncoder().encode(s));
  };
  const from = (d, enc) => {
    if (typeof d === 'string') return fromString(d, enc);
    if (typeof d === 'function') { const args = arguments; return Uint8Array.from.call(Buf, args[0], args[1]); }
    const b = new Buf(d.length); b.set(d); return b;
  };
  const fromAny = (d, e) => {
    if (typeof d === 'string') return fromString(d, e);
    if (typeof e === 'function') { const arr = Array.from(d, e); const b = new Buf(arr.length); b.set(arr); return b; }
    if (d instanceof Uint8Array || Array.isArray(d)) { const b = new Buf(d.length); b.set(d); return b; }
    return new Buf(d);
  };
  return {
    from: fromAny,
    concat: (list) => { const n = list.reduce((s, x) => s + x.length, 0); const o = new Buf(n); let i = 0; for (const x of list) { o.set(x, i); i += x.length; } return o; },
    alloc: (n) => new Buf(n),
    isBuffer: (x) => x instanceof Uint8Array,
  };
})();
