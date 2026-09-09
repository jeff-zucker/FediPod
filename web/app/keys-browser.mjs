// keys-browser.mjs — turn the keys record (from keystore/the pod) into what the
// agent's deliverer and publisher expect. The Node agent's resolveKeys returns
// { rsaPrivate (a WebCrypto key), rsaPublicPem, edPrivate, edPublicMultibase };
// this returns the same, RSA only. FEP-8b32 Ed25519 proofs are optional — the
// deliverer treats a null edPrivate as "no proof", and an unproved activity
// still federates — so the browser MVP omits them.
const pemToDer = (pem) => Uint8Array.from(
  atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));

export async function importSigningKey(keysRecord) {
  const rsaPrivate = await crypto.subtle.importKey('pkcs8', pemToDer(keysRecord.rsa.privatePem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  return { rsaPrivate, rsaPublicPem: keysRecord.rsa.publicPem, edPrivate: null, edPublicMultibase: null };
}

// Read the owner-only signing key the agent stored on the pod (keys.json in the
// state container) and import it for signing. Used by the redirect-login boot,
// where the OIDC session — authenticated as the pod owner — is what reads it.
export async function loadKeysFromPod(remote, urls) {
  const rec = await remote.getJson(urls.state + 'keys.json');
  if (!rec || !rec.rsa) throw new Error('no signing key on the pod — sign up did not finish');
  return importSigningKey(rec);
}
