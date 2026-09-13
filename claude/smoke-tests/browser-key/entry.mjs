// Headless-browser check: the opened signing key is kept in IndexedDB as a
// non-extractable CryptoKey, an old PEM copy is upgraded on read, and the key
// still signs. Bundled by scripts/build-app.mjs, run by run.mjs.
import { generateKeys } from '../../../web/app/keystore.mjs';
import { cacheOpenedKeys, loadKeysFromPod, keyCacheKey } from '../../../web/app/keys-browser.mjs';
import { kvGet, kvPut } from '../../../web/app/idb-kv.mjs';
import { sign } from '../../../web/app/shims/fedify-sig.mjs';

const out = [];
window.addEventListener('unhandledrejection', (e) => { out.push(`FAIL  unhandled: ${e.reason?.message || e.reason}`); fetch('/done', { method: 'POST', body: out.join('\n') }); });
window.addEventListener('error', (e) => { out.push(`FAIL  error: ${e.message}`); fetch('/done', { method: 'POST', body: out.join('\n') }); });
const check = (ok, what) => out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
const actor = 'https://pod.example/fedipod/ap/actor';
const urls = { actor };
const remote = { fetch: async () => { throw new Error('the pod must not be read when a cached key exists'); } };

try {
  const rec = await generateKeys();
  const keys = await cacheOpenedKeys(actor, rec);
  check(keys.rsaPrivate?.type === 'private', 'cacheOpenedKeys returns a private CryptoKey');
  check(keys.rsaPrivate.extractable === false, 'the imported key is non-extractable');

  const stored = await kvGet(keyCacheKey(actor));
  check(stored?.rsaPrivate?.type === 'private', 'IndexedDB holds a CryptoKey, not a record');
  check(stored.rsaPrivate.extractable === false, 'the stored key is non-extractable');
  check(!('rsa' in stored) && !JSON.stringify(stored).includes('PRIVATE KEY'), 'no PEM in storage');
  let exported = null;
  try { exported = await crypto.subtle.exportKey('pkcs8', stored.rsaPrivate); } catch { /* expected */ }
  check(exported === null, 'exportKey on the stored key fails');

  const loaded = await loadKeysFromPod(remote, urls);
  check(loaded.rsaPrivate?.type === 'private' && loaded.rsaPublicPem === rec.rsa.publicPem,
    'loadKeysFromPod serves the cached key without touching the pod');
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', loaded.rsaPrivate, new TextEncoder().encode('hello'));
  check(sig.byteLength === 256, 'the cached key signs (2048-bit RSA signature)');
  // The browser's outbound signer — the only thing that signs deliveries in
  // this build — must accept the non-extractable key.
  const signed = await sign({ url: 'https://remote.example/inbox', method: 'POST',
    headers: { 'content-type': 'application/activity+json' }, body: '{}' }, loaded.rsaPrivate, actor + '#main-key');
  check(/^keyId=.*signature="[A-Za-z0-9+/=]+"$/.test(signed.headers.signature),
    'the HTTP-Signature signer works with the stored key');
  const pub = await crypto.subtle.importKey('spki',
    Uint8Array.from(atob(rec.rsa.publicPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const names = signed.covered;
  const str = names.map((n) => (n === '(request-target)' ? '(request-target): post /inbox' : `${n}: ${signed.headers[n]}`)).join('\n');
  const sigB64 = /signature="([^"]+)"/.exec(signed.headers.signature)[1];
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub,
    Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0)), new TextEncoder().encode(str));
  check(ok, 'and the signature verifies against the published public key');

  // Upgrade path: a PEM record left by an earlier build.
  await kvPut(keyCacheKey(actor), rec);
  const before = await kvGet(keyCacheKey(actor));
  check(typeof before?.rsa?.privatePem === 'string', 'old-form PEM record planted');
  const up = await loadKeysFromPod(remote, urls);
  check(up.rsaPrivate?.type === 'private', 'old PEM record is imported on read');
  const after = await kvGet(keyCacheKey(actor));
  check(after?.rsaPrivate?.type === 'private' && !('rsa' in after), 'and replaced in storage by the CryptoKey');
} catch (e) {
  out.push(`FAIL  threw: ${e.message}`);
}
await fetch('/done', { method: 'POST', body: out.join('\n') });
