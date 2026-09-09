// node-crypto.mjs — a browser stand-in for node:crypto, for the agent bundle.
//
// The agent uses only a small synchronous slice: SHA-256 (and HMAC-SHA-256)
// hashing, random bytes, constant-time compare — plus WebCrypto (crypto.subtle),
// which the browser has natively. Rather than pull in crypto-browserify (which
// drags Node streams into the bundle), SHA-256 is implemented here in pure JS.
// Key generation and KeyObject calls are never reached: keys are made by
// keystore.mjs and loaded straight into WebCrypto.

const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

function sha256(bytes) {
  const l = bytes.length;
  const withOne = l + 1;
  const k = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + k + 8;
  const m = new Uint8Array(total);
  m.set(bytes); m[l] = 0x80;
  const bits = l * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 4, bits >>> 0);
  dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t-15],7) ^ rotr(w[t-15],18) ^ (w[t-15] >>> 3);
      const s1 = rotr(w[t-2],17) ^ rotr(w[t-2],19) ^ (w[t-2] >>> 10);
      w[t] = (w[t-16] + s0 + w[t-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
  }
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, H[0]); new DataView(out.buffer).setUint32(4, H[1]);
  new DataView(out.buffer).setUint32(8, H[2]); new DataView(out.buffer).setUint32(12, H[3]);
  new DataView(out.buffer).setUint32(16, H[4]); new DataView(out.buffer).setUint32(20, H[5]);
  new DataView(out.buffer).setUint32(24, H[6]); new DataView(out.buffer).setUint32(28, H[7]);
  return out;
}
function hmacSha256(key, msg) {
  if (key.length > 64) key = sha256(key);
  const pad = new Uint8Array(64); pad.set(key);
  const ipad = new Uint8Array(64); const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { ipad[i] = pad[i] ^ 0x36; opad[i] = pad[i] ^ 0x5c; }
  const inner = sha256(concat(ipad, msg));
  return sha256(concat(opad, inner));
}
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const toBytes = (data, enc) => {
  if (data == null) return new Uint8Array(0);
  if (typeof data === 'string') {
    if (enc === 'hex') return Uint8Array.from(data.match(/.{1,2}/g) || [], (h) => parseInt(h, 16));
    if (enc === 'base64') return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new TextEncoder().encode(data);
  }
  return data instanceof Uint8Array ? data : new Uint8Array(data);
};
const encode = (bytes, enc) => {
  if (!enc || enc === 'buffer') return bytes;
  if (enc === 'hex') return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = btoa(String.fromCharCode(...bytes));
  if (enc === 'base64url') return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64;   // base64
};

export function createHash(alg) {
  if (alg !== 'sha256') throw new Error(`node-crypto shim: only sha256 is implemented (got ${alg})`);
  let acc = new Uint8Array(0);
  return { update(d, e) { acc = concat(acc, toBytes(d, e)); return this; }, digest(enc) { return encode(sha256(acc), enc); } };
}
export function createHmac(alg, key) {
  if (alg !== 'sha256') throw new Error(`node-crypto shim: only hmac-sha256 is implemented (got ${alg})`);
  const k = toBytes(key); let acc = new Uint8Array(0);
  return { update(d, e) { acc = concat(acc, toBytes(d, e)); return this; }, digest(enc) { return encode(hmacSha256(k, acc), enc); } };
}
// A Buffer, not a bare Uint8Array, so callers' `.toString('hex')` works (the
// prelude defines Buffer before any bundle code runs).
export function randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return globalThis.Buffer ? globalThis.Buffer.from(b) : b; }
export const webcrypto = globalThis.crypto;
export const randomUUID = () => globalThis.crypto.randomUUID();
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0; for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}
const unavailable = (name) => () => { throw new Error(`node:crypto ${name} is not available in the browser agent`); };
export const generateKeyPairSync = unavailable('generateKeyPairSync');
export const createPrivateKey = unavailable('createPrivateKey');
export const createPublicKey = unavailable('createPublicKey');
export const scryptSync = unavailable('scryptSync');
export default { createHash, createHmac, randomBytes, webcrypto, randomUUID, timingSafeEqual,
  generateKeyPairSync, createPrivateKey, createPublicKey, scryptSync };
