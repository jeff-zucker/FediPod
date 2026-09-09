// web-push.mjs — browser stand-in. The facade needs a VAPID public key to put
// in its instance document; server-sent push while the tab is closed is not
// part of the browser build, so sendNotification is a no-op. The keypair is a
// well-formed placeholder (a real one needs a matching private key, which the
// browser push model does not use this way).
const b64u = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function generateVAPIDKeys() {
  const pub = new Uint8Array(65); pub[0] = 0x04; crypto.getRandomValues(pub.subarray(1));
  const priv = new Uint8Array(32); crypto.getRandomValues(priv);
  return { publicKey: b64u(pub), privateKey: b64u(priv) };
}
export function setVapidDetails() { /* no-op */ }
export async function sendNotification() { return { statusCode: 201, body: '', headers: {} }; }
export default { generateVAPIDKeys, setVapidDetails, sendNotification };
